import { EventEmitter } from 'node:events';

const WS_URL = 'wss://eventsub.wss.twitch.tv/ws';
const CONNECT_TIMEOUT_MS = 30_000;

// Активный сокет и ещё не получившая welcome попытка учитываются отдельно.
export class EventSubClient extends EventEmitter {
  constructor({ subscriptions, helix, webSocketFactory = (url) => new WebSocket(url),
    schedule = setTimeout, cancel = clearTimeout }) {
    super();
    this.subscriptions = subscriptions;
    this.helix = helix;
    this.webSocketFactory = webSocketFactory;
    this.schedule = schedule;
    this.cancel = cancel;
    this.ws = null;
    this.pendingWs = null;
    this.sessionId = null;
    this.keepaliveTimer = null;
    this.connectTimer = null;
    this.reconnectTimer = null;
    this.keepaliveSeconds = 30;
    this.closedByUs = false;
    this.connecting = false;
    this.ready = false;
    this.reconnectDelay = 1000;
  }

  isConnected() {
    return this.ws?.readyState === 1 && this.ready && Boolean(this.sessionId);
  }

  ensureConnected() {
    if (this.closedByUs || this.connecting || this.reconnectTimer !== null || this.isConnected()) return;
    this.connect();
  }

  connect(url = WS_URL, isReconnect = false) {
    if (this.closedByUs || this.connecting || this.reconnectTimer !== null ||
      (!isReconnect && this.isConnected())) return;
    this.connecting = true;
    let ws;
    try {
      ws = this.webSocketFactory(url);
    } catch (error) {
      console.error('[eventsub] не удалось открыть сокет:', error.message);
      this.resetConnection();
      return;
    }
    this.pendingWs = ws;
    this.connectTimer = this.schedule(() => {
      if (!this.isCurrent(ws)) return;
      console.error('[eventsub] таймаут подключения/оформления подписок');
      this.resetConnection();
    }, CONNECT_TIMEOUT_MS);

    ws.addEventListener('message', (event) => {
      this.onMessage(ws, event, isReconnect).catch((error) => {
        if (!this.isCurrent(ws)) return;
        console.error('[eventsub] ошибка обработки сообщения:', error.message);
        this.resetConnection();
      });
    });
    ws.addEventListener('close', () => this.onDisconnect(ws));
    ws.addEventListener('error', (error) => {
      if (!this.isCurrent(ws)) return;
      console.error('[eventsub] ошибка сокета:', error?.message ?? 'WebSocket error');
      // Сначала отвязываем сокет: close() сам может синхронно вызвать error.
      this.onDisconnect(ws);
    });
  }

  isCurrent(ws) {
    return !this.closedByUs && (this.ws === ws || this.pendingWs === ws);
  }

  async onMessage(ws, event, isReconnect) {
    if (!this.isCurrent(ws)) return;
    let msg;
    try { msg = JSON.parse(String(event.data)); } catch { return; }
    const type = msg.metadata?.message_type;
    if (type === 'session_welcome') {
      if (this.pendingWs !== ws) return;
      const oldWs = this.ws;
      this.ws = ws;
      this.pendingWs = null;
      this.ready = false;
      const sessionId = msg.payload.session.id;
      this.sessionId = sessionId;
      this.keepaliveSeconds = msg.payload.session.keepalive_timeout_seconds ?? 10;
      this.armKeepalive(ws);
      // Twitch переносит подписки только при миграции по reconnect_url.
      this.closeSocket(oldWs);
      if (!isReconnect && !(await this.subscribeAll(ws, sessionId))) return;
      if (this.ws !== ws || this.closedByUs) return;
      this.cancel(this.connectTimer);
      this.connectTimer = null;
      this.connecting = false;
      this.ready = true;
      this.reconnectDelay = 1000;
      if (isReconnect) console.log('[eventsub] переподключение завершено, подписки сохранены');
      this.emit('connected');
      return;
    }
    if (this.ws !== ws) return;
    switch (type) {
      case 'session_keepalive':
        this.armKeepalive(ws);
        break;
      case 'notification':
        this.armKeepalive(ws);
        this.emit('notification', msg.payload.subscription.type, msg.payload.event);
        break;
      case 'session_reconnect':
        console.log('[eventsub] Твич просит переподключиться');
        this.connect(msg.payload.session.reconnect_url, true);
        break;
      case 'revocation':
        console.error(`[eventsub] подписка ${msg.payload.subscription?.type} отозвана: ${msg.payload.subscription?.status}`);
        this.resetConnection();
        break;
    }
  }

  async subscribeAll(ws, sessionId) {
    for (const sub of this.subscriptions) {
      if (this.ws !== ws || this.closedByUs) return false;
      try {
        await this.helix.createEventSubSubscription({ ...sub, sessionId });
      } catch (error) {
        if (this.ws !== ws || this.closedByUs) return false;
        console.error(`[eventsub] не удалось подписаться на ${sub.type}: ${error.message}`);
        this.resetConnection();
        return false;
      }
      if (this.ws !== ws || this.closedByUs) return false;
      console.log(`[eventsub] подписка оформлена: ${sub.type} v${sub.version}`);
    }
    return true;
  }

  onDisconnect(ws) {
    if (!this.isCurrent(ws)) return;
    if (this.ws === ws && this.pendingWs) {
      // Во время миграции старый сокет может закрыться раньше нового welcome.
      this.ws = null;
      this.sessionId = null;
      this.ready = false;
      this.cancel(this.keepaliveTimer);
      this.keepaliveTimer = null;
      this.closeSocket(ws);
      return;
    }
    this.resetConnection();
  }

  armKeepalive(ws) {
    this.cancel(this.keepaliveTimer);
    this.keepaliveTimer = this.schedule(() => {
      if (this.ws !== ws || this.closedByUs) return;
      console.log('[eventsub] нет сигнала от Твича, переподключаюсь');
      this.onDisconnect(ws);
    }, (this.keepaliveSeconds + 10) * 1000);
  }

  closeSocket(ws) {
    if (!ws || ws.readyState >= 2) return;
    try { ws.close(); } catch {}
  }

  resetConnection() {
    const sockets = [this.ws, this.pendingWs];
    this.ws = null;
    this.pendingWs = null;
    this.sessionId = null;
    this.connecting = false;
    this.ready = false;
    this.cancel(this.keepaliveTimer);
    this.cancel(this.connectTimer);
    this.keepaliveTimer = null;
    this.connectTimer = null;
    for (const ws of sockets) this.closeSocket(ws);
    this.scheduleReconnect();
  }

  scheduleReconnect() {
    if (this.closedByUs || this.reconnectTimer !== null) return;
    console.log(`[eventsub] соединение потеряно, переподключение через ${this.reconnectDelay / 1000} с`);
    this.reconnectTimer = this.schedule(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30_000);
  }

  close() {
    this.closedByUs = true;
    this.cancel(this.reconnectTimer);
    this.reconnectTimer = null;
    this.resetConnection();
  }
}
