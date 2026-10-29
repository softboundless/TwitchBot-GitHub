import path from 'node:path';

function includesChannel(feature, channel, defaultEnabled) {
  if ((feature?.enabled ?? defaultEnabled) !== true) return false;
  return !feature?.channels?.size || feature.channels.has(channel);
}

export const gamesEnabled = (channel, config = {}) => includesChannel(config.fun, channel, true);
export const trackEnabled = (channel, config = {}) => includesChannel(config.music, channel, false);

export function channelConfig(config, channel) {
  return {
    ...config,
    channel,
    mods: config.channelMods?.get(channel) ?? config.mods ?? new Set(),
    allowChannelModerators: config.allowChannelModerators ?? true,
    disabledCommands: new Set([
      ...(config.disabledCommands ?? []),
      ...(config.channelDisabledCommands?.get(channel) ?? []),
    ]),
  };
}

export function channelDataPaths(dataDir, channel) {
  if (!/^[a-z0-9_]{1,25}$/.test(channel) || channel === '__proto__') {
    throw new Error('Некорректный логин канала');
  }
  const directory = path.join(dataDir, channel);
  return {
    directory,
    players: path.join(directory, 'players.json'),
    settings: path.join(directory, 'settings.json'),
    commands: path.join(directory, 'commands.json'),
    templates: path.join(directory, 'templates.json'),
    gameTemplates: path.join(directory, 'gameTemplates.json'),
  };
}
