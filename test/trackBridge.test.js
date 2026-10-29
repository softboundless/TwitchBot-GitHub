import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TrackBridge, TrackProvider, validateFossabotRequest } from '../src/trackBridge.js';

const secret = 's'.repeat(64);

test('health returns 503 when Twitch disconnects and 200 after recovery', async () => {
  let twitchConnected = false;
  const bridge = new TrackBridge({ secret, port: 0, getChatHealth: () => ({ twitchConnected }) });
  await bridge.start();
  try {
    const url = `http://127.0.0.1:${bridge.port}/health`;
    const offline = await fetch(url);
    assert.equal(offline.status, 503);
    assert.deepEqual(await offline.json(), { ok: false, fresh: false, twitchConnected: false });
    twitchConnected = true;
    const online = await fetch(url);
    assert.equal(online.status, 200);
    assert.equal((await online.json()).twitchConnected, true);
  } finally { await bridge.close(); }
});

async function post(bridge, payload, requestSecret = secret) {
  return fetch(`http://127.0.0.1:${bridge.port}/api/track`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Track-Secret': requestSecret,
    },
    body: JSON.stringify(payload),
  });
}

function fossabotHeaders(token = 'valid-token', channel = 'cacto0o') {
  return {
    'x-fossabot-channellogin': channel,
    'x-fossabot-channelprovider': 'twitch',
    'x-fossabot-customapitoken': token,
  };
}

function makeFossabotFetch({ contextChannel = 'cacto0o', contextUrlOrigin = 'https://api.fossabot.com' } = {}) {
  const calls = [];
  const fetchFn = async (url) => {
    const value = String(url);
    calls.push(value);
    if (value.includes('/v2/customapi/validate/')) {
      const token = value.split('/').at(-1);
      return new Response(
        JSON.stringify({ context_url: `${contextUrlOrigin}/v2/customapi/context/${token}` }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    if (value.startsWith('https://api.fossabot.com/v2/customapi/context/')) {
      return new Response(
        JSON.stringify({
          channel: { login: contextChannel, provider: 'twitch' },
          message: { provider: 'twitch', user: { login: 'viewer' } },
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } },
      );
    }
    throw new Error(`unexpected URL: ${value}`);
  };
  return { fetchFn, calls };
}

test('TrackBridge принимает защищённое состояние и перестаёт доверять устаревшему', async () => {
  let currentTime = 10_000;
  const bridge = new TrackBridge({ secret, port: 0, maxAgeMs: 15_000, now: () => currentTime });
  await bridge.start();
  try {
    const response = await post(bridge, { playing: true, artist: 'babyteen, Harle', title: 'schizo' });
    assert.equal(response.status, 204);
    assert.deepEqual(bridge.getCurrentTrack(), {
      status: 'playing',
      artist: 'babyteen, Harle',
      title: 'schizo',
    });

    currentTime += 15_001;
    assert.equal(bridge.getCurrentTrack(), null);
  } finally {
    await bridge.close();
  }
});

test('TrackBridge отклоняет неверный секрет и отражает паузу', async () => {
  const bridge = new TrackBridge({ secret, port: 0 });
  await bridge.start();
  try {
    assert.equal((await post(bridge, { playing: true, title: 'wrong' }, 'wrong')).status, 401);
    assert.equal(bridge.getCurrentTrack(), null);

    assert.equal((await post(bridge, { playing: false, artist: '', title: '' })).status, 204);
    assert.deepEqual(bridge.getCurrentTrack(), { status: 'idle' });
  } finally {
    await bridge.close();
  }
});

test('TrackProvider предпочитает браузер и использует Ynison только без свежего состояния', async () => {
  let bridgeState = { status: 'playing', artist: 'Browser', title: 'Track' };
  let fallbackCalls = 0;
  const provider = new TrackProvider({
    bridge: { getCurrentTrack: () => bridgeState },
    fallback: {
      async getCurrentTrack() {
        fallbackCalls++;
        return { status: 'idle' };
      },
    },
  });

  assert.deepEqual(await provider.getCurrentTrack(), bridgeState);
  assert.equal(fallbackCalls, 0);
  bridgeState = null;
  assert.deepEqual(await provider.getCurrentTrack(), { status: 'idle' });
  assert.equal(fallbackCalls, 1);
});

test('Fossabot endpoint возвращает точный текст трека только после проверки запроса', async () => {
  const fossabot = makeFossabotFetch();
  const bridge = new TrackBridge({
    secret,
    port: 0,
    fossabot: { enabled: true, channel: 'cacto0o', fetchFn: fossabot.fetchFn },
  });
  await bridge.start();
  try {
    await post(bridge, { playing: true, artist: 'тёмный принц', title: 'paprika' });
    const response = await fetch(`http://127.0.0.1:${bridge.port}/api/fossabot/track`, {
      headers: fossabotHeaders(),
    });

    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/plain/);
    assert.equal(await response.text(), 'Сейчас играет: тёмный принц - paprika');
    assert.equal(fossabot.calls.length, 2);
  } finally {
    await bridge.close();
  }
});

test('Fossabot endpoint не раскрывает трек запросу без заголовков Fossabot', async () => {
  const fossabot = makeFossabotFetch();
  const bridge = new TrackBridge({
    secret,
    port: 0,
    fossabot: { enabled: true, channel: 'cacto0o', fetchFn: fossabot.fetchFn },
  });
  await bridge.start();
  try {
    await post(bridge, { playing: true, artist: 'Private', title: 'Track' });
    const response = await fetch(`http://127.0.0.1:${bridge.port}/api/fossabot/track`);
    assert.equal(response.status, 403);
    assert.equal(await response.text(), '');
    assert.equal(fossabot.calls.length, 0);
  } finally {
    await bridge.close();
  }
});

test('Fossabot endpoint возвращает фразу о паузе и отклоняет другой канал', async () => {
  const validFossabot = makeFossabotFetch();
  const bridge = new TrackBridge({
    secret,
    port: 0,
    fossabot: { enabled: true, channel: 'cacto0o', fetchFn: validFossabot.fetchFn },
  });
  await bridge.start();
  try {
    await post(bridge, { playing: false, artist: '', title: '' });
    const idleResponse = await fetch(`http://127.0.0.1:${bridge.port}/api/fossabot/track`, {
      headers: fossabotHeaders('idle-token'),
    });
    assert.equal(idleResponse.status, 200);
    assert.equal(await idleResponse.text(), 'Сейчас музыка не воспроизводится.');

    const wrongChannelResponse = await fetch(`http://127.0.0.1:${bridge.port}/api/fossabot/track`, {
      headers: { ...fossabotHeaders('wrong-channel'), 'x-fossabot-channellogin': 'otherchannel' },
    });
    assert.equal(wrongChannelResponse.status, 403);
  } finally {
    await bridge.close();
  }
});

test('проверка Fossabot не переходит по подменённому context_url', async () => {
  const fossabot = makeFossabotFetch({ contextUrlOrigin: 'https://attacker.example' });
  const context = await validateFossabotRequest({
    headers: fossabotHeaders(),
    channel: 'cacto0o',
    fetchFn: fossabot.fetchFn,
  });
  assert.equal(context, null);
  assert.equal(fossabot.calls.length, 1);
});

test('проверка Fossabot принимает любой канал из настроенного списка', async () => {
  const fossabot = makeFossabotFetch({ contextChannel: 'tiltocacto0o' });
  const context = await validateFossabotRequest({
    headers: fossabotHeaders('second-channel', 'tiltocacto0o'),
    channels: ['cacto0o', 'tiltocacto0o'],
    fetchFn: fossabot.fetchFn,
  });

  assert.equal(context?.channel?.login, 'tiltocacto0o');
  assert.equal(fossabot.calls.length, 2);
});
