// Одноразовая OAuth-авторизация через Device Code Flow — без портов и туннелей.
// Запуск: node --env-file=.env scripts/authorize.js [bot|owner|owner:<канал>]
// Без аргумента авторизует бота и владельцев всех настроенных каналов по очереди.
//
// Скрипт печатает код. Код нужно ввести на https://www.twitch.tv/activate,
// войдя под нужным аккаунтом (боту — аккаунт бота, владельцу — аккаунт канала).
// Владельцу канала код можно просто переслать — он введёт его у себя, хоть с телефона.
// Скрипт дождётся подтверждения, сохранит токены в tokens/ и завершится сам.
import { config, ownerTokenAccount } from '../src/config.js';
import { TokenStore } from '../src/tokenStore.js';

const SCOPES = {
  // Права сверх чата нужны для автоматического разбана: сам разбан —
  // moderator:manage:banned_users, остальные требует подписка channel.moderate v2.
  bot: [
    'chat:read',
    'chat:edit',
    // Send Chat Message API возвращает message_id, который нужен для pin.
    'user:write:chat',
    // Чтение состояния и управление закреплёнными сообщениями.
    'moderator:manage:chat_messages',
    'moderator:manage:announcements',
    'moderator:manage:banned_users',
    'moderator:read:blocked_terms',
    'moderator:read:chat_settings',
    'moderator:read:unban_requests',
    'moderator:read:chat_messages',
    'moderator:read:warnings',
    'moderator:read:moderators',
    'moderator:read:vips',
  ],
  // channel:manage:broadcast — смена категории стрима (!g), доступна только владельцу
  owner: ['channel:manage:polls', 'channel:manage:predictions', 'channel:manage:broadcast'],
};
const ID = 'https://id.twitch.tv/oauth2';

async function deviceStart(scopes) {
  const res = await fetch(`${ID}/device`, {
    method: 'POST',
    body: new URLSearchParams({ client_id: config.clientId, scopes: scopes.join(' ') }),
  });
  if (!res.ok) {
    throw new Error(`не удалось начать авторизацию: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  return res.json(); // { device_code, user_code, verification_uri, expires_in, interval }
}

// объект токена | 'pending' | 'expired'
async function devicePoll(scopes, deviceCode) {
  const res = await fetch(`${ID}/token`, {
    method: 'POST',
    body: new URLSearchParams({
      client_id: config.clientId,
      scopes: scopes.join(' '),
      device_code: deviceCode,
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
    }),
  });
  const j = await res.json().catch(() => ({}));
  if (res.ok) return j;
  const msg = (j.message ?? `HTTP ${res.status}`).toLowerCase();
  if (msg.includes('pending') || msg.includes('slow')) return 'pending';
  return 'expired'; // код истёк или отклонён — сгенерируем новый
}

async function authorizeAccount({ account, role, channel, label }) {
  const store = new TokenStore(config, account);
  const scopes = SCOPES[role];

  // уже есть рабочий токен нужного аккаунта с нужными правами — пропускаем
  if (store.exists()) {
    try {
      store.load();
      let info = await store.validate();
      if (!info) {
        await store.refresh();
        info = await store.validate();
      }
      const loginOk = role !== 'owner' || info?.login.toLowerCase() === channel;
      const have = new Set(info?.scopes ?? []);
      const missing = scopes.filter((s) => !have.has(s));
      if (info && loginOk && missing.length === 0) {
        console.log(`SAVED ${account} ${info.login} (уже был авторизован)`);
        return;
      }
      if (info && loginOk && missing.length > 0) {
        console.log(`[authorize] у токена «${account}» не хватает прав: ${missing.join(', ')}`);
        console.log('[authorize] нужна повторная авторизация этого аккаунта');
      }
    } catch {
      // токен битый и не обновляется — идём авторизовываться заново
    }
  }

  for (let attempt = 1; attempt <= 10; attempt++) {
    const d = await deviceStart(scopes);
    console.log('');
    console.log(`CODE ${account} ${d.user_code}`);
    console.log(`[authorize] ${label}: откройте https://www.twitch.tv/activate и введите код ${d.user_code}`);
    console.log(`[authorize] прямая ссылка: https://www.twitch.tv/activate?device-code=${d.user_code}`);
    console.log(`[authorize] код действует ${Math.round(d.expires_in / 60)} минут, жду подтверждения...`);

    const deadline = Date.now() + d.expires_in * 1000;
    const interval = Math.max(d.interval ?? 5, 5) * 1000;

    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, interval));
      const tok = await devicePoll(scopes, d.device_code).catch((e) => {
        console.log(`[authorize] сеть: ${e.message} — продолжаю ждать`);
        return 'pending';
      });
      if (tok === 'pending') continue;
      if (tok === 'expired') break;

      store.data = { access_token: tok.access_token, refresh_token: tok.refresh_token };
      const info = await store.validate();
      if (!info) break;
      if (role === 'owner' && info.login.toLowerCase() !== channel) {
        console.log(`MISMATCH owner ${info.login}`);
        console.log(
          `[authorize] ⚠ код подтвердил аккаунт «${info.login}», а нужен владелец канала «${channel}». ` +
            'Токен не сохранён. Генерирую новый код — введите его под правильным аккаунтом.',
        );
        break;
      }
      store.save({
        access_token: tok.access_token,
        refresh_token: tok.refresh_token,
        login: info.login,
        user_id: info.user_id,
        scopes: info.scopes,
        obtained_at: new Date().toISOString(),
      });
      console.log(`SAVED ${account} ${info.login}`);
      return;
    }
    console.log('[authorize] код истёк или не подошёл — пробую заново');
  }
  throw new Error(`авторизация «${account}» не удалась за 10 попыток`);
}

const botAccount = {
  account: 'bot',
  role: 'bot',
  channel: null,
  label: 'бот (аккаунт Twitch, от имени которого будут отправляться сообщения)',
};
const ownerAccounts = config.channels.map((channel) => ({
  account: ownerTokenAccount(channel, config.channel),
  role: 'owner',
  channel,
  label: `владелец канала (аккаунт ${channel})`,
}));

const which = process.argv[2];
let accounts;
if (!which) {
  accounts = [botAccount, ...ownerAccounts];
} else if (which === 'bot') {
  accounts = [botAccount];
} else if (which === 'owner') {
  accounts = [ownerAccounts[0]];
} else if (which.startsWith('owner:')) {
  const channel = which.slice('owner:'.length).trim().toLowerCase();
  const selected = ownerAccounts.find((item) => item.channel === channel);
  if (!selected) {
    throw new Error(`канал «${channel}» не найден в TWITCH_CHANNELS (${config.channels.join(', ')})`);
  }
  accounts = [selected];
} else {
  throw new Error('аргумент должен быть bot, owner или owner:<канал>');
}

for (const account of accounts) {
  await authorizeAccount(account);
}
console.log('');
console.log('DONE все токены получены');
