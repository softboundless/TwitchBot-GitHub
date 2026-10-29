import { FunSettings } from './funSettings.js';
import { gamesEnabled } from './channelPolicy.js';
import { hasCommandAccess } from './access.js';
import { normalizeCommandText } from './commandText.js';
import { newPlayer } from './funStore.js';
import { responses } from './funResponses.js';
import { TAROT_BLOCKED } from './tarotPolicy.js';

export const FUN_USAGE = Object.freeze({
  '!кд': '<секунды>', '!вкл': '', '!выкл': '', '!выклвип': '',
  '!добавить': '<ник>', '!удалить': '<ник>',
  '!дуэль': '<ник> <ставка>', '!принять': '', '!кредит': '', '!бал': '', '!балтоп': '',
  '!каз': '<ставка>', '!кража': '<ник> <сумма>', '!додеп': '', '!сбп': '<ник> <сумма>',
  '!рулетка': '', '!стат': '', '!пиво': '', '!литры': '', '!топпиво': '',
  '!жрать': '', '!вес': '', '!вестоп': '', '!топвес': '',
  '!пивостатус': '', '!пиворулетка': '', '!кальян': '', '!тяги': '', '!топтяги': '',
  '!инфо': '', '!шип': '[текст]', '!совместимость': '<ник или текст>', '!iq': '',
  '!я': '<текст>', '!кликуха': '', '!шар': '<вопрос>', '!расклад': '<вопрос>', '!поцеловать': '<ник>',
});
export const FUN_COMMANDS = Object.freeze(Object.keys(FUN_USAGE));
const ADMIN = new Set(['!кд', '!вкл', '!выкл', '!выклвип', '!добавить', '!удалить']);
const TIMED = { '!кредит': 1200, '!каз': 1200, '!кража': 1200, '!додеп': 1200, '!пиво': 180, '!жрать': 180, '!пиворулетка': 180, '!кальян': 180 };
const ARG_COUNTS = { '!кд': 1, '!добавить': 1, '!удалить': 1, '!дуэль': 2, '!каз': 1, '!кража': 2, '!сбп': 2, '!поцеловать': 1 };
const FREE_TEXT = new Set(['!шип', '!совместимость', '!я', '!шар', '!расклад']);
const validLogin = (s) => /^[a-z0-9_]{1,25}$/.test(s) && s !== '__proto__';

class CommandError extends Error {}
class InputError extends CommandError {}
const checkInput = (condition, message) => { if (!condition) throw new InputError(message); };
const check = (condition, message) => { if (!condition) throw new CommandError(message); };
function number(raw, min = 1) {
  const n = Number(raw);
  checkInput(/^\d+$/.test(raw ?? '') && Number.isSafeInteger(n) && n >= min && n <= 1_000_000_000,
    `Нужно целое число от ${min} до 1000000000`);
  return n;
}
function target(raw) {
  const name = String(raw ?? '').replace(/^@/, '').toLowerCase();
  checkInput(validLogin(name), 'Нужен корректный логин Twitch');
  return name;
}
function player(data, name) {
  if (!Object.hasOwn(data.players, name)) data.players[name] = newPlayer();
  return data.players[name];
}

function formatCooldown(milliseconds) {
  const totalSeconds = Math.ceil(milliseconds / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes === 0) return `${seconds} сек`;
  const lastTwo = minutes % 100;
  const last = minutes % 10;
  const unit = lastTwo >= 11 && lastTwo <= 14 ? 'минут' :
    last === 1 ? 'минуту' : last >= 2 && last <= 4 ? 'минуты' : 'минут';
  return `${minutes} ${unit}${seconds ? ` ${seconds} сек` : ''}`;
}

// Убираем управляющие символы и ограничиваем текст 400 символами Unicode.
export function cleanFunText(text) {
  return Array.from(String(text).replace(/[\x00-\x1f\x7f]/g, ' ')).slice(0, 400).join('');
}

export function createFunCommandHandler({
  config, chat, ids, store, tarot, helix, settings = new FunSettings(undefined, { defaultMode: config.fun?.defaultMode ?? 'off' }),
  isCommandDisabled = (cmd) => config.disabledCommands?.has(cmd) ?? false,
  now = () => Date.now(), random = Math.random,
  schedule = (fn, delay) => { const timer = setTimeout(fn, delay); timer.unref(); return timer; },
  cancel = clearTimeout,
}) {
  const say = (text) => chat.say(cleanFunText(text));
  const adminLabel = config.allowChannelModerators ? 'модераторы канала' : 'MODS';
  const fail = (msg, cmd, reason) => {
    const usage = `Шаблон команды ${cmd}${FUN_USAGE[cmd] ? ' ' + FUN_USAGE[cmd] : ''}`;
    // Причина ограничена, чтобы обязательный шаблон поместился целиком.
    say(`@${msg.displayName || msg.login} ошибка выполнения команды. ${reason.slice(0, 60)}. ${usage}`);
  };
  const int = (lo, hi) => lo + Math.floor(random() * (hi - lo + 1));
  const pick = (items) => items[int(0, items.length - 1)];
  const phrase = (items, values) => pick(items).replace(/\{([^}]+)\}/g, (_, key) => values[key] ?? '');
  const recent = new Map();
  let lastUsed = null;
  const tarotUntil = new Map();
  const tempVips = new Set(settings?.data.tempVips);
  let cooldown = settings?.data.cooldown ?? 0;
  let mode = settings?.data.mode ?? 'off';
  let duel = null;
  let duelUntil = 0;
  let timer;
  let repeatTimer;
  let commandsLinkTimer;
  let closed = !store || !settings;
  const commandsUrl = config.fun?.commandsUrl ?? '';
  const commandsInfo = () => commandsUrl ? `Ссылка на все игровые команды: ${commandsUrl}` :
    'Игровые команды: ' + FUN_COMMANDS.filter((cmd) => !ADMIN.has(cmd) && !isCommandDisabled(cmd)).join(', ');

  function stopCommandsLink() {
    cancel(commandsLinkTimer);
    commandsLinkTimer = undefined;
  }

  function startCommandsLink() {
    if (!commandsUrl || isCommandDisabled('!инфо') || commandsLinkTimer !== undefined || closed || mode !== 'on') return;
    commandsLinkTimer = schedule(() => {
      commandsLinkTimer = undefined;
      if (closed || mode !== 'on' || isCommandDisabled('!инфо')) return;
      say(commandsInfo());
      startCommandsLink();
    }, 30 * 60 * 1000);
  }

  function hasGameAccess(msg) {
    return hasCommandAccess(config, msg) || mode === 'on' ||
      (mode === 'vip' && tempVips.has(String(msg.login ?? '').toLowerCase()));
  }

  // Один таймер для всех игровых команд и всех пользователей канала.
  function tryCooldown(cmd) {
    if (ADMIN.has(cmd) || cooldown === 0) return true;
    const at = now();
    if (lastUsed !== null && at < lastUsed + cooldown * 1000) return false;
    lastUsed = at; // До await: параллельные запросы тоже ограничены.
    return true;
  }

  function clearDuel() {
    cancel(timer);
    cancel(repeatTimer);
    timer = repeatTimer = undefined;
    duel = null;
  }

  function expireDuel() {
    if (!duel || now() < duel.deadline) return;
    if (duel.status === 'pending') {
      const { initiator, recipient } = duel;
      clearDuel();
      say(`⏳ Дуэль между ${initiator} и ${recipient} отменена: не принята за 10 секунд.`);
    } else {
      const { initiator, recipient, bet } = duel;
      store.transact((data) => { data.escrow = null; }); // Обе ставки уже зарезервированы.
      clearDuel();
      duelUntil = now() + 30_000;
      say(`⏰ Время вышло! ${initiator} и ${recipient} теряют по ${bet} монет.`);
    }
  }

  // Отключение команды прекращает уже начатую дуэль и возвращает ставки.
  function refreshCommandPolicy() {
    if (isCommandDisabled('!инфо')) stopCommandsLink();
    if (!duel || (!isCommandDisabled('!дуэль') && !isCommandDisabled('!принять'))) return;
    if (duel.status === 'active') {
      const { initiator, recipient, bet } = duel;
      store.transact((data) => {
        player(data, initiator).balance += bet;
        player(data, recipient).balance += bet;
        data.escrow = null;
      });
    }
    clearDuel();
  }

  function armDeadline() {
    cancel(timer);
    timer = schedule(() => {
      if (closed) return;
      try {
        expireDuel();
        if (duel) armDeadline();
      } catch {
        // Ставки остаются в escrow на диске и вернутся после перезапуска.
        closed = true;
        clearDuel();
        console.error(`[fun:#${config.channel}] ошибка сохранения дуэли; игровой модуль остановлен`);
        say('Игровые команды временно недоступны: ошибка сохранения данных.');
      }
    }, Math.max(1, duel.deadline - now()));
  }

  function top(field, title, unit) {
    const entries = Object.entries(store.data.players).sort((a, b) => b[1][field] - a[1][field]).slice(0, 5);
    if (!entries.length) return say('Статистика пока пуста.');
    say(`${title}: ` + entries.map(([name, p], i) => `${i + 1}. ${name} — ${p[field]} ${unit}`).join(' | '));
  }

  function timedChange(cmd, user, update) {
    return store.transact((data) => {
      const p = player(data, user);
      const result = update(p, data);
      if (TIMED[cmd]) p.cooldowns[cmd] = now() + TIMED[cmd] * 1000;
      return result;
    });
  }

  async function execute(msg, cmd, args) {
    const user = msg.login.toLowerCase();
    const author = msg.displayName || user;
    const text = args.join(' ');
    if (cmd === '!расклад' && now() < (tarotUntil.get(user) ?? 0)) return;
    if (FREE_TEXT.has(cmd)) {
      checkInput(cmd === '!шип' || args.length > 0, 'Не указан текст или вопрос');
    } else {
      const count = ARG_COUNTS[cmd] ?? 0;
      checkInput(args.length >= count, 'Недостаточно аргументов');
      checkInput(args.length <= count, 'Лишние аргументы');
    }
    if (TIMED[cmd]) {
      const left = (store.player(user).cooldowns[cmd] ?? 0) - now();
      if (left > 0) return say(`@${author} Подождите ${formatCooldown(left)}`);
    }

    switch (cmd) {
      case '!кд':
        settings.update({ cooldown: number(args[0], 0) });
        cooldown = settings.data.cooldown;
        say(`Общая задержка между игровыми командами для всех пользователей: ${cooldown} сек.`);
        break;
      case '!вкл': case '!выкл': case '!выклвип':
        settings.update({ mode: cmd === '!вкл' ? 'on' : cmd === '!выкл' ? 'off' : 'vip' });
        mode = settings.data.mode;
        if (mode === 'on') startCommandsLink();
        else stopCommandsLink();
        say(`Режим игр: ${mode === 'on' ? 'включён для всех' : mode === 'off' ? `только владелец и ${adminLabel}` : `владелец, ${adminLabel} и временные VIP`}.`);
        break;
      case '!добавить': {
        const name = target(args[0]);
        settings.update({ tempVips: [...new Set([...tempVips, name])].sort() });
        tempVips.add(name);
        say(`${name} добавлен во временные VIP для режима !выклвип.`);
        break;
      }
      case '!удалить': {
        const name = target(args[0]);
        settings.update({ tempVips: [...tempVips].filter((vip) => vip !== name) });
        say(tempVips.delete(name) ? `${name} удалён из временных VIP.` : `${name} не найден во временных VIP.`);
        break;
      }
      case '!дуэль': {
        const recipient = target(args[0]);
        const bet = number(args[1], 50);
        const left = duelUntil - now();
        if (left > 0) return say(`@${author} Подождите ${formatCooldown(left)}`);
        check(!duel, 'Уже идёт другая дуэль или ожидание');
        check(recipient !== user, 'Нельзя вызвать самого себя');
        check(hasGameAccess({ login: recipient }), 'У соперника нет доступа к играм');
        check(store.player(user).balance >= bet && store.player(recipient).balance >= bet, 'У одного из игроков недостаточно монет');
        duel = { status: 'pending', initiator: user, recipient, bet, deadline: now() + 10_000 };
        armDeadline();
        say(`⚔️ ${recipient}, ${user} вызывает на дуэль за ${bet} монет! Напишите !принять за 10 секунд.`);
        break;
      }
      case '!принять': {
        check(duel?.status === 'pending', 'Нет ожидающей дуэли');
        check(duel.recipient === user, 'Вызов адресован другому игроку');
        const { initiator, recipient, bet } = duel;
        store.transact((data) => {
          const a = player(data, initiator), b = player(data, recipient);
          check(a.balance >= bet && b.balance >= bet, 'У одного из игроков недостаточно монет');
          a.balance -= bet;
          b.balance -= bet;
          data.escrow = { initiator, recipient, bet };
        });
        const letters = [...'абвгдеёжзийклмнопрстуфхцчшщъыьэюя'];
        duel = { ...duel, status: 'active', word: Array.from({ length: 8 }, () => pick(letters)).join(''), deadline: now() + 30_000 };
        armDeadline();
        const active = duel;
        const announcement = `🔥 Дуэль началась! Первый, кто напишет '${duel.word}', побеждает! У вас 30 секунд!`;
        say(announcement);
        repeatTimer = schedule(() => { if (!closed && duel === active) say(announcement); }, 2000);
        break;
      }
      case '!кредит': {
        const amount = int(10, 30);
        timedChange(cmd, user, (p) => { p.balance += amount; });
        say(`✅ ${author}, вы получили кредит ${amount} монет! Баланс: ${store.player(user).balance}.`);
        break;
      }
      case '!бал': say(`${author}, ваш баланс: ${store.player(user).balance} монет 💰`); break;
      case '!балтоп': top('balance', '🏆 Топ-5 богачей чата', 'монет'); break;
      case '!каз': {
        const bet = number(args[0]);
        const roll = int(1, 100);
        const delta = roll === 1 ? bet * 2 : roll <= 41 ? bet : -bet;
        timedChange(cmd, user, (p) => {
          check(p.balance >= bet, 'Недостаточно монет');
          p.balance += delta;
        });
        say(`${author}, ${roll === 1 ? 'ДЖЕКПОТ' : delta > 0 ? 'ПОБЕДА' : 'ПРОИГРЫШ'}! ${delta > 0 ? '+' : ''}${delta} монет. Баланс: ${store.player(user).balance}.`);
        break;
      }
      case '!кража': case '!сбп': {
        const recipient = target(args[0]);
        const amount = number(args[1]);
        check(user !== recipient, 'Нельзя указать самого себя');
        const success = cmd === '!сбп' || int(1, 100) <= 35;
        timedChange(cmd, user, (p, data) => {
          check(Object.hasOwn(data.players, recipient) || recent.has(recipient), 'Пользователь не найден в базе');
          const other = player(data, recipient);
          if (cmd === '!сбп') {
            check(p.balance >= amount, 'Недостаточно монет');
            p.balance -= amount;
            other.balance += amount;
          } else {
            check(amount <= Math.floor(other.balance * 0.3), 'Можно украсть не более 30% баланса цели');
            if (success) { p.balance += amount; other.balance -= amount; }
          }
        });
        say(cmd === '!сбп' ? `✅ ${author} перевёл ${amount} монет пользователю ${recipient}.` :
          success ? `😈 ${author} украл ${amount} монет у ${recipient}!` : `👮 ${author}, попытка кражи провалилась!`);
        break;
      }
      case '!додеп': {
        const delta = int(0, 1) ? 10 : -10;
        timedChange(cmd, user, (p) => { check(p.balance >= 10, 'Нужно минимум 10 монет'); p.balance += delta; });
        say(`${author}, додеп: ${delta > 0 ? '+' : ''}${delta} монет. Баланс: ${store.player(user).balance}.`);
        break;
      }
      case '!рулетка': {
        const death = int(1, 6) === 1;
        timedChange(cmd, user, (p) => { p[death ? 'deaths' : 'survivals']++; });
        say(death ? `БАХ! 💥 ${author} трагически погибает...` : `Щелчок... 😌 ${author} выживает!`);
        if (death && !msg.isMod && !msg.isBroadcaster && user !== config.channel) {
          try {
            const userId = msg.userId || await helix.getUserId(user);
            check(userId, 'Не удалось определить пользователя');
            await helix.timeoutUser({
              broadcasterId: ids.broadcasterId, moderatorId: ids.botUserId,
              userId, duration: 120, reason: 'Выстрел в !рулетка',
            });
          } catch {
            throw new CommandError('Не удалось выдать тайм-аут на 120 секунд');
          }
        }
        break;
      }
      case '!стат': {
        const p = store.player(user);
        say(`📊 ${author}: Выживаний — ${p.survivals} | Смертей — ${p.deaths}`);
        break;
      }
      case '!пиво': {
        let message;
        timedChange(cmd, user, (p) => {
          if (int(1, 100) <= 10) {
            const event = int(0, 2);
            if (event === 0) { p.liters += 50; message = '🎉 Тебя угостили! +50 л пива!'; }
            else if (event === 1) { p.liters = Math.max(0, p.liters - 20); message = '💥 Ты разбил кружку! -20 л пива.'; }
            else { p.liters += 150; message = '🎊 Пивной фестиваль! +150 л пива!'; }
          } else {
            const amount = int(0, 100);
            const lost = amount > 4 && int(1, 5) === 1 ? Math.floor(amount * 0.2) : 0;
            p.liters += amount - lost;
            message = lost ? `🍺 Выпито ${amount} л, пролито ${lost} л. Засчитано ${amount - lost} л.` : `🍺 Выпито ${amount} л пива.`;
          }
        });
        say(`${author}, ${message} Всего: ${store.player(user).liters} л.`);
        break;
      }
      case '!жрать': {
        let message;
        timedChange(cmd, user, (p) => {
          if (int(1, 100) <= 10) {
            const event = int(0, 2);
            if (event === 0) { p.weight += 50; message = '🍕 Тебя угостили пиццей! +50 кг!'; }
            else if (event === 1) { p.weight = Math.max(0, p.weight - 20); message = '🏃 Пришлось пробежаться! -20 кг.'; }
            else { p.weight += 150; message = '🎊 Попал на шведский стол! +150 кг!'; }
          } else {
            const amount = int(0, 100);
            const lost = amount > 4 && int(1, 5) === 1 ? Math.floor(amount * 0.2) : 0;
            p.weight += amount - lost;
            message = lost ? `🍔 Набрал ${amount} кг, сжёг ${lost} кг. Засчитано ${amount - lost} кг.` : `🍔 Плотно поел! +${amount} кг.`;
          }
        });
        say(`${author}, ${message} Твой вес: ${store.player(user).weight} кг.`);
        break;
      }
      case '!вес': say(`⚖️ ${author}, твой вес: ${store.player(user).weight} кг.`); break;
      case '!вестоп': case '!топвес': {
        const entries = Object.entries(store.data.players).filter(([, p]) => p.weight > 0)
          .sort((a, b) => b[1].weight - a[1].weight || a[0].localeCompare(b[0])).slice(0, 5);
        if (!entries.length) { say('Статистика веса пока пуста. Напиши !жрать!'); break; }
        const title = '🏆 Топ-5 по весу: ';
        let line = title;
        for (const [i, [name, p]] of entries.entries()) {
          const entry = `${i + 1}. ${name} — ${p.weight} кг`;
          const next = line + (line === title ? '' : ' | ') + entry;
          if (Array.from(next).length > 400 || Buffer.byteLength(next, 'utf8') > 400) { say(line); line = title + entry; }
          else line = next;
        }
        say(line);
        break;
      }
      case '!литры': say(`🍺 ${author}, ты выпил всего ${store.player(user).liters} л пива.`); break;
      case '!топпиво': top('liters', '🏆 Топ-5 любителей пива', 'л'); break;
      case '!пивостатус': {
        const liters = store.player(user).liters;
        const rank = liters <= 1000 ? 'Новичок по пиву' : liters <= 3000 ? 'Бутылочник' : liters <= 5000 ? 'Бочонок-мен' : liters <= 8000 ? 'Пивной бог' : liters <= 12000 ? 'Поглотитель пива' : 'ТЫ САМ ПИВО';
        say(`🍻 ${author}, твой пивной ранг: «${rank}» (${liters} л).`);
        break;
      }
      case '!пиворулетка': {
        const roll = int(1, 6);
        const amount = roll <= 2 ? int(1, 250) : 0;
        let delta = 0;
        timedChange(cmd, user, (p) => { delta = roll === 1 ? -Math.min(p.liters, amount) : amount; p.liters += delta; });
        say(`🍻 ${author}, ${roll === 1 ? 'потеря' : roll === 2 ? 'ДЖЕКПОТ' : 'пустой бокал'}: ${delta} л. Всего: ${store.player(user).liters} л.`);
        break;
      }
      case '!кальян':
        timedChange(cmd, user, (p) => { p.hits++; });
        say(phrase(responses.hookah[0], { 'ctx.author.name': author }));
        break;
      case '!тяги': say(`😤 ${author}, ты сделал ${store.player(user).hits} тяг кальяна!`); break;
      case '!топтяги': top('hits', '🏆 Топ-5 кальянщиков', 'тяг'); break;
      case '!инфо': chat.say(commandsInfo(), { replyTo: msg.id }); break;
      case '!шип': {
        const botLogin = String(ids.botLogin ?? '').toLowerCase();
        const users = [...recent.keys()].filter((name) => name !== botLogin);
        if (!text) {
          check(users.length >= 2, 'Нужно минимум два активных участника');
          const user1 = pick(users), user2 = pick(users.filter((name) => name !== user1));
          say(phrase(responses.ship[0], { user1, user2 }));
        } else {
          const others = users.filter((name) => name !== user);
          check(others.length > 0, 'Нет других активных участников');
          say(phrase(responses.ship[1], { user_text: text, random_user: pick(others) }));
        }
        break;
      }
      case '!совместимость': {
        const other = args.length === 1 && /^@?[a-z0-9_]{1,25}$/i.test(text) ? text.replace(/^@/, '').toLowerCase() : text;
        const percent = int(0, 100);
        say(`💞 Совместимость между ${author} и ${other}: ${percent}%. ${pick(responses.compatibility[percent <= 25 ? 0 : percent <= 50 ? 1 : percent <= 75 ? 2 : 3])}`);
        break;
      }
      case '!iq': {
        const iq = int(0, 200);
        say(`${author} твой IQ: ${iq}. ${pick(responses.iq[iq < 30 ? 0 : iq < 70 ? 1 : iq < 100 ? 2 : iq < 130 ? 3 : iq < 160 ? 4 : 5])}`);
        break;
      }
      case '!я': say(`${author} ${text} на ${int(0, 100)}%`); break;
      case '!кликуха': say(`${author} ты ${pick(responses.nicknames[0])}`); break;
      case '!шар': say(`${author} ${pick(responses.ball[0])}`); break;
      case '!расклад': {
        // Фиксируем до await, чтобы одновременные сообщения не обходили КД.
        tarotUntil.set(user, now() + 20_000);
        try {
          check(typeof tarot === 'function', 'Расклад не настроен');
          const answer = await tarot(text);
          if (!closed) say(answer === TAROT_BLOCKED ? `@${author} ${TAROT_BLOCKED}` : `🔮 ${author}, ${answer}`);
        } catch (error) {
          throw new CommandError(error.message);
        }
        break;
      }
      case '!поцеловать':
        say(phrase(responses.kiss[0], { user: author, target_user: target(args[0]) }));
        break;
    }
  }

  async function onMessage(msg) {
    const user = String(msg.login ?? '').toLowerCase();
    if (!validLogin(user) || user === String(ids.botLogin).toLowerCase() || (msg.channel && msg.channel !== config.channel)) return false;
    const text = normalizeCommandText(msg.text);
    const tokens = text.split(/\s+/);
    const cmd = tokens[0].toLowerCase();
    const known = FUN_COMMANDS.includes(cmd);
    if (!gamesEnabled(config.channel, config) || isCommandDisabled(cmd)) return known;
    const allowed = ADMIN.has(cmd) ? hasCommandAccess(config, msg) :
      hasGameAccess(msg);
    if (known && allowed && !tryCooldown(cmd)) return true;
    if (closed) {
      if (known && allowed) fail(msg, cmd, 'Игровые данные недоступны');
      return known;
    }
    for (const [name, at] of recent) if (now() - at >= 600_000) recent.delete(name);
    recent.set(user, now());
    try {
      refreshCommandPolicy();
      expireDuel();
      // Текущий режим действует также на строку победы в дуэли.
      if (allowed && duel?.status === 'active' && [duel.initiator, duel.recipient].includes(user) && msg.text === duel.word) {
        const bet = duel.bet;
        store.transact((data) => { player(data, user).balance += bet * 2; data.escrow = null; });
        clearDuel();
        duelUntil = now() + 30_000;
        say(`🏆 ${user} побеждает в дуэли и забирает ${bet} монет!`);
        return true;
      }
      if (!known) return false;
      if (!allowed) return true;
      await execute(msg, cmd, tokens.slice(1));
    } catch (error) {
      if (error instanceof InputError && !ADMIN.has(cmd)) return true;
      if (error instanceof CommandError) {
        fail(msg, cmd, error.message);
      } else {
        closed = true;
        clearDuel();
        console.error(`[fun:#${config.channel}] ошибка игровых данных; модуль остановлен`);
        if (known && allowed) fail(msg, cmd, 'Ошибка сохранения игровых данных');
      }
    }
    return known;
  }

  if (settings?.file && settings.data.mode === 'on' && gamesEnabled(config.channel, config)) startCommandsLink();
  onMessage.refreshCommandPolicy = () => {
    refreshCommandPolicy();
    if (gamesEnabled(config.channel, config)) startCommandsLink();
  };
  onMessage.close = () => { closed = true; clearDuel(); stopCommandsLink(); };
  return onMessage;
}
