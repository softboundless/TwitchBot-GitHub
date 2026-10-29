import fs from 'node:fs';
import path from 'node:path';

const TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const VALIDATE_URL = 'https://id.twitch.tv/oauth2/validate';

// Хранит пару access/refresh-токенов одного аккаунта ('bot' или 'owner')
// в tokens/<account>.json и обновляет её по мере протухания.
export class TokenStore {
  constructor(config, account) {
    this.config = config;
    this.account = account;
    this.file = path.join(config.tokensDir, `${account}.json`);
    this.data = null;
    this.expiresAt = 0; // unix ms; 0 = неизвестно
  }

  get login() {
    return this.data?.login ?? null;
  }

  get userId() {
    return this.data?.user_id ?? null;
  }

  exists() {
    return fs.existsSync(this.file);
  }

  load() {
    this.data = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    this.loadedMtimeMs = fs.statSync(this.file).mtimeMs;
    return this.data;
  }

  save(data = this.data) {
    this.data = data;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
    this.loadedMtimeMs = fs.statSync(this.file).mtimeMs;
  }

  // Файл могли перезаписать снаружи (повторная авторизация через scripts/authorize.js).
  // Тогда берём свежий токен с диска — иначе бот затрёт его своим старым при refresh().
  reloadIfChanged() {
    try {
      if (fs.statSync(this.file).mtimeMs !== this.loadedMtimeMs) {
        this.load();
        this.expiresAt = 0; // заставит провалидировать новый токен
        console.log(`[auth] токен «${this.account}» перечитан с диска (файл обновился снаружи)`);
      }
    } catch {
      // файл недоступен — работаем с тем, что в памяти
    }
  }

  // null — токен невалиден (401), иначе объект с login/user_id/scopes/expires_in
  async validate() {
    const res = await fetch(VALIDATE_URL, {
      headers: { Authorization: `OAuth ${this.data.access_token}` },
    });
    if (res.status === 401) return null;
    if (!res.ok) throw new Error(`validate «${this.account}»: HTTP ${res.status}`);
    const info = await res.json();
    this.expiresAt = Date.now() + info.expires_in * 1000;
    this.data.login = info.login;
    this.data.user_id = info.user_id;
    this.data.scopes = info.scopes;
    return info;
  }

  async refresh() {
    const body = new URLSearchParams({
      client_id: this.config.clientId,
      client_secret: this.config.clientSecret,
      grant_type: 'refresh_token',
      refresh_token: this.data.refresh_token,
    });
    const res = await fetch(TOKEN_URL, { method: 'POST', body });
    if (!res.ok) {
      const text = (await res.text()).slice(0, 200);
      throw new Error(
        `не удалось обновить токен «${this.account}» (HTTP ${res.status}: ${text}). ` +
          'Нужна повторная авторизация — см. README.md',
      );
    }
    const json = await res.json();
    this.data.access_token = json.access_token;
    if (json.refresh_token) this.data.refresh_token = json.refresh_token;
    this.expiresAt = Date.now() + (json.expires_in ?? 3600) * 1000;
    this.save();
    console.log(`[auth] токен «${this.account}» обновлён`);
  }

  // Отдаёт живой access_token, при необходимости обновив его.
  async ensureFresh() {
    if (!this.data) this.load();
    else this.reloadIfChanged();
    if (Date.now() > this.expiresAt - 10 * 60 * 1000) {
      const info = await this.validate().catch(() => null);
      if (!info) await this.refresh();
    }
    return this.data.access_token;
  }

  // Загрузка и проверка при старте. false — файла с токеном нет вообще.
  async init() {
    if (!this.exists()) return false;
    this.load();
    let info = await this.validate();
    if (!info) {
      await this.refresh();
      info = await this.validate();
      if (!info) throw new Error(`токен «${this.account}» невалиден даже после обновления`);
    }
    return true;
  }
}
