import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCommandHandler } from '../src/commands.js';

function viewerMessage(login, id = `${login}-message`) {
  return {
    id,
    login,
    displayName: login,
    text: '!трек',
    isBroadcaster: false,
    isMod: false,
    isVip: false,
    isSub: false,
  };
}

function makeHandler({ result, clock = () => 1_000 }) {
  const sent = [];
  let calls = 0;
  const handler = createCommandHandler({
    config: { channel: 'cacto0o', mods: new Set(), trackCooldownMs: 5000, music: { enabled: true } },
    chat: {
      say(text, options) {
        sent.push({ text, options });
      },
    },
    helix: {},
    templates: {},
    gameTemplates: {},
    yandexMusic: {
      async getCurrentTrack() {
        calls++;
        return result;
      },
    },
    ids: { botLogin: 'peeacefullbot' },
    now: clock,
  });
  return { handler, sent, getCalls: () => calls };
}

test('!трек доступен обычному зрителю и отвечает настоящим Twitch reply', async () => {
  const ctx = makeHandler({ result: { status: 'playing', artist: 'babyteen, Harle', title: 'schizo' } });
  await ctx.handler(viewerMessage('viewer'));

  assert.equal(ctx.getCalls(), 1);
  assert.deepEqual(ctx.sent, [
    {
      text: 'Сейчас играет: babyteen, Harle - schizo',
      options: { replyTo: 'viewer-message' },
    },
  ]);
});

test('!трек сообщает об отсутствии воспроизведения точной фразой', async () => {
  const ctx = makeHandler({ result: { status: 'idle' } });
  await ctx.handler(viewerMessage('viewer'));

  assert.equal(ctx.sent[0].text, 'Сейчас музыка не воспроизводится.');
  assert.deepEqual(ctx.sent[0].options, { replyTo: 'viewer-message' });
});

test('!трек использует общий cooldown 5 секунд для всего чата', async () => {
  let currentTime = 10_000;
  const ctx = makeHandler({ result: { status: 'idle' }, clock: () => currentTime });

  await ctx.handler(viewerMessage('first'));
  currentTime += 4_999;
  await ctx.handler(viewerMessage('second'));
  assert.equal(ctx.getCalls(), 1);

  currentTime += 1;
  await ctx.handler(viewerMessage('third'));
  assert.equal(ctx.getCalls(), 2);
  assert.equal(ctx.sent.length, 2);
});
