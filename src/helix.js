const API = 'https://api.twitch.tv/helix';

export class HelixError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HelixError';
    this.status = status;
  }
}

// 401 бывает двух видов: протухший токен (лечится обновлением) и «нет прав»
// (обновлением не лечится). Без этой защиты второй случай при частых запросах
// устроил бы шторм обновлений токена.
const REFRESH_COOLDOWN_MS = 60_000;
const lastRefreshAt = new WeakMap();

async function call(config, store, method, pathname, { query, body } = {}) {
  const token = await store.ensureFresh();
  const url = new URL(API + pathname);
  if (query) for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);

  const doFetch = (tok) =>
    fetch(url, {
      method,
      signal: AbortSignal.timeout(15_000),
      headers: {
        'Client-Id': config.clientId,
        Authorization: `Bearer ${tok}`,
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

  let res = await doFetch(token);
  if (res.status === 401) {
    const last = lastRefreshAt.get(store) ?? 0;
    if (Date.now() - last > REFRESH_COOLDOWN_MS) {
      lastRefreshAt.set(store, Date.now());
      await store.refresh();
      res = await doFetch(store.data.access_token);
    }
  }
  if (!res.ok) {
    let msg = `HTTP ${res.status}`;
    try {
      const j = await res.json();
      if (j.message) msg = j.message;
    } catch {
      // тело не JSON — оставляем HTTP-статус
    }
    throw new HelixError(res.status, msg);
  }
  if (res.status === 204) return null;
  return res.json();
}

// botStore — токен аккаунта бота (чат, анонсы), ownerStore — токен владельца (опросы, прогнозы)
export function makeHelix(config, botStore, ownerStore) {
  return {
    async getUserId(login) {
      const j = await call(config, botStore, 'GET', '/users', { query: { login } });
      return j.data[0]?.id ?? null;
    },

    async createPoll({ broadcasterId, title, choices, duration }) {
      const j = await call(config, ownerStore, 'POST', '/polls', {
        body: {
          broadcaster_id: broadcasterId,
          title,
          choices: choices.map((t) => ({ title: t })),
          duration,
        },
      });
      return j.data[0];
    },

    async getActivePoll(broadcasterId) {
      const j = await call(config, ownerStore, 'GET', '/polls', {
        query: { broadcaster_id: broadcasterId, first: '20' },
      });
      return j.data.find((p) => p.status === 'ACTIVE') ?? null;
    },

    async endPoll(broadcasterId, id) {
      await call(config, ownerStore, 'PATCH', '/polls', {
        body: { broadcaster_id: broadcasterId, id, status: 'TERMINATED' },
      });
    },

    async createPrediction({ broadcasterId, title, outcomes, windowSeconds }) {
      const j = await call(config, ownerStore, 'POST', '/predictions', {
        body: {
          broadcaster_id: broadcasterId,
          title,
          outcomes: outcomes.map((t) => ({ title: t })),
          prediction_window: windowSeconds,
        },
      });
      return j.data[0];
    },

    // прогноз, который ещё не закрыт: идёт приём ставок (ACTIVE) или заблокирован (LOCKED)
    async getCurrentPrediction(broadcasterId) {
      const j = await call(config, ownerStore, 'GET', '/predictions', {
        query: { broadcaster_id: broadcasterId, first: '20' },
      });
      return j.data.find((p) => p.status === 'ACTIVE' || p.status === 'LOCKED') ?? null;
    },

    // status: 'RESOLVED' (нужен winningOutcomeId) | 'CANCELED' | 'LOCKED'
    async endPrediction(broadcasterId, id, status, winningOutcomeId) {
      const body = { broadcaster_id: broadcasterId, id, status };
      if (winningOutcomeId) body.winning_outcome_id = winningOutcomeId;
      await call(config, ownerStore, 'PATCH', '/predictions', { body });
    },

    async sendAnnouncement({ broadcasterId, moderatorId, message, color }) {
      await call(config, botStore, 'POST', '/chat/announcements', {
        query: { broadcaster_id: broadcasterId, moderator_id: moderatorId },
        body: { message, color },
      });
    },

    async sendChatMessage({ broadcasterId, senderId, message }) {
      const j = await call(config, botStore, 'POST', '/chat/messages', {
        body: {
          broadcaster_id: broadcasterId,
          sender_id: senderId,
          message,
        },
      });
      return j.data[0] ?? null;
    },

    async getPinnedChatMessage({ broadcasterId, moderatorId }) {
      const j = await call(config, botStore, 'GET', '/chat/pins', {
        query: { broadcaster_id: broadcasterId, moderator_id: moderatorId },
      });
      return j.data[0] ?? null;
    },

    async pinChatMessage({ broadcasterId, moderatorId, messageId }) {
      // duration_seconds намеренно не передаётся: такой закреп действует до
      // завершения стрима, а не ограниченные API 30–1800 секунд.
      await call(config, botStore, 'PUT', '/chat/pins', {
        query: {
          broadcaster_id: broadcasterId,
          moderator_id: moderatorId,
          message_id: messageId,
        },
      });
    },

    async getStream(broadcasterId) {
      const j = await call(config, botStore, 'GET', '/streams', {
        query: { user_id: broadcasterId, first: '1' },
      });
      return j.data[0] ?? null;
    },

    async isStreamLive(broadcasterId) {
      return (await this.getStream(broadcasterId)) !== null;
    },

    async timeoutUser({ broadcasterId, moderatorId, userId, duration, reason }) {
      if (!Number.isInteger(duration) || duration < 1 || duration > 1_209_600) {
        throw new Error('Invalid timeout duration');
      }
      await call(config, botStore, 'POST', '/moderation/bans', {
        query: { broadcaster_id: broadcasterId, moderator_id: moderatorId },
        body: { data: { user_id: userId, duration, reason } },
      });
    },

    // Снимает бан или таймаут. Токен бота-модератора.
    async unbanUser({ broadcasterId, moderatorId, userId }) {
      await call(config, botStore, 'DELETE', '/moderation/bans', {
        query: { broadcaster_id: broadcasterId, moderator_id: moderatorId, user_id: userId },
      });
    },

    // Поиск категории по названию. Токен подойдёт любой — прав не требует.
    async searchCategories(query) {
      const j = await call(config, botStore, 'GET', '/search/categories', {
        query: { query, first: '20' },
      });
      return j.data;
    },

    // Смена категории стрима. Только токен владельца канала: ни модератор,
    // ни редактор канала этот эндпоинт вызвать не могут.
    async modifyChannel({ broadcasterId, gameId }) {
      await call(config, ownerStore, 'PATCH', '/channels', {
        query: { broadcaster_id: broadcasterId },
        body: { game_id: String(gameId) },
      });
    },

    async createEventSubSubscription({ type, version, condition, sessionId }) {
      return call(config, botStore, 'POST', '/eventsub/subscriptions', {
        body: { type, version, condition, transport: { method: 'websocket', session_id: sessionId } },
      });
    },
  };
}
