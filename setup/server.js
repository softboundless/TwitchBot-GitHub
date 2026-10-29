import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { parseEnv } from 'node:util';
import { fields, commands, defaults, secretKeys, dynamicKeys, channelList, validateValues, serializeEnv } from './schema.js';
import { channelDataPaths } from '../src/channelPolicy.js';

const setupDir = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.dirname(setupDir);
const staticFiles = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
  ['/style.css', ['style.css', 'text/css; charset=utf-8']],
]);

export async function readSettings(directory) {
  try { return { exists: true, values: parseEnv(await fs.readFile(path.join(directory, '.env'), 'utf8')) }; }
  catch (error) { if (error.code === 'ENOENT') return { exists: false, values: {} }; throw error; }
}

export async function writeSettings(directory, values) {
  const destination = path.join(directory, '.env');
  const temp = path.join(directory, `.env.${randomBytes(12).toString('hex')}.tmp`);
  try {
    await fs.writeFile(temp, serializeEnv(values), { mode: 0o600, flag: 'wx' });
    await fs.rename(temp, destination);
  } finally { await fs.unlink(temp).catch(() => {}); }
}

async function readOptional(file) {
  try { return await fs.readFile(file); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

async function chatCommands(directory, channel) {
  const file = channelDataPaths(path.join(directory, 'data', 'fun'), channel).commands;
  const bytes = await readOptional(file);
  if (bytes === null) return { file, disabled: [] };
  let disabled;
  try { disabled = JSON.parse(bytes.toString('utf8')); } catch {}
  if (!Array.isArray(disabled) || disabled.some(cmd => typeof cmd !== 'string' || !cmd.startsWith('!'))) {
    throw new Error(`Файл настроек команд канала ${channel} повреждён. Проверьте data/fun/${channel}/commands.json; он не был изменён.`);
  }
  return { file, disabled };
}

async function readChatCommands(directory, values) {
  const entries = await Promise.all(channelList(values.TWITCH_CHANNELS).map(async channel =>
    [channel, (await chatCommands(directory, channel)).disabled]));
  return Object.fromEntries(entries);
}

async function commandChanges(directory, values, requested = {}) {
  if (!requested || typeof requested !== 'object' || Array.isArray(requested)) throw new Error('Неверный список команд для включения.');
  const channels = new Set(channelList(values.TWITCH_CHANNELS));
  const known = new Set(commands.map(command => command.name));
  const changes = [];
  for (const [channel, enabled] of Object.entries(requested)) {
    if (!channels.has(channel)) throw new Error('Команды можно включать только в настроенных каналах.');
    if (!Array.isArray(enabled) || enabled.some(cmd => typeof cmd !== 'string' || !known.has(cmd))) throw new Error(`Неверный список команд канала ${channel}.`);
    const current = await chatCommands(directory, channel);
    const remove = new Set(enabled);
    const next = current.disabled.filter(cmd => !remove.has(cmd));
    if (next.length !== current.disabled.length) changes.push({ file: current.file, content: JSON.stringify(next, null, 2) + '\n' });
  }
  return changes;
}

// Сначала готовим все файлы; при ошибке записи восстанавливаем уже заменённые.
async function commitSettings(directory, values, commandUpdates) {
  const changes = [...commandUpdates, { file: path.join(directory, '.env'), content: serializeEnv(values) }];
  const staged = [];
  const committed = [];
  try {
    for (const change of changes) {
      const entry = { ...change, original: await readOptional(change.file), temp: `${change.file}.${randomBytes(12).toString('hex')}.tmp` };
      staged.push(entry);
      await fs.writeFile(entry.temp, entry.content, { mode: 0o600, flag: 'wx' });
    }
    for (const entry of staged) {
      await fs.rename(entry.temp, entry.file);
      committed.push(entry);
    }
  } catch (error) {
    let restoreFailed = false;
    for (const entry of committed.reverse()) {
      try {
        if (entry.original === null) await fs.unlink(entry.file);
        else {
          await fs.writeFile(entry.temp, entry.original, { mode: 0o600, flag: 'wx' });
          await fs.rename(entry.temp, entry.file);
        }
      } catch { restoreFailed = true; }
    }
    if (restoreFailed) throw new Error('Сохранение прервалось, часть настроек не удалось восстановить. Проверьте .env и файлы команд перед перезапуском бота.');
    throw error;
  } finally {
    await Promise.all(staged.map(entry => fs.unlink(entry.temp).catch(() => {})));
  }
}

function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(value));
}

async function body(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 128 * 1024) throw new Error('Форма слишком большая.');
    chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new Error('Не удалось прочитать форму.'); }
}

export function createSetupServer({ directory = rootDir } = {}) {
  const csrfToken = randomBytes(32).toString('hex');
  let saving = false;
  const server = http.createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    const port = server.address()?.port;
    const allowedHosts = [`127.0.0.1:${port}`, `localhost:${port}`];
    if (!allowedHosts.includes(req.headers.host)) return json(res, 403, { error: 'Панель доступна только через localhost.' });
    const expectedOrigin = `http://${req.headers.host}`;
    if (req.headers.origin && req.headers.origin !== expectedOrigin) return json(res, 403, { error: 'Запрос с другого сайта запрещён.' });
    try {
      const url = new URL(req.url, expectedOrigin);
      if (url.pathname === '/api/config' && req.method === 'GET') {
        const stored = await readSettings(directory);
        const values = { ...defaults, DISABLED_COMMANDS: '', ...stored.values };
        const allowed = new Set([...fields.map(f => f.key), 'DISABLED_COMMANDS', ...dynamicKeys(values)]);
        const visible = Object.fromEntries(Object.entries(values).filter(([key]) => allowed.has(key) && !secretKeys.includes(key)));
        const chatDisabledCommands = await readChatCommands(directory, values);
        return json(res, 200, { fields, commands, values: visible, chatDisabledCommands, secretsSet: secretKeys.filter(k => !!values[k]), csrfToken, exists: stored.exists });
      }
      if (url.pathname === '/api/config' && req.method === 'POST') {
        const supplied = Buffer.from(String(req.headers['x-setup-token'] || ''));
        const expected = Buffer.from(csrfToken);
        if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) return json(res, 403, { error: 'Сессия настройки истекла. Обновите страницу.' });
        if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) return json(res, 415, { error: 'Ожидается JSON-форма.' });
        if (saving) return json(res, 409, { error: 'Настройки уже сохраняются. Повторите запрос.' });
        saving = true;
        try {
          const payload = await body(req);
          if (!payload || typeof payload !== 'object' || !payload.values || typeof payload.values !== 'object' || Array.isArray(payload.values)) throw new Error('Неверный формат настроек.');
          const stored = await readSettings(directory);
          const next = { ...defaults, DISABLED_COMMANDS: '', ...stored.values };
          const combined = { ...next, ...payload.values };
          const allowed = new Set([...fields.map(f => f.key), 'DISABLED_COMMANDS', ...dynamicKeys(combined), ...dynamicKeys(next)]);
          for (const [key, value] of Object.entries(payload.values)) {
            if (!allowed.has(key)) throw new Error(`Неизвестная настройка ${key}.`);
            if (typeof value !== 'string') throw new Error(`Настройка ${key} должна быть строкой.`);
            if (secretKeys.includes(key) && value === '') continue;
            next[key] = value;
          }
          const clearSecrets = payload.clearSecrets ?? [];
          const deleteKeys = payload.deleteKeys ?? [];
          if (!Array.isArray(clearSecrets) || clearSecrets.some(k => !secretKeys.includes(k))) throw new Error('Неверный список секретов.');
          if (!Array.isArray(deleteKeys) || deleteKeys.some(k => !dynamicKeys(next).includes(k) && !dynamicKeys(stored.values).includes(k))) throw new Error('Неверный список настроек для удаления.');
          for (const key of clearSecrets) next[key] = '';
          for (const key of deleteKeys) delete next[key];
          validateValues(next);
          const updates = await commandChanges(directory, next, payload.enableChatCommands);
          await commitSettings(directory, next, updates);
          return json(res, 200, { ok: true, message: 'Настройки сохранены в .env. Перезапустите бот, чтобы применить изменения.' });
        } finally { saving = false; }
      }
      if (req.method === 'GET' && staticFiles.has(url.pathname)) {
        const [filename, contentType] = staticFiles.get(url.pathname);
        const data = await fs.readFile(path.join(setupDir, filename));
        res.writeHead(200, { 'Content-Type': contentType });
        return res.end(data);
      }
      return json(res, 404, { error: 'Страница не найдена.' });
    } catch (error) {
      if (error.code) return json(res, 500, { error: 'Не удалось прочитать или сохранить файл настроек. Проверьте права на папку бота.' });
      return json(res, 400, { error: error.message });
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  return server;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.SETUP_PORT || 8788);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('SETUP_PORT должен быть от 1024 до 65535.');
  const server = createSetupServer();
  server.on('error', e => { console.error(`[setup] ${e.code === 'EADDRINUSE' ? `Порт ${port} занят. Задайте другой SETUP_PORT.` : 'Не удалось запустить панель.'}`); process.exitCode = 1; });
  server.listen(port, '127.0.0.1', () => {
    console.log(`Откройте http://127.0.0.1:${port} для настройки Twitch Bot.`);
    console.log('Панель сохраняет .env в этой копии. Для закрытия: Ctrl+C.');
  });
}
