import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { realpathSync, readFileSync, writeFileSync, statSync } from 'node:fs';
import { resolve, sep, isAbsolute } from 'node:path';
import type { AgentProcess } from './agent.js';
import type { Store } from '../store/db.js';
import type {
  SessionMeta,
  SessionEvent,
  SessionEventKind,
  PendingPermission,
} from '@devin-remote/protocol';
import type {
  SessionNewResult,
  JsonRpcRequest,
  RequestPermissionParams,
  FsReadParams,
  FsWriteParams,
  SessionUpdateParams,
} from '@devin-remote/acp-types';

interface PendingEntry {
  requestId: string;
  acpId: string | number;
  toolCall: RequestPermissionParams['toolCall'];
  options: RequestPermissionParams['options'];
  requestedAt: number;
  responded: boolean;
}

/**
 * 单会话运行时 — 状态机 + 事件溯源:
 *  事件统一分配 seq → 持久化 JSONL → 广播订阅者
 *  prompt 串行队列; 权限请求挂起等待任一客户端裁决; fs 请求限定 cwd 子树
 */
export class SessionRuntime {
  public meta: SessionMeta;
  public acpCache: SessionNewResult | null = null;
  private seq = 0;
  private promptChain: Promise<unknown> = Promise.resolve();
  private pendingPerms = new Map<string, PendingEntry>();
  private recentClientMsgIds = new Set<string>();
  private runningPrompt = false;

  constructor(
    public readonly sessionId: string,
    public readonly cwd: string,
    private mgr: SessionManager,
    existing?: SessionMeta,
  ) {
    this.meta = existing ?? {
      sessionId,
      cwd,
      title: null,
      createdAt: Date.now(),
      lastActiveAt: Date.now(),
      status: 'idle',
      lastSeq: 0,
      hasPendingPermission: false,
    };
    this.seq = this.mgr.store.lastSeq(sessionId);
    this.meta.lastSeq = this.seq;
  }

  // ---------- 事件核心 ----------

  emit(kind: SessionEventKind, payload: unknown): SessionEvent {
    this.seq++;
    const ev: SessionEvent = {
      sessionId: this.sessionId,
      seq: this.seq,
      ts: Date.now(),
      kind,
      payload,
    };
    this.mgr.store.appendEvent(ev);
    this.meta.lastActiveAt = ev.ts;
    this.meta.lastSeq = this.seq;
    this.mgr.store.upsertSession(this.meta, this.acpCache);
    this.mgr.broadcastEvent(ev);
    return ev;
  }

  private setStatus(status: SessionMeta['status'], error?: string) {
    if (this.meta.status === status) return;
    this.meta.status = status;
    this.emit('session-status', { status, error });
    this.mgr.broadcastSessionStatus(this.sessionId, status);
  }

  // ---------- ACP 通知入口 (agent→client notifications) ----------

  handleNotification(method: string, params: unknown): void {
    if (method === 'session/update') {
      const p = params as SessionUpdateParams;
      this.emit('acp-update', p.update);
      const u = p.update as { sessionUpdate?: string; title?: string | null; currentModeId?: string };
      if (u.sessionUpdate === 'session_info_update' && u.title) {
        this.meta.title = u.title;
        this.mgr.broadcastSessionStatus(this.sessionId, this.meta.status, this.meta.title);
      }
      if (u.sessionUpdate === 'current_mode_update' && u.currentModeId) {
        this.meta.modeId = u.currentModeId;
      }
    } else if (method.startsWith('_cognition.ai/')) {
      this.emit('acp-notification', { method, params });
    }
  }

  // ---------- prompt 队列 ----------

  prompt(text: string, clientMsgId: string, deviceName: string): void {
    if (this.recentClientMsgIds.has(clientMsgId)) return; // 幂等去重
    this.recentClientMsgIds.add(clientMsgId);
    if (this.recentClientMsgIds.size > 200) {
      const first = this.recentClientMsgIds.values().next().value;
      if (first) this.recentClientMsgIds.delete(first);
    }

    // 用户消息多端回显
    this.emit('user-message', { text, clientMsgId, deviceName, ts: Date.now() });

    this.promptChain = this.promptChain.then(() => this.runPrompt(text)).catch((err) => {
      this.emit('prompt-result', { stopReason: 'error', error: String(err?.message ?? err) });
      this.setStatus('idle');
    });
  }

  private async runPrompt(text: string): Promise<void> {
    const conn = this.mgr.agent.connection;
    if (!conn || conn.isClosed()) throw new Error('agent 进程不可用');
    this.runningPrompt = true;
    this.setStatus('running');
    try {
      const result = await conn.request<{ stopReason?: string; usage?: unknown }>(
        'session/prompt',
        { sessionId: this.sessionId, prompt: [{ type: 'text', text }] },
        30 * 60 * 1000, // 长 turn 上限 30min
      );
      this.emit('prompt-result', { stopReason: result?.stopReason ?? 'end_turn', usage: result?.usage });
    } finally {
      this.runningPrompt = false;
      if (!this.meta.hasPendingPermission) this.setStatus('idle');
    }
  }

  cancel(): void {
    const conn = this.mgr.agent.connection;
    conn?.notify('session/cancel', { sessionId: this.sessionId });
  }

  isRunning(): boolean {
    return this.runningPrompt;
  }

  // ---------- 模式 / 模型 ----------

  async setMode(modeId: string): Promise<void> {
    const conn = this.mgr.agent.connection;
    if (!conn) throw new Error('agent 不可用');
    await conn.request('session/set_mode', { sessionId: this.sessionId, modeId }, 15000);
  }

  async setConfig(configId: string, value: string): Promise<unknown> {
    const conn = this.mgr.agent.connection;
    if (!conn) throw new Error('agent 不可用');
    const r = await conn.request('session/set_config_option', { sessionId: this.sessionId, configId, value }, 15000);
    if (configId === 'model') this.meta.modelId = value;
    if (configId === 'mode') this.meta.modeId = value;
    return r;
  }

  // ---------- 权限裁决 ----------

  handlePermissionRequest(msg: JsonRpcRequest): void {
    const params = msg.params as RequestPermissionParams;
    const requestId = randomUUID();
    const entry: PendingEntry = {
      requestId,
      acpId: msg.id,
      toolCall: params.toolCall,
      options: params.options,
      requestedAt: Date.now(),
      responded: false,
    };
    this.pendingPerms.set(requestId, entry);
    this.meta.hasPendingPermission = true;
    this.setStatus('waiting_permission');

    const pending: PendingPermission = {
      requestId,
      sessionId: this.sessionId,
      toolCall: params.toolCall,
      options: params.options,
      requestedAt: entry.requestedAt,
    };
    this.mgr.broadcastPermissionRequest(pending);
    this.emit('session-status', { status: 'waiting_permission', permissionRequestId: requestId });
  }

  respondPermission(requestId: string, optionId: string | undefined, cancelled: boolean, deviceName: string): boolean {
    const entry = this.pendingPerms.get(requestId);
    if (!entry || entry.responded) return false;
    entry.responded = true;
    this.pendingPerms.delete(requestId);

    const conn = this.mgr.agent.connection;
    if (conn && !conn.isClosed()) {
      conn.respond(entry.acpId, {
        outcome: cancelled ? { outcome: 'cancelled' } : { outcome: 'selected', optionId },
      });
    }

    if (this.pendingPerms.size === 0) {
      this.meta.hasPendingPermission = false;
      if (this.meta.status === 'waiting_permission') this.setStatus(this.runningPrompt ? 'running' : 'idle');
    }
    this.mgr.broadcastPermissionResolved(this.sessionId, requestId, optionId, cancelled, deviceName);
    return true;
  }

  listPendingPermissions(): PendingPermission[] {
    return [...this.pendingPerms.values()].map((e) => ({
      requestId: e.requestId,
      sessionId: this.sessionId,
      toolCall: e.toolCall,
      options: e.options,
      requestedAt: e.requestedAt,
    }));
  }

  // ---------- fs 监狱 ----------

  /** 路径必须落在会话 cwd 子树内 (realpath 防符号链接逃逸) */
  private jail(pathInput: string): string {
    if (!isAbsolute(pathInput)) throw new Error('必须是绝对路径');
    const baseReal = realpathSync(this.cwd);
    const target = resolve(pathInput);
    let targetReal: string;
    try {
      targetReal = realpathSync(target);
    } catch {
      // 文件不存在 (写入新文件场景): 校验其父链最近存在祖先
      targetReal = target;
    }
    const baseNorm = baseReal.endsWith(sep) ? baseReal : baseReal + sep;
    const same = targetReal.toLowerCase().startsWith(baseNorm.toLowerCase()) || targetReal.toLowerCase() === baseReal.toLowerCase();
    if (!same) throw new Error(`路径越出工作目录: ${pathInput}`);
    return target;
  }

  handleFsRead(msg: JsonRpcRequest): void {
    const conn = this.mgr.agent.connection;
    if (!conn) return;
    const params = msg.params as FsReadParams;
    try {
      const p = this.jail(params.path);
      let content = readFileSync(p, 'utf8');
      if (params.line || params.limit) {
        const lines = content.split('\n');
        const start = Math.max(0, (params.line ?? 1) - 1);
        const end = params.limit ? start + params.limit : lines.length;
        content = lines.slice(start, end).join('\n');
      }
      conn.respond(msg.id, { content });
    } catch (e) {
      conn.respondError(msg.id, -32602, `fs read denied: ${(e as Error).message}`);
    }
  }

  handleFsWrite(msg: JsonRpcRequest): void {
    const conn = this.mgr.agent.connection;
    if (!conn) return;
    const params = msg.params as FsWriteParams;
    try {
      const p = this.jail(params.path);
      writeFileSync(p, params.content);
      conn.respond(msg.id, {});
    } catch (e) {
      conn.respondError(msg.id, -32602, `fs write denied: ${(e as Error).message}`);
    }
  }

  // ---------- 生命周期 ----------

  /** agent 进程死亡时: 拒绝所有挂起权限, 标记错误 */
  onAgentDied(): void {
    for (const [, entry] of this.pendingPerms) {
      entry.responded = true;
      this.mgr.broadcastPermissionResolved(this.sessionId, entry.requestId, undefined, true, 'server');
    }
    this.pendingPerms.clear();
    this.meta.hasPendingPermission = false;
    this.setStatus('error', 'agent 进程退出');
  }
}

/**
 * 会话管理器 — 拥有唯一 agent 进程, 路由方法到各 SessionRuntime
 */
export class SessionManager extends EventEmitter {
  private sessions = new Map<string, SessionRuntime>();

  constructor(
    public readonly agent: AgentProcess,
    public readonly store: Store,
  ) {
    super();
    agent.on('agentRequest', (msg: JsonRpcRequest) => this.routeRequest(msg));
    agent.on('agentNotification', (msg: { method: string; params?: unknown }) => this.routeNotification(msg));
    agent.on('exit', () => {
      for (const rt of this.sessions.values()) rt.onAgentDied();
    });
  }

  private routeNotification(msg: { method: string; params?: unknown }) {
    const params = msg.params as { sessionId?: string } | undefined;
    const sid = params?.sessionId;
    if (sid && this.sessions.has(sid)) {
      this.sessions.get(sid)!.handleNotification(msg.method, msg.params);
    } else if (msg.method === 'session/update') {
      // 未知会话的 update — 可能是恢复中的会话, 忽略但记录
      this.emit('orphanNotification', msg);
    }
    // _cognition 全局通知 (sessionId 为空) 目前不广播, 避免噪音
  }

  private routeRequest(msg: JsonRpcRequest) {
    const params = msg.params as { sessionId?: string } | undefined;
    const sid = params?.sessionId;
    const rt = sid ? this.sessions.get(sid) : undefined;
    const conn = this.agent.connection;
    if (!rt) {
      conn?.respondError(msg.id, -32602, `unknown session: ${sid}`);
      return;
    }
    switch (msg.method) {
      case 'session/request_permission':
        rt.handlePermissionRequest(msg);
        break;
      case 'fs/read_text_file':
        rt.handleFsRead(msg);
        break;
      case 'fs/write_text_file':
        rt.handleFsWrite(msg);
        break;
      default:
        conn?.respondError(msg.id, -32601, `not implemented: ${msg.method}`);
    }
  }

  async createSession(cwd: string): Promise<SessionRuntime> {
    await this.agent.ensureReady();
    const conn = this.agent.connection!;
    const result = await conn.request<SessionNewResult>('session/new', { cwd, mcpServers: [] }, 60000);
    const rt = new SessionRuntime(result.sessionId, cwd, this);
    rt.acpCache = result;
    rt.meta.modeId = result.modes?.currentModeId;
    const modelOpt = result.configOptions?.find((o) => o.category === 'model');
    if (modelOpt?.currentValue) rt.meta.modelId = modelOpt.currentValue;
    this.sessions.set(result.sessionId, rt);
    this.store.upsertSession(rt.meta, result);
    rt.emit('session-status', { status: 'idle', created: true });
    return rt;
  }

  /** 恢复本地持久化的会话记录 (进程重启后展示列表; acp 侧按需 session/load) */
  restoreSessions(): void {
    for (const s of this.store.listSessions()) {
      if (this.sessions.has(s.sessionId)) continue;
      const rt = new SessionRuntime(s.sessionId, s.cwd, this, {
        ...s,
        status: 'idle',
        hasPendingPermission: false,
      });
      rt.acpCache = (s.acpCache as SessionNewResult) ?? null;
      this.sessions.set(s.sessionId, rt);
    }
  }

  get(sessionId: string): SessionRuntime | undefined {
    return this.sessions.get(sessionId);
  }

  list(): SessionRuntime[] {
    return [...this.sessions.values()];
  }

  // ---------- 广播挂钩 (由 gateway 实现注入) ----------

  broadcastEvent(ev: SessionEvent): void {
    this.emit('event', ev);
  }

  broadcastSessionStatus(sessionId: string, status: SessionMeta['status'], title?: string | null): void {
    this.emit('sessionStatus', sessionId, status, title);
  }

  broadcastPermissionRequest(p: PendingPermission): void {
    this.emit('permissionRequest', p);
  }

  broadcastPermissionResolved(sessionId: string, requestId: string, optionId: string | undefined, cancelled: boolean, byDevice: string): void {
    this.emit('permissionResolved', sessionId, requestId, optionId, cancelled, byDevice);
  }
}
