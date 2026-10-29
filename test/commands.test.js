import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseCreateArgs, parseDuration, matchOutcome, matchCategory, calcExpression } from '../src/commands.js';
import { parseIrcLine } from '../src/irc.js';
import { parseModerateEvent, RateLimiter } from '../src/autoUnban.js';

const pollOpts = { maxTitle: 60, maxChoices: 5, minSec: 15, maxSec: 1800, defaultSec: 120 };
const predOpts = { maxTitle: 45, maxChoices: 10, minSec: 30, maxSec: 1800, defaultSec: 60 };

test('parseDuration: секунды и минуты', () => {
  assert.equal(parseDuration('120'), 120);
  assert.equal(parseDuration('90с'), 90);
  assert.equal(parseDuration('45s'), 45);
  assert.equal(parseDuration('3м'), 180);
  assert.equal(parseDuration('2m'), 120);
  assert.equal(parseDuration('5мин'), 300);
  assert.equal(parseDuration('abc'), null);
  assert.equal(parseDuration('12x'), null);
});

test('poll: простой случай с дефолтной длительностью', () => {
  const p = parseCreateArgs(['тест', 'да/нет'], pollOpts);
  assert.equal(p.error, undefined);
  assert.equal(p.title, 'тест');
  assert.deepEqual(p.choices, ['да', 'нет']);
  assert.equal(p.duration, 120);
});

test('poll: название из нескольких слов + длительность в минутах', () => {
  const p = parseCreateArgs(['Кто', 'победит', 'сегодня', 'да/нет/незнаю', '5м'], pollOpts);
  assert.equal(p.error, undefined);
  assert.equal(p.title, 'Кто победит сегодня');
  assert.deepEqual(p.choices, ['да', 'нет', 'незнаю']);
  assert.equal(p.duration, 300);
});

test('poll: один ответ — ошибка «Недостаточно ответов» (пример из ТЗ)', () => {
  const p = parseCreateArgs(['ОпросТест', 'Да'], pollOpts);
  assert.equal(p.error, 'Недостаточно ответов');
});

test('poll: нет названия — ошибка', () => {
  assert.equal(parseCreateArgs(['да/нет'], pollOpts).error, 'Не указано название');
  assert.equal(parseCreateArgs([], pollOpts).error, 'Не указано название');
});

test('poll: слишком много ответов', () => {
  const p = parseCreateArgs(['т', 'а/б/в/г/д/е'], pollOpts);
  assert.match(p.error, /максимум 5/);
});

test('pred: до 10 исходов допустимо', () => {
  const p = parseCreateArgs(['т', 'а/б/в/г/д/е'], predOpts);
  assert.equal(p.error, undefined);
  assert.equal(p.choices.length, 6);
  assert.equal(p.duration, 60);
});

test('ответ длиннее 25 символов — ошибка', () => {
  const p = parseCreateArgs(['т', 'да/оченьдлинныйответкоторыйнепройдет'], pollOpts);
  assert.match(p.error, /длиннее 25/);
});

test('длительность вне диапазона — ошибка', () => {
  assert.match(parseCreateArgs(['т', 'да/нет', '10'], pollOpts).error, /от 15 сек/);
  assert.match(parseCreateArgs(['т', 'да/нет', '31м'], pollOpts).error, /от 15 сек/);
});

test('непонятная длительность — ошибка', () => {
  assert.match(parseCreateArgs(['т', 'да/нет', 'долго'], pollOpts).error, /Не понял длительность/);
});

test('лишние параметры — ошибка', () => {
  assert.match(parseCreateArgs(['т', 'да/нет', '60', 'мусор'], pollOpts).error, /Лишние параметры/);
});

test('calcExpression: пример из запроса', () => {
  assert.equal(calcExpression('15+30+30').value, 75);
});

test('calcExpression: приоритет операций и скобки', () => {
  assert.equal(calcExpression('2+2*2').value, 6);
  assert.equal(calcExpression('(2+2)*2').value, 8);
  assert.equal(calcExpression('10-4/2').value, 8);
});

test('calcExpression: пробелы, запятая как десятичная, унарный минус', () => {
  assert.equal(calcExpression('15 + 30 * 2').value, 75);
  assert.equal(calcExpression('1,5+1.5').value, 3);
  assert.equal(calcExpression('-5+10').value, 5);
  assert.equal(calcExpression('2*-3').value, -6);
});

test('calcExpression: мусор плавающей точки убирается', () => {
  assert.equal(calcExpression('0.1+0.2').value, 0.3);
});

test('calcExpression: деление на ноль', () => {
  assert.match(calcExpression('5/0').error, /деление на ноль/);
});

test('calcExpression: недопустимые символы и кривые выражения', () => {
  assert.match(calcExpression('5+abc').error, /допустимы только/);
  assert.match(calcExpression('2+').error, /ожидалось число/);
  assert.match(calcExpression('(2+3').error, /закрывающей скобки/);
  assert.match(calcExpression('2)3').error, /лишние символы/);
  assert.match(calcExpression('').error, /пустое выражение/);
});

test('calcExpression: слишком большой результат', () => {
  assert.match(calcExpression('999999999*999999999*999999999').error, /слишком большое/);
});

test('parseIrcLine: бейджи VIP и подписчика', () => {
  const line =
    '@badges=vip/1,subscriber/3;id=abc-123;display-name=SomeVip ' +
    ':somevip!somevip@somevip.tmi.twitch.tv PRIVMSG #cacto0o :!скок 2+2';
  const m = parseIrcLine(line);
  assert.ok(m.tags.badges.includes('vip/'));
  assert.ok(m.tags.badges.includes('subscriber/'));
  assert.equal(m.tags.id, 'abc-123');
});

test('parseIrcLine: PRIVMSG с тегами', () => {
  const line =
    '@badges=moderator/1,subscriber/12;display-name=Peacefull02;mod=1 ' +
    ':peacefull02!peacefull02@peacefull02.tmi.twitch.tv PRIVMSG #cacto0o :!poll тест да/нет';
  const m = parseIrcLine(line);
  assert.equal(m.command, 'PRIVMSG');
  assert.equal(m.prefixUser, 'peacefull02');
  assert.equal(m.tags['display-name'], 'Peacefull02');
  assert.equal(m.tags.mod, '1');
  assert.equal(m.trailing, '!poll тест да/нет');
  assert.ok(m.tags.badges.includes('moderator/'));
});

test('matchOutcome: точное совпадение без учёта регистра', () => {
  const outs = [{ id: 'a', title: 'Да' }, { id: 'b', title: 'Нет' }];
  assert.equal(matchOutcome(outs, 'да').outcome.id, 'a');
  assert.equal(matchOutcome(outs, 'НЕТ').outcome.id, 'b');
});

test('matchOutcome: выбор по номеру', () => {
  const outs = [{ id: 'a', title: 'Да' }, { id: 'b', title: 'Нет' }];
  assert.equal(matchOutcome(outs, '2').outcome.id, 'b');
  assert.match(matchOutcome(outs, '5').error, /нет исхода с номером/);
});

test('matchOutcome: уникальная подстрока, неоднозначность, не найдено', () => {
  const outs = [{ id: 'a', title: 'Победа синих' }, { id: 'b', title: 'Победа красных' }];
  assert.equal(matchOutcome(outs, 'красн').outcome.id, 'b');
  assert.match(matchOutcome(outs, 'победа').error, /нескольким/);
  assert.match(matchOutcome(outs, 'зелёных').error, /не найден/);
});

test('matchCategory: точное совпадение важнее первого результата', () => {
  const res = [
    { id: '1', name: 'Counter-Strike 2' },
    { id: '2', name: 'Counter-Strike' },
  ];
  assert.equal(matchCategory(res, 'Counter-Strike').id, '2');
  assert.equal(matchCategory(res, 'counter-strike').id, '2');
});

test('matchCategory: префикс, затем первый результат', () => {
  const res = [
    { id: '1', name: 'Dead by Daylight' },
    { id: '2', name: 'Deadlock' },
  ];
  assert.equal(matchCategory(res, 'deadl').id, '2');
  assert.equal(matchCategory(res, 'что-то другое').id, '1');
  assert.equal(matchCategory([], 'что угодно'), null);
  assert.equal(matchCategory(null, 'что угодно'), null);
});

test('parseIrcLine: CLEARCHAT с баном и с таймаутом', () => {
  const ban = parseIrcLine('@room-id=1 :tmi.twitch.tv CLEARCHAT #cacto0o :dubstepcatt1');
  assert.equal(ban.command, 'CLEARCHAT');
  assert.equal(ban.trailing, 'dubstepcatt1');
  assert.equal(ban.tags['ban-duration'], undefined);

  const to = parseIrcLine('@ban-duration=600 :tmi.twitch.tv CLEARCHAT #cacto0o :dubstepcatt1');
  assert.equal(to.tags['ban-duration'], '600');
});

test('parseIrcLine: PING не ломает разбор', () => {
  const m = parseIrcLine('PING :tmi.twitch.tv');
  assert.equal(m.command, 'PING');
  assert.equal(m.trailing, 'tmi.twitch.tv');
});

test('parseModerateEvent: перманентный бан', () => {
  const p = parseModerateEvent({
    action: 'ban',
    moderator_user_login: 'SomeMod',
    ban: { user_id: '42', user_login: 'TargetGuy', reason: 'спам' },
  });
  assert.equal(p.action, 'ban');
  assert.equal(p.targetLogin, 'targetguy');
  assert.equal(p.moderatorLogin, 'somemod');
  assert.equal(p.reason, 'спам');
});

test('parseModerateEvent: таймаут', () => {
  const p = parseModerateEvent({
    action: 'timeout',
    moderator_user_login: 'mod2',
    timeout: { user_id: '42', user_login: 'targetguy', expires_at: '2026-01-01T00:00:00Z' },
  });
  assert.equal(p.action, 'timeout');
  assert.equal(p.targetLogin, 'targetguy');
  assert.equal(p.moderatorLogin, 'mod2');
});

test('parseModerateEvent: другие действия не ломают разбор', () => {
  assert.equal(parseModerateEvent({ action: 'unban', unban: { user_login: 'x' } }).action, 'unban');
  assert.equal(parseModerateEvent({}), null);
  assert.equal(parseModerateEvent(null), null);
});

test('RateLimiter: пропускает до лимита и блокирует сверх него', () => {
  const rl = new RateLimiter(3);
  const t = 1_000_000;
  assert.equal(rl.tryAcquire(t), true);
  assert.equal(rl.tryAcquire(t), true);
  assert.equal(rl.tryAcquire(t), true);
  assert.equal(rl.tryAcquire(t), false);
});

test('RateLimiter: окно сдвигается через минуту', () => {
  const rl = new RateLimiter(2);
  const t = 1_000_000;
  rl.tryAcquire(t);
  rl.tryAcquire(t);
  assert.equal(rl.tryAcquire(t + 59_000), false);
  assert.equal(rl.tryAcquire(t + 61_000), true);
});
