import { WebSocketServer, WebSocket } from 'ws';
import type { Server as HttpServer } from 'node:http';
import type { SessionManager } from '../acp/runtime.js';
import type { Store } from '../store/db.js';
import { PairingService, verifySignature, newNonce, deviceUsable } from '../auth/pairing.js';
import type { ClientMessage, ServerMessage, SessionEvent, PendingPermission } from '@devin-remote/protocol';
import type { ServerConfig } from '../config.js';

interface ClientState {
  ws: WebSocket;
  authed: boolean;
  deviceId?: string;
  deviceName?: string;
  nonce?: string;
  subscriptions: Set<string>;
  remoteKey: string;
  alive: boolean;
}

/**
 * WebSocket 网关 — 配对/鉴权握手 + 订阅分发 + 协议路由
 * 握手时序: pair → pair.ok | auth.hello → auth.challenge → auth.response → auth.ok
 */

/** 快照事件瘦身: tool_call 的 rawInput/rawOutput 可能含整文件内容, 超 16KB 截断 */
function sanitizeEventForSnapshot(ev: import('@devin-remote/protocol').SessionEvent): typeof ev {
  if (ev.kind !== 'acp-update' || !ev.payload) return ev;
  const p = ev.payload as Record<string, unknown>;
  const MAX = 16 * 1024;
  const cut = (v: unknown): unknown =>
    typeof v === 'string' && v.length > MAX ? v.slice(0, MAX) + ' …[truncated]' : v;
  if (p.rawInput || p.rawOutput) {
    return { ...ev, payload: { ...p, rawInput: cut(p.rawInput), rawOutput: cut(p.rawOutput) } };
  }
  return ev;
}

export class Gateway {
  private wss: WebSocketServer;
  private clients = new Set<ClientState>();
  private serverVersion = '0.1.0';

  constructor(
    httpServer: HttpServer,
    private mgr: SessionManager,
    private store: Store,
    private pairing: PairingService,
    private config: ServerConfig,
    private startedAt: number,
  ) {
    this.wss = new WebSocketServer({ server: httpServer, path: '/ws' });
    this.wss.on('connection', (ws, req) => this.onConnection(ws, req.socket.remoteAddress ?? 'unknown'));

    mgr.on('event', (ev: SessionEvent) => this.broadcastEvent(ev));
    mgr.on('sessionStatus', (sessionId: string, status: string, title?: string | null) => {
      this.broadcast({ type: 'session.status', sessionId, status: status as never, title });
    });
    mgr.on('permissionRequest', (p: PendingPermission) => {
      this.broadcast({ type: 'permission.request', request: p });
    });
    mgr.on('permissionResolved', (sessionId: string, requestId: string, optionId: string | undefined, cancelled: boolean, byDevice: string) => {
      this.broadcast({ type: 'permission.resolved', sessionId, requestId, optionId, cancelled, byDevice });
    });

    // 心跳保活: 30s 探活, 死的清掉
    const iv = setInterval(() => {
      for (const c of this.clients) {
        if (!c.alive) {
          try { c.ws.terminate(); } catch { /* ignore */ }
          this.clients.delete(c);
          continue;
        }
        c.alive = false;
        try { c.ws.ping(); } catch { /* ignore */ }
      }
    }, 30000);
    this.wss.on('close', () => clearInterval(iv));
  }

  private onConnection(ws: WebSocket, remoteKey: string) {
    const state: ClientState = {
      ws, authed: false, subscriptions: new Set(), remoteKey, alive: true,
    };
    this.clients.add(state);
    ws.on('pong', () => { state.alive = true; });
    ws.on('close', () => this.clients.delete(state));
    ws.on('error', () => this.clients.delete(state));
    ws.on('message', (data) => {
      let msg: ClientMessage;
      try {
        msg = JSON.parse(data.toString());
      } catch {
        return this.send(ws, { type: 'error', code: 'bad_json', message: '消息不是合法 JSON' });
      }
      this.handleMessage(state, msg).catch((err) => {
        this.send(ws, { type: 'error', code: 'internal', message: String(err?.message ?? err) });
      });
    });
  }

  private send(ws: WebSocket, msg: ServerMessage): void {
    if (ws.readyState === ws.OPEN) {
      ws.send(JSON.stringify(msg));
    }
  }

  private broadcast(msg: ServerMessage, sessionId?: string): void {
    for (const c of this.clients) {
      if (!c.authed) continue;
      this.send(c.ws, msg);
    }
  }

  private broadcastEvent(ev: SessionEvent): void {
    for (const c of this.clients) {
      if (!c.authed) continue;
      if (!c.subscriptions.has(ev.sessionId)) continue;
      this.send(c.ws, { type: 'session.event', event: ev });
    }
  }

  private async handleMessage(state: ClientState, msg: ClientMessage): Promise<void> {
    const ws = state.ws;

    // ---------- 配对与鉴权 (未 authed 唯一入口) ----------
    if (msg.type === 'pair') {
      const res = this.pairing.tryPair(msg.code, msg.deviceName, msg.platform, state.remoteKey);
      if (!res.ok) {
        return this.send(ws, { type: 'error', code: 'pair_failed', message: res.reason });
      }
      this.send(ws, {
        type: 'pair.ok',
        deviceId: res.device.deviceId,
        deviceSecret: res.device.deviceSecret,
        deviceName: res.device.deviceName,
      });
      return;
    }

    if (msg.type === 'auth.hello') {
      const device = this.store.getDevice(msg.deviceId);
      const usable = device ? deviceUsable(device) : { ok: false as const, reason: '设备不存在, 请重新配对' };
      if (!device || !usable.ok) {
        return this.send(ws, { type: 'error', code: 'auth_rejected', message: usable.reason ?? '设备不存在, 请重新配对' });
      }
      state.nonce = newNonce();
      state.deviceId = msg.deviceId;
      this.send(ws, { type: 'auth.challenge', nonce: state.nonce });
      return;
    }

    if (msg.type === 'auth.response') {
      const device = this.store.getDevice(msg.deviceId);
      if (!device || !state.nonce || msg.nonce !== state.nonce) {
        return this.send(ws, { type: 'error', code: 'auth_rejected', message: '挑战无效' });
      }
      if (!verifySignature(device.deviceSecret, msg.deviceId, state.nonce, msg.signature)) {
        return this.send(ws, { type: 'error', code: 'auth_rejected', message: '签名验证失败' });
      }
      state.authed = true;
      state.deviceName = device.deviceName;
      this.store.touchDevice(device.deviceId);
      this.send(ws, {
        type: 'auth.ok',
        deviceId: device.deviceId,
        deviceName: device.deviceName,
        serverVersion: this.serverVersion,
      });
      return;
    }

    if (msg.type === 'ping') {
      return this.send(ws, { type: 'pong', ts: Date.now() });
    }

    // ---------- 以下全部要求已鉴权 ----------
    if (!state.authed) {
      return this.send(ws, { type: 'error', code: 'unauthorized', message: '未完成配对/鉴权' });
    }

    switch (msg.type) {
      case 'session.list': {
        this.send(ws, { type: 'session.list', sessions: this.mgr.list().map((rt) => rt.meta) });
        break;
      }

      case 'session.subscribe': {
        const rt = this.mgr.get(msg.sessionId);
        if (!rt) return this.send(ws, { type: 'error', code: 'no_session', message: '会话不存在' });
        state.subscriptions.add(msg.sessionId);
        const sinceSeq = msg.sinceSeq ?? 0;
        const all = this.store.eventsSince(msg.sessionId, sinceSeq);
        // 全量快照(sinceSeq=0)限量最近 400 条防爆 WS; 增量补拉不截断 — 截断会造成中间 seq 永久丢失
        const SNAP_LIMIT = 400;
        const truncated = sinceSeq <= 0 && all.length > SNAP_LIMIT;
        const events = (truncated ? all.slice(-SNAP_LIMIT) : all).map(sanitizeEventForSnapshot);
        this.send(ws, {
          type: 'session.snapshot',
          sessionId: msg.sessionId,
          session: rt.meta,
          events,
          truncated,
          totalEvents: all.length,
          acp: rt.acpCache,
          pendingPermissions: rt.listPendingPermissions(),
        });
        // acp 侧未加载时快照用的是磁盘缓存, configOptions 可能陈旧 (认证/清单变化后)
        // 后台触发 load — 完成后广播 session.loaded 刷新各端模型/模式清单; 失败不影响订阅
        if (!rt.acpLoaded) {
          this.mgr.loadDevinSession(msg.sessionId, rt.meta.cwd, rt.meta.additionalDirectories)
            .then((loaded) => {
              this.broadcast({ type: 'session.loaded', session: loaded.meta, acp: loaded.acpCache ?? undefined });
            })
            .catch(() => { /* load 失败不影响订阅; prompt 前还会重试 */ });
        }
        break;
      }

      case 'session.history': {
        const rt = this.mgr.get(msg.sessionId);
        if (!rt) return this.send(ws, { type: 'error', code: 'no_session', message: '会话不存在' });
        const limit = Math.min(Math.max(msg.limit ?? 200, 1), 400);
        const batch = this.store.eventsBefore(msg.sessionId, msg.beforeSeq, limit)
          .map(sanitizeEventForSnapshot);
        this.send(ws, {
          type: 'session.history.batch',
          sessionId: msg.sessionId,
          events: batch,
          hasMore: batch.length === limit && (batch[0]?.seq ?? 0) > 1,
          oldestSeq: batch[0]?.seq ?? msg.beforeSeq,
        });
        break;
      }

      case 'session.unsubscribe': {
        state.subscriptions.delete(msg.sessionId);
        break;
      }

      case 'session.create': {
        const allowed = this.config.workdirs.length === 0
          || this.config.workdirs.some((w) => w.path.toLowerCase() === msg.cwd.toLowerCase());
        if (!allowed) {
          return this.send(ws, { type: 'error', code: 'cwd_not_allowed', message: '该目录不在允许清单内' });
        }
        try {
          const rt = await this.mgr.createSession(msg.cwd);
          const created = { type: 'session.created' as const, session: rt.meta, acp: rt.acpCache ?? undefined };
          this.broadcast(created);
        } catch (e) {
          this.send(ws, { type: 'error', code: 'create_failed', message: String((e as Error).message) });
        }
        break;
      }

      case 'session.prompt': {
        const rt = this.mgr.get(msg.sessionId);
        if (!rt) return this.send(ws, { type: 'error', code: 'no_session', message: '会话不存在' });
        rt.prompt(msg.text, msg.clientMsgId, state.deviceName ?? 'unknown', msg.attachments);
        break;
      }

      case 'devinSession.list': {
        try {
          const sessions = await this.mgr.listDevinSessions();
          this.send(ws, { type: 'devinSession.list', sessions });
        } catch (e) {
          this.send(ws, { type: 'error', code: 'list_failed', message: String((e as Error).message) });
        }
        break;
      }

      case 'session.load': {
        try {
          const rt = await this.mgr.loadDevinSession(msg.devinSessionId, msg.cwd, msg.additionalDirectories);
          const loaded = { type: 'session.loaded' as const, session: rt.meta, acp: rt.acpCache ?? undefined };
          this.broadcast(loaded);
        } catch (e) {
          this.send(ws, { type: 'error', code: 'load_failed', message: String((e as Error).message) });
        }
        break;
      }

      case 'session.cancel': {
        this.mgr.get(msg.sessionId)?.cancel();
        break;
      }

      case 'session.setMode': {
        const rt = this.mgr.get(msg.sessionId);
        if (!rt) return this.send(ws, { type: 'error', code: 'no_session', message: '会话不存在' });
        try {
          await rt.setMode(msg.modeId);
        } catch (e) {
          this.send(ws, { type: 'error', code: 'mode_failed', message: String((e as Error).message) });
        }
        break;
      }

      case 'session.setConfig': {
        const rt = this.mgr.get(msg.sessionId);
        if (!rt) return this.send(ws, { type: 'error', code: 'no_session', message: '会话不存在' });
        try {
          await rt.setConfig(msg.configId, msg.value);
        } catch (e) {
          this.send(ws, { type: 'error', code: 'config_failed', message: String((e as Error).message) });
        }
        break;
      }

      case 'permission.respond': {
        const rt = this.mgr.get(msg.sessionId);
        if (!rt) return this.send(ws, { type: 'error', code: 'no_session', message: '会话不存在' });
        const ok = rt.respondPermission(msg.requestId, msg.optionId, msg.cancelled ?? !msg.optionId, state.deviceName ?? 'unknown');
        if (!ok) {
          this.send(ws, { type: 'error', code: 'permission_gone', message: '该请求已被处理或不存在', ref: msg.requestId });
        }
        break;
      }

      case 'status.request': {
        this.send(ws, {
          type: 'server.status',
          uptimeSec: Math.floor((Date.now() - this.startedAt) / 1000),
          host: this.config.host,
          port: this.config.port,
          hostname: this.config.publicHostname,
          activeSessions: this.mgr.list().filter((rt) => rt.isRunning()).length,
          onlineDevices: [...this.clients].filter((c) => c.authed).length,
          version: this.serverVersion,
        });
        break;
      }

      case 'device.list': {
        const online = new Set([...this.clients].filter((c) => c.authed).map((c) => c.deviceId));
        this.send(ws, {
          type: 'device.list',
          devices: this.store.listDevices().filter((d) => !d.revokedAt).map((d) => ({
            deviceId: d.deviceId,
            deviceName: d.deviceName,
            platform: d.platform,
            pairedAt: d.pairedAt,
            lastActiveAt: d.lastActiveAt,
            online: online.has(d.deviceId),
          })),
        });
        break;
      }

      case 'device.revoke': {
        const okRevoke = this.store.revokeDevice(msg.deviceId);
        // 踢掉在线连接
        for (const c of this.clients) {
          if (c.deviceId === msg.deviceId) {
            try { c.ws.close(4000, 'revoked'); } catch { /* ignore */ }
          }
        }
        if (!okRevoke) this.send(ws, { type: 'error', code: 'no_device', message: '设备不存在' });
        break;
      }

      case 'device.delete': {
        if (!this.store.deleteDevice(msg.deviceId)) {
          this.send(ws, { type: 'error', code: 'delete_rejected', message: '设备不存在或未撤销 — 仅已撤销设备可删除' });
        } else {
          this.send(ws, { type: 'device.deleted', deviceId: msg.deviceId });
        }
        break;
      }

      case 'workdir.list': {
        const { existsSync } = await import('node:fs');
        this.send(ws, {
          type: 'workdir.list',
          dirs: this.config.workdirs.map((w) => ({ ...w, exists: existsSync(w.path) })),
        });
        break;
      }

      default:
        this.send(ws, { type: 'error', code: 'unknown_type', message: `未知消息类型: ${(msg as { type?: string }).type}` });
    }
  }

  onlineDeviceCount(): number {
    return [...this.clients].filter((c) => c.authed).length;
  }
}
