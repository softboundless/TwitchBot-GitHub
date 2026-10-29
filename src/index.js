import { FunSettings } from './funSettings.js';
import { config, ownerTokenAccount } from './config.js';
import { TokenStore } from './tokenStore.js';
import { makeHelix } from './helix.js';
import { TwitchChat } from './irc.js';
import { Templates } from './templates.js';
import { createCommandHandler } from './commands.js';
import { CommandSettings } from './commandSettings.js';
import { AutoUnban } from './autoUnban.js';
import { AutoPin } from './autoPin.js';
import { YandexMusic } from './yandexMusic.js';
import { TrackBridge, TrackProvider } from './trackBridge.js';
import fs from 'node:fs';
import { channelConfig as makeChannelConfig, channelDataPaths, gamesEnabled } from './channelPolicy.js';
import { FunStore } from './funStore.js';
import { createFunCommandHandler } from './funCommands.js';
import { createTarot } from './tarot.js';

async function main() {
  console.log('[init] запуск PCFLBot');

  const bot = new TokenStore(config, 'bot');

  const botOk = await bot.init().catch((e) => {
    console.error('[init]', e.message);
    return false;
  });
  if (!botOk) {
    console.error('[init] Нет рабочего токена бота. Пройдите авторизацию: npm run authorize (см. README.md)');
    process.exit(1);
  }

  const channelContexts = new Map();
  for (const channel of config.channels) {
    const account = ownerTokenAccount(channel, config.channel);
    const owner = new TokenStore(config, account);
    const ownerOk = await owner.init().catch((e) => {
      console.error(`[init:#${channel}]`, e.message);
      return false;
    });
    if (!ownerOk) {
      console.warn(
        `[init:#${channel}] ⚠ Нет токена владельца — опросы, прогнозы и смена категории не будут работать. ` +
          `Авторизация: npm run authorize -- owner:${channel}`,
      );
    } else if (owner.login.toLowerCase() !== channel) {
      console.warn(
        `[init:#${channel}] ⚠ Токен владельца выдан аккаунту «${owner.login}». ` +
          `Авторизуйте владельца заново: npm run authorize -- owner:${channel}`,
      );
    }

    const helix = makeHelix(config, bot, owner);
    const broadcasterId = await helix.getUserId(channel);
    if (!broadcasterId) {
      console.error(`[init] канал «${channel}» не найден на Твиче`);
      process.exit(1);
    }

    const ids = {
      channel,
      broadcasterId,
      botUserId: bot.userId,
      botLogin: bot.login.toLowerCase(),
    };
    channelContexts.set(channel, { channel, owner, ownerOk, helix, ids });
    console.log(`[init] канал #${channel} (id ${broadcasterId}), бот ${bot.login} (id ${ids.botUserId})`);
  }
  console.log(`[init] каналы: ${config.channels.map((channel) => `#${channel}`).join(', ')}`);
  console.log(`[init] общий вайтлист: ${[...config.mods].join(', ')}`);

  const chat = new TwitchChat({ channels: config.channels, tokenStore: bot });
  let trackProvider;
  if (config.music.enabled) {
    const yandexMusic = new YandexMusic(config.yandexMusic);
    const trackBridge = new TrackBridge({ ...config.trackBridge, getChatHealth: () => chat.getHealth() });
    if (trackBridge.isConfigured) {
      await trackBridge.start();
      console.log('[track-bridge] браузерный мост запущен');
    }
    if (!yandexMusic.isConfigured && !trackBridge.isConfigured) {
      console.warn('[music] Выбран вариант с музыкой, но источник не настроен. Откройте npm run setup.');
    }
    trackProvider = new TrackProvider({ bridge: trackBridge, fallback: yandexMusic });
  }
  const handlers = new Map();
  const tarot = createTarot(config.fun);
  for (const context of channelContexts.values()) {
    const channelConfig = makeChannelConfig(config, context.channel);
    const dataPaths = channelDataPaths(config.fun.dataDir, context.channel);
    fs.mkdirSync(dataPaths.directory, { recursive: true });
    const channelChat = {
      say(text, options = {}) {
        chat.say(text, { ...options, channel: context.channel });
      },
    };
    let funStore;
    try {
      if (gamesEnabled(context.channel, config)) {
        funStore = new FunStore(dataPaths.players);
      }
    } catch {
      // Повреждённые данные не перезаписываем; остальные команды продолжают работать.
      console.error(`[fun:#${context.channel}] не удалось загрузить игровые данные; игры отключены`);
    }
    let funSettings = null;
    try {
      funSettings = new FunSettings(dataPaths.settings, { defaultMode: config.fun.defaultMode });
    } catch {
      console.error(`[fun:#${context.channel}] не удалось загрузить настройки игр; управление играми отключено`);
    }
    const commandSettings = new CommandSettings(dataPaths.commands);
    const funCommands = createFunCommandHandler({
      settings: funSettings,
      isCommandDisabled: (cmd) => channelConfig.disabledCommands.has(cmd) || commandSettings.isDisabled(cmd),
      config: channelConfig, chat: channelChat, ids: context.ids, store: funStore, tarot, helix: context.helix,
    });
    handlers.set(
      context.channel,
      createCommandHandler({
        config: channelConfig,
        chat: channelChat,
        helix: context.helix,
        templates: new Templates(dataPaths.templates),
        gameTemplates: new Templates(dataPaths.gameTemplates),
        yandexMusic: trackProvider,
        funCommands,
        commandSettings,
        ids: context.ids,
      }),
    );
  }
  chat.on('chat', (m) => {
    const handler = handlers.get(m.channel);
    if (!handler) return;
    handler(m).catch((e) => console.error(`[cmd:#${m.channel}] необработанная ошибка:`, e));
  });
  await chat.connect();

  const autoPinContexts = [...channelContexts.values()].filter((context) =>
    config.autoPin.channels.has(context.channel),
  );
  const autoPin = new AutoPin({ config, contexts: autoPinContexts });
  await autoPin.start().catch((e) => console.error('[pin] не удалось запустить:', e));

  for (const context of channelContexts.values()) {
    if (!config.autoUnban.channels.has(context.channel)) continue;
    const autoUnban = new AutoUnban({ config, helix: context.helix, ids: context.ids, chat });
    await autoUnban.start().catch((e) => console.error(`[unban:#${context.channel}] не удалось запустить:`, e));
  }

  // Твич требует проверять пользовательские токены не реже раза в час
  setInterval(() => {
    bot.ensureFresh().catch((e) => console.error('[auth] bot:', e.message));
    for (const context of channelContexts.values()) {
      if (!context.owner.exists()) continue;
      context.owner.ensureFresh().catch((e) => console.error(`[auth] owner:${context.channel}:`, e.message));
    }
  }, 50 * 60 * 1000);
}

main().catch((e) => {
  console.error('[fatal]', e);
  process.exit(1);
});
