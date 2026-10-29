import { FunSettings } from '../src/funSettings.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FunStore, newPlayer } from '../src/funStore.js';
import { createFunCommandHandler, FUN_COMMANDS, FUN_USAGE } from '../src/funCommands.js';
import { createCommandHandler } from '../src/commands.js';
import { TwitchChat } from '../src/irc.js';
import { TAROT_BLOCKED } from '../src/tarotPolicy.js';
import { CommandSettings } from '../src/commandSettings.js';

function setup(t, { channel = 'cacto0o', gamesEnabled = true, random = () => 0.5, tarot, helix } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcfl-fun-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, `${channel}.json`);
  const store = new FunStore(file);
  const sent = [];
  let clock = 1_000_000;
  const timers = new Set();
  const config = { channel, mods: new Set(['mod', 'other']), music: { enabled: true }, fun: { enabled: gamesEnabled, defaultMode: 'on', commandsUrl: 'https://example.com/commands' } };
  const chat = { say: (text) => sent.push(text) };
  const ids = { botLogin: 'peeacefullbot' };
  const handler = createFunCommandHandler({
    config, chat, ids, store, random, tarot, helix, now: () => clock,
    schedule: (fn, delay) => { const timer = { fn, at: clock + delay }; timers.add(timer); return timer; },
    cancel: (timer) => timers.delete(timer),
  });
  t.after(handler.close);
  const message = (text, login = 'mod', extra = {}) => ({ text, login, displayName: login, channel, ...extra });
  return {
    handler, store, file, sent, config, chat, ids, message,
    send: (text, login, extra) => handler(message(text, login, extra)),
    seed(name, balance) { store.transact((data) => { data.players[name] = { ...newPlayer(), balance }; }); },
    advance(ms) {
      clock += ms;
      for (const timer of [...timers]) if (timer.at <= clock) { timers.delete(timer); timer.fn(); }
    },
  };
}

test('запрещённая тема расклада упоминает автора без шаблона ошибки', async (t) => {
  const s = setup(t, { tarot: async () => TAROT_BLOCKED });
  await s.send('!расклад вопрос');
  assert.deepEqual(s.sent, [`@mod ${TAROT_BLOCKED}`]);
});

test('ссылка на команды повторяется через 30 минут после !вкл и останавливается', async (t) => {
  const s = setup(t);
  const link = 'Ссылка на все игровые команды: https://example.com/commands';
  const count = () => s.sent.filter((text) => text === link).length;
  s.advance(30 * 60_000);
  assert.equal(count(), 0);
  await s.send('!вкл', 'viewer');
  s.advance(30 * 60_000);
  assert.equal(count(), 0);
  for (const stop of ['!выкл', '!выклвип']) {
    await s.send('!вкл');
    const before = count();
    s.advance(15 * 60_000);
    await s.send('!вкл');
    s.advance(15 * 60_000 - 1);
    assert.equal(count(), before);
    s.advance(1);
    assert.equal(count(), before + 1);
    s.advance(30 * 60_000);
    assert.equal(count(), before + 2);
    await s.send(stop);
    s.advance(30 * 60_000);
    assert.equal(count(), before + 2);
  }
  await s.send('!вкл');
  s.handler.close();
  const beforeClose = count();
  s.advance(30 * 60_000);
  assert.equal(count(), beforeClose);
});

test('ссылка на команды не запускается в канале с выключенными играми', async (t) => {
  const s = setup(t, { channel: 'tiltocacto0o', gamesEnabled: false });
  await s.send('!вкл');
  s.advance(30 * 60_000);
  assert.deepEqual(s.sent, []);
});

test('сохранены все 38 игровых команд', () => {
  const names = 'кд вкл выкл выклвип добавить удалить дуэль принять кредит бал балтоп каз кража додеп сбп рулетка стат пиво литры топпиво жрать вес вестоп топвес пивостатус пиворулетка кальян тяги топтяги инфо шип совместимость iq я кликуха шар расклад поцеловать';
  assert.deepEqual([...FUN_COMMANDS].sort(), names.split(' ').map((name) => `!${name}`).sort());
});

test('в выключенном режиме доступны только владелец и MODS', async (t) => {
  for (const channel of ['cacto0o', 'ryler234']) {
    const s = setup(t, { channel });
    await s.send('!выкл');
    s.sent.length = 0;
    for (const login of ['viewer', 'aksenr', 'dubstepcatt1']) {
      for (const cmd of FUN_COMMANDS.filter((cmd) => cmd !== '!рулетка')) await s.send(cmd, login, { isMod: true, isVip: true, isSub: true });
    }
    await s.send('!кредит', 'peeacefullbot');
    await s.send('!кредит', 'mod', { channel: 'unknown' });
    await s.send('!кредти');
    assert.equal(s.sent.length, 0);
    assert.equal(fs.existsSync(s.file), false);
    await s.send('!кредит', channel);
    await s.send('!КРЕДИТ', 'mod');
    assert.equal(s.store.player(channel).balance, 20);
    assert.equal(s.store.player('mod').balance, 20);
  }
});

test('tiltocacto0o: все игры молчат для всех ролей, данные и API не затрагиваются', async (t) => {
  let requests = 0;
  const s = setup(t, {
    channel: 'tiltocacto0o', gamesEnabled: false, random: () => 0,
    tarot: async () => { requests++; return 'answer'; },
    helix: { timeoutUser: async () => { requests++; } },
  });
  s.seed('mod', 100);
  const before = fs.readFileSync(s.file, 'utf8');
  for (const login of ['tiltocacto0o', 'mod', 'viewer']) {
    for (const cmd of FUN_COMMANDS.filter((name) => name !== '!кд')) {
      await s.send(cmd, login, { isMod: true, isVip: true, isSub: true, userId: 'id' });
    }
    await s.send('!расклад вопрос', login);
    await s.send('!вкл', login);
    await s.send('!кредит', login);
  }
  s.advance(60_000);
  assert.deepEqual(s.sent, []);
  assert.equal(requests, 0);
  assert.equal(fs.readFileSync(s.file, 'utf8'), before);
});

test('основные команды работают без игрового хранилища при отключённых играх', async (t) => {
  const s = setup(t, { channel: 'tiltocacto0o', gamesEnabled: false });
  const funCommands = createFunCommandHandler({ config: s.config, chat: s.chat, ids: s.ids });
  t.after(funCommands.close);
  const handler = createCommandHandler({ config: s.config, chat: s.chat, ids: s.ids, funCommands });
  await handler(s.message('!кд 10'));
  await handler(s.message('!рулетка'));
  await handler(s.message('!скок 2+2'));
  assert.equal(s.sent.at(-1), '@mod 4');
  const before = s.sent.length;
  await handler(s.message('!скок 3+3'));
  assert.equal(s.sent.length, before + 1);
  await handler(s.message('!кд 0'));
  await handler(s.message('!скок 3+3'));
  assert.equal(s.sent.at(-1), '@mod 6');
  await handler(s.message('!команды'));
  assert.ok(!s.sent.some((line) => line.includes('Игры:')));
});

test('повторные IRC-команды с невидимым хвостом работают, реальные аргументы отклоняются', async (t) => {
  const s = setup(t);
  const handler = createCommandHandler({ config: s.config, chat: s.chat, ids: s.ids, funCommands: s.handler });
  const chat = new TwitchChat({ channel: 'cacto0o', tokenStore: {} });
  let pending;
  chat.on('chat', (msg) => { pending = handler(msg); });
  for (const cmd of ['!кликуха', '!рулетка', '!скок 2+2']) {
    for (const suffix of ['', ' ', '\u200b', ' \u200b', ' \u2063', ' \u034f', ' \u2060', ' \u2800', ' \u200b \u2063']) {
      const before = s.sent.length;
      chat.handleLine(`@display-name=mod;mod=1 :mod!user@host PRIVMSG #cacto0o :${cmd}${suffix}`);
      await pending;
      assert.equal(s.sent.length, before + 1);
      assert.doesNotMatch(s.sent.at(-1), /ошибка|не получилось/);
    }
  }
  const beforeInvalid = s.sent.length;
  await s.send('!кликуха лишнее \u2063');
  assert.equal(s.sent.length, beforeInvalid);
  await s.send('!кд 10 \u2063');
  await s.send('!рулетка');
  const before = s.sent.length;
  await s.send('!рулетка \u2063');
  assert.equal(s.sent.length, before);
});

test('!инфо отвечает настоящим IRC reply на исходное сообщение', async (t) => {
  const s = setup(t);
  const chat = new TwitchChat({ channel: 'cacto0o', tokenStore: {} });
  const sent = [];
  chat.ws = { readyState: WebSocket.OPEN, send: (line) => sent.push(line) };
  const handler = createFunCommandHandler({ config: s.config, chat, ids: s.ids, store: s.store });
  t.after(handler.close);
  let pending;
  chat.on('chat', (msg) => { pending = handler(msg); });
  chat.handleLine('@id=info-message-123;display-name=mod;mod=1 :mod!user@host PRIVMSG #cacto0o :!инфо');
  await pending;
  assert.deepEqual(sent, ['@reply-parent-msg-id=info-message-123 PRIVMSG #cacto0o :Ссылка на все игровые команды: https://example.com/commands']);
});

test('удалённая !команды молчит в обоих каналах и не запускает общий КД', async (t) => {
  for (const channel of ['cacto0o', 'tiltocacto0o']) {
    const s = setup(t, { channel });
    await s.send('!выкл');
    s.sent.length = 0;
    const handler = createCommandHandler({ config: s.config, chat: s.chat, ids: s.ids, funCommands: s.handler });
    await handler(s.message('!кд 10'));
    s.sent.length = 0;
    for (const login of [channel, 'mod', 'viewer']) await handler(s.message('!команды', login));
    assert.deepEqual(s.sent, []);
    await handler(s.message('!скок 2+2'));
    assert.deepEqual(s.sent, ['@mod 4']);
  }
});

test('режимы открывают игры всем, администрации или временным VIP', async (t) => {
  const s = setup(t);
  await s.send('!добавить @Viewer');
  for (const mode of ['!вкл', '!выкл', '!выклвип']) {
    await s.send(mode);
    const count = s.sent.length;
    await s.send('!бал', 'viewer');
    assert.equal(s.sent.length, count + (mode === '!выкл' ? 0 : 1));
    const before = s.sent.length;
    await s.send('!кликуха', 'stranger');
    assert.equal(s.sent.length, before + (mode === '!вкл' ? 1 : 0));
    const adminBefore = s.sent.length;
    await s.send('!бал');
    assert.equal(s.sent.length, adminBefore + 1);
  }
  await s.send('!удалить viewer');
  assert.match(s.sent.at(-1), /удалён/);
  const before = s.sent.length;
  await s.send('!бал', 'viewer');
  assert.equal(s.sent.length, before);
  await s.send('!удалить viewer');
  assert.match(s.sent.at(-1), /не найден/);
});

test('публичные игры через основной обработчик не открывают административные команды', async (t) => {
  const s = setup(t);
  const handler = createCommandHandler({ config: s.config, chat: s.chat, ids: s.ids, funCommands: s.handler });
  await s.send('!вкл');
  s.sent.length = 0;
  for (const text of ['!выкл', '!вкл', '!выклвип', '!кд 10', '!добавить viewer', '!удалить viewer', '!poll test a/b 60']) {
    await handler(s.message(text, 'viewer'));
  }
  assert.deepEqual(s.sent, []);
  await handler(s.message('!кликуха', 'viewer'));
  assert.match(s.sent.at(-1), /^viewer ты /);
  await s.send('!выкл');
  const before = s.sent.length;
  await handler(s.message('!кликуха', 'viewer'));
  assert.equal(s.sent.length, before);
  await handler(s.message('!рулетка', 'viewer'));
  assert.equal(s.sent.length, before);
});

test('зрители могут вызвать, принять и выиграть дуэль при !вкл', async (t) => {
  const s = setup(t);
  s.seed('viewer', 100);
  s.seed('stranger', 100);
  await s.send('!вкл');
  await s.send('!дуэль stranger 50', 'viewer');
  await s.send('!принять', 'stranger');
  const word = s.sent.at(-1).match(/'([^']+)'/)[1];
  await s.send(word, 'viewer');
  assert.equal(s.store.player('viewer').balance, 150);
  assert.equal(s.store.player('stranger').balance, 50);
});

test('неправильный ввод игровых команд молча игнорируется без изменения данных', async (t) => {
  const s = setup(t);
  const before = JSON.stringify(s.store.data);
  for (const input of ['!дуэль', '!каз', '!кража', '!сбп', '!совместимость', '!я', '!шар', '!расклад', '!поцеловать', '!каз -1', '!каз 1.5', '!каз NaN', '!каз 9007199254740993', '!сбп @other 0', '!поцеловать @@@', '!бал лишнее', '!дуэль other 49', '!казз']) {
    await s.send(input);
    assert.equal(s.sent.length, 0, input);
    assert.equal(JSON.stringify(s.store.data), before, input);
  }
  await s.send('!бал');
  assert.match(s.sent.at(-1), /ваш баланс/);
});

test('ошибки аргументов административных команд сохраняют шаблон', async (t) => {
  const s = setup(t);
  for (const cmd of ['!кд', '!добавить', '!удалить']) {
    await s.send(cmd);
    assert.match(s.sent.at(-1), /^@mod ошибка выполнения команды\./);
    assert.ok(s.sent.at(-1).endsWith(`Шаблон команды ${cmd} ${FUN_USAGE[cmd]}`), s.sent.at(-1));
  }
  for (const input of ['!кд -1', '!добавить @@@']) {
    await s.send(input);
    assert.match(s.sent.at(-1), /ошибка выполнения команды/);
  }
  assert.equal(s.store.player('mod').balance, 0);
});

test('кредит, перевод, кража, казино и додеп сохраняют правильные балансы и КД', async (t) => {
  const s = setup(t, { random: () => 0 });
  await Promise.all([s.send('!кредит'), s.send('!кредит')]);
  assert.equal(s.store.player('mod').balance, 10);
  s.seed('other', 100);
  await s.send('!кража other 31');
  assert.match(s.sent.at(-1), /30%/);
  await s.send('!кража other 30');
  assert.equal(s.store.player('mod').balance, 40);
  assert.equal(s.store.player('other').balance, 70);
  await s.send('!сбп other 10');
  await s.send('!каз 10'); // Jackpot: +20.
  await s.send('!додеп'); // -10.
  assert.equal(s.store.player('mod').balance, 40);
  assert.equal(s.store.player('other').balance, 80);
  const reload = new FunStore(s.file);
  assert.deepEqual(reload.data, s.store.data);
  await s.send('!каз 10');
  assert.equal(s.sent.at(-1), '@mod Подождите 20 минут');
  s.advance(1_200_000);
  await s.send('!кредит');
  assert.equal(s.store.player('mod').balance, 50);
});

test('обычное пиво, кальян, рулетка и КД переживают перезапуск', async (t) => {
  const s = setup(t);
  await s.send('!пиво');
  await s.send('!кальян');
  await s.send('!рулетка');
  const reload = new FunStore(s.file);
  assert.equal(reload.player('mod').liters, 50);
  assert.equal(reload.player('mod').hits, 1);
  assert.equal(reload.player('mod').survivals, 1);
  await s.send('!пиво');
  assert.equal(s.sent.at(-1), '@mod Подождите 3 минуты');
  s.advance(180_000);
  await s.send('!пиво');
  assert.equal(s.store.player('mod').liters, 100);
});

test('вес и КД еды сохраняются, пиво независимо, старые данные совместимы', async (t) => {
  const s = setup(t);
  await s.send('!вес');
  assert.match(s.sent.at(-1), /вес: 0 кг/);
  await s.send('!жрать');
  await s.send('!пиво');
  const reload = new FunStore(s.file);
  assert.equal(reload.player('mod').weight, 50);
  assert.equal(reload.player('mod').liters, 50);
  assert.equal(reload.player('mod').cooldowns['!жрать'], 1_180_000);
  await s.send('!жрать');
  assert.equal(s.sent.at(-1), '@mod Подождите 3 минуты');
  s.advance(180_000);
  await s.send('!жрать');
  assert.equal(s.store.player('mod').weight, 100);
  const legacy = JSON.parse(fs.readFileSync(s.file, 'utf8'));
  delete legacy.players.mod.weight;
  fs.writeFileSync(s.file, JSON.stringify(legacy));
  const migrated = new FunStore(s.file);
  assert.equal(migrated.player('mod').weight, 0);
  assert.equal(migrated.player('mod').liters, 50);
  assert.throws(() => migrated.transact((data) => { data.players.mod.weight = -1; }));
});

test('еда повторяет события и потери пива, вес не уходит ниже нуля', async (t) => {
  for (const [rolls, expected] of [[[0, 0], 50], [[0, 0.5], 0], [[0, 0.99], 150], [[0.5, 0.5, 0], 40], [[0.5, 0], 0]]) {
    const values = [...rolls];
    const s = setup(t, { random: () => values.shift() });
    await s.send('!жрать');
    assert.equal(s.store.player('mod').weight, expected);
    assert.doesNotMatch(s.sent.at(-1), /undefined|ошибка/);
  }
});

test('оба рейтинга веса выводят только пять лидеров, исключая нулевой вес', async (t) => {
  const s = setup(t);
  await s.send('!топвес');
  assert.match(s.sent.at(-1), /пока пуста/);
  s.store.transact((data) => {
    data.players.zero = newPlayer();
    for (let i = 1; i <= 30; i++) data.players[`viewer_${i}`] = { ...newPlayer(), weight: i };
  });
  s.sent.length = 0;
  await s.send('!вестоп');
  const first = [...s.sent];
  assert.equal(first.length, 1);
  assert.match(first[0], /Топ-5 по весу/);
  assert.match(first[0], /1\. viewer_30 — 30 кг/);
  assert.match(first[0], /5\. viewer_26 — 26 кг/);
  assert.doesNotMatch(first.join(' '), /zero/);
  assert.equal((first.join(' ').match(/viewer_\d+ —/g) || []).length, 5);
  for (const line of first) assert.ok(Buffer.byteLength(line, 'utf8') <= 400);
  s.sent.length = 0;
  await s.send('!топвес');
  assert.deepEqual(s.sent, first);
});

test('особое пивное событие и пиворулетка не делают литры отрицательными', async (t) => {
  const s = setup(t, { random: () => 0 });
  await s.send('!пиворулетка');
  assert.equal(s.store.player('mod').liters, 0);
  await s.send('!пиво');
  assert.equal(s.store.player('mod').liters, 50);
});

test('все команды статистики и развлечения отвечают, !инфо отправляет ссылку', async (t) => {
  const s = setup(t);
  await s.send('привет', 'viewer');
  await s.send('!кредит');
  for (const command of ['!бал', '!балтоп', '!стат', '!литры', '!топпиво', '!пивостатус', '!тяги', '!топтяги', '!шип', '!шип кто-то', '!совместимость @other', '!iq', '!я крутой', '!кликуха', '!шар да?', '!поцеловать @other']) {
    const before = s.sent.length;
    await s.send(command);
    assert.equal(s.sent.length, before + 1, command);
    assert.doesNotMatch(s.sent.at(-1), /undefined|\{ctx|ошибка/);
  }
  s.sent.length = 0;
  await s.send('!инфо');
  assert.deepEqual(s.sent, ['Ссылка на все игровые команды: https://example.com/commands']);
  for (const line of s.sent) assert.ok(Buffer.byteLength(line) <= 400);
});

test('!шип исключает настроенный логин бота из обоих вариантов выбора', async (t) => {
  const s = setup(t, { random: () => 0 });
  s.ids.botLogin = 'CustomBot';
  await s.send('привет', 'CUSTOMBOT');
  await s.send('привет', 'CustomBot');
  await s.send('!шип');
  assert.match(s.sent.at(-1), /два активных/);
  await s.send('!шип пицца');
  assert.match(s.sent.at(-1), /Нет других активных/);
  await s.send('привет', 'viewer');
  await s.send('!шип');
  assert.doesNotMatch(s.sent.at(-1), /peeacefullbot|custombot|ошибка/i);
  assert.match(s.sent.at(-1), /mod/);
  assert.match(s.sent.at(-1), /viewer/);
  await s.send('!шип пицца');
  assert.doesNotMatch(s.sent.at(-1), /peeacefullbot|custombot|ошибка/i);
  assert.match(s.sent.at(-1), /пицца/);
  assert.match(s.sent.at(-1), /viewer/);
});

test('!совместимость принимает ник, слово и предложение; пустой ввод игнорируется', async (t) => {
  const s = setup(t);
  for (const [input, expected] of [
    ['@Other', 'other'], ['пицца', 'пицца'],
    ['Пицца с ананасами!', 'Пицца с ананасами!'],
    ['Люблю спать 😴', 'Люблю спать 😴'],
  ]) {
    await s.send(`!совместимость ${input}`);
    assert.ok(s.sent.at(-1).includes(`Совместимость между mod и ${expected}: 50%.`));
  }
  const before = s.sent.length;
  await s.send('!совместимость');
  assert.equal(s.sent.length, before);
});

test('!кд ограничивает также экономику; активность истекает через 10 минут', async (t) => {
  const s = setup(t);
  await s.send('!кд 10');
  await s.send('!iq');
  const before = s.sent.length;
  await s.send('!шар да?');
  assert.equal(s.sent.length, before);
  await s.send('!кредит');
  assert.equal(s.sent.length, before);
  assert.equal(s.store.player('mod').balance, 0);
  s.advance(10_000);
  await s.send('!шар да?');
  assert.equal(s.sent.length, before + 1);
  await s.send('!кд 1');
  s.advance(1000);
  const afterChange = s.sent.length;
  await s.send('!iq');
  assert.equal(s.sent.length, afterChange + 1);
  await s.send('привет', 'viewer');
  s.advance(600_000);
  await s.send('!шип');
  assert.match(s.sent.at(-1), /два активных/);
});

test('!кд 2 ограничивает всех игроков, но не основные и административные команды', async (t) => {
  const s = setup(t);
  const handler = createCommandHandler({ config: s.config, chat: s.chat, ids: s.ids, funCommands: s.handler });
  await handler(s.message('!кд 2'));
  await handler(s.message('!скок 2+2'));
  await handler(s.message('!бал', 'viewer'));
  const before = s.sent.length;
  s.advance(500);
  await handler(s.message('!iq', 'other'));
  await handler(s.message('!кредит', 'cacto0o'));
  assert.equal(s.sent.length, before);
  assert.equal(s.store.player('cacto0o').balance, 0);
  await handler(s.message('!скок 3+3'));
  assert.equal(s.sent.at(-1), '@mod 6');
  await handler(s.message('!poll'));
  assert.match(s.sent.at(-1), /Шаблон команды !poll/);
  await handler(s.message('!вкл'));
  assert.match(s.sent.at(-1), /Режим игр/);
  s.advance(1499);
  const blocked = s.sent.length;
  await handler(s.message('!бал', 'third'));
  assert.equal(s.sent.length, blocked);
  s.advance(1);
  await handler(s.message('!бал', 'third'));
  assert.equal(s.sent.length, blocked + 1);
  await handler(s.message('!кд 0'));
  await handler(s.message('!бал', 'viewer'));
  await handler(s.message('!бал', 'other'));
  assert.equal(s.sent.length, blocked + 4);
});

test('общий КД подавляет ошибки и параллельные команды, не отменяет отдельные кулдауны', async (t) => {
  const s = setup(t);
  await s.send('!кд 10');
  await Promise.all([s.send('!кредит'), s.send('!бал', 'other')]);
  assert.equal(s.sent.length, 2);
  s.advance(10_000);
  await s.send('!кредит');
  assert.match(s.sent.at(-1), /Подождите/);
  const before = s.sent.length;
  await s.send('!каз');
  assert.equal(s.sent.length, before);
  await s.send('!кд 0');
  await s.send('!кредит');
  assert.match(s.sent.at(-1), /Подождите/);
});

test('дуэль резервирует обе ставки; только участник выигрывает один раз', async (t) => {
  const s = setup(t);
  s.seed('mod', 100); s.seed('other', 100);
  await s.send('!дуэль other 50');
  await s.send('!принять', 'other');
  assert.equal(s.store.player('mod').balance, 50);
  assert.equal(s.store.player('other').balance, 50);
  await s.send('!сбп other 51');
  assert.match(s.sent.at(-1), /Недостаточно монет/);
  const word = s.sent.find((line) => line.includes('Дуэль началась')).match(/'([^']+)'/)[1];
  await s.send(word, 'viewer');
  assert.ok(s.store.data.escrow);
  await Promise.all([s.send(word), s.send(word, 'other')]);
  assert.equal(s.store.player('mod').balance, 150);
  assert.equal(s.store.player('other').balance, 50);
  assert.equal(s.store.data.escrow, null);
  await s.send('!дуэль other 50');
  assert.match(s.sent.at(-1), /30 сек/);
  s.advance(30_000);
  assert.equal(s.sent.filter((line) => line.startsWith('🏆') && line.includes('побеждает')).length, 1);
});

test('при принятии повторно проверяет баланс; при !выкл зритель не может быть вызван', async (t) => {
  const s = setup(t);
  await s.send('!выкл');
  s.seed('mod', 100); s.seed('other', 100);
  await s.send('!дуэль viewer 50');
  assert.match(s.sent.at(-1), /нет доступа/);
  await s.send('!дуэль other 100');
  await s.send('!сбп mod 50', 'other');
  await s.send('!принять', 'other');
  assert.match(s.sent.at(-1), /недостаточно монет/);
  assert.equal(s.store.data.escrow, null);
});

test('таймауты дуэли работают без входящих сообщений', async (t) => {
  const s = setup(t);
  s.seed('mod', 100); s.seed('other', 100);
  await s.send('!дуэль other 50');
  s.advance(10_000);
  assert.match(s.sent.at(-1), /не принята/);
  assert.equal(s.store.player('mod').balance, 100);
  await s.send('!дуэль other 50');
  await s.send('!принять', 'other');
  s.advance(30_000);
  assert.match(s.sent.at(-1), /Время вышло/);
  assert.equal(s.store.player('mod').balance, 50);
  assert.equal(s.store.player('other').balance, 50);
  assert.equal(s.store.data.escrow, null);
});

test('после перезапуска активная дуэль возвращает ставки ровно один раз', async (t) => {
  const s = setup(t);
  s.seed('mod', 100); s.seed('other', 100);
  await s.send('!дуэль other 50');
  await s.send('!принять', 'other');
  s.handler.close();
  const first = new FunStore(s.file);
  const second = new FunStore(s.file);
  assert.equal(first.player('mod').balance, 100);
  assert.equal(first.player('other').balance, 100);
  assert.deepEqual(first.data, second.data);
});

test('балансы, КД, активность и дуэли изолированы между каналами', async (t) => {
  const a = setup(t), b = setup(t, { channel: 'tiltocacto0o' });
  a.seed('mod', 100); a.seed('other', 100);
  await a.send('!дуэль other 50');
  await b.send('!принять', 'other');
  assert.match(b.sent.at(-1), /не вызывал|нет|Нет|не ожидает|не адресована/);
  await b.send('!кредит');
  assert.equal(b.store.player('mod').balance, 20);
  assert.equal(a.store.player('mod').balance, 100);
});

test('игры подключены к общему обработчику; старая команда доступна при незавершённом раскладе', async (t) => {
  let finish;
  const s = setup(t, { tarot: () => new Promise((resolve) => { finish = resolve; }) });
  const handler = createCommandHandler({
    config: s.config, chat: s.chat, ids: s.ids, funCommands: s.handler,
    yandexMusic: { getCurrentTrack: async () => ({ status: 'idle' }) },
  });
  const pending = handler(s.message('!расклад вопрос'));
  await handler(s.message('!трек', 'viewer'));
  assert.match(s.sent.at(-1), /музыка не воспроизводится/);
  await handler(s.message('!кредит'));
  assert.equal(s.store.player('mod').balance, 20);
  const sentBeforeCooldown = [...s.sent];
  await handler(s.message('!расклад снова'));
  await handler(s.message('!расклад'));
  assert.deepEqual(s.sent, sentBeforeCooldown);
  finish('Ответ\r\nPRIVMSG #other :текст');
  await pending;
  assert.doesNotMatch(s.sent.at(-1), /[\r\n]/);
});

test('ошибка сохранения не меняет баланс и отключает только игровой модуль', async (t) => {
  const s = setup(t);
  s.store.transact = () => { throw new Error('disk full'); };
  await s.send('!кредит');
  assert.equal(s.store.player('mod').balance, 0);
  assert.match(s.sent.at(-1), /Ошибка сохранения/);
  await s.send('!бал');
  assert.match(s.sent.at(-1), /недоступны/);
  assert.equal(await s.send('!трек'), false);
});

test('ошибка записи на диск откатывает настоящую транзакцию в памяти', (t) => {
  const s = setup(t);
  s.seed('mod', 10);
  // Каталог на месте временного файла моделирует невозможность записи.
  fs.mkdirSync(`${s.file}.tmp`);
  const before = fs.readFileSync(s.file, 'utf8');
  assert.throws(() => s.store.transact((data) => { data.players.mod.balance += 20; }));
  assert.equal(s.store.player('mod').balance, 10);
  assert.equal(fs.readFileSync(s.file, 'utf8'), before);
});

test('попытка победы ровно на границе таймаута не получает банк', async (t) => {
  const s = setup(t);
  s.seed('mod', 100); s.seed('other', 100);
  await s.send('!дуэль other 50');
  await s.send('!принять', 'other');
  const word = s.sent.at(-1).match(/'([^']+)'/)[1];
  s.advance(30_000);
  await s.send(word);
  assert.equal(s.store.player('mod').balance, 50);
  assert.equal(s.store.player('other').balance, 50);
});

test('повреждённый файл не перезаписывается; транзакция откатывается при переполнении', async (t) => {
  const s = setup(t);
  s.seed('mod', 10);
  const before = fs.readFileSync(s.file, 'utf8');
  assert.throws(() => s.store.transact((data) => { data.players.mod.balance = Infinity; }));
  assert.equal(s.store.player('mod').balance, 10);
  assert.equal(fs.readFileSync(s.file, 'utf8'), before);
  fs.writeFileSync(s.file, '{broken');
  assert.throws(() => new FunStore(s.file));
  assert.equal(fs.readFileSync(s.file, 'utf8'), '{broken');
});


test('roulette regression 321', async (t) => {
  for (const channel of ['cacto0o', 'ryler234']) {
    const calls = [];
    const s = setup(t, { channel, random: () => 0, helix: { timeoutUser: async (args) => calls.push(args) } });
    Object.assign(s.ids, { broadcasterId: channel + '-id', botUserId: 'bot-id' });
    for (const flags of [{}, { isVip: true }, { isSub: true }]) {
      await s.send('!рулетка', 'viewer', { userId: 'viewer-id', ...flags });
    }
    assert.equal(calls.length, 3);
    for (const call of calls) assert.deepEqual(call, {
      broadcasterId: channel + '-id', moderatorId: 'bot-id', userId: 'viewer-id',
      duration: 120, reason: 'Выстрел в !рулетка',
    });
    assert.equal(s.store.player('viewer').deaths, 3);
  }
});

test('roulette regression 338', async (t) => {
  const calls = [];
  const helix = { timeoutUser: async (args) => calls.push(args), getUserId: async () => { calls.push('lookup'); } };
  const s = setup(t, { random: () => 0, helix });
  await s.send('!рулетка', 'moderator', { isMod: true, isVip: true });
  await s.send('!рулетка', 'owner', { isBroadcaster: true });
  await s.send('!рулетка', 'cacto0o');
  const survivor = setup(t, { random: () => 0.9, helix });
  await survivor.send('!рулетка', 'viewer');
  assert.equal(survivor.store.player('viewer').survivals, 1);
  assert.deepEqual(calls, []);
});

test('roulette regression 351', async (t) => {
  const s = setup(t, { random: () => 0, helix: { timeoutUser: async () => { throw new Error('403'); } } });
  await s.send('!рулетка', 'viewer', { userId: 'viewer-id' });
  assert.match(s.sent.at(-1), /Не удалось выдать тайм-аут.*Шаблон команды !рулетка/);
  await s.send('!бал');
  assert.match(s.sent.at(-1), /баланс/);
});

function restartWithSettings(t, s) {
  const settings = new FunSettings(`${s.file}.settings`);
  const handler = createFunCommandHandler({
    config: s.config, chat: s.chat, ids: s.ids, store: new FunStore(s.file), settings,
  });
  t.after(handler.close);
  return { settings, send: (text, user) => handler(s.message(text, user)), close: handler.close };
}

test('settings persistence regression 1', async (t) => {
  const s = setup(t);
  let current = restartWithSettings(t, s);
  await current.send('!выклвип');
  await current.send('!кд 60');
  await current.send('!добавить @Viewer');
  current.close();
  current = restartWithSettings(t, s);
  assert.deepEqual(current.settings.data, { version: 1, mode: 'vip', cooldown: 60, tempVips: ['viewer'] });
  s.sent.length = 0;
  await current.send('!бал', 'outsider');
  assert.equal(s.sent.length, 0);
  await current.send('!бал', 'viewer');
  assert.equal(s.sent.length, 1);
  await current.send('!бал', 'mod');
  assert.equal(s.sent.length, 1);
  await current.send('!удалить viewer');
  await current.send('!выкл');
  current.close();
  current = restartWithSettings(t, s);
  assert.equal(current.settings.data.mode, 'off');
  assert.deepEqual(current.settings.data.tempVips, []);
  s.sent.length = 0;
  await current.send('!бал', 'viewer');
  assert.equal(s.sent.length, 0);
  await current.send('!вкл');
  await current.send('!кд 0');
  current.close();
  current = restartWithSettings(t, s);
  assert.equal(current.settings.data.mode, 'on');
  assert.equal(current.settings.data.cooldown, 0);
  s.sent.length = 0;
  await current.send('!бал', 'viewer');
  await current.send('!бал', 'outsider');
  assert.equal(s.sent.length, 2);
});

test('settings persistence regression 2', async (t) => {
  const a = setup(t), b = setup(t, { channel: 'tiltocacto0o' });
  const first = restartWithSettings(t, a), second = restartWithSettings(t, b);
  await first.send('!кд 10');
  await second.send('!кд 20');
  assert.equal(new FunSettings(`${a.file}.settings`).data.cooldown, 10);
  assert.equal(new FunSettings(`${b.file}.settings`).data.cooldown, 20);
});

test('settings persistence regression 3', async (t) => {
  const s = setup(t), current = restartWithSettings(t, s);
  await current.send('!выкл');
  const before = fs.readFileSync(current.settings.file, 'utf8');
  fs.mkdirSync(`${current.settings.file}.tmp`);
  await current.send('!вкл');
  assert.match(s.sent.at(-1), /Ошибка сохранения/);
  assert.equal(current.settings.data.mode, 'off');
  assert.equal(fs.readFileSync(current.settings.file, 'utf8'), before);
});

test('settings persistence regression 4', async (t) => {
  const s = setup(t), file = `${s.file}.settings`;
  for (const text of ['{broken', JSON.stringify({ version: 1, mode: 'on', cooldown: -1, tempVips: [] })]) {
    fs.writeFileSync(file, text);
    assert.throws(() => new FunSettings(file));
    assert.equal(fs.readFileSync(file, 'utf8'), text);
  }
});

test('disabling a live duel refunds both stakes and blocks plain-word settlement', async (t) => {
  const s = setup(t, { random: () => 0 });
  s.seed('alice', 100);
  s.seed('bob', 100);
  const commandSettings = new CommandSettings();
  const fun = createFunCommandHandler({
    config: s.config, ids: s.ids, chat: s.chat, store: s.store, random: () => 0,
    isCommandDisabled: (cmd) => commandSettings.isDisabled(cmd),
  });
  t.after(fun.close);
  const handler = createCommandHandler({ config: s.config, ids: s.ids, chat: s.chat, funCommands: fun, commandSettings });
  await handler(s.message('!дуэль bob 50', 'alice'));
  await handler(s.message('!принять', 'bob'));
  assert.equal(s.store.player('alice').balance, 50);
  assert.equal(s.store.player('bob').balance, 50);
  const word = /напишет '([^']+)'/.exec(s.sent.at(-1))[1];
  await handler(s.message('!откл дуэль', 'mod'));
  assert.equal(s.store.data.escrow, null);
  assert.equal(s.store.player('alice').balance, 100);
  assert.equal(s.store.player('bob').balance, 100);
  const sent = [...s.sent];
  await handler(s.message(word, 'alice'));
  assert.deepEqual(s.sent, sent);
  assert.equal(s.store.player('alice').balance, 100);
});

test('empty commands URL produces a local command list without recurring promotion', async (t) => {
  const s = setup(t);
  s.config.fun.commandsUrl = '';
  const scheduled = [];
  const fun = createFunCommandHandler({
    config: s.config, ids: s.ids, chat: s.chat, store: s.store,
    schedule: (fn) => { scheduled.push(fn); return 1; }, cancel: () => {},
  });
  t.after(fun.close);
  await fun(s.message('!вкл'));
  await fun(s.message('!инфо'));
  assert.match(s.sent.at(-1), /Игровые команды: !дуэль/);
  assert.doesNotMatch(s.sent.at(-1), /https?:\/\//);
  assert.equal(scheduled.length, 0);
});

test('default game mode applies to new settings and does not replace saved mode', async (t) => {
  const s = setup(t);
  const file = `${s.file}.settings`;
  assert.equal(new FunSettings(file).data.mode, 'off');
  const settings = new FunSettings(file, { defaultMode: 'on' });
  settings.update({ mode: 'vip' });
  assert.equal(new FunSettings(file, { defaultMode: 'off' }).data.mode, 'vip');
});

test('chat disabling info cancels promotion and enabling it restarts the timer', async (t) => {
  const s = setup(t);
  const commandSettings = new CommandSettings();
  const scheduled = new Set();
  const fun = createFunCommandHandler({
    config: s.config, ids: s.ids, chat: s.chat, store: s.store,
    isCommandDisabled: cmd => commandSettings.isDisabled(cmd),
    schedule: fn => { scheduled.add(fn); return fn; }, cancel: fn => scheduled.delete(fn),
  });
  t.after(fun.close);
  const handler = createCommandHandler({ config: s.config, ids: s.ids, chat: s.chat, funCommands: fun, commandSettings });
  await handler(s.message('!вкл'));
  assert.equal(scheduled.size, 1);
  await handler(s.message('!откл инфо'));
  assert.equal(scheduled.size, 0);
  await handler(s.message('!вкл инфо'));
  assert.equal(scheduled.size, 1);
  const next = [...scheduled][0];
  scheduled.delete(next);
  next();
  assert.match(s.sent.at(-1), /https:\/\/example.com\/commands/);
});
