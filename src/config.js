import path from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function required(name) {
  const v = process.env[name]?.trim();
  if (!v) {
    console.error(`[config] Не задана переменная окружения ${name} — проверьте файл .env`);
    process.exit(1);
  }
  return v;
}

export function parseChannelList(value) {
  return [
    ...new Set(
      String(value ?? '')
        .toLowerCase()
        .split(',')
        .map((s) => s.trim().replace(/^#/, ''))
        .filter(Boolean),
    ),
  ];
}

export function ownerTokenAccount(channel, primaryChannel) {
  return channel === primaryChannel ? 'owner' : `owner-${channel}`;
}

const channels = parseChannelList(process.env.TWITCH_CHANNELS ?? process.env.TWITCH_CHANNEL);
if (channels.length === 0 || channels.some((channel) => !/^[a-z0-9_]{1,25}$/.test(channel) || channel === '__proto__')) {
  console.error('[config] Укажите корректные логины каналов в TWITCH_CHANNELS (через запятую) — проверьте файл .env');
  process.exit(1);
}

const bool = (name, fallback = false) => (process.env[name]?.trim() || String(fallback)).toLowerCase() === 'true';
const channelSet = (name, fallback = channels) => new Set(parseChannelList(process.env[name]?.trim() || fallback.join(',')));
const suffix = (channel) => channel.toUpperCase();
const commands = (value) => new Set(String(value ?? '').split(',').map((s) => s.trim().toLowerCase()).filter(Boolean).map((s) => s.startsWith('!') ? s : `!${s}`));
const music = { enabled: bool('MUSIC_ENABLED'), channels: channelSet('MUSIC_CHANNELS') };
const disabledCommands = commands(process.env.DISABLED_COMMANDS);
const channelDisabledCommands = new Map(channels.map((channel) => [channel, commands(process.env[`DISABLED_COMMANDS_${suffix(channel)}`])]));
const fossabotChannels = [...channelSet('FOSSABOT_TRACK_CHANNELS')].filter((channel) =>
  music.enabled && music.channels.has(channel) && channels.includes(channel) &&
  !disabledCommands.has('!трек') && !channelDisabledCommands.get(channel)?.has('!трек'));

function autoPinMessage(channel) {
  return (
    process.env[`AUTO_PIN_MESSAGE_${suffix(channel)}`] ??
    process.env.AUTO_PIN_MESSAGE ??
    ''
  ).trim();
}

export const config = {
  rootDir,
  clientId: required('TWITCH_CLIENT_ID'),
  clientSecret: required('TWITCH_CLIENT_SECRET'),
  channels,
  // Первый канал остаётся основным для совместимости с существующим owner.json.
  channel: channels[0],
  mods: new Set(
    (process.env.MODS ?? '')
      .toLowerCase()
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  ),
  pollDefaultSeconds: Number(process.env.POLL_DEFAULT_SECONDS ?? 120),
  channelMods: new Map(channels.filter((channel) => Object.hasOwn(process.env, `MODS_${suffix(channel)}`)).map((channel) => [channel, new Set(parseChannelList(process.env[`MODS_${suffix(channel)}`]))])),
  allowChannelModerators: bool('ALLOW_CHANNEL_MODERATORS', true),
  disabledCommands,
  channelDisabledCommands,
  music,
  predDefaultSeconds: Number(process.env.PRED_DEFAULT_SECONDS ?? 60),
  authPort: Number(process.env.AUTH_PORT ?? 3000),
  tokensDir: path.join(rootDir, 'tokens'),
  templatesFile: path.join(rootDir, 'templates.json'),
  gameTemplatesFile: path.join(rootDir, 'gameTemplates.json'),
  fun: {
    enabled: bool('GAMES_ENABLED', true),
    channels: channelSet('GAMES_CHANNELS'),
    defaultMode: ['on', 'off', 'vip'].includes(process.env.GAMES_DEFAULT_MODE) ? process.env.GAMES_DEFAULT_MODE : 'off',
    commandsUrl: (process.env.FUN_COMMANDS_URL ?? '').trim(),
    dataDir: path.join(rootDir, 'data', 'fun'),
    apiKey: (process.env.GROQCLOUD_API_KEY ?? '').trim(),
    model: (process.env.GROQCLOUD_MODEL ?? '').trim() || 'openai/gpt-oss-20b',
  },
  trackCooldownMs: Math.max(Number(process.env.TRACK_COOLDOWN_MS ?? 5000), 0),
  yandexMusic: {
    token: (process.env.YANDEX_MUSIC_TOKEN ?? '').trim(),
    pythonPath:
      (process.env.YANDEX_MUSIC_PYTHON ?? '').trim() ||
      (process.platform === 'win32'
        ? path.join(rootDir, '.venv-ynison', 'Scripts', 'python.exe')
        : path.join(rootDir, '.venv-ynison', 'bin', 'python')),
    scriptPath: path.join(rootDir, 'scripts', 'yandex_track.py'),
    timeoutMs: 20_000,
  },
  trackBridge: {
    secret: (process.env.TRACK_BRIDGE_SECRET ?? '').trim(),
    host: (process.env.TRACK_BRIDGE_HOST ?? '127.0.0.1').trim(),
    port: Number(process.env.TRACK_BRIDGE_PORT ?? 8787),
    maxAgeMs: Math.max(Number(process.env.TRACK_BRIDGE_MAX_AGE_MS ?? 15_000), 5_000),
    fossabot: {
      enabled: music.enabled && fossabotChannels.length > 0 && bool('FOSSABOT_TRACK_API_ENABLED'),
      channels: fossabotChannels,
      // Старое поле оставлено для совместимости с тестами и внешними импортами.
      channel: fossabotChannels[0] ?? '',
      timeoutMs: Math.max(Number(process.env.FOSSABOT_API_TIMEOUT_MS ?? 5_000), 1_000),
    },
  },
  autoPin: {
    enabled: (process.env.AUTO_PIN ?? '').toLowerCase() === 'true',
    channels: channelSet('AUTO_PIN_CHANNELS'),
    messages: new Map(channels.map((channel) => [channel, autoPinMessage(channel)])),
    // Twitch снимает pin при завершении стрима. Небольшая пауза позволяет API
    // сначала отразить это изменение, и только затем создаётся новый закреп.
    offlineDelayMs: Math.max(Number(process.env.AUTO_PIN_OFFLINE_DELAY_MS ?? 3_000), 0),
  },
  autoUnban: {
    enabled: (process.env.AUTO_UNBAN ?? '').toLowerCase() === 'true',
    // По умолчанию сохраняем прежнюю область действия: только основной канал.
    channels: channelSet('AUTO_UNBAN_CHANNELS', [channels[0]]),
    target: (process.env.AUTO_UNBAN_TARGET ?? '').toLowerCase().trim(),
    // пустой список = разбанивать независимо от того, кто забанил
    onlyFrom: new Set(
      (process.env.AUTO_UNBAN_ONLYFROM ?? '')
        .toLowerCase()
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean),
    ),
    // Разбанивать при старте, не зная автора бана (ONLYFROM в этот момент не проверяется)
    onStart: (process.env.AUTO_UNBAN_ON_START ?? '').toLowerCase() === 'true',
    intervalSeconds: Math.max(Number(process.env.AUTO_UNBAN_INTERVAL ?? 1), 1),
    maxPerMinute: Number(process.env.AUTO_UNBAN_MAX_PER_MINUTE ?? 100),
  },
};
