import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { AutoPin } from '../src/autoPin.js';

const messages = new Map([
  ['cacto0o', 'tg - cacto0o.t.me | Donationalerts - donationalerts.com/r/cacto'],
  ['tiltocacto0o', 'Основа - twitch.tv/cacto0o | tg - cacto0o.t.me'],
  ['ryler234', 'tg — t.me/ryler2342 | DonatePay — new.donatepay.ru/donate/ryler234donat'],
]);

function makeContext(channel, helix) {
  return {
    channel,
    helix,
    ids: {
      channel,
      broadcasterId: `${channel}-broadcaster`,
      botUserId: 'bot-id',
    },
  };
}

function makeAutoPin(contexts, options = {}) {
  return new AutoPin({
    config: {
      autoPin: {
        enabled: true,
        messages,
        offlineDelayMs: options.offlineDelayMs ?? 0,
      },
    },
    contexts,
    eventsubFactory: options.eventsubFactory,
    sleep: options.sleep,
    now: options.now,
    schedule: options.schedule,
    cancel: options.cancel,
  });
}

test('существующий закреп сохраняется и новое сообщение не отправляется', async () => {
  const calls = [];
  const context = makeContext('cacto0o', {
    async getPinnedChatMessage(params) {
      calls.push(['get', params]);
      return { message_id: 'existing-pin' };
    },
    async sendChatMessage() {
      calls.push(['send']);
    },
    async pinChatMessage() {
      calls.push(['pin']);
    },
  });

  const result = await makeAutoPin([context]).ensurePinned(context, 'тест');

  assert.equal(result, false);
  assert.deepEqual(calls, [
    ['get', { broadcasterId: 'cacto0o-broadcaster', moderatorId: 'bot-id' }],
  ]);
});

test('для каждого канала отправляется его текст и pin создаётся по message_id', async () => {
  for (const channel of ['cacto0o', 'tiltocacto0o', 'ryler234']) {
    const calls = [];
    const context = makeContext(channel, {
      async getPinnedChatMessage(params) {
        calls.push(['get', params]);
        return null;
      },
      async sendChatMessage(params) {
        calls.push(['send', params]);
        return { message_id: `${channel}-message`, is_sent: true };
      },
      async pinChatMessage(params) {
        calls.push(['pin', params]);
      },
    });

    const result = await makeAutoPin([context]).ensurePinned(context, 'тест');

    assert.equal(result, true);
    assert.deepEqual(calls[1], [
      'send',
      {
        broadcasterId: `${channel}-broadcaster`,
        senderId: 'bot-id',
        message: messages.get(channel),
      },
    ]);
    assert.deepEqual(calls[2], [
      'pin',
      {
        broadcasterId: `${channel}-broadcaster`,
        moderatorId: 'bot-id',
        messageId: `${channel}-message`,
      },
    ]);
  }
});

test('start проверяет состояние стрима и подписывается на online/offline всех каналов', async (t) => {
  class FakeEventSub extends EventEmitter {
    connect() {
      this.connected = true;
    }
    close() {}
  }

  let eventsubOptions;
  const contexts = ['cacto0o', 'tiltocacto0o', 'ryler234'].map((channel) =>
    makeContext(channel, {
      async getStream() {
        return channel === 'cacto0o' ? { id: 'stream-1', started_at: '2026-09-25T00:00:00Z' } : null;
      },
      async getPinnedChatMessage() {
        return { message_id: 'already-pinned' };
      },
    }),
  );
  const autoPin = makeAutoPin(contexts, {
    eventsubFactory(options) {
      eventsubOptions = options;
      return new FakeEventSub();
    },
  });
  t.after(() => autoPin.stop());

  await autoPin.start();

  assert.equal(autoPin.eventsub.connected, true);
  assert.deepEqual(
    eventsubOptions.subscriptions.map(({ type, condition }) => [type, condition.broadcaster_user_id]),
    [
      ['stream.online', 'cacto0o-broadcaster'],
      ['stream.offline', 'cacto0o-broadcaster'],
      ['stream.online', 'tiltocacto0o-broadcaster'],
      ['stream.offline', 'tiltocacto0o-broadcaster'],
      ['stream.online', 'ryler234-broadcaster'],
      ['stream.offline', 'ryler234-broadcaster'],
    ],
  );
});

test('stream.offline ждёт снятия старого pin и обрабатывает только нужный канал', async () => {
  const slept = [];
  const checked = [];
  const contexts = ['cacto0o', 'tiltocacto0o'].map((channel) =>
    makeContext(channel, {
      async getStream() { return null; },
      async getPinnedChatMessage() {
        checked.push(channel);
        return { message_id: 'already-pinned' };
      },
    }),
  );
  const autoPin = makeAutoPin(contexts, {
    offlineDelayMs: 3000,
    async sleep(ms) {
      slept.push(ms);
    },
  });
  autoPin.streamByChannel.set('tiltocacto0o', 'previous-stream');

  const result = await autoPin.onStreamEvent('stream.offline', {
    broadcaster_user_id: 'tiltocacto0o-broadcaster',
  });

  assert.equal(result, false);
  assert.deepEqual(slept, [3000]);
  assert.deepEqual(checked, ['tiltocacto0o']);
});

function recoverySetup(t) {
  let time = 0;
  let nextId = 0;
  const timers = new Map();
  const state = {
    stream: { id: 'stream-1', started_at: '2026-09-25T00:00:00Z' },
    pin: { message_id: 'existing' },
    streamChecks: 0, pinChecks: 0, sends: 0, pins: [],
  };
  const context = makeContext('cacto0o', {
    async getStream() {
      state.streamChecks++;
      if (state.streamError) throw state.streamError;
      return state.stream;
    },
    async getPinnedChatMessage() { state.pinChecks++; return state.pin; },
    async sendChatMessage() {
      state.sends++;
      return { is_sent: true, message_id: `sent-${state.sends}` };
    },
    async pinChatMessage({ messageId }) {
      state.pins.push(messageId);
      if (state.pinError) throw state.pinError;
      state.pin = { message_id: messageId };
    },
  });
  const eventsub = new EventEmitter();
  eventsub.connect = () => {};
  eventsub.close = () => {};
  const autoPin = makeAutoPin([context], {
    eventsubFactory: () => eventsub,
    now: () => time,
    schedule(fn, delay) { const id = ++nextId; timers.set(id, { fn, at: time + delay }); return id; },
    cancel(id) { timers.delete(id); },
  });
  t.after(() => autoPin.stop());
  return {
    autoPin, eventsub, context, state, timers,
    async advance(ms) {
      const end = time + ms;
      while (true) {
        const next = [...timers].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        time = next[1].at;
        timers.delete(next[0]);
        await next[1].fn();
      }
      time = end;
    },
    event(type) { return autoPin.onStreamEvent(type, { broadcaster_user_id: context.ids.broadcasterId }); },
  };
}

test('после 47 часов пропущенные offline/online восстанавливаются через API', async (t) => {
  const s = recoverySetup(t);
  await s.autoPin.start();
  await s.advance(47 * 60 * 60 * 1000);
  assert.equal(s.state.sends, 0);
  assert.equal(s.state.pinChecks, 5, 'во время неизменного стрима закреп больше не проверяется');
  s.state.stream = null;
  s.state.pin = null;
  await s.advance(30_000);
  assert.equal(s.state.sends, 1);
  s.state.stream = { id: 'stream-2', started_at: '2026-09-26T23:00:00Z' };
  await s.advance(30_000);
  assert.equal(s.state.sends, 1, 'закреп между стримами сохраняется');
});

test('быстрый перезапуск между проверками определяется по ID трансляции', async (t) => {
  const s = recoverySetup(t);
  await s.autoPin.start();
  await s.advance(120_000);
  s.state.stream = { id: 'stream-2', started_at: '2026-09-25T00:03:00Z' };
  s.state.pin = null;
  await s.advance(30_000);
  assert.equal(s.state.sends, 1);
  assert.deepEqual(s.state.pins, ['sent-1']);
});

test('восстановление соединения сразу проверяет пропущенную смену стрима', async (t) => {
  const s = recoverySetup(t);
  await s.autoPin.start();
  await s.advance(120_000);
  s.state.stream = null;
  s.state.pin = null;
  s.eventsub.emit('connected');
  await s.autoPin.checkAll();
  assert.equal(s.state.sends, 1);
});

test('снятие закрепа посреди неизменного стрима не вызывает повторную отправку', async (t) => {
  const s = recoverySetup(t);
  await s.autoPin.start();
  await s.advance(120_000);
  const before = s.state.pinChecks;
  s.state.pin = null;
  await s.advance(300_000);
  s.eventsub.emit('connected');
  await s.autoPin.checkAll();
  await s.event('stream.online');
  assert.equal(s.state.sends, 0);
  assert.equal(s.state.pinChecks, before);
});

test('повторная проверка ловит снятие старого закрепа с задержкой', async (t) => {
  const s = recoverySetup(t);
  await s.autoPin.start();
  await s.advance(120_000);
  s.state.stream = null;
  await s.event('stream.offline');
  assert.equal(s.state.sends, 0);
  s.state.pin = null;
  await s.advance(30_000);
  assert.equal(s.state.sends, 1);
});

test('неудачный pin повторяется с тем же сообщением, даже после окна проверки', async (t) => {
  const s = recoverySetup(t);
  s.state.pin = null;
  s.state.pinError = new Error('temporary pin failure');
  await s.autoPin.start();
  await s.advance(150_000);
  assert.equal(s.state.sends, 1);
  assert.ok(s.state.pins.every((id) => id === 'sent-1'));
  s.state.pinError = null;
  await s.advance(30_000);
  assert.equal(s.state.pin.message_id, 'sent-1');
  assert.equal(s.state.sends, 1);
  assert.equal(s.autoPin.recoveryByChannel.size, 0);
});

test('удалённое сообщение заменяется только после ответа 404', async (t) => {
  const s = recoverySetup(t);
  s.state.pin = null;
  s.state.pinError = Object.assign(new Error('not found'), { status: 404 });
  await s.autoPin.start();
  s.state.pinError = null;
  await s.advance(30_000);
  assert.equal(s.state.sends, 2);
  assert.equal(s.state.pin.message_id, 'sent-2');
});

test('ошибка стартового запроса не останавливает резервную проверку', async (t) => {
  const s = recoverySetup(t);
  s.state.streamError = new Error('temporary API failure');
  s.state.pin = null;
  await s.autoPin.start();
  s.state.streamError = null;
  await s.advance(30_000);
  assert.equal(s.state.sends, 1);
});

test('дубликаты событий и параллельная проверка не дублируют сообщение', async (t) => {
  const s = recoverySetup(t);
  await s.autoPin.start();
  await s.advance(120_000);
  s.state.stream = { id: 'new', started_at: 'new-time' };
  s.state.pin = null;
  await Promise.all([s.event('stream.online'), s.event('stream.online'), s.autoPin.checkAll()]);
  assert.equal(s.state.sends, 1);
  assert.deepEqual(s.state.pins, ['sent-1']);
});

test('запоздавшее offline не перезаписывает состояние уже начавшегося стрима', async (t) => {
  const s = recoverySetup(t);
  await s.autoPin.start();
  await s.advance(120_000);
  const before = s.state.pinChecks;
  await s.event('stream.offline');
  assert.equal(s.state.pinChecks, before);
  assert.equal(s.autoPin.streamByChannel.get('cacto0o'), 'stream-1:2026-09-25T00:00:00Z');
});

test('stop отменяет проверки и блокирует действия после незавершённого API-запроса', async (t) => {
  const s = recoverySetup(t);
  await s.autoPin.start();
  let release;
  s.context.helix.getPinnedChatMessage = () => new Promise((resolve) => { release = resolve; });
  const running = s.autoPin.checkAll();
  await new Promise(setImmediate);
  s.autoPin.stop();
  release(null);
  await running;
  await s.advance(60_000);
  await s.event('stream.offline');
  assert.equal(s.timers.size, 0);
  assert.equal(s.state.sends, 0);
});

test('новый стрим во время offline-паузы учитывается перед созданием закрепа', async (t) => {
  const s = recoverySetup(t);
  await s.autoPin.start();
  await s.advance(120_000);
  s.autoPin.cfg.offlineDelayMs = 3000;
  s.autoPin.sleep = async () => { s.state.stream = { id: 'new-stream', started_at: 'new-time' }; };
  s.state.stream = null;
  s.state.pin = null;
  await s.event('stream.offline');
  assert.equal(s.autoPin.streamByChannel.get('cacto0o'), 'new-stream:new-time');
  assert.equal(s.state.sends, 1);
  await s.event('stream.online');
  assert.equal(s.state.sends, 1);
});

test('ошибка одного канала не мешает восстановить закреп второго', async (t) => {
  const sent = [];
  const broken = makeContext('cacto0o', { async getStream() { throw new Error('channel API unavailable'); } });
  const healthy = makeContext('tiltocacto0o', {
    async getStream() { return null; },
    async getPinnedChatMessage() { return null; },
    async sendChatMessage(params) { sent.push(params); return { is_sent: true, message_id: 'message' }; },
    async pinChatMessage() {},
  });
  const autoPin = makeAutoPin([broken, healthy]);
  t.after(() => autoPin.stop());
  await autoPin.checkAll();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].broadcasterId, healthy.ids.broadcasterId);
  assert.equal(sent[0].message, messages.get('tiltocacto0o'));
});
