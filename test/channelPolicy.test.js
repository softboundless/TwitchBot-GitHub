import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { channelConfig, channelDataPaths, gamesEnabled, trackEnabled } from '../src/channelPolicy.js';
import { FunStore } from '../src/funStore.js';
import { FunSettings } from '../src/funSettings.js';
import { CommandSettings } from '../src/commandSettings.js';
import { Templates } from '../src/templates.js';
import { createFunCommandHandler } from '../src/funCommands.js';
import { createCommandHandler } from '../src/commands.js';
import { hasCommandAccess } from '../src/access.js';

function setup(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pcfl-channels-'));
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }));
  const base = {
    mods: new Set(['oldmod']), channelMods: new Map([['ryler234', new Set()]]), trackCooldownMs: 0,
    music: { enabled: true, channels: new Set(['cacto0o']) },
    fun: { enabled: true, channels: new Set(['cacto0o', 'ryler234']), defaultMode: 'on' },
  };
  function context(channel) {
    const config = channelConfig(base, channel);
    const files = channelDataPaths(dataDir, channel);
    fs.mkdirSync(files.directory, { recursive: true });
    const store = gamesEnabled(channel, config) ? new FunStore(files.players) : undefined;
    const settings = new FunSettings(files.settings, { defaultMode: config.fun.defaultMode });
    const commandSettings = new CommandSettings(files.commands);
    const sent = [];
    let trackCalls = 0;
    const chat = { say: (text) => sent.push(text) };
    const ids = { botLogin: 'peeacefullbot', broadcasterId: `${channel}-id`, botUserId: 'bot-id' };
    const funCommands = createFunCommandHandler({ config, chat, ids, store, settings, random: () => 0.5 });
    t.after(funCommands.close);
    const handler = createCommandHandler({ config, chat, ids, funCommands, commandSettings,
      helix: { searchCategories: async () => [{ id: 'minecraft', name: 'Minecraft' }] },
      templates: new Templates(files.templates ?? path.join(dataDir, 'templates.json')),
      gameTemplates: new Templates(files.gameTemplates ?? path.join(dataDir, 'gameTemplates.json')),
      yandexMusic: { getCurrentTrack: async () => { trackCalls++; return { status: 'stopped' }; } },
    });
    return { files, store, settings, commandSettings, sent, trackCalls: () => trackCalls,
      send: (text, login = channel, extra = {}) => handler({ text, login, channel, displayName: login, ...extra }),
    };
  }
  return { dataDir, context };
}

test('all channel balances, cooldowns, settings, VIPs, commands and templates remain isolated after reload', async (t) => {
  const { context, dataDir } = setup(t);
  const old = context('cacto0o');
  const added = context('ryler234');
  assert.equal(old.files.players, path.join(dataDir, 'cacto0o', 'players.json'));
  assert.equal(added.files.directory, path.join(dataDir, 'ryler234'));
  await old.send('!кредит', 'viewer');
  const oldBytes = fs.readFileSync(old.files.players, 'utf8');
  await added.send('!кредит', 'viewer');
  assert.equal(added.store.player('viewer').balance, 20);
  await added.send('!кредит', 'viewer');
  assert.equal(added.store.player('viewer').balance, 20);
  assert.match(added.sent.at(-1), /Подождите/);
  await added.send('!кд 13');
  await added.send('!добавить viewer');
  await added.send('!выклвип');
  await added.send('!откл бал');
  await added.send('!+g shared Minecraft');
  assert.equal(new Templates(added.files.gameTemplates).get('shared').title, 'shared');
  assert.equal(fs.existsSync(path.join(dataDir, 'gameTemplates.json')), false);
  const reloaded = context('ryler234');
  assert.equal(reloaded.store.player('viewer').balance, 20);
  assert.deepEqual(reloaded.store.player('viewer').cooldowns, added.store.player('viewer').cooldowns);
  assert.deepEqual(reloaded.settings.data, { version: 1, mode: 'vip', cooldown: 13, tempVips: ['viewer'] });
  assert.equal(reloaded.commandSettings.isDisabled('!бал'), true);
  assert.equal(old.settings.data.mode, 'on');
  assert.equal(old.settings.data.cooldown, 0);
  assert.deepEqual(old.settings.data.tempVips, []);
  assert.equal(old.commandSettings.isDisabled('!бал'), false);
  assert.equal(fs.readFileSync(old.files.players, 'utf8'), oldBytes);
});

test('music channel allowlist silences !трек for every role, including after chat enable attempts', async (t) => {
  const { context } = setup(t);
  const added = context('ryler234');
  await added.send('!вкл трек');
  assert.match(added.sent.pop(), /недоступна/);
  await added.send('!вкл');
  added.sent.length = 0;
  for (const login of ['ryler234', 'viewer', 'oldmod']) {
    await added.send('!ТРЕК\u200b', login);
    await added.send('!трек', login, { isMod: true });
  }
  assert.equal(added.trackCalls(), 0);
  assert.deepEqual(added.sent, []);
  const old = context('cacto0o');
  await old.send('!трек', 'viewer');
  assert.equal(old.trackCalls(), 1);
});

test('channel-specific admin list replaces shared admins; moderators are configurable', async (t) => {
  const { context } = setup(t);
  const added = context('ryler234');
  await added.send('!выкл', 'oldmod');
  assert.equal(added.settings.data.mode, 'on');
  await added.send('!выкл', 'localmod', { isMod: true });
  assert.equal(added.settings.data.mode, 'off');
  await added.send('!кредит', 'viewer');
  assert.equal(added.store.player('viewer').balance, 0);
  await added.send('!кредит', 'localmod', { isMod: true });
  assert.equal(added.store.player('localmod').balance, 20);
  await added.send('!вкл');
  assert.equal(added.settings.data.mode, 'on');
  const legacy = channelConfig({ mods: new Set(['oldmod']), allowChannelModerators: false }, 'cacto0o');
  assert.equal(hasCommandAccess(legacy, { login: 'oldmod' }), true);
  assert.equal(hasCommandAccess(legacy, { login: 'localmod', isMod: true }), false);
  const second = context('tiltocacto0o');
  await second.send('!кредит');
  assert.deepEqual(second.sent, []);
  assert.equal(fs.existsSync(second.files.players), false);
});

test('arbitrary channel names have the same policy and separate data paths', () => {
  const config = { mods: new Set(), music: { enabled: true }, fun: { enabled: true } };
  for (const name of ['new_streamer', 'another_channel', 'ryler234']) {
    assert.equal(gamesEnabled(name, config), true);
    assert.equal(trackEnabled(name, config), true);
    assert.equal(channelConfig(config, name).allowChannelModerators, true);
    assert.equal(channelDataPaths('data', name).directory, path.join('data', name));
  }
  assert.equal(trackEnabled('new_streamer'), false);
  assert.equal(gamesEnabled('new_streamer', { fun: { enabled: false } }), false);
  assert.throws(() => channelDataPaths('data', '../escape'));
});

test('global and per-channel env command prohibitions are combined', () => {
  const config = { disabledCommands: new Set(['!пинг']), channelDisabledCommands: new Map([['new_streamer', new Set(['!вкл'])]]) };
  assert.deepEqual([...channelConfig(config, 'new_streamer').disabledCommands], ['!пинг', '!вкл']);
  assert.deepEqual([...channelConfig(config, 'another_channel').disabledCommands], ['!пинг']);
});
