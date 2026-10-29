import { EventSubClient } from './eventsub.js';

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const CHECK_INTERVAL_MS = 30_000;
const VERIFY_TRANSITION_MS = 120_000;

export class AutoPin {
  constructor({ config, contexts, eventsubFactory, sleep = wait,
    now = Date.now, schedule = setTimeout, cancel = clearTimeout }) {
    this.cfg = config.autoPin;
    this.contexts = [...contexts];
    this.contextsByBroadcasterId = new Map(
      this.contexts.map((context) => [String(context.ids.broadcasterId), context]),
    );
    this.eventsubFactory = eventsubFactory ?? ((options) => new EventSubClient(options));
    this.sleep = sleep;
    this.now = now;
    this.schedule = schedule;
    this.cancel = cancel;
    this.eventsub = null;
    this.pendingByChannel = new Map();
    this.streamByChannel = new Map();
    this.recoveryByChannel = new Map();
    this.checking = null;
    this.checkTimer = null;
    this.stopped = false;
  }

  async start() {
    if (this.eventsub || this.stopped) return;
    if (!this.cfg.enabled) {
      console.log('[pin] автоматический закреп выключен (AUTO_PIN не true)');
      return;
    }
    if (this.contexts.length === 0) {
      console.error('[pin] AUTO_PIN=true, но в AUTO_PIN_CHANNELS нет подключённых каналов');
      return;
    }

    const subscriptions = this.contexts.flatMap((context) => [
      {
        type: 'stream.online',
        version: '1',
        condition: { broadcaster_user_id: context.ids.broadcasterId },
      },
      {
        type: 'stream.offline',
        version: '1',
        condition: { broadcaster_user_id: context.ids.broadcasterId },
      },
    ]);
    this.eventsub = this.eventsubFactory({ subscriptions, helix: this.contexts[0].helix });
    this.eventsub.on('notification', (type, event) => {
      if (type !== 'stream.online' && type !== 'stream.offline') return;
      this.onStreamEvent(type, event).catch((error) => {
        const channel = event?.broadcaster_user_login ?? '?';
        console.error(`[pin:#${channel}] ошибка обработки ${type}:`, error);
      });
    });
    this.eventsub.on('connected', () => { void this.checkAll(); });
    this.eventsub.connect();

    await this.checkAll();
    this.scheduleCheck();
  }

  async onStreamEvent(type, event) {
    if (this.stopped || (type !== 'stream.online' && type !== 'stream.offline')) return false;
    const context = this.contextsByBroadcasterId.get(String(event?.broadcaster_user_id ?? ''));
    if (!context) return false;

    // События могут запоздать. Сверяем фактическую трансляцию через API.
    return this.enqueue(context, () => this.checkContext(context));
  }

  scheduleCheck() {
    if (this.stopped) return;
    this.checkTimer = this.schedule(async () => {
      this.checkTimer = null;
      await this.checkAll();
      this.scheduleCheck();
    }, CHECK_INTERVAL_MS);
    this.checkTimer?.unref?.();
  }

  checkAll() {
    if (this.stopped) return Promise.resolve();
    if (this.checking) return this.checking;
    this.checking = Promise.all(this.contexts.map((context) =>
      this.enqueue(context, () => this.checkContext(context)).catch((error) => {
        console.error(`[pin:#${context.channel}] проверка/восстановление не удалось:`, error);
      }),
    )).finally(() => { this.checking = null; });
    return this.checking;
  }

  async checkContext(context) {
    if (this.stopped) return false;
    const keyOf = (stream) => stream ? `${stream.id}:${stream.started_at}` : null;
    let key = keyOf(await context.helix.getStream(context.ids.broadcasterId));
    if (this.stopped) return false;
    const known = this.streamByChannel.has(context.channel);
    const previous = this.streamByChannel.get(context.channel);
    if (known && previous !== key && key === null && this.cfg.offlineDelayMs > 0) {
      await this.sleep(this.cfg.offlineDelayMs);
      if (this.stopped) return false;
      // За время ожидания мог уже начаться следующий стрим.
      key = keyOf(await context.helix.getStream(context.ids.broadcasterId));
      if (this.stopped) return false;
    }
    if (!known || previous !== key) {
      this.streamByChannel.set(context.channel, key);
      this.recoveryByChannel.set(context.channel, {
        reason: !known ? (key === null ? 'запуск офлайн' : 'запуск во время стрима') :
          (key === null ? 'стрим завершился' : 'стрим начался'),
        verifyUntil: this.now() + VERIFY_TRANSITION_MS,
        messageId: null,
      });
    }
    const recovery = this.recoveryByChannel.get(context.channel);
    if (!recovery) return false;
    const result = await this.ensurePinned(context, recovery.reason, recovery);
    // Несколько проверок после перехода ловят запоздалое снятие старого pin.
    // Ошибка оставляет восстановление активным; неизменный стрим вне этого
    // окна не вызывает ни проверки pin, ни повторной отправки сообщения.
    if (this.now() >= recovery.verifyUntil) this.recoveryByChannel.delete(context.channel);
    return result;
  }

  async enqueue(context, action) {
    const previous = this.pendingByChannel.get(context.channel) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(action);
    this.pendingByChannel.set(context.channel, current);
    try {
      return await current;
    } finally {
      if (this.pendingByChannel.get(context.channel) === current) {
        this.pendingByChannel.delete(context.channel);
      }
    }
  }

  async ensurePinned(context, reason, recovery = {}) {
    if (this.stopped) return false;
    const { broadcasterId, botUserId } = context.ids;
    const message = this.cfg.messages.get(context.channel);
    if (!message) {
      throw new Error(`не задан текст AUTO_PIN_MESSAGE_${context.channel.toUpperCase()}`);
    }
    const pinned = await context.helix.getPinnedChatMessage({
      broadcasterId,
      moderatorId: botUserId,
    });
    if (this.stopped) return false;
    if (pinned) {
      console.log(`[pin:#${context.channel}] ${reason}: закреп уже есть, ничего не меняю`);
      return false;
    }

    if (!recovery.messageId) {
      const sent = await context.helix.sendChatMessage({
        broadcasterId,
        senderId: botUserId,
        message,
      });
      if (!sent?.is_sent || !sent.message_id) {
        const reasonText = sent?.drop_reason?.message ?? 'Twitch не вернул message_id';
        throw new Error(`сообщение для закрепа не отправлено: ${reasonText}`);
      }
      recovery.messageId = sent.message_id;
    }
    if (this.stopped) return false;
    try {
      await context.helix.pinChatMessage({
        broadcasterId,
        moderatorId: botUserId,
        messageId: recovery.messageId,
      });
    } catch (error) {
      if (error.status === 404) recovery.messageId = null;
      throw error;
    }
    recovery.messageId = null;
    console.log(`[pin:#${context.channel}] ${reason}: сообщение отправлено и закреплено до конца стрима`);
    return true;
  }

  stop() {
    this.stopped = true;
    this.cancel(this.checkTimer);
    this.checkTimer = null;
    this.eventsub?.close();
  }
}
