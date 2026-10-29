import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.TWITCH_CLIENT_ID = 'test-client';
process.env.TWITCH_CLIENT_SECRET = 'test-secret';
process.env.TWITCH_CHANNEL = 'cacto0o';
process.env.TWITCH_CHANNELS = 'Cacto0o, #tiltocacto0o, cacto0o, Ryler234';
process.env.AUTO_UNBAN_CHANNELS = '';
delete process.env.AUTO_PIN;
process.env.AUTO_PIN_CHANNELS = '';
delete process.env.AUTO_PIN_MESSAGE;
delete process.env.AUTO_PIN_MESSAGE_CACTO0O;
delete process.env.AUTO_PIN_MESSAGE_TILTOCACTO0O;
delete process.env.AUTO_PIN_MESSAGE_RYLER234;
delete process.env.FOSSABOT_TRACK_CHANNEL;
process.env.FOSSABOT_TRACK_CHANNELS = '';
delete process.env.MUSIC_ENABLED;
delete process.env.GAMES_ENABLED;
delete process.env.GAMES_DEFAULT_MODE;
process.env.MODS_RYLER234 = '';
process.env.DISABLED_COMMANDS = '!пинг';
process.env.DISABLED_COMMANDS_RYLER234 = '!скок';
process.env.GROQCLOUD_API_KEY = ' test-groq-key ';
process.env.OPENAI_API_KEY = 'unused-old-key';
delete process.env.GROQCLOUD_MODEL;

const { config, ownerTokenAccount, parseChannelList } = await import('../src/config.js');

test('игры читают ключ Groq Cloud и выбирают GPT OSS по умолчанию', () => {
  assert.equal(config.fun.apiKey, 'test-groq-key');
  assert.equal(config.fun.model, 'openai/gpt-oss-20b');
});

test('многоканальная конфигурация нормализует и удаляет дубликаты', () => {
  assert.deepEqual(config.channels, ['cacto0o', 'tiltocacto0o', 'ryler234']);
  assert.deepEqual(parseChannelList('One, #TWO,one'), ['one', 'two']);
  assert.deepEqual(config.trackBridge.fossabot.channels, []);
  assert.deepEqual([...config.autoPin.channels], ['cacto0o', 'tiltocacto0o', 'ryler234']);
  assert.equal(config.autoPin.enabled, false);
  assert.equal(config.autoPin.messages.get('cacto0o'), '');
  assert.equal(config.autoPin.messages.get('tiltocacto0o'), '');
  assert.equal(config.autoPin.messages.get('ryler234'), '');
});

test('new installs default to no music, games restricted to admins, and configurable per-channel overrides', () => {
  assert.equal(config.music.enabled, false);
  assert.equal(config.trackBridge.fossabot.enabled, false);
  assert.equal(config.fun.enabled, true);
  assert.equal(config.fun.defaultMode, 'off');
  assert.equal(config.fun.commandsUrl, '');
  assert.deepEqual([...config.fun.channels], config.channels);
  assert.deepEqual([...config.channelMods.get('ryler234')], []);
  assert.deepEqual([...config.disabledCommands], ['!пинг']);
  assert.deepEqual([...config.channelDisabledCommands.get('ryler234')], ['!скок']);
});

test('основной токен владельца сохраняет старое имя, дополнительный получает имя канала', () => {
  assert.equal(ownerTokenAccount('cacto0o', config.channel), 'owner');
  assert.equal(ownerTokenAccount('tiltocacto0o', config.channel), 'owner-tiltocacto0o');
  assert.equal(ownerTokenAccount('ryler234', config.channel), 'owner-ryler234');
  assert.deepEqual([...config.autoUnban.channels], ['cacto0o']);
});
