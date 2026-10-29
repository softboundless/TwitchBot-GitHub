import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TwitchChat } from '../src/irc.js';

function setup(t, tokenStore = { login: 'bot', ensureFresh: async () => 'test-token' }) {
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const sockets = [];
  class Socket extends EventTarget {
    static OPEN = 1;
    constructor() { super(); this.readyState = 0; this.sent = []; sockets.push(this); }
    send(s) { this.sent.push(s); }
    close() {
      this.closeCount = (this.closeCount ?? 0) + 1;
      assert.ok(this.closeCount < 3, 'close must not recursively emit errors');
      this.emit('error'); // Reproduces error-during-close without a close event.
      this.readyState = 3;
    }
    emit(type, data) {
      const event = new Event(type);
      event.data = data;
      this.dispatchEvent(event);
    }
    join() {
      this.readyState = 1;
      this.emit('open');
      this.emit('message', ':tmi.twitch.tv 001 bot :Welcome\r\n:bot!bot@host JOIN #one\r\n:bot!bot@host JOIN #two');
    }
  }
  const previous = globalThis.WebSocket;
  globalThis.WebSocket = Socket;
  const chat = new TwitchChat({ channels: ['one', 'two'], tokenStore });
  t.after(() => { chat.close(); globalThis.WebSocket = previous; });
  return { chat, sockets };
}

test('socket error reconnects without close event; old socket cannot disturb recovery', async (t) => {
  const { chat, sockets } = setup(t);
  await chat.connect();
  sockets[0].emit('error');
  assert.equal(sockets[0].closeCount, 1);
  assert.equal(chat.getHealth().twitchConnected, false);
  t.mock.timers.tick(1000);
  await Promise.resolve();
  assert.equal(sockets.length, 2);
  sockets[1].join();
  assert.equal(chat.getHealth().twitchConnected, true);
  sockets[0].emit('close');
  sockets[0].emit('error');
  t.mock.timers.tick(5000);
  assert.equal(sockets.length, 2);
  assert.equal(chat.getHealth().twitchConnected, true);
});

test('connection/authentication timeout retries and close cancels pending retry', async (t) => {
  const { chat, sockets } = setup(t);
  await chat.connect();
  t.mock.timers.tick(30_000);
  t.mock.timers.tick(1000);
  await Promise.resolve();
  assert.equal(sockets.length, 2);
  sockets[1].emit('error');
  chat.close();
  t.mock.timers.tick(60_000);
  await Promise.resolve();
  assert.equal(sockets.length, 2);
});

test('heartbeat detects silent connection loss; PONG keeps a live connection', async (t) => {
  const { chat, sockets } = setup(t);
  await chat.connect();
  sockets[0].join();
  t.mock.timers.tick(60_000);
  assert.equal(sockets[0].sent.at(-1), 'PING :pcflbot');
  sockets[0].emit('message', ':tmi.twitch.tv PONG tmi.twitch.tv :pcflbot');
  t.mock.timers.tick(30_000);
  assert.equal(chat.getHealth().twitchConnected, true);
  t.mock.timers.tick(30_000);
  t.mock.timers.tick(30_000);
  assert.equal(chat.getHealth().twitchConnected, false);
  t.mock.timers.tick(1000);
  await Promise.resolve();
  assert.equal(sockets.length, 2);
});

test('late token resolution after timeout or shutdown never creates stale sockets', async (t) => {
  const resolvers = [];
  const { chat, sockets } = setup(t, { login: 'bot', ensureFresh: () => new Promise((resolve) => resolvers.push(resolve)) });
  const first = chat.connect();
  t.mock.timers.tick(30_000);
  t.mock.timers.tick(1000);
  resolvers[0]('old-token');
  await first;
  assert.equal(sockets.length, 0);
  chat.close();
  resolvers[1]('late-token');
  await Promise.resolve();
  assert.equal(sockets.length, 0);
});

test('token refresh rejection retries, and health requires all channel joins', async (t) => {
  let attempts = 0;
  const { chat, sockets } = setup(t, { login: 'bot', ensureFresh: async () => {
    if (++attempts === 1) throw new Error('temporary network outage');
    return 'test-token';
  } });
  await chat.connect();
  t.mock.timers.tick(1000);
  await Promise.resolve();
  sockets[0].readyState = 1;
  sockets[0].emit('open');
  sockets[0].emit('message', ':tmi.twitch.tv 001 bot :Welcome\r\n:bot!bot@host JOIN #one');
  assert.equal(chat.getHealth().twitchConnected, false);
  sockets[0].emit('message', ':bot!bot@host JOIN #two');
  assert.equal(chat.getHealth().twitchConnected, true);
});
