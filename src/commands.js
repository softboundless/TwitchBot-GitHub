import { HelixError } from './helix.js';
import { hasCommandAccess } from './access.js';
import { normalizeCommandText } from './commandText.js';
import { FUN_COMMANDS } from './funCommands.js';
import { CommandSettings } from './commandSettings.js';
import { trackEnabled } from './channelPolicy.js';

export const USAGE = {
  poll: 'Шаблон команды !poll <Название опроса> <Ответы (не менее двух)> <Длительность>',
  pred: 'Шаблон команды !pred <Название прогноза> <Возможные результаты (не менее двух)> <Срок прогноза> — либо !pred <Название шаблона>',
  addPred: 'Шаблон команды !+pred <Название шаблона> <Название прогноза> <Возможные результаты (не менее двух)> <Срок прогноза>',
  delPred: 'Шаблон команды !-pred <Название шаблона>',
  predwin: 'Шаблон команды !predwin <Название победившего исхода или его номер>',
  game: 'Шаблон команды !g <Название категории или шаблона>',
  addGame: 'Шаблон команды !+g <Название шаблона> <Полное название категории>',
  delGame: 'Шаблон команды !-g <Название шаблона>',
  calc: 'Шаблон команды !скок <выражение из чисел, скобок и знаков + - * />',
};

// Безопасный калькулятор без eval: числа, скобки, + - * /.
// Возвращает { value } либо { error }.
export function calcExpression(input) {
  const s = String(input).replace(/\s+/g, '').replace(/,/g, '.').replace(/[×хx]/gi, '*').replace(/[÷:]/g, '/');
  if (!s) return { error: 'пустое выражение' };
  if (s.length > 200) return { error: 'слишком длинное выражение' };
  if (!/^[0-9.+\-*/()]+$/.test(s)) return { error: 'допустимы только числа, скобки и знаки + - * /' };

  let i = 0;
  function factor() {
    if (s[i] === '+') { i++; return factor(); }
    if (s[i] === '-') { i++; return -factor(); }
    if (s[i] === '(') {
      i++;
      const v = expr();
      if (s[i] !== ')') throw new Error('не хватает закрывающей скобки');
      i++;
      return v;
    }
    const m = /^(\d+(\.\d+)?|\.\d+)/.exec(s.slice(i));
    if (!m) throw new Error('ожидалось число');
    i += m[0].length;
    return Number(m[0]);
  }
  function term() {
    let v = factor();
    while (s[i] === '*' || s[i] === '/') {
      const op = s[i++];
      const r = factor();
      if (op === '/') {
        if (r === 0) throw new Error('деление на ноль');
        v /= r;
      } else {
        v *= r;
      }
    }
    return v;
  }
  function expr() {
    let v = term();
    while (s[i] === '+' || s[i] === '-') {
      const op = s[i++];
      const r = term();
      v = op === '+' ? v + r : v - r;
    }
    return v;
  }

  try {
    const v = expr();
    if (i !== s.length) throw new Error('лишние символы в выражении');
    if (!Number.isFinite(v) || Math.abs(v) > 1e15) return { error: 'слишком большое число' };
    // toFixed(9) убирает мусор плавающей точки вида 0.30000000000000004
    return { value: Number(v.toFixed(9)) };
  } catch (e) {
    return { error: e.message };
  }
}

// «120», «90с», «3м», «2m» → секунды; null — не распознано
export function parseDuration(token) {
  const sec = /^(\d+)(с|c|s|сек|sec)?$/i.exec(token);
  if (sec) return Number(sec[1]);
  const min = /^(\d+)(м|m|мин|min)$/i.exec(token);
  if (min) return Number(min[1]) * 60;
  return null;
}

// Разбирает аргументы вида: <Название из нескольких слов> <отв1/отв2/...> [длительность]
export function parseCreateArgs(args, { maxTitle, maxChoices, minSec, maxSec, defaultSec }) {
  if (args.length === 0) return { error: 'Не указано название' };
  const slashIdx = args.findIndex((t) => t.includes('/'));
  if (slashIdx === -1) return { error: 'Недостаточно ответов' };
  if (slashIdx === 0) return { error: 'Не указано название' };

  const title = args.slice(0, slashIdx).join(' ');
  const choices = args[slashIdx]
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);
  const rest = args.slice(slashIdx + 1);

  if (title.length > maxTitle) return { error: `Название длиннее ${maxTitle} символов` };
  if (choices.length < 2) return { error: 'Недостаточно ответов' };
  if (choices.length > maxChoices) return { error: `Слишком много ответов (максимум ${maxChoices})` };
  const tooLong = choices.find((c) => c.length > 25);
  if (tooLong) return { error: `Ответ «${tooLong}» длиннее 25 символов` };

  let duration = defaultSec;
  if (rest.length > 1) return { error: 'Лишние параметры после длительности' };
  if (rest.length === 1) {
    const d = parseDuration(rest[0]);
    if (d === null) return { error: `Не понял длительность «${rest[0]}» (пример: 120 или 3м)` };
    duration = d;
  }
  if (duration < minSec || duration > maxSec) {
    return { error: `Длительность должна быть от ${minSec} сек до ${maxSec / 60} мин` };
  }
  return { title, choices, duration };
}

// Подбирает исход прогноза по названию (без учёта регистра), номеру (1..N)
// или уникальной подстроке. Возвращает { outcome } либо { error }.
export function matchOutcome(outcomes, query) {
  const q = query.trim().toLowerCase();
  const exact = outcomes.find((o) => o.title.trim().toLowerCase() === q);
  if (exact) return { outcome: exact };
  if (/^\d+$/.test(q)) {
    const n = Number(q);
    if (n >= 1 && n <= outcomes.length) return { outcome: outcomes[n - 1] };
    return { error: `нет исхода с номером ${n} (всего ${outcomes.length})` };
  }
  const subs = outcomes.filter((o) => o.title.toLowerCase().includes(q));
  if (subs.length === 1) return { outcome: subs[0] };
  if (subs.length > 1) return { error: `«${query}» подходит к нескольким исходам — уточните` };
  return { error: `исход «${query}» не найден` };
}

// Поиск у Твича нечёткий: точное совпадение важнее первого результата.
export function matchCategory(results, query) {
  if (!results?.length) return null;
  const q = query.trim().toLowerCase();
  return (
    results.find((c) => c.name.toLowerCase() === q) ??
    results.find((c) => c.name.toLowerCase().startsWith(q)) ??
    results[0]
  );
}

function ruHelixError(e) {
  if (e instanceof HelixError) {
    const m = (e.message || '').toLowerCase();
    if (m.includes('poll') && (m.includes('already') || m.includes('active'))) {
      return 'на канале уже идёт опрос — завершите его командой !endpoll';
    }
    if (m.includes('prediction') && (m.includes('already') || m.includes('active') || m.includes('locked') || m.includes('resolve'))) {
      return 'уже есть незавершённый прогноз — завершите (resolve) его в панели Твича';
    }
    if (m.includes('missing scope') || m.includes('scope')) {
      return 'у токена не хватает прав — нужна повторная авторизация, см. README.md';
    }
    if (e.status === 401 || e.status === 403) {
      return 'у токена нет прав (проверьте авторизацию и статус модератора бота)';
    }
    return `Twitch ответил: ${e.message}`;
  }
  return 'внутренняя ошибка, подробности в логах бота';
}

export const KNOWN = [
  '!poll',
  '!endpoll',
  '!pred',
  '!+pred',
  '!-pred',
  '!predwin',
  '!predstop',
  '!predcancel',
  '!g',
  '!+g',
  '!-g',
  '!шаблоны',
  '!скок',
  '!трек',
  '!пинг',
];

export function createCommandHandler({
  config,
  chat,
  helix,
  templates,
  gameTemplates,
  yandexMusic,
  funCommands,
  commandSettings = new CommandSettings(),
  ids,
  now = () => Date.now(),
}) {
  const reply = (msg, text) => chat.say(`@${msg.displayName} ${text}`);
  // Настоящий reply на сообщение; если id вдруг нет — обычное упоминание
  const replyTo = (msg, text) =>
    msg.id ? chat.say(String(text), { replyTo: msg.id }) : reply(msg, String(text));
  const fail = (msg, reason, usage) => reply(msg, `ошибка выполнения команды. ${reason}. ${usage}`);
  let trackCooldownUntil = 0;
  let trackRequestInFlight = false;

  async function announce(message, color) {
    try {
      await helix.sendAnnouncement({
        broadcasterId: ids.broadcasterId,
        moderatorId: ids.botUserId,
        message,
        color,
      });
    } catch (e) {
      // чаще всего 403: бот ещё не модератор — шлём обычным сообщением
      console.error(`[announce] не получилось (${e.status ?? ''} ${e.message}), отправляю обычным сообщением`);
      chat.say(message);
    }
  }

  async function cmdPoll(msg, args) {
    const p = parseCreateArgs(args, {
      maxTitle: 60,
      maxChoices: 5,
      minSec: 15,
      maxSec: 1800,
      defaultSec: config.pollDefaultSeconds,
    });
    if (p.error) return fail(msg, p.error, USAGE.poll);
    await helix.createPoll({
      broadcasterId: ids.broadcasterId,
      title: p.title,
      choices: p.choices,
      duration: p.duration,
    });
    console.log(`[cmd] ${msg.login} создал опрос «${p.title}» (${p.choices.join('/')}, ${p.duration}с)`);
    await announce('Опрос начат!', 'purple');
  }

  async function cmdEndPoll(msg) {
    const active = await helix.getActivePoll(ids.broadcasterId);
    if (!active) return reply(msg, 'сейчас нет активного опроса.');
    await helix.endPoll(ids.broadcasterId, active.id);
    console.log(`[cmd] ${msg.login} завершил опрос «${active.title}»`);
    // по ТЗ — без announce и лишних сообщений
  }

  async function startPrediction(title, outcomes, windowSeconds, login) {
    await helix.createPrediction({
      broadcasterId: ids.broadcasterId,
      title,
      outcomes,
      windowSeconds,
    });
    console.log(`[cmd] ${login} запустил прогноз «${title}» (${outcomes.join('/')}, ${windowSeconds}с)`);
    await announce('Alarm Ставка в чате! Alarm', 'blue');
  }

  async function cmdPred(msg, args) {
    if (args.length === 0) return fail(msg, 'Не указано название', USAGE.pred);
    const hasSlash = args.some((t) => t.includes('/'));
    if (!hasSlash) {
      // запуск по шаблону
      const name = args.join(' ');
      const tpl = templates.get(name);
      if (!tpl) return fail(msg, `Шаблон «${name}» не найден`, USAGE.pred);
      return startPrediction(tpl.title, tpl.outcomes, tpl.window, msg.login);
    }
    const p = parseCreateArgs(args, {
      maxTitle: 45,
      maxChoices: 10,
      minSec: 30,
      maxSec: 1800,
      defaultSec: config.predDefaultSeconds,
    });
    if (p.error) return fail(msg, p.error, USAGE.pred);
    await startPrediction(p.title, p.choices, p.duration, msg.login);
  }

  async function cmdAddPred(msg, args) {
    // первый токен — имя шаблона (одно слово, как в !+g), дальше сам прогноз
    if (args.length === 0) return fail(msg, 'Не указано название шаблона', USAGE.addPred);
    const name = args[0];
    if (name.includes('/')) return fail(msg, 'Не указано название шаблона', USAGE.addPred);
    const p = parseCreateArgs(args.slice(1), {
      maxTitle: 45,
      maxChoices: 10,
      minSec: 30,
      maxSec: 1800,
      defaultSec: config.predDefaultSeconds,
    });
    if (p.error) {
      const reason = p.error === 'Не указано название' ? 'Не указано название прогноза' : p.error;
      return fail(msg, reason, USAGE.addPred);
    }
    const existed = !!templates.get(name);
    templates.set(name, { name, title: p.title, outcomes: p.choices, window: p.duration });
    reply(
      msg,
      existed
        ? `шаблон «${name}» обновлён.`
        : `шаблон «${name}» сохранён. Запуск: !pred ${name}`,
    );
  }

  async function cmdDelPred(msg, args) {
    if (args.length === 0) return fail(msg, 'Не указано название шаблона', USAGE.delPred);
    const name = args.join(' ');
    if (!templates.get(name)) return fail(msg, `Шаблон «${name}» не найден`, USAGE.delPred);
    templates.delete(name);
    reply(msg, `шаблон «${name}» удалён.`);
  }

  async function cmdPredWin(msg, args) {
    if (args.length === 0) return fail(msg, 'Не указан победивший исход', USAGE.predwin);
    const pred = await helix.getCurrentPrediction(ids.broadcasterId);
    if (!pred) return reply(msg, 'сейчас нет незавершённого прогноза.');
    const m = matchOutcome(pred.outcomes, args.join(' '));
    if (m.error) {
      const list = pred.outcomes.map((o, i) => `${i + 1}) ${o.title}`).join('  ');
      return reply(msg, `${m.error}. Варианты: ${list}`);
    }
    await helix.endPrediction(ids.broadcasterId, pred.id, 'RESOLVED', m.outcome.id);
    console.log(`[cmd] ${msg.login} закрыл прогноз «${pred.title}» исходом «${m.outcome.title}»`);
    reply(msg, `прогноз «${pred.title}» закрыт, победил исход «${m.outcome.title}».`);
  }

  async function cmdPredStop(msg) {
    const pred = await helix.getCurrentPrediction(ids.broadcasterId);
    if (!pred) return reply(msg, 'сейчас нет незавершённого прогноза.');
    if (pred.status === 'LOCKED') {
      return reply(msg, `приём ставок по прогнозу «${pred.title}» уже закрыт. Завершить: !predwin <исход>`);
    }
    await helix.endPrediction(ids.broadcasterId, pred.id, 'LOCKED');
    console.log(`[cmd] ${msg.login} закрыл приём ставок по прогнозу «${pred.title}»`);
    reply(msg, `приём ставок по прогнозу «${pred.title}» закрыт. Завершить: !predwin <исход или номер>`);
  }

  async function cmdPredCancel(msg) {
    const pred = await helix.getCurrentPrediction(ids.broadcasterId);
    if (!pred) return reply(msg, 'сейчас нет незавершённого прогноза.');
    await helix.endPrediction(ids.broadcasterId, pred.id, 'CANCELED');
    console.log(`[cmd] ${msg.login} отменил прогноз «${pred.title}»`);
    reply(msg, `прогноз «${pred.title}» отменён, баллы возвращены.`);
  }

  async function cmdGame(msg, args) {
    if (args.length === 0) return fail(msg, 'Не указана категория', USAGE.game);
    const query = args.join(' ');
    const tpl = gameTemplates.get(query);

    let gameId = tpl?.gameId ?? null;
    let name = tpl?.category ?? query;
    if (!gameId) {
      const found = await helix.searchCategories(name);
      const match = matchCategory(found, name);
      if (!match) return fail(msg, `Категория «${name}» не найдена на Твиче`, USAGE.game);
      gameId = match.id;
      name = match.name;
    }

    await helix.modifyChannel({ broadcasterId: ids.broadcasterId, gameId });
    console.log(`[cmd] ${msg.login} сменил категорию на «${name}» (id ${gameId})`);
    reply(msg, `категория изменена на «${name}».`);
  }

  async function cmdAddGame(msg, args) {
    if (args.length < 2) {
      return fail(msg, 'Нужно название шаблона и полное название категории', USAGE.addGame);
    }
    const short = args[0];
    const category = args.slice(1).join(' ');
    const found = await helix.searchCategories(category);
    const match = matchCategory(found, category);
    if (!match) return fail(msg, `Категория «${category}» не найдена на Твиче`, USAGE.addGame);

    const existed = !!gameTemplates.get(short);
    gameTemplates.set(short, { title: short, category: match.name, gameId: match.id });
    reply(
      msg,
      existed
        ? `шаблон «${short}» обновлён: ${match.name}`
        : `шаблон «${short}» сохранён: ${match.name}. Запуск: !g ${short}`,
    );
  }

  async function cmdDelGame(msg, args) {
    if (args.length === 0) return fail(msg, 'Не указано название шаблона', USAGE.delGame);
    const name = args.join(' ');
    if (!gameTemplates.get(name)) return fail(msg, `Шаблон «${name}» не найден`, USAGE.delGame);
    gameTemplates.delete(name);
    reply(msg, `шаблон категории «${name}» удалён.`);
  }

  function cmdTemplates() {
    const preds = templates.list();
    const games = gameTemplates.list();
    if (preds.length === 0 && games.length === 0) {
      return chat.say(
        'Шаблонов пока нет. Прогноз: !+pred <Шаблон> <Название прогноза> <Исходы> [срок] • Категория: !+g <Кратко> <Полное название>',
      );
    }
    if (preds.length) {
      chat.say(
        'Шаблоны прогнозов: ' +
          preds
            .map((t) => {
              const name = t.name ?? t.title; // у старых шаблонов имени нет — оно же и название
              const head = name === t.title ? name : `${name} → «${t.title}»`;
              return `${head} (${t.outcomes.join('/')}, ${t.window}с)`;
            })
            .join(' • '),
      );
    }
    if (games.length) {
      chat.say('Шаблоны категорий: ' + games.map((t) => `${t.title} → ${t.category}`).join(' • '));
    }
  }

  function cmdCalc(msg, args) {
    if (args.length === 0) {
      return replyTo(msg, `ошибка выполнения команды. Пустое выражение. ${USAGE.calc}`);
    }
    const r = calcExpression(args.join(' '));
    if (r.error) return replyTo(msg, `ошибка: ${r.error}. ${USAGE.calc}`);
    replyTo(msg, r.value);
  }

  async function cmdTrack(msg) {
    const currentTime = now();
    if (trackRequestInFlight || currentTime < trackCooldownUntil) return;

    trackCooldownUntil = currentTime + (config.trackCooldownMs ?? 5000);
    trackRequestInFlight = true;
    try {
      const result = await yandexMusic.getCurrentTrack();
      if (result.status === 'playing') {
        replyTo(msg, `Сейчас играет: ${result.artist} - ${result.title}`);
        console.log(`[track] ${msg.login}: ${result.artist} - ${result.title}`);
      } else {
        replyTo(msg, 'Сейчас музыка не воспроизводится.');
        console.log(`[track] ${msg.login}: воспроизведение не найдено`);
      }
    } catch (error) {
      console.error(`[track] запрос от ${msg.login}:`, error);
      replyTo(msg, 'Не удалось определить текущий трек.');
    } finally {
      trackRequestInFlight = false;
    }
  }

  return async function onChat(msg) {
    const text = normalizeCommandText(msg.text);
    if (msg.login === ids.botLogin) return;
    const tokens = text.split(/\s+/);
    const cmd = tokens[0].toLowerCase();
    const args = tokens.slice(1);
    // Панель задаёт запреты для всех ролей, в том числе для команд управления.
    if (config.disabledCommands?.has(cmd)) return;
    // !вкл без аргументов по-прежнему управляет режимом игр.
    if (cmd === '!откл' || (cmd === '!вкл' && args.length > 0)) {
      if (!hasCommandAccess(config, msg)) return;
      const usage = `Шаблон команды ${cmd} <команда>`;
      if (args.length !== 1) return fail(msg, args.length ? 'Укажите только одну команду' : 'Не указана команда', usage);
      const target = (args[0].startsWith('!') ? args[0] : `!${args[0]}`).toLowerCase();
      if (target === '!откл' || target === '!вкл') return fail(msg, 'Управление отключением команд нельзя отключить', usage);
      if (config.disabledCommands?.has(target)) return fail(msg, 'Команда отключена в настройках .env; включите её в панели настройки', usage);
      if (!KNOWN.includes(target) && !FUN_COMMANDS.includes(target)) return fail(msg, `Неизвестная команда «${target}»`, usage);
      if (target === '!трек' && !trackEnabled(config.channel, config)) return fail(msg, 'Команда !трек недоступна в этом канале', usage);
      try {
        commandSettings.setDisabled(target, cmd === '!откл');
        funCommands?.refreshCommandPolicy?.();
        reply(msg, `команда ${target} ${cmd === '!откл' ? 'отключена' : 'включена'} в этом канале.`);
      } catch (error) {
        console.error('[commands] не удалось сохранить настройки:', error);
        fail(msg, 'Не удалось сохранить настройки', usage);
      }
      return;
    }
    if (cmd === '!трек' && !trackEnabled(config.channel, config)) return;
    if (commandSettings.isDisabled(cmd)) return;
    // Игровому модулю нужны и обычные сообщения: активные участники и ответы в дуэли.
    if (funCommands && await funCommands(msg)) return;
    if (!text.startsWith('!')) return;

    if (!KNOWN.includes(cmd)) return; // на незнакомые команды не реагируем

    // только владелец канала и вайтлист модераторов
    const allowed = hasCommandAccess(config, msg);
    // !трек доступен всем зрителям; !скок — модераторам по бейджу, VIP и подписчикам
    if (cmd === '!трек') {
      // публичная команда
    } else if (cmd === '!скок') {
      if (!allowed && !msg.isMod && !msg.isVip && !msg.isSub) return;
    } else if (!allowed) {
      return;
    }

    try {
      switch (cmd) {
        case '!пинг':
          chat.say('ПОНГ');
          break;
        case '!poll':
          await cmdPoll(msg, args);
          break;
        case '!endpoll':
          await cmdEndPoll(msg);
          break;
        case '!pred':
          await cmdPred(msg, args);
          break;
        case '!+pred':
          await cmdAddPred(msg, args);
          break;
        case '!-pred':
          await cmdDelPred(msg, args);
          break;
        case '!predwin':
          await cmdPredWin(msg, args);
          break;
        case '!predstop':
          await cmdPredStop(msg);
          break;
        case '!predcancel':
          await cmdPredCancel(msg);
          break;
        case '!g':
          await cmdGame(msg, args);
          break;
        case '!+g':
          await cmdAddGame(msg, args);
          break;
        case '!-g':
          await cmdDelGame(msg, args);
          break;
        case '!шаблоны':
          cmdTemplates();
          break;
        case '!скок':
          cmdCalc(msg, args);
          break;
        case '!трек':
          await cmdTrack(msg);
          break;
      }
    } catch (e) {
      console.error(`[cmd] ${cmd} от ${msg.login}:`, e);
      reply(msg, `не получилось: ${ruHelixError(e)}`);
    }
  };
}
