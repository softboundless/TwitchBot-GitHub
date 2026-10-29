import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { parseEnv } from 'node:util';
import { createSetupServer, writeSettings } from '../setup/server.js';
import { defaults } from '../setup/schema.js';
import { channelDataPaths } from '../src/channelPolicy.js';
import { CommandSettings } from '../src/commandSettings.js';

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'setup-commands-'));
  await writeSettings(directory, { ...defaults, TWITCH_CLIENT_ID: 'test', TWITCH_CLIENT_SECRET: 'test-secret', TWITCH_CHANNELS: 'streamer,second' });
  for (const channel of ['streamer', 'second']) {
    const commandFile = channelDataPaths(path.join(directory, 'data', 'fun'), channel).commands;
    const settings = new CommandSettings(commandFile);
    settings.setDisabled('!пинг', true);
    settings.setDisabled('!бал', true);
  }
  const server = createSetupServer({ directory });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await fs.rm(directory, { recursive: true, force: true });
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const state = () => fetch(url + '/api/config').then(r => r.json());
  const csrfToken = (await state()).csrfToken;
  const post = payload => fetch(url + '/api/config', {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Setup-Token': csrfToken }, body: JSON.stringify(payload),
  });
  const commandFile = channel => channelDataPaths(path.join(directory, 'data', 'fun'), channel).commands;
  return { directory, url, state, post, commandFile };
}

test('panel reports persistent chat disables and removes only commands explicitly enabled in one channel', async t => {
  const f = await fixture(t);
  assert.deepEqual((await f.state()).chatDisabledCommands, { streamer: ['!бал', '!пинг'], second: ['!бал', '!пинг'] });
  const response = await f.post({ values: { DISABLED_COMMANDS: '!каз' }, enableChatCommands: { streamer: ['!пинг'] } });
  assert.equal(response.status, 200, await response.text());
  assert.deepEqual(new CommandSettings(f.commandFile('streamer')).disabled, new Set(['!бал']));
  assert.deepEqual(new CommandSettings(f.commandFile('second')).disabled, new Set(['!бал', '!пинг']));
  assert.deepEqual((await f.state()).chatDisabledCommands.streamer, ['!бал']);
  const env = parseEnv(await fs.readFile(path.join(f.directory, '.env'), 'utf8'));
  assert.equal(env.DISABLED_COMMANDS, '!каз');
  assert.equal(Object.hasOwn(env, 'enableChatCommands'), false);
  assert.equal(Object.hasOwn(env, 'chatDisabledCommands'), false);
});

test('forged channels, traversal and unknown commands are rejected before changing files', async t => {
  const f = await fixture(t);
  const before = await fs.readFile(f.commandFile('streamer'), 'utf8');
  const envBefore = await fs.readFile(path.join(f.directory, '.env'), 'utf8');
  for (const requested of [{ unknown: ['!пинг'] }, { '../escape': ['!пинг'] }, { streamer: ['!madeup'] }, { streamer: '!пинг' }, []]) {
    assert.equal((await f.post({ values: { DISABLED_COMMANDS: '!каз' }, enableChatCommands: requested })).status, 400);
    assert.equal(await fs.readFile(f.commandFile('streamer'), 'utf8'), before);
    assert.equal(await fs.readFile(path.join(f.directory, '.env'), 'utf8'), envBefore);
  }
});

test('corrupt persisted command data is reported and never overwritten', async t => {
  const f = await fixture(t);
  await fs.writeFile(f.commandFile('streamer'), '{broken');
  const response = await f.post({ values: {}, enableChatCommands: { streamer: ['!пинг'] } });
  assert.equal(response.status, 400);
  assert.match((await response.json()).error, /повреждён/);
  assert.equal(await fs.readFile(f.commandFile('streamer'), 'utf8'), '{broken');
  assert.match((await f.state()).error, /повреждён/);
});

test('later save failure rolls back already replaced chat settings', async t => {
  const f = await fixture(t);
  const envFile = path.join(f.directory, '.env');
  const before = await fs.readFile(f.commandFile('streamer'), 'utf8');
  const envBefore = await fs.readFile(envFile, 'utf8');
  const rename = fs.rename;
  const mock = t.mock.method(fs, 'rename', async (source, target) => {
    if (target === envFile) throw Object.assign(new Error('simulated write failure'), { code: 'EACCES' });
    return rename(source, target);
  });
  try {
    assert.equal((await f.post({ values: { DISABLED_COMMANDS: '!каз' }, enableChatCommands: { streamer: ['!пинг'] } })).status, 500);
    assert.equal(await fs.readFile(f.commandFile('streamer'), 'utf8'), before);
    assert.equal(await fs.readFile(envFile, 'utf8'), envBefore);
  } finally { mock.mock.restore(); }
});

test('malformed request target does not stop the local setup server', async t => {
  const f = await fixture(t);
  const target = new URL(f.url);
  const status = await new Promise((resolve, reject) => {
    const req = http.request({ hostname: target.hostname, port: target.port, path: 'http://[', method: 'GET' }, res => { res.resume(); resolve(res.statusCode); });
    req.on('error', reject);
    req.end();
  });
  assert.ok(status >= 400);
  assert.equal((await fetch(f.url + '/api/config')).status, 200);
});
