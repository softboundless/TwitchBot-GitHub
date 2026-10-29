// Общая проверка для административных и игровых команд.
// MODS — разрешённые логины, а не автоматическая проверка moderator-бейджа.
export function hasCommandAccess(config, msg) {
  const login = String(msg.login ?? '').toLowerCase();
  return login === config.channel || msg.isBroadcaster === true || config.mods.has(login) ||
    (config.allowChannelModerators === true && msg.isMod === true);
}
