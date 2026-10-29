import { EventEmitter } from 'node:events';

const IRC_URL = 'wss://irc-ws.chat.twitch.tv:443';

// Подключение к чату Твича по IRC-over-WebSocket (глобальный WebSocket доступен в Node 22).
// Эмитит событие 'chat' с { login, displayName, text, isBroadcaster, isMod }.
export class TwitchChat extends EventEmitter {
  constructor({ channel, channels, tokenStore }) {
    super();
    this.channels = [
      ...new Set(
        (channels ?? [channel])
          .map((value) => String(value ?? '').trim().replace(/^#/, '').toLowerCase())
          .filter(Boolean),
      ),
    ];
    if (this.channels.length === 0) throw new Error('не указан ни один Twitch-канал для подключения');
    this.channel = this.channels[0];
    this.tokenStore = tokenStore;
    this.ws = null;
    this.closedByUs = false;
    this.reconnectDelay = 1000;
    this.reconnectTimer = null;
    this.connectTimer = null;
    this.pingTimer = null;
    this.pongTimer = null;
    this.connecting = false;
    this.generation = 0;
    this.authenticated = false;
    this.joinedChannels = new Set();
    this.detachSocket = null;
  }

  getHealth() {
    return {
      twitchConnected: this.ws?.readyState === WebSocket.OPEN && this.authenticated
        && this.channels.every((channel) => this.joinedChannels.has(channel)),
    };
  }

  clearSocket() {
    this.generation++;
    this.connecting = false;
    clearTimeout(this.connectTimer);
    clearTimeout(this.pongTimer);
    clearInterval(this.pingTimer);
    this.authenticated = false;
    this.joinedChannels.clear();
    const ws = this.ws;
    this.ws = null;
    // Detach before closing: Node may emit another error when closing CONNECTING.
    this.detachSocket?.();
    this.detachSocket = null;
    try { ws?.close(); } catch {}
  }

  async connect() {
    if (this.closedByUs || this.connecting || this.ws) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.connecting = true;
    const generation = ++this.generation;
    this.connectTimer = setTimeout(() => {
      console.error('[irc] таймаут подключения/входа в каналы');
      this.scheduleReconnect();
    }, 30_000);
    try {
      const token = await this.tokenStore.ensureFresh();
      if (this.closedByUs || generation !== this.generation) return;
      const login = this.tokenStore.login;
      const ws = new WebSocket(IRC_URL);
      this.ws = ws;
      const current = () => this.ws === ws && generation === this.generation && !this.closedByUs;
      const listeners = {
        open: () => {
          if (!current()) return;
          try {
            ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands twitch.tv/membership');
            ws.send(`PASS oauth:${token}`);
            ws.send(`NICK ${login}`);
            for (const joinedChannel of this.channels) ws.send(`JOIN #${joinedChannel}`);
          } catch { this.scheduleReconnect(); }
        },
        message: (ev) => {
          if (!current()) return;
          for (const line of String(ev.data).split('\r\n')) {
            if (!current()) break;
            if (line) this.handleLine(line);
          }
          if (this.getHealth().twitchConnected) {
            clearTimeout(this.connectTimer);
            this.connecting = false;
            if (!this.pingTimer) this.pingTimer = setInterval(() => {
              if (!current()) return;
              try { ws.send('PING :pcflbot'); } catch { this.scheduleReconnect(); return; }
              this.pongTimer = setTimeout(() => {
                console.error('[irc] Twitch не ответил на PING');
                this.scheduleReconnect();
              }, 30_000);
            }, 60_000);
          }
        },
        close: () => { if (current()) this.scheduleReconnect(); },
        error: (e) => {
          if (!current()) return;
          console.error('[irc] ошибка сокета:', e?.message ?? e);
          this.scheduleReconnect();
        },
      };
      for (const [event, listener] of Object.entries(listeners)) ws.addEventListener(event, listener);
      this.detachSocket = () => {
        for (const [event, listener] of Object.entries(listeners)) ws.removeEventListener(event, listener);
      };
    } catch (err) {
      if (this.closedByUs || generation !== this.generation) return;
      console.error('[irc] подключение не удалось:', err.message);
      this.scheduleReconnect();
    }
  }

  scheduleReconnect() {
    if (this.closedByUs || this.reconnectTimer) return;
    this.clearSocket();
    this.pingTimer = null;
    console.log(`[irc] соединение закрыто, переподключение через ${this.reconnectDelay / 1000} с`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      void this.connect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
  }

  handleLine(line) {
    if (line.startsWith('PING')) {
      try { this.ws?.send('PONG :tmi.twitch.tv'); } catch { this.scheduleReconnect(); }
      return;
    }
    const msg = parseIrcLine(line);
    if (!msg) return;
    switch (msg.command) {
      case 'PONG':
        clearTimeout(this.pongTimer);
        break;
      case '001':
        this.authenticated = true;
        console.log(`[irc] авторизованы в чате как ${msg.params[0]}`);
        this.reconnectDelay = 1000;
        break;
      case 'JOIN':
        if (msg.prefixUser?.toLowerCase() === this.tokenStore.login?.toLowerCase()) {
          const joinedChannel = String(msg.params[0] ?? '').replace(/^#/, '').toLowerCase();
          this.joinedChannels.add(joinedChannel);
          console.log(`[irc] зашли в чат #${joinedChannel || this.channel}`);
        }
        break;
      case 'NOTICE':
        console.log('[irc] NOTICE:', msg.trailing);
        if (/authentication failed|improperly formatted auth/i.test(msg.trailing ?? '')) {
          // токен протух — при переподключении ensureFresh() его обновит
          this.scheduleReconnect();
        }
        break;
      case 'RECONNECT':
        this.scheduleReconnect();
        break;
      case 'CLEARCHAT': {
        // trailing есть — забанили/затаймаутили конкретного человека;
        // нет — просто очистили чат. Кто выдал бан, здесь не сообщается.
        if (msg.trailing) {
          const channel = String(msg.params[0] ?? '').replace(/^#/, '').toLowerCase();
          if (!this.channels.includes(channel)) break;
          this.emit('clearchat', {
            channel,
            login: msg.trailing.toLowerCase(),
            durationSeconds: msg.tags['ban-duration'] ? Number(msg.tags['ban-duration']) : null,
          });
        }
        break;
      }
      case 'PRIVMSG': {
        const channel = String(msg.params[0] ?? '').replace(/^#/, '').toLowerCase();
        if (!this.channels.includes(channel)) break;
        const badges = msg.tags.badges ?? '';
        this.emit('chat', {
          channel,
          id: msg.tags.id ?? null,
          userId: msg.tags['user-id'] ?? null,
          login: (msg.prefixUser ?? '').toLowerCase(),
          displayName: msg.tags['display-name'] || msg.prefixUser,
          text: msg.trailing ?? '',
          isBroadcaster: badges.includes('broadcaster/'),
          isMod: msg.tags.mod === '1' || badges.includes('moderator/'),
          isVip: msg.tags.vip === '1' || badges.includes('vip/'),
          // founder — это тоже подписчик (старый бейдж сабов)
          isSub: msg.tags.subscriber === '1' || badges.includes('subscriber/') || badges.includes('founder/'),
        });
        break;
      }
    }
  }

  say(text, { replyTo, channel = this.channel } = {}) {
    const targetChannel = String(channel ?? '').trim().replace(/^#/, '').toLowerCase();
    if (!this.channels.includes(targetChannel)) {
      console.error(`[irc] попытка отправить сообщение в неподключённый канал #${targetChannel || '?'}`);
      return;
    }
    if (text.length > 480) text = text.slice(0, 477) + '...';
    if (this.ws?.readyState === WebSocket.OPEN) {
      const tag = replyTo ? `@reply-parent-msg-id=${replyTo} ` : '';
      this.ws.send(`${tag}PRIVMSG #${targetChannel} :${text}`);
    } else {
      console.error('[irc] нет соединения, сообщение не отправлено:', text);
    }
  }

  close() {
    this.closedByUs = true;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    this.clearSocket();
    this.pingTimer = null;
  }
}

// Разбор строки IRC: @tags :prefix COMMAND params :trailing
export function parseIrcLine(line) {
  let rest = line;
  const tags = {};
  if (rest.startsWith('@')) {
    const sp = rest.indexOf(' ');
    if (sp === -1) return null;
    for (const kv of rest.slice(1, sp).split(';')) {
      const eq = kv.indexOf('=');
      const key = eq === -1 ? kv : kv.slice(0, eq);
      const raw = eq === -1 ? '' : kv.slice(eq + 1);
      tags[key] = raw.replace(/\\(.)/g, (_, c) =>
        c === 's' ? ' ' : c === ':' ? ';' : c === 'r' ? '\r' : c === 'n' ? '\n' : c,
      );
    }
    rest = rest.slice(sp + 1);
  }
  let prefix = null;
  if (rest.startsWith(':')) {
    const sp = rest.indexOf(' ');
    if (sp === -1) return null;
    prefix = rest.slice(1, sp);
    rest = rest.slice(sp + 1);
  }
  let trailing = null;
  const colon = rest.indexOf(' :');
  if (colon !== -1) {
    trailing = rest.slice(colon + 2);
    rest = rest.slice(0, colon);
  }
  const [command, ...params] = rest.split(' ').filter(Boolean);
  if (!command) return null;
  const prefixUser = prefix?.includes('!') ? prefix.split('!')[0] : prefix;
  return { tags, prefix, prefixUser, command, params, trailing };
}
