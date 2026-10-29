import crypto from 'node:crypto';
import http from 'node:http';

const MAX_BODY_BYTES = 4096;
const ALLOWED_ORIGINS = new Set(['https://music.yandex.ru', 'https://music.yandex.com']);
const FOSSABOT_API_ORIGIN = 'https://api.fossabot.com';
const FOSSABOT_TRACK_PATH = '/api/fossabot/track';
const TRACK_IDLE_TEXT = 'Сейчас музыка не воспроизводится.';

function cleanText(value, maxLength = 200) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength);
}

function secretsEqual(actual, expected) {
  const a = Buffer.from(String(actual ?? ''), 'utf8');
  const b = Buffer.from(String(expected ?? ''), 'utf8');
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function setCors(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.has(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Track-Secret');
}

function headerValue(headers, name) {
  const value = headers?.[name];
  return Array.isArray(value) ? value[0] : String(value ?? '').trim();
}

function normalizeChannels(value) {
  const values = Array.isArray(value) || value instanceof Set ? [...value] : [value];
  return new Set(
    values
      .flatMap((item) => String(item ?? '').split(','))
      .map((item) => item.trim().replace(/^#/, '').toLowerCase())
      .filter(Boolean),
  );
}

async function responseJson(response) {
  try {
    return await response.json();
  } catch {
    throw new Error('Fossabot API вернул некорректный JSON');
  }
}

export async function validateFossabotRequest({ headers, channel, channels, fetchFn = fetch, timeoutMs = 5_000 }) {
  const expectedChannels = normalizeChannels(channels ?? channel);
  const headerChannel = headerValue(headers, 'x-fossabot-channellogin').toLowerCase();
  const headerProvider = headerValue(headers, 'x-fossabot-channelprovider').toLowerCase();
  const token = headerValue(headers, 'x-fossabot-customapitoken');

  // Быстрая проверка не считается авторизацией, но не даёт посторонним
  // заставлять сервер обращаться к API Fossabot без нужных заголовков.
  if (!expectedChannels.has(headerChannel) || headerProvider !== 'twitch') return null;
  if (!token || token.length > 512 || /[\s\u0000-\u001f\u007f]/.test(token)) return null;

  const signal = AbortSignal.timeout(Math.max(Number(timeoutMs) || 5_000, 1_000));
  const validationUrl = `${FOSSABOT_API_ORIGIN}/v2/customapi/validate/${encodeURIComponent(token)}`;
  const validationResponse = await fetchFn(validationUrl, {
    headers: { Accept: 'application/json' },
    signal,
    redirect: 'error',
  });
  if (!validationResponse.ok) {
    if (validationResponse.status >= 500 || validationResponse.status === 429) {
      throw new Error(`Fossabot validation unavailable (${validationResponse.status})`);
    }
    return null;
  }

  const validation = await responseJson(validationResponse);
  let contextUrl;
  try {
    contextUrl = new URL(validation?.context_url);
  } catch {
    return null;
  }
  if (
    contextUrl.origin !== FOSSABOT_API_ORIGIN ||
    !contextUrl.pathname.startsWith('/v2/customapi/context/') ||
    contextUrl.search ||
    contextUrl.hash
  ) {
    return null;
  }

  const contextResponse = await fetchFn(contextUrl.href, {
    headers: { Accept: 'application/json' },
    signal,
    redirect: 'error',
  });
  if (!contextResponse.ok) {
    if (contextResponse.status >= 500 || contextResponse.status === 429) {
      throw new Error(`Fossabot context unavailable (${contextResponse.status})`);
    }
    return null;
  }

  const context = await responseJson(contextResponse);
  if (
    String(context?.channel?.login ?? '').toLowerCase() !== headerChannel ||
    String(context?.channel?.provider ?? '').toLowerCase() !== 'twitch' ||
    String(context?.message?.provider ?? '').toLowerCase() !== 'twitch'
  ) {
    return null;
  }
  return context;
}

export class TrackBridge {
  constructor({
    secret,
    host = '127.0.0.1',
    port = 8787,
    maxAgeMs = 15_000,
    now = () => Date.now(),
    fossabot = {},
    getChatHealth = null,
  }) {
    this.secret = String(secret ?? '').trim();
    this.host = host;
    this.port = port;
    this.maxAgeMs = maxAgeMs;
    this.now = now;
    this.getChatHealth = getChatHealth;
    this.state = null;
    this.server = null;
    this.fossabot = {
      enabled: fossabot.enabled === true,
      channels: [...normalizeChannels(fossabot.channels ?? fossabot.channel)],
      timeoutMs: Math.max(Number(fossabot.timeoutMs) || 5_000, 1_000),
      fetchFn: fossabot.fetchFn ?? fetch,
    };
    this.fossabot.channel = this.fossabot.channels[0] ?? '';
  }

  get isConfigured() {
    return this.secret.length >= 32;
  }

  getCurrentTrack() {
    if (!this.state || this.now() - this.state.updatedAt > this.maxAgeMs) return null;
    if (!this.state.playing) return { status: 'idle' };
    return { status: 'playing', artist: this.state.artist, title: this.state.title };
  }

  async start() {
    if (!this.isConfigured) return false;
    if (this.server) return true;

    this.server = http.createServer((req, res) => this.#handleRequest(req, res));
    await new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      this.server.once('error', onError);
      this.server.listen(this.port, this.host, () => {
        this.server.off('error', onError);
        resolve();
      });
    });
    const address = this.server.address();
    if (address && typeof address === 'object') this.port = address.port;
    console.log(`[track-bridge] слушает http://${this.host}:${this.port}`);
    return true;
  }

  async close() {
    if (!this.server) return;
    const server = this.server;
    this.server = null;
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }

  #send(res, status, body = '') {
    res.statusCode = status;
    res.setHeader('Cache-Control', 'no-store');
    res.end(body);
  }

  #handleRequest(req, res) {
    setCors(req, res);
    if (req.method === 'OPTIONS') return this.#send(res, 204);
    if (req.method === 'GET' && req.url === '/health') {
      const fresh = Boolean(this.getCurrentTrack());
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      const chatHealth = this.getChatHealth?.();
      const ok = chatHealth ? chatHealth.twitchConnected === true : true;
      return this.#send(res, ok ? 200 : 503, JSON.stringify({ ok, fresh, ...chatHealth }));
    }
    if (req.method === 'GET' && req.url === FOSSABOT_TRACK_PATH && this.fossabot.enabled) {
      this.#handleFossabotTrack(req, res).catch((error) => {
        console.error(`[fossabot-track] ошибка проверки запроса: ${error?.name || 'Error'}`);
        if (!res.writableEnded) {
          res.setHeader('Content-Type', 'text/plain; charset=utf-8');
          this.#send(res, 503, 'Не удалось определить текущий трек.');
        }
      });
      return;
    }
    if (req.method !== 'POST' || req.url !== '/api/track') return this.#send(res, 404);
    if (!secretsEqual(req.headers['x-track-secret'], this.secret)) return this.#send(res, 401);

    let size = 0;
    const chunks = [];
    let rejected = false;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        rejected = true;
        this.#send(res, 413);
        req.resume();
        return;
      }
      if (!rejected) chunks.push(chunk);
    });
    req.on('end', () => {
      if (rejected) return;
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      } catch {
        return this.#send(res, 400);
      }

      const playing = body?.playing === true;
      const artist = cleanText(body?.artist);
      const title = cleanText(body?.title);
      if (playing && !title) return this.#send(res, 400);

      const previous = this.state;
      this.state = { playing, artist, title, updatedAt: this.now() };
      if (!previous || previous.playing !== playing || previous.artist !== artist || previous.title !== title) {
        console.log(playing ? `[track-bridge] играет: ${artist || 'Неизвестный исполнитель'} - ${title}` : '[track-bridge] пауза');
      }
      this.#send(res, 204);
    });
    req.on('error', () => {
      if (!res.writableEnded) this.#send(res, 400);
    });
  }

  async #handleFossabotTrack(req, res) {
    const context = await validateFossabotRequest({
      headers: req.headers,
      channels: this.fossabot.channels,
      fetchFn: this.fossabot.fetchFn,
      timeoutMs: this.fossabot.timeoutMs,
    });
    if (!context) return this.#send(res, 403);

    const state = this.getCurrentTrack();
    const text =
      state?.status === 'playing'
        ? `Сейчас играет: ${state.artist || 'Неизвестный исполнитель'} - ${state.title}`
        : TRACK_IDLE_TEXT;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    console.log(
      `[fossabot-track] запрос от ${context.message.user?.login || 'зрителя'} для #${String(context.channel?.login ?? '').toLowerCase()}`,
    );
    this.#send(res, 200, text);
  }
}

export class TrackProvider {
  constructor({ bridge, fallback }) {
    this.bridge = bridge;
    this.fallback = fallback;
  }

  async getCurrentTrack() {
    const bridged = this.bridge.getCurrentTrack();
    if (bridged) return bridged;
    return this.fallback.getCurrentTrack();
  }
}
