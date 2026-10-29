import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHelix } from '../src/helix.js';

test('Helix отправляет сообщение отдельно и закрепляет его без ограничения длительности', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url: new URL(url), options });
    if (String(url).includes('/chat/messages')) {
      return new Response(JSON.stringify({ data: [{ message_id: 'message-1', is_sent: true }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(null, { status: 204 });
  };

  try {
    const store = { async ensureFresh() { return 'token'; } };
    const helix = makeHelix({ clientId: 'client-id' }, store, store);

    const sent = await helix.sendChatMessage({
      broadcasterId: 'broadcaster-id',
      senderId: 'bot-id',
      message: 'Закреп',
    });
    await helix.pinChatMessage({
      broadcasterId: 'broadcaster-id',
      moderatorId: 'bot-id',
      messageId: sent.message_id,
    });

    assert.equal(requests[0].options.method, 'POST');
    assert.deepEqual(JSON.parse(requests[0].options.body), {
      broadcaster_id: 'broadcaster-id',
      sender_id: 'bot-id',
      message: 'Закреп',
    });
    assert.equal(requests[1].options.method, 'PUT');
    assert.equal(requests[1].url.searchParams.get('message_id'), 'message-1');
    assert.equal(requests[1].url.searchParams.has('duration_seconds'), false);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('getStream сохраняет ID трансляции, а пустой ответ означает офлайн', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const stream = { id: 'stream-42', started_at: '2026-09-25T12:00:00Z' };
  let live = true;
  globalThis.fetch = async (url) => {
    assert.equal(new URL(url).searchParams.get('user_id'), 'channel-id');
    return Response.json({ data: live ? [stream] : [] });
  };
  const store = { async ensureFresh() { return 'token'; } };
  const helix = makeHelix({ clientId: 'client' }, store, store);
  assert.deepEqual(await helix.getStream('channel-id'), stream);
  assert.equal(await helix.isStreamLive('channel-id'), true);
  live = false;
  assert.equal(await helix.getStream('channel-id'), null);
  assert.equal(await helix.isStreamLive('channel-id'), false);
});
