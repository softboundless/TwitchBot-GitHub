import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventSubClient } from '../src/eventsub.js';

const flush = () => new Promise(setImmediate);

function setup(t, subscribe = async () => {}) {
  let time = 0;
  let nextId = 0;
  const timers = new Map();
  const sockets = [];
  const subscriptions = [];
  class Socket {
    constructor(url) { this.url = url; this.readyState = 0; this.listeners = new Map(); this.closes = 0; }
    addEventListener(type, fn) { this.listeners.set(type, fn); }
    emit(type, event = {}) { this.listeners.get(type)?.(event); }
    async message(type, payload) {
      this.emit('message', { data: JSON.stringify({ metadata: { message_type: type }, payload }) });
      await flush();
    }
    async welcome(id) {
      this.readyState = 1;
      await this.message('session_welcome', { session: { id, keepalive_timeout_seconds: 10 } });
    }
    close() {
      this.closes++;
      if (this.errorOnClose) this.emit('error', { message: 'close failed' });
      this.readyState = 3;
      this.emit('close');
    }
  }
  const client = new EventSubClient({
    subscriptions: [{ type: 'stream.online', version: '1', condition: { broadcaster_user_id: 'channel' } }],
    helix: { async createEventSubSubscription(params) { subscriptions.push(params); await subscribe(params); } },
    webSocketFactory(url) { const ws = new Socket(url); sockets.push(ws); return ws; },
    schedule(fn, delay) { const id = ++nextId; timers.set(id, { fn, at: time + delay }); return id; },
    cancel(id) { timers.delete(id); },
  });
  t.after(() => client.close());
  return {
    client, sockets, subscriptions, timers,
    async advance(ms) {
      const end = time + ms;
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        time = next[1].at;
        timers.delete(next[0]);
        next[1].fn();
        await flush();
      }
      time = end;
    },
  };
}

test('ошибка до welcome после обрыва не останавливает повторные подключения', async (t) => {
  const s = setup(t);
  s.client.connect();
  await s.sockets[0].welcome('first');
  s.sockets[0].close();
  await s.advance(1000);
  s.sockets[1].errorOnClose = true;
  s.sockets[1].emit('error', { message: 'network error' });
  assert.equal(s.sockets[1].closes, 1, 'error внутри close не вызывает рекурсию');
  assert.equal(s.timers.size, 1);
  await s.advance(2000);
  await s.sockets[2].welcome('recovered');
  assert.equal(s.client.isConnected(), true);
  assert.deepEqual(s.subscriptions.map((sub) => sub.sessionId), ['first', 'recovered']);
});

test('сторож и прямой connect не обходят задержку и не создают параллельные сокеты', async (t) => {
  const s = setup(t);
  s.client.connect();
  s.client.ensureConnected();
  s.client.connect();
  assert.equal(s.sockets.length, 1);
  await s.sockets[0].welcome('first');
  s.sockets[0].close();
  s.client.ensureConnected();
  s.client.connect();
  await s.advance(999);
  assert.equal(s.sockets.length, 1);
  await s.advance(1);
  s.client.ensureConnected();
  assert.equal(s.sockets.length, 2);
});

test('подключение без welcome ограничено таймаутом', async (t) => {
  const s = setup(t);
  s.client.connect();
  await s.advance(30_000);
  assert.equal(s.sockets[0].closes, 1);
  await s.advance(1000);
  assert.equal(s.sockets.length, 2);
});

test('повторные ошибки увеличивают задержку до 30 секунд', async (t) => {
  const s = setup(t);
  s.client.connect();
  for (const delay of [1000, 2000, 4000, 8000, 16000, 30000, 30000]) {
    s.sockets.at(-1).close();
    const count = s.sockets.length;
    await s.advance(delay - 1);
    assert.equal(s.sockets.length, count);
    await s.advance(1);
    assert.equal(s.sockets.length, count + 1);
  }
});

test('миграция сохраняет старый сокет до welcome и не пересоздаёт подписки', async (t) => {
  const s = setup(t);
  const events = [];
  s.client.on('notification', (...args) => events.push(args));
  s.client.connect();
  const old = s.sockets[0];
  await old.welcome('first');
  const url = 'wss://example.invalid/ws?reconnect=opaque';
  await old.message('session_reconnect', { session: { reconnect_url: url } });
  assert.equal(old.closes, 0);
  assert.equal(s.sockets[1].url, url);
  await old.message('notification', { subscription: { type: 'stream.offline' }, event: { id: 1 } });
  await s.sockets[1].welcome('transferred');
  assert.equal(old.closes, 1);
  assert.equal(s.subscriptions.length, 1);
  assert.equal(s.client.isConnected(), true);
  await old.message('notification', { subscription: { type: 'stream.offline' }, event: { id: 2 } });
  old.emit('close');
  assert.equal(events.length, 1, 'запоздалые события старого сокета игнорируются');
  assert.equal(s.client.isConnected(), true);
});

test('закрытие старого сокета во время миграции не отменяет новый', async (t) => {
  const s = setup(t);
  s.client.connect();
  await s.sockets[0].welcome('first');
  await s.sockets[0].message('session_reconnect', { session: { reconnect_url: 'wss://example.invalid/ws' } });
  s.sockets[0].close();
  await s.sockets[1].welcome('transferred');
  assert.equal(s.client.isConnected(), true);
  assert.equal(s.subscriptions.length, 1);
});

test('неудачная миграция возвращается на основной URL и восстанавливает подписки', async (t) => {
  const s = setup(t);
  s.client.connect();
  await s.sockets[0].welcome('first');
  await s.sockets[0].message('session_reconnect', { session: { reconnect_url: 'wss://example.invalid/ws' } });
  s.sockets[1].close();
  await s.advance(1000);
  assert.equal(s.sockets[2].url, 'wss://eventsub.wss.twitch.tv/ws');
  await s.sockets[2].welcome('new-session');
  assert.equal(s.subscriptions.length, 2);
  assert.equal(s.client.isConnected(), true);
});

test('ошибка оформления подписки не оставляет ложное живое соединение', async (t) => {
  let fail = true;
  const s = setup(t, async () => { if (fail) throw new Error('temporary API error'); });
  let ready = 0;
  s.client.on('connected', () => ready++);
  s.client.connect();
  await s.sockets[0].welcome('first');
  assert.equal(s.client.isConnected(), false);
  assert.equal(ready, 0);
  fail = false;
  await s.advance(1000);
  await s.sockets[1].welcome('second');
  assert.equal(s.client.isConnected(), true);
  assert.equal(ready, 1);
});

test('зависшая подписка и её поздний ответ не портят новую сессию', async (t) => {
  let finish;
  const s = setup(t, (params) => params.sessionId === 'first' ? new Promise((resolve) => { finish = resolve; }) : undefined);
  s.client.connect();
  await s.sockets[0].welcome('first');
  await s.advance(20_000);
  await s.advance(1000);
  await s.sockets[1].welcome('second');
  finish();
  await flush();
  assert.equal(s.client.sessionId, 'second');
  assert.equal(s.client.isConnected(), true);
});

test('отзыв подписки и пропажа keepalive запускают восстановление', async (t) => {
  const s = setup(t);
  s.client.connect();
  await s.sockets[0].welcome('first');
  await s.sockets[0].message('revocation', { subscription: { type: 'stream.online', status: 'authorization_revoked' } });
  await s.advance(1000);
  await s.sockets[1].welcome('second');
  await s.advance(20_000);
  assert.equal(s.client.isConnected(), false);
  await s.advance(1000);
  assert.equal(s.sockets.length, 3);
});

test('stop отменяет подключение и отложенные повторы', async (t) => {
  const s = setup(t);
  s.client.connect();
  s.sockets[0].close();
  s.client.close();
  await s.advance(60_000);
  s.client.ensureConnected();
  s.client.connect();
  assert.equal(s.timers.size, 0);
  assert.equal(s.sockets.length, 1);
});

test('исключение конструктора сокета не останавливает повторные попытки', async (t) => {
  const s = setup(t);
  const factory = s.client.webSocketFactory;
  s.client.webSocketFactory = () => { throw new Error('cannot connect'); };
  s.client.connect();
  assert.equal(s.client.connecting, false);
  s.client.webSocketFactory = factory;
  await s.advance(1000);
  await s.sockets[0].welcome('recovered');
  assert.equal(s.client.isConnected(), true);
});

test('keepalive не позволяет зависшему запросу подписки заблокировать восстановление', async (t) => {
  let finish;
  const s = setup(t, () => new Promise((resolve) => { finish = resolve; }));
  s.client.connect();
  await s.sockets[0].welcome('first');
  await s.advance(15_000);
  await s.sockets[0].message('session_keepalive', {});
  await s.advance(15_000);
  assert.equal(s.sockets[0].closes, 1);
  finish();
  await flush();
  await s.advance(1000);
  assert.equal(s.sockets.length, 2);
  assert.equal(s.client.isConnected(), false);
});
