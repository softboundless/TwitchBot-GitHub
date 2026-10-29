import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseEnv } from 'node:util';
import http from 'node:http';
import { createSetupServer } from '../setup/server.js';
import { defaults, commands, serializeEnv, validateValues } from '../setup/schema.js';
import { FUN_COMMANDS } from '../src/funCommands.js';
import { KNOWN } from '../src/commands.js';

const valid = () => ({ ...defaults, TWITCH_CLIENT_ID: 'test-client', TWITCH_CLIENT_SECRET: 'test-secret', TWITCH_CHANNELS: 'streamer,second' });
async function fixture(t) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'twitch-setup-'));
  const server = createSetupServer({ directory: dir });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => server.close(resolve)); await fs.rm(dir, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const state = await (await fetch(url + '/api/config')).json();
  const post = (payload, headers = {}) => fetch(url + '/api/config', { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Setup-Token': state.csrfToken, ...headers }, body: JSON.stringify(payload) });
  return { dir, server, url, state, post };
}

test('панель запускается без .env и не возвращает секреты после сохранения', async t => {
  const f = await fixture(t);
  assert.equal(f.state.exists, false);
  assert.equal(f.state.values.MUSIC_ENABLED, 'false');
  const values = { ...valid(), MODS_SECOND: '', AUTO_PIN_MESSAGE_SECOND: 'Текст #1 | "цитата"', DISABLED_COMMANDS: '!пинг,!откл', DISABLED_COMMANDS_SECOND: '!каз' };
  const res = await f.post({ values });
  assert.equal(res.status, 200, await res.text());
  const saved = parseEnv(await fs.readFile(path.join(f.dir, '.env'), 'utf8'));
  assert.equal(saved.TWITCH_CLIENT_SECRET, 'test-secret');
  assert.equal(saved.AUTO_PIN_MESSAGE_SECOND, values.AUTO_PIN_MESSAGE_SECOND);
  const current = await (await fetch(f.url + '/api/config')).json();
  assert.equal(current.exists, true);
  assert.equal(current.values.TWITCH_CLIENT_SECRET, undefined);
  assert.ok(current.secretsSet.includes('TWITCH_CLIENT_SECRET'));
  assert.equal(JSON.stringify(current).includes('test-secret'), false);
  assert.equal((await fetch(f.url + '/.env')).status, 404);
  assert.equal((await fetch(f.url + '/src/config.js')).status, 404);
});

test('секрет сохраняется при пустом поле; удаление только по явному выбору', async t => {
  const f = await fixture(t);
  await f.post({ values: { ...valid(), GROQCLOUD_API_KEY: 'fake-groq', MODS_SECOND: 'helper' } });
  assert.equal((await f.post({ values: { TWITCH_CLIENT_SECRET: '', GROQCLOUD_API_KEY: '', MODS: 'globalmod' }, clearSecrets: ['GROQCLOUD_API_KEY'], deleteKeys: ['MODS_SECOND'] })).status, 200);
  const saved = parseEnv(await fs.readFile(path.join(f.dir, '.env'), 'utf8'));
  assert.equal(saved.TWITCH_CLIENT_SECRET, 'test-secret');
  assert.equal(saved.GROQCLOUD_API_KEY, '');
  assert.equal(saved.MODS, 'globalmod');
  assert.equal(Object.hasOwn(saved, 'MODS_SECOND'), false);
});

test('посторонний сайт, чужой Host и запрос без CSRF не могут изменить настройки', async t => {
  const f = await fixture(t);
  for (const headers of [{ Origin: 'https://outside.example' }, { 'X-Setup-Token': '' }]) {
    assert.equal((await f.post({ values: valid() }, headers)).status, 403);
  }
  await assert.rejects(fs.access(path.join(f.dir, '.env')));
  const hostStatus = await new Promise((resolve, reject) => {
    http.get(f.url + '/api/config', { headers: { Host: 'outside.example' } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject);
  });
  assert.equal(hostStatus, 403);
});

test('невалидные значения не портят .env и не позволяют внедрять другие переменные', async t => {
  const f = await fixture(t);
  await f.post({ values: valid() });
  const before = await fs.readFile(path.join(f.dir, '.env'), 'utf8');
  for (const values of [{ NODE_OPTIONS: '--inspect' }, { MODS: 'good\nINJECTED=true' }, { DISABLED_COMMANDS: '!madeup' }, { TWITCH_CHANNELS: '../escape' }, { TRACK_BRIDGE_PORT: 'NaN' }, { AUTO_UNBAN: 'true', AUTO_UNBAN_TARGET: '' }, { AUTO_PIN: 'true' }, { GAMES_CHANNELS: 'unknown' }]) {
    const r = await f.post({ values });
    assert.equal(r.status, 400, JSON.stringify(values));
    assert.equal(await fs.readFile(path.join(f.dir, '.env'), 'utf8'), before);
  }
});

test('сериализация .env сохраняет #, кавычки, пробелы, обратные слеши', () => {
  const values = { TEXT: '  текст # хэш "ok" \\bin\\python.exe  ', SECRET: "value'with#symbols", EMPTY: '' };
  assert.deepEqual(parseEnv(serializeEnv(values)), values);
  assert.throws(() => serializeEnv({ TEXT: 'bad\nKEY=value' }));
});

test('каталог панели содержит все игровые команды и управление командами', () => {
  const known = new Set(commands.map(c => c.name));
  for (const name of [...FUN_COMMANDS, ...KNOWN, '!откл']) assert.ok(known.has(name), name);
  assert.equal(known.size, commands.length);
  const values = valid();
  values.TWITCH_CHANNELS = '#Streamer,second,streamer';
  assert.equal(validateValues(values).TWITCH_CHANNELS, 'streamer,second');
});
