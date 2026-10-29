import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeHelix } from '../src/helix.js';

test('timeout sends bot token and explicit duration; missing duration cannot become permanent ban', async (t) => {
  const originalFetch = globalThis.fetch;
  t.after(() => { globalThis.fetch = originalFetch; });
  const requests = [];
  globalThis.fetch = async (url, options) => {
    requests.push({ url, options });
    return new Response(JSON.stringify({ data: [] }), { status: 200 });
  };
  const helix = makeHelix({ clientId: 'client' }, { ensureFresh: async () => 'bot-token' }, {});
  const args = { broadcasterId: 'channel', moderatorId: 'bot', userId: 'viewer', duration: 120, reason: 'roulette' };
  await helix.timeoutUser(args);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url.pathname, '/helix/moderation/bans');
  assert.equal(requests[0].url.searchParams.get('broadcaster_id'), 'channel');
  assert.equal(requests[0].url.searchParams.get('moderator_id'), 'bot');
  assert.equal(requests[0].options.method, 'POST');
  assert.equal(requests[0].options.headers.Authorization, 'Bearer bot-token');
  assert.deepEqual(JSON.parse(requests[0].options.body), { data: { user_id: 'viewer', duration: 120, reason: 'roulette' } });
  await assert.rejects(helix.timeoutUser({ ...args, duration: undefined }));
  assert.equal(requests.length, 1);
});
