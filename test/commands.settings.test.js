import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCommandHandler, KNOWN } from '../src/commands.js';
import { FUN_COMMANDS } from '../src/funCommands.js';
import { CommandSettings } from '../src/commandSettings.js';

function setup(commandSettings = new CommandSettings(), channel = 'cacto0o', overrides = {}) {
  const sent = [], games = [];
  let requests = 0;
  const handler = createCommandHandler({
    config: { channel, mods: new Set(['moderator']), trackCooldownMs: 0, music: { enabled: true }, ...overrides },
    chat: { say: (text) => sent.push(text) },
    ids: { botLogin: 'peeacefullbot' },
    commandSettings,
    funCommands: async (msg) => { games.push(msg.text); return msg.text === '!вкл'; },
    yandexMusic: { getCurrentTrack: async () => { requests++; throw new Error('extension missing'); } },
  });
  return { sent, games, requests: () => requests,
    send: (text, login = 'moderator', extra = {}) => handler({ text, login, displayName: login, ...extra }) };
}

test('disabled track never calls provider or replies, enabling restores it', async () => {
  const ctx = setup();
  await ctx.send('!откл !ТРЕК\u200b');
  assert.match(ctx.sent.pop(), /!трек отключена/);
  await ctx.send('!трек', 'viewer');
  await ctx.send('!трек');
  assert.equal(ctx.requests(), 0);
  assert.deepEqual(ctx.sent, []);
  await ctx.send('!вкл трек');
  assert.match(ctx.sent.pop(), /!трек включена/);
  await ctx.send('!трек', 'viewer');
  assert.equal(ctx.requests(), 1);
  assert.match(ctx.sent[0], /Не удалось определить/);
});

test('env prohibitions silence every command including controls for owners and moderators', async () => {
  const names = [...KNOWN, ...FUN_COMMANDS, '!откл'];
  const settings = new CommandSettings();
  const ctx = setup(settings, 'any_channel', { disabledCommands: new Set(names), allowChannelModerators: true });
  for (const name of names) {
    await ctx.send(`${name.toUpperCase()}\u200b`, 'any_channel');
    await ctx.send(name, 'local_mod', { isMod: true });
  }
  await ctx.send('!вкл бал');
  await ctx.send('!откл бал');
  assert.deepEqual(ctx.sent, []);
  assert.deepEqual(ctx.games, []);
  assert.equal(ctx.requests(), 0);
  assert.equal(settings.disabled.size, 0);
});

test('chat controls cannot override an env prohibition', async () => {
  const settings = new CommandSettings();
  const ctx = setup(settings, 'any_channel', { disabledCommands: new Set(['!бал']) });
  await ctx.send('!вкл бал');
  assert.match(ctx.sent.pop(), /отключена в настройках .env/);
  await ctx.send('!бал', 'any_channel');
  assert.deepEqual(ctx.sent, []);
  assert.deepEqual(ctx.games, []);
});

test('no-music profile ignores !трек even with an available provider', async () => {
  const ctx = setup(new CommandSettings(), 'any_channel', { music: { enabled: false } });
  await ctx.send('!трек', 'any_channel');
  await ctx.send('!трек', 'viewer');
  assert.equal(ctx.requests(), 0);
  assert.deepEqual(ctx.sent, []);
  await ctx.send('!вкл трек');
  assert.match(ctx.sent[0], /недоступна/);
});

test('only channel owner and MODS can change settings', async () => {
  const settings = new CommandSettings();
  const ctx = setup(settings);
  for (const extra of [{}, { isMod: true }, { isVip: true }, { isSub: true }]) {
    await ctx.send('!откл трек', 'viewer', extra);
  }
  assert.deepEqual(ctx.sent, []);
  assert.equal(settings.isDisabled('!трек'), false);
  await ctx.send('!откл трек', 'cacto0o');
  assert.equal(settings.isDisabled('!трек'), true);
  await ctx.send('!вкл трек', 'viewer');
  assert.equal(settings.isDisabled('!трек'), true);
});

test('validation and protected controls; unknown top-level commands stay silent', async () => {
  const ctx = setup();
  for (const text of ['!откл', '!откл трек пинг', '!откл unknown', '!откл вкл', '!откл откл', '!вкл трек пинг']) {
    await ctx.send(text);
    assert.match(ctx.sent.pop(), /ошибка выполнения команды.*Шаблон команды/);
  }
  await ctx.send('!unknown');
  assert.deepEqual(ctx.sent, []);
});

test('games are filtered before dispatch; bare !вкл keeps its original behavior', async () => {
  const ctx = setup();
  await ctx.send('!откл бал');
  await ctx.send('!бал', 'viewer');
  assert.deepEqual(ctx.games, []);
  await ctx.send('!вкл');
  await ctx.send('!бал', 'viewer');
  assert.deepEqual(ctx.games, ['!вкл']);
  await ctx.send('!вкл бал');
  await ctx.send('!бал', 'viewer');
  assert.deepEqual(ctx.games, ['!вкл', '!бал']);
});

test('settings persist across restart and remain isolated per channel', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'command-settings-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'cacto0o.json');
  await setup(new CommandSettings(file)).send('!откл трек');
  const restored = new CommandSettings(file);
  assert.equal(restored.isDisabled('!трек'), true);
  const second = new CommandSettings(path.join(dir, 'tiltocacto0o.json'));
  assert.equal(second.isDisabled('!трек'), false);
  await setup(restored).send('!вкл трек');
  assert.equal(new CommandSettings(file).isDisabled('!трек'), false);
});

test('failed save does not disable command or report success', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'command-settings-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const settings = new CommandSettings(path.join(dir, 'settings.json'));
  fs.mkdirSync(settings.file);
  const ctx = setup(settings);
  await ctx.send('!откл трек');
  assert.equal(settings.isDisabled('!трек'), false);
  assert.match(ctx.sent[0], /Не удалось сохранить настройки.*Шаблон команды/);
});
