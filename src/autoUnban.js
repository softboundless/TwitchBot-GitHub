import { EventSubClient } from './eventsub.js';

// Атрибуция бана (кто именно забанил) приходит только из EventSub: список
// забаненных через API доступен лишь по токену владельца канала, а сигнал
// CLEARCHAT в чате автора бана не сообщает. Поэтому при заданном ONLYFROM
// неатрибутированный бан — повод записать в лог, а не действовать.
const UNATTRIBUTED_LOG_EVERY_MS = 60 * 1000;

// Из события channel.moderate достаёт { action, targetLogin, moderatorLogin }.
// Для каждого действия Твич кладёт детали во вложенный объект с именем действия.
export function parseModerateEvent(event) {
  const action = event?.action;
  if (!action) return null;
  const details = event[action] ?? {};
  const targetLogin = (details.user_login ?? details.user_name ?? '').toLowerCase();
  return {
    action,
    targetLogin,
    moderatorLogin: (event.moderator_user_login ?? '').toLowerCase(),
    reason: details.reason ?? null,
  };
}

// Скользящее окно: не больше limit срабатываний за минуту.
export class RateLimiter {
  constructor(limit, windowMs = 60_000) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.hits = [];
  }

  tryAcquire(now = Date.now()) {
    this.hits = this.hits.filter((t) => now - t < this.windowMs);
    if (this.hits.length >= this.limit) return false;
    this.hits.push(now);
    return true;
  }
}

export class AutoUnban {
  constructor({ config, helix, ids, chat }) {
    this.cfg = config.autoUnban;
    this.helix = helix;
    this.ids = ids;
    this.channel = ids.channel ?? null;
    this.chat = chat;
    this.targetId = null;
    this.limiter = new RateLimiter(this.cfg.maxPerMinute);
    this.lastAttributedBanAt = 0;
    this.lastUnattributedLogAt = 0;
    this.eventsub = null;
    this.watchdogTimer = null;
  }

  allowedModerator(login) {
    return this.cfg.onlyFrom.size === 0 || this.cfg.onlyFrom.has(login);
  }

  async start() {
    if (!this.cfg.enabled) {
      console.log('[unban] автоматический разбан выключен (AUTO_UNBAN не true)');
      return;
    }
    if (!this.cfg.target) {
      console.error('[unban] AUTO_UNBAN=true, но AUTO_UNBAN_TARGET не задан — модуль не запущен');
      return;
    }

    this.targetId = await this.helix.getUserId(this.cfg.target);
    if (!this.targetId) {
      console.error(`[unban] пользователь «${this.cfg.target}» не найден на Твиче — модуль не запущен`);
      return;
    }

    const from = this.cfg.onlyFrom.size ? [...this.cfg.onlyFrom].join(', ') : 'кто угодно';
    console.log(
      `[unban] слежу за «${this.cfg.target}» (id ${this.targetId}); источник бана: ${from}; ` +
        `проверка связи раз в ${this.cfg.intervalSeconds} с; лимит ${this.cfg.maxPerMinute}/мин`,
    );

    this.eventsub = new EventSubClient({
      helix: this.helix,
      subscriptions: [
        {
          type: 'channel.moderate',
          version: '2',
          condition: {
            broadcaster_user_id: this.ids.broadcasterId,
            moderator_user_id: this.ids.botUserId,
          },
        },
      ],
    });
    this.eventsub.on('notification', (type, event) => {
      if (type !== 'channel.moderate') return;
      this.onModerateEvent(event).catch((e) => console.error('[unban] ошибка обработки события:', e));
    });
    this.eventsub.connect();

    // Дублирующий мгновенный сигнал из чата. Кто выдал бан, IRC не сообщает,
    // поэтому сам по себе он к разбану не приводит — только сверяется с EventSub.
    this.chat?.on('clearchat', (e) => {
      if (this.channel && e.channel && e.channel !== this.channel) return;
      if (e.login !== this.cfg.target) return;
      this.onChatClear(e).catch((err) => console.error('[unban] ошибка обработки CLEARCHAT:', err));
    });

    // Сторож: следит, что канал событий жив. Опрос состояния банов через API
    // невозможен — Твич отдаёт список забаненных только по токену владельца канала.
    this.watchdogTimer = setInterval(() => {
      this.eventsub.ensureConnected();
    }, this.cfg.intervalSeconds * 1000);

    if (this.cfg.onStart) await this.unbanOnStart();
  }

  // Закрывает разрыв: бан, выданный пока бот не работал, события не породил.
  // Автор такого бана неизвестен, поэтому ONLYFROM здесь не проверяется —
  // включается отдельным флагом AUTO_UNBAN_ON_START.
  async unbanOnStart() {
    try {
      await this.helix.unbanUser({
        broadcasterId: this.ids.broadcasterId,
        moderatorId: this.ids.botUserId,
        userId: this.targetId,
      });
      console.log(`[unban] при старте: «${this.cfg.target}» был забанен — разбанен`);
    } catch (e) {
      if (e.status === 400) {
        console.log(`[unban] при старте: «${this.cfg.target}» не забанен, всё в порядке`);
        return;
      }
      console.error(`[unban] при старте не удалось разбанить: ${e.status ?? ''} ${e.message}`);
    }
  }

  async onChatClear(e) {
    const kind = e.durationSeconds ? `таймаут ${e.durationSeconds}с` : 'бан';
    // событие EventSub приходит практически одновременно; даём ему мгновение
    await new Promise((r) => setTimeout(r, 1500));
    if (Date.now() - this.lastAttributedBanAt < 5000) return; // уже обработано по EventSub

    if (this.cfg.onlyFrom.size === 0) {
      console.log(`[unban] «${this.cfg.target}»: ${kind} (по чату, список ONLYFROM пуст) — разбаниваю`);
      await this.unban();
      return;
    }
    if (Date.now() - this.lastUnattributedLogAt > UNATTRIBUTED_LOG_EVERY_MS) {
      this.lastUnattributedLogAt = Date.now();
      console.log(
        `[unban] «${this.cfg.target}»: ${kind} виден в чате, но события модерации не пришло — ` +
          'автор бана неизвестен. ONLYFROM задан, поэтому не вмешиваюсь.',
      );
    }
  }

  async onModerateEvent(event) {
    const parsed = parseModerateEvent(event);
    if (!parsed) return;
    if (parsed.action !== 'ban' && parsed.action !== 'timeout') return;
    if (parsed.targetLogin !== this.cfg.target) return;

    if (!this.allowedModerator(parsed.moderatorLogin)) {
      console.log(
        `[unban] «${this.cfg.target}» получил ${parsed.action} от ${parsed.moderatorLogin} — ` +
          'не из списка ONLYFROM, не вмешиваюсь',
      );
      return;
    }

    this.lastAttributedBanAt = Date.now();
    console.log(`[unban] «${this.cfg.target}»: ${parsed.action} от ${parsed.moderatorLogin} — разбаниваю`);
    await this.unban();
  }

  // Разбан с несколькими попытками: сеть может моргнуть, а второго шанса
  // (опроса состояния) у нас нет.
  async unban(attempts = 3) {
    for (let i = 1; i <= attempts; i++) {
      if (!this.limiter.tryAcquire()) {
        console.error(
          `[unban] достигнут лимит ${this.cfg.maxPerMinute} разбанов в минуту — пауза. ` +
            'Похоже на цикл бан-разбан, разберитесь вручную.',
        );
        return false;
      }
      try {
        await this.helix.unbanUser({
          broadcasterId: this.ids.broadcasterId,
          moderatorId: this.ids.botUserId,
          userId: this.targetId,
        });
        console.log(`[unban] «${this.cfg.target}» разбанен`);
        return true;
      } catch (e) {
        // 400 прилетает, если человек уже не забанен — нормальная гонка, не ошибка
        if (e.status === 400) return true;
        console.error(`[unban] попытка ${i}/${attempts} не удалась: ${e.status ?? ''} ${e.message}`);
        if (i < attempts) await new Promise((r) => setTimeout(r, 500 * i));
      }
    }
    return false;
  }

  stop() {
    clearInterval(this.watchdogTimer);
    this.eventsub?.close();
  }
}
