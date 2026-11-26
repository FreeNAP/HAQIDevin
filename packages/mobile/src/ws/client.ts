/**
 * DevinSocket — 轻量自写 reconnecting WebSocket + 配对/鉴权状态机 + 消息分发
 *
 *  - 指数退避重连: 1s → 2s → … → 上限 30s, ±30% 抖动
 *  - 心跳: 每 15s {type:'ping'}; 45s 无任何入站消息 → 判死强制重连 (Cloudflare 空闲重置防御)
 *  - 鉴权: auth.hello → auth.challenge → HMAC-SHA256 签名 → auth.response → auth.ok
 *  - 配对: pair → pair.ok → deviceSecret 入 SecureStore (绝不落日志/普通存储)
 *  - auth.ok 后 bootstrap: session.list + status.request + device.list + 按 sinceSeq 重订阅
 *  - 事件 seq 去重/增量补拉在 chatReducer 内完成
 */
import { Platform } from 'react-native';
import Constants from 'expo-constants';
import type {
  ClientMessage,
  ServerMessage,
  SessionMeta,
  PendingPermission,
  PromptAttachment,
  DevinSessionInfo,
  SessionLoad,
  FsListResult,
  FsReadResult,
  FsWriteResult,
  FsDeleteResult,
  FsMoveResult,
  FsCopyResult,
  AccountQuotaMsg,
  ConfigRulesMsg,
  ConfigMcpMsg,
} from '../protocol/wire';
import { useConnectionStore } from '../store/connection';
import { useSessionsStore } from '../store/sessions';
import { useChatStore } from '../store/chat';
import {
  HostEntry,
  DeviceCredentials,
  loadCredentials,
  saveCredentials,
  deleteCredentials,
} from '../store/storage';
import { deviceSignature } from '../crypto/hmac';
import { genClientMsgId } from '../util/id';
import { notifyPermissionRequest } from '../notify';
import { normalizeFsKey } from '../util/fspath';

const HEARTBEAT_MS = 15_000;
const WATCHDOG_MS = 10_000;
const DEAD_AFTER_MS = 45_000;
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 30_000;
const CREATE_TIMEOUT_MS = 30_000;
const LOAD_TIMEOUT_MS = 45_000;   // 加载已有会话需重放历史, 比新建更慢
const FS_TIMEOUT_MS = 15_000;     // fs.* 请求响应超时

type Timer = ReturnType<typeof setTimeout>;

/** fs 结果消息统一联合 — 响应 type 与请求同名, 请求方自行按 type 窄化 */
export type FsResultMsg = FsListResult | FsReadResult | FsWriteResult | FsDeleteResult | FsMoveResult | FsCopyResult;

type FsOpType = 'fs.list' | 'fs.read' | 'fs.write' | 'fs.delete' | 'fs.move' | 'fs.copy';

interface PendingFs {
  type: FsOpType;
  /** 归一匹配键: list/read/write/delete = path; move/copy = `${src} -> ${dst}` (与 error ref 格式一致) */
  key: string;
  resolve: (msg: FsResultMsg) => void;
  reject: (e: Error) => void;
  timer: Timer;
}

interface PendingCreate {
  cwd: string;
  resolve: (s: SessionMeta) => void;
  reject: (e: Error) => void;
  timer: Timer;
}

/** 按响应 type 匹配的简单请求 (account.quota / config.rules / config.mcp) — 同类响应兑现全部在途等待者 */
interface PendingSimple {
  resolve: (msg: ServerMessage) => void;
  reject: (e: Error) => void;
  timer: Timer;
}

/** device.delete 在途请求 — 响应 device.deleted 带 deviceId 精确匹配;
 *  错误 delete_rejected 无 ref, 采用启发式: 仅在途一个删除时归给它 */
interface PendingDelete {
  deviceId: string;
  resolve: () => void;
  reject: (e: Error) => void;
  timer: Timer;
}

/** workdir.add/remove 在途请求 — 无专用成功响应: 成功后 server 广播新 workdir.list 即兑现;
 *  失败 error 带 ref=请求路径, 归一匹配拒绝 */
interface PendingWorkdir {
  op: 'workdir.add' | 'workdir.remove';
  key: string;             // normalizeFsKey(path)
  resolve: () => void;
  reject: (e: Error) => void;
  timer: Timer;
}

interface PendingLoad {
  devinSessionId: string;
  waiters: {
    resolve: (s: SessionMeta) => void;
    reject: (e: Error) => void;
  }[];
  timer: Timer;
}

interface SubscriptionState {
  /** 最近一次 subscribe 请求的 sinceSeq — 迟到快照 reset 判定用 */
  sinceSeq: number;
  /** false = 已取消订阅; 记录仍保留, 避免迟到快照误判全量 reset */
  active: boolean;
}

/** 设备被撤销/鉴权失败类错误码 — 收到即清除本地凭据回到配对态
 *  以服务器实际实现为准 (packages/server/src/gateway/ws.ts):
 *  设备不存在/被撤销/超 30 天未活跃/签名失败 → 统一 'auth_rejected' */
const FATAL_AUTH_CODES = new Set([
  'auth_rejected',
  'device_revoked',
  'device_unknown',
  'auth_failed',
  'bad_signature',
]);

class DevinClient {
  private ws: WebSocket | null = null;
  private host: HostEntry | null = null;
  private cred: DeviceCredentials | null = null;
  private manualClose = false;
  private retryCount = 0;
  private retryTimer: Timer | null = null;
  private heartbeatTimer: Timer | null = null;
  private watchdogTimer: Timer | null = null;
  private lastActivityAt = 0;
  private pingSentAt = 0;
  private authed = false;
  private opening = false;
  /** 连接代际计数 — connect() 异步段的竞态防护: 代际过期即放弃 */
  private connectGen = 0;
  /** sessionId → 订阅状态 (sinceSeq 判定快照全量/增量; active 控制重连后是否重订阅) */
  private subscriptions = new Map<string, SubscriptionState>();
  private pendingCreates: PendingCreate[] = [];
  private pendingLoads: PendingLoad[] = [];
  private pendingFs: PendingFs[] = [];
  /** 响应 type → 在途等待者 (quota/config 类无 ref 机制的查询) */
  private pendingSimple = new Map<string, PendingSimple[]>();
  private pendingDeletes: PendingDelete[] = [];
  private pendingWorkdirs: PendingWorkdir[] = [];

  // ---------- 公共 API ----------

  /** 连接指定主机 (切换主机会清空旧会话缓存) */
  async connect(host: HostEntry): Promise<void> {
    const gen = ++this.connectGen;
    this.teardown(true);
    const prevHostId = this.host?.id;
    this.host = host;
    if (prevHostId !== host.id) {
      useSessionsStore.getState().clear();
      useChatStore.getState().clearAll();
      this.subscriptions.clear();
    }
    const conn = useConnectionStore.getState();
    conn.setActiveHost(host);
    conn.setPhase('connecting');
    conn.setLatency(null);
    conn.setServerStatus(null);
    this.retryCount = 0;
    const cred = await loadCredentials(host.id);
    // 竞态防护: 等待凭据期间用户切换了主机/断开 → 放弃本次连接
    if (gen !== this.connectGen) return;
    this.cred = cred;
    this.openSocket();
  }

  /** 手动断开 (不清凭据) */
  disconnect(): void {
    ++this.connectGen; // 使任何进行中的 connect() 异步段失效
    this.teardown(true);
    useConnectionStore.getState().setPhase('idle');
  }

  /** 重新配对: 清除本机凭据并回到未配对态 (socket 保持) */
  async resetPairing(): Promise<void> {
    ++this.connectGen;
    if (this.host) {
      await deleteCredentials(this.host.id);
    }
    this.cred = null;
    this.authed = false;
    useConnectionStore.getState().setIdentity(null, null);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      useConnectionStore.getState().setPhase('unpaired');
    } else {
      this.teardown(true);
      useConnectionStore.getState().setPhase('connecting');
      this.openSocket();
    }
  }

  /** 发送配对请求 */
  pair(code: string): void {
    const normalized = code.trim().toUpperCase();
    if (!/^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(normalized)) {
      useConnectionStore.getState().setPhase('unpaired', '配对码格式应为 XXXX-XXXX');
      return;
    }
    if (!this.isOpen()) {
      useConnectionStore.getState().setPhase('unpaired', '尚未连接到主机');
      return;
    }
    useConnectionStore.getState().setPhase('pairing');
    this.send({
      type: 'pair',
      code: normalized,
      deviceName: this.deviceName(),
      platform: Platform.OS,
    });
  }

  subscribe(sessionId: string): void {
    const chat = useChatStore.getState();
    chat.ensure(sessionId);
    const sinceSeq = chat.bySession[sessionId]?.maxSeq ?? 0;
    this.subscriptions.set(sessionId, { sinceSeq, active: true });
    if (this.authed) {
      const msg: ClientMessage = sinceSeq > 0
        ? { type: 'session.subscribe', sessionId, sinceSeq }
        : { type: 'session.subscribe', sessionId };
      this.send(msg);
    }
  }

  unsubscribe(sessionId: string): void {
    const sub = this.subscriptions.get(sessionId);
    if (sub) {
      this.subscriptions.set(sessionId, { ...sub, active: false });
    }
    if (this.authed) {
      this.send({ type: 'session.unsubscribe', sessionId });
    }
  }

  /** 发送 prompt — 已认证时立即乐观回显, 返回 clientMsgId; 未连接返回 null 且不发送
   *  attachments 为契约 v2 附件数组 (图片 base64 / 文本 embedded context), 无附件时省略 */
  sendPrompt(sessionId: string, text: string, attachments?: PromptAttachment[]): string | null {
    if (!this.authed || !this.isOpen()) {
      return null; // 界面层已在离线时禁用输入, 双重防护避免静默丢消息
    }
    const clientMsgId = genClientMsgId();
    useChatStore.getState().optimisticUser(sessionId, text, clientMsgId);
    const msg: ClientMessage = attachments && attachments.length > 0
      ? { type: 'session.prompt', sessionId, text, clientMsgId, attachments }
      : { type: 'session.prompt', sessionId, text, clientMsgId };
    this.send(msg);
    return clientMsgId;
  }

  cancel(sessionId: string): void {
    this.send({ type: 'session.cancel', sessionId });
  }

  setConfig(sessionId: string, configId: string, value: string): void {
    this.send({ type: 'session.setConfig', sessionId, configId, value });
  }

  setMode(sessionId: string, modeId: string): void {
    this.send({ type: 'session.setMode', sessionId, modeId });
  }

  respondPermission(sessionId: string, requestId: string, optionId?: string): void {
    const msg: ClientMessage = optionId
      ? { type: 'permission.respond', sessionId, requestId, optionId }
      : { type: 'permission.respond', sessionId, requestId, cancelled: true };
    this.send(msg);
    // 乐观移除卡片; 服务器的 permission.resolved 到达后覆盖为权威结果
    useChatStore.getState().resolvePermissionMsg(sessionId, requestId, {
      byDevice: this.selfLabel(),
      optionId,
      cancelled: !optionId,
    });
  }

  createSession(cwd: string): Promise<SessionMeta> {
    return new Promise<SessionMeta>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingCreates = this.pendingCreates.filter((p) => p.cwd !== cwd || p.resolve !== resolve);
        reject(new Error('创建会话超时'));
      }, CREATE_TIMEOUT_MS);
      this.pendingCreates.push({ cwd, resolve, reject, timer });
      this.send({ type: 'session.create', cwd });
    });
  }

  /**
   * 契约 v2: 加载已有 devin 会话 — cwd/additionalDirectories 从 devinSession.list 原样透传
   * server 幂等: 已加载的同 id 会话直接复用; 成功广播 session.loaded, 失败 error load_failed
   * 同 id 并发重复调用挂到同一在途请求上 (session.loaded 到达时全部兑现)
   */
  loadSession(info: DevinSessionInfo): Promise<SessionMeta> {
    return new Promise<SessionMeta>((resolve, reject) => {
      if (!this.authed || !this.isOpen()) {
        reject(new Error('尚未连接到主机'));
        return;
      }
      const existing = this.pendingLoads.find((p) => p.devinSessionId === info.sessionId);
      if (existing) {
        // 不重复发 session.load — 复用在途请求
        existing.waiters.push({ resolve, reject });
        return;
      }
      const timer = setTimeout(() => {
        const pending = this.pendingLoads.find((p) => p.devinSessionId === info.sessionId);
        this.pendingLoads = this.pendingLoads.filter((p) => p.devinSessionId !== info.sessionId);
        if (pending) {
          for (const w of pending.waiters) w.reject(new Error('加载会话超时 — 会话历史可能较大, 请重试'));
        }
      }, LOAD_TIMEOUT_MS);
      const waiters = [{ resolve, reject }];
      this.pendingLoads.push({ devinSessionId: info.sessionId, waiters, timer });
      const msg: SessionLoad = {
        type: 'session.load',
        devinSessionId: info.sessionId,
        cwd: info.cwd,
      };
      if (info.additionalDirectories && info.additionalDirectories.length > 0) {
        msg.additionalDirectories = info.additionalDirectories;
      }
      this.send(msg);
    });
  }

  requestSessions(): void {
    if (this.authed) this.send({ type: 'session.list' });
  }

  /** 契约 v2: 拉取 devin 侧全部会话 (含未加载的) */
  requestDevinSessions(): void {
    if (this.authed) this.send({ type: 'devinSession.list' });
  }

  requestStatus(): void {
    if (this.authed) this.send({ type: 'status.request' });
  }

  requestDevices(): void {
    if (this.authed) this.send({ type: 'device.list' });
  }

  requestWorkdirs(): void {
    if (this.authed) this.send({ type: 'workdir.list' });
  }

  revokeDevice(deviceId: string): void {
    if (this.authed) this.send({ type: 'device.revoke', deviceId });
  }

  // ---------- 设备删除 / 工作目录 / 配置 / 额度 (请求-响应型) ----------

  /** 删除已撤销设备 — 成功响应 device.deleted; 失败 error delete_rejected (无 ref, 单在途启发式归并) */
  deleteDevice(deviceId: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!this.authed || !this.isOpen()) {
        reject(new Error('尚未连接到主机'));
        return;
      }
      const timer = setTimeout(() => {
        this.pendingDeletes = this.pendingDeletes.filter((p) => !(p.deviceId === deviceId && p.resolve === resolve));
        reject(new Error('请求超时 — 主机未响应'));
      }, FS_TIMEOUT_MS);
      this.pendingDeletes.push({ deviceId, resolve, reject, timer });
      this.send({ type: 'device.delete', deviceId });
    });
  }

  /**
   * 新增工作目录 — 成功无专用响应, server 广播新 workdir.list 即兑现;
   * 失败 error 带 ref=请求路径 (归一匹配); 15s 超时兜底
   */
  addWorkdir(path: string): Promise<void> {
    return this.workdirRequest('workdir.add', path, { type: 'workdir.add', path });
  }

  /** 移除工作目录 — 至少保留一个 (server 强制); 兑现/拒绝语义同 addWorkdir */
  removeWorkdir(path: string): Promise<void> {
    return this.workdirRequest('workdir.remove', path, { type: 'workdir.remove', path });
  }

  private workdirRequest(op: 'workdir.add' | 'workdir.remove', path: string, msg: ClientMessage): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      if (!this.authed || !this.isOpen()) {
        reject(new Error('尚未连接到主机'));
        return;
      }
      const timer = setTimeout(() => {
        this.pendingWorkdirs = this.pendingWorkdirs.filter((p) => !(p.op === op && p.resolve === resolve));
        reject(new Error('请求超时 — 主机未响应'));
      }, FS_TIMEOUT_MS);
      this.pendingWorkdirs.push({ op, key: normalizeFsKey(path), resolve, reject, timer });
      this.send(msg);
    });
  }

  /** 查询账户额度 — 响应复用同名 type, 按 type 兑现全部在途等待者 */
  requestQuota(): Promise<AccountQuotaMsg> {
    return this.simpleRequest<AccountQuotaMsg>('account.quota', { type: 'account.quota' });
  }

  /** 读取规则配置 — cwd 缺省仅 global 层 */
  getRulesConfig(cwd?: string): Promise<ConfigRulesMsg> {
    const msg: ClientMessage = cwd ? { type: 'config.rules.get', cwd } : { type: 'config.rules.get' };
    return this.simpleRequest<ConfigRulesMsg>('config.rules', msg);
  }

  /** 读取 MCP 配置 — cwd 缺省仅用户/遗留层 */
  getMcpConfig(cwd?: string): Promise<ConfigMcpMsg> {
    const msg: ClientMessage = cwd ? { type: 'config.mcp.get', cwd } : { type: 'config.mcp.get' };
    return this.simpleRequest<ConfigMcpMsg>('config.mcp', msg);
  }

  /**
   * 无 ref 关联机制的查询统一入口 — 响应 type 与请求不同名但唯一 (get→config.rules / quota→account.quota),
   * 按响应 type 匹配; 同类并发查询结果等价, 全部兑现; 断连时 teardown 统一拒绝
   */
  private simpleRequest<T extends ServerMessage>(responseType: string, msg: ClientMessage): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.authed || !this.isOpen()) {
        reject(new Error('尚未连接到主机'));
        return;
      }
      const timer = setTimeout(() => {
        const arr = this.pendingSimple.get(responseType);
        if (arr) {
          const next = arr.filter((p) => p.resolve !== (resolve as (m: ServerMessage) => void));
          if (next.length > 0) this.pendingSimple.set(responseType, next);
          else this.pendingSimple.delete(responseType);
        }
        reject(new Error('请求超时 — 主机未响应'));
      }, FS_TIMEOUT_MS);
      const arr = this.pendingSimple.get(responseType) ?? [];
      arr.push({ resolve: resolve as (m: ServerMessage) => void, reject, timer });
      this.pendingSimple.set(responseType, arr);
      this.send(msg);
    });
  }

  /** 简单查询兑现 — 该 type 全部在途等待者共享同一响应 */
  private resolveSimple(type: string, msg: ServerMessage): void {
    const arr = this.pendingSimple.get(type);
    if (!arr || arr.length === 0) return;
    this.pendingSimple.delete(type);
    for (const p of arr) {
      clearTimeout(p.timer);
      p.resolve(msg);
    }
  }

  /** 简单查询拒绝 — error 到达且能归属该 type 时调用 */
  private rejectSimple(type: string, err: Error): void {
    const arr = this.pendingSimple.get(type);
    if (!arr || arr.length === 0) return;
    this.pendingSimple.delete(type);
    for (const p of arr) {
      clearTimeout(p.timer);
      p.reject(err);
    }
  }

  // ---------- 契约 v2: 文件系统 ----------

  /** 列目录 — path 须在 server workdirs 监狱内; 未连接/超时 reject; 失败经 error 消息 reject */
  fsList(path: string, showHidden?: boolean): Promise<FsListResult> {
    return this.fsRequest<FsListResult>('fs.list', path, { type: 'fs.list', path, showHidden });
  }

  /** 读文件内容 — 二进制时 content 为 base64 (encoding 字段标识) */
  fsRead(path: string, maxBytes?: number): Promise<FsReadResult> {
    return this.fsRequest<FsReadResult>('fs.read', path, { type: 'fs.read', path, maxBytes });
  }

  /** 删除 — 非空目录须 recursive=true */
  fsDelete(path: string, recursive?: boolean): Promise<FsDeleteResult> {
    return this.fsRequest<FsDeleteResult>('fs.delete', path, { type: 'fs.delete', path, recursive });
  }

  /** 移动 — dst 为完整目标路径 (含末段名); 目标已存在则失败, overwrite 可强制 */
  fsMove(src: string, dst: string, overwrite?: boolean): Promise<FsMoveResult> {
    return this.fsRequest<FsMoveResult>('fs.move', `${src} -> ${dst}`, { type: 'fs.move', src, dst, overwrite });
  }

  /** 复制 — dst 语义同 fsMove */
  fsCopy(src: string, dst: string, overwrite?: boolean): Promise<FsCopyResult> {
    return this.fsRequest<FsCopyResult>('fs.copy', `${src} -> ${dst}`, { type: 'fs.copy', src, dst, overwrite });
  }

  /**
   * fs 请求统一入口 — 无请求 id 机制: 响应复用请求同名 type, 按 type+归一路径键匹配, 15s 超时;
   * 断连时 teardown 统一 reject; 同路径并发相同请求合并兑现 (结果等价, 按先到先配)
   */
  private fsRequest<T extends FsResultMsg>(type: FsOpType, pathKey: string, msg: ClientMessage): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      if (!this.authed || !this.isOpen()) {
        reject(new Error('尚未连接到主机'));
        return;
      }
      const key = normalizeFsKey(pathKey);
      const timer = setTimeout(() => {
        this.pendingFs = this.pendingFs.filter((p) => !(p.type === type && p.key === key && p.resolve === resolve));
        reject(new Error('请求超时 — 主机未响应'));
      }, FS_TIMEOUT_MS);
      this.pendingFs.push({
        type,
        key,
        resolve: resolve as (m: FsResultMsg) => void,
        reject,
        timer,
      });
      this.send(msg);
    });
  }

  /** fs 成功响应兑现 — type + 归一路径键匹配; move/copy 从响应 src/dst 重建复合键 */
  private resolveFs(msg: FsResultMsg): void {
    let pathKey: string;
    if (msg.type === 'fs.move' || msg.type === 'fs.copy') {
      const src = typeof msg.src === 'string' ? msg.src : '';
      const dst = typeof msg.dst === 'string' ? msg.dst : '';
      pathKey = `${src} -> ${dst}`;
    } else {
      pathKey = typeof msg.path === 'string' ? msg.path : '';
    }
    if (!pathKey) return;
    const key = normalizeFsKey(pathKey);
    const idx = this.pendingFs.findIndex((p) => p.type === msg.type && p.key === key);
    if (idx < 0) return; // 迟到/未知响应 — 静默丢弃
    const [pending] = this.pendingFs.splice(idx, 1);
    clearTimeout(pending.timer);
    pending.resolve(msg);
  }

  isAuthed(): boolean {
    return this.authed;
  }

  selfLabel(): string {
    return useConnectionStore.getState().selfDeviceName ?? '本机';
  }

  // ---------- 连接生命周期 ----------

  private isOpen(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  private deviceName(): string {
    const n = (Constants as unknown as { deviceName?: string }).deviceName;
    if (typeof n === 'string' && n) return n;
    return Platform.OS === 'ios' ? 'iPhone' : Platform.OS === 'android' ? 'Android 设备' : '移动设备';
  }

  private openSocket(): void {
    if (!this.host || this.opening) return;
    this.opening = true;
    this.manualClose = false;
    let ws: WebSocket;
    try {
      ws = new WebSocket(this.host.url);
    } catch {
      this.opening = false;
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    // 连接黑洞防护: 12s 未 open 强制关闭走重连 (RN WebSocket 无内建连接超时)
    const connectTimeout = setTimeout(() => {
      if (this.ws === ws && ws.readyState !== WebSocket.OPEN) {
        try {
          ws.close();
        } catch {
          // 忽略
        }
        // close 若因异常未触发 onclose, 兜底直接调度重连
        if (this.ws === ws) {
          this.ws = null;
          this.opening = false;
          this.scheduleReconnect();
        }
      }
    }, 12_000);

    ws.onopen = () => {
      // 身份守卫: 旧 socket 的迟到回调不得影响当前连接
      if (this.ws !== ws) return;
      clearTimeout(connectTimeout);
      this.opening = false;
      this.lastActivityAt = Date.now();
      this.startHeartbeat();
      this.startWatchdog();
      if (this.cred) {
        useConnectionStore.getState().setPhase('authenticating');
        this.send({ type: 'auth.hello', deviceId: this.cred.deviceId });
      } else {
        useConnectionStore.getState().setPhase('unpaired');
      }
    };

    ws.onmessage = (ev) => {
      if (this.ws !== ws) return;
      this.lastActivityAt = Date.now();
      const raw = typeof ev.data === 'string' ? ev.data : '';
      if (!raw) return;
      let msg: ServerMessage;
      try {
        msg = JSON.parse(raw) as ServerMessage;
      } catch {
        return;
      }
      this.dispatch(msg);
    };

    ws.onerror = () => {
      // onclose 会随之而来, 重连逻辑统一在 onclose
    };

    ws.onclose = () => {
      if (this.ws !== ws) return; // 旧 socket 关闭不得清掉新 socket 的引用
      clearTimeout(connectTimeout);
      this.opening = false;
      this.stopTimers();
      this.authed = false;
      this.ws = null;
      if (this.manualClose) return;
      this.scheduleReconnect();
    };
  }

  private scheduleReconnect(): void {
    if (!this.host || this.manualClose) return;
    const conn = useConnectionStore.getState();
    conn.setPhase('connecting');
    conn.setReconnectAttempt(this.retryCount + 1);
    const exp = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * Math.pow(2, this.retryCount));
    const jitter = exp * 0.3 * Math.random();
    const delay = Math.round(exp + jitter);
    this.retryCount += 1;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      this.openSocket();
    }, delay);
  }

  private teardown(closeSocket: boolean): void {
    this.manualClose = true;
    this.stopTimers();
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
    for (const p of this.pendingCreates) {
      clearTimeout(p.timer);
      p.reject(new Error('连接已断开'));
    }
    this.pendingCreates = [];
    for (const p of this.pendingLoads) {
      clearTimeout(p.timer);
      for (const w of p.waiters) w.reject(new Error('连接已断开'));
    }
    this.pendingLoads = [];
    for (const p of this.pendingFs) {
      clearTimeout(p.timer);
      p.reject(new Error('连接已断开'));
    }
    this.pendingFs = [];
    for (const arr of this.pendingSimple.values()) {
      for (const p of arr) {
        clearTimeout(p.timer);
        p.reject(new Error('连接已断开'));
      }
    }
    this.pendingSimple.clear();
    for (const p of this.pendingDeletes) {
      clearTimeout(p.timer);
      p.reject(new Error('连接已断开'));
    }
    this.pendingDeletes = [];
    for (const p of this.pendingWorkdirs) {
      clearTimeout(p.timer);
      p.reject(new Error('连接已断开'));
    }
    this.pendingWorkdirs = [];
    this.authed = false;
    if (closeSocket && this.ws) {
      try {
        this.ws.close();
      } catch {
        // 忽略关闭异常
      }
    }
    // 必须重置 opening: 旧 socket 若为 CONNECTING 态, 其 onclose 因身份守卫不再复位该标志,
    // 不复位则后续 openSocket 永远被拦截 — 切换主机/重置配对场景会死锁
    this.opening = false;
    this.ws = null;
    useConnectionStore.getState().setReconnectAttempt(0);
  }

  private stopTimers(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = null;
    }
  }

  private startHeartbeat(): void {
    if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (this.isOpen()) {
        this.pingSentAt = Date.now();
        this.send({ type: 'ping', ts: this.pingSentAt });
      }
    }, HEARTBEAT_MS);
  }

  private startWatchdog(): void {
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.watchdogTimer = setInterval(() => {
      if (this.isOpen() && Date.now() - this.lastActivityAt > DEAD_AFTER_MS) {
        // 静默死亡 (NAT/Cloudflare 空闲重置) — 强制关闭触发重连
        try {
          this.ws?.close();
        } catch {
          // 忽略
        }
      }
    }, WATCHDOG_MS);
  }

  private send(msg: ClientMessage): void {
    if (this.isOpen()) {
      try {
        this.ws!.send(JSON.stringify(msg));
      } catch {
        // 发送失败由 watchdog/close 路径处理
      }
    }
  }

  // ---------- 消息分发 ----------

  private dispatch(msg: ServerMessage): void {
    const conn = useConnectionStore.getState();
    const sessions = useSessionsStore.getState();
    const chat = useChatStore.getState();

    switch (msg.type) {
      case 'auth.challenge': {
        if (!this.cred) {
          conn.setPhase('unpaired');
          return;
        }
        const signature = deviceSignature(this.cred.deviceSecret, this.cred.deviceId, msg.nonce);
        this.send({
          type: 'auth.response',
          deviceId: this.cred.deviceId,
          nonce: msg.nonce,
          signature,
        });
        return;
      }
      case 'auth.ok': {
        this.authed = true;
        this.retryCount = 0;
        conn.setReconnectAttempt(0);
        conn.setIdentity(msg.deviceId, msg.deviceName);
        conn.setServerVersion(msg.serverVersion);
        conn.setPhase('authed');
        this.bootstrap();
        return;
      }
      case 'pair.ok': {
        const cred: DeviceCredentials = {
          deviceId: msg.deviceId,
          deviceSecret: msg.deviceSecret,
          deviceName: msg.deviceName,
        };
        this.cred = cred;
        if (this.host) {
          void saveCredentials(this.host.id, cred);
        }
        conn.setIdentity(msg.deviceId, msg.deviceName);
        conn.setPhase('authenticating');
        this.send({ type: 'auth.hello', deviceId: msg.deviceId });
        return;
      }
      case 'pong': {
        if (this.pingSentAt > 0) {
          conn.setLatency(Math.max(0, Date.now() - this.pingSentAt));
        }
        return;
      }
      case 'session.list': {
        sessions.setAll(msg.sessions);
        return;
      }
      case 'devinSession.list': {
        sessions.setDevinSessions(msg.sessions);
        return;
      }
      case 'session.created': {
        sessions.upsert(msg.session);
        // 优先按 cwd 匹配 (并发创建两个不同目录会话时不错配), 无匹配回退 FIFO
        let idx = this.pendingCreates.findIndex((p) => p.cwd === msg.session.cwd);
        if (idx < 0 && this.pendingCreates.length > 0) idx = 0;
        if (idx >= 0) {
          const [pending] = this.pendingCreates.splice(idx, 1);
          clearTimeout(pending.timer);
          pending.resolve(msg.session);
        }
        return;
      }
      case 'session.loaded': {
        // 契约 v2: session.load 成功 — 结构同 session.created, 按 devinSessionId 兑现等待者
        sessions.upsert(msg.session);
        // load 后 acp 数据已刷新 (模型/模式清单可能变化) — 以 reset=false 纯 merge 注入聊天区,
        // 不动消息列表; pendingPermissions 传现值避免被空数组误清
        if (msg.acp) {
          chat.applySnapshotMsg(
            msg.session.sessionId,
            {
              session: msg.session,
              events: [],
              acp: msg.acp,
              pendingPermissions: chat.bySession[msg.session.sessionId]?.pendingPermissions ?? [],
            },
            false,
          );
        }
        const idx = this.pendingLoads.findIndex((p) => p.devinSessionId === msg.session.sessionId);
        if (idx >= 0) {
          const [pending] = this.pendingLoads.splice(idx, 1);
          clearTimeout(pending.timer);
          for (const w of pending.waiters) w.resolve(msg.session);
        }
        return;
      }
      case 'session.snapshot': {
        const requestedSince = this.subscriptions.get(msg.sessionId)?.sinceSeq ?? 0;
        const reset = requestedSince <= 0;
        chat.applySnapshotMsg(
          msg.sessionId,
          {
            session: msg.session,
            events: msg.events,
            truncated: msg.truncated,
            totalEvents: msg.totalEvents,
            acp: msg.acp ?? null,
            configOptions: msg.configOptions,
            availableCommands: msg.availableCommands,
            pendingPermissions: msg.pendingPermissions,
          },
          reset,
        );
        sessions.upsert(msg.session);
        return;
      }
      case 'session.event': {
        chat.applyEventMsg(msg.event);
        sessions.touchActivity(msg.event.sessionId, msg.event.ts, msg.event.seq);
        return;
      }
      case 'session.status': {
        sessions.patchStatus(msg.sessionId, msg.status, msg.title);
        chat.setSessionStatus(msg.sessionId, msg.status);
        return;
      }
      case 'permission.request': {
        const perm: PendingPermission = msg.request;
        chat.addPermission(perm);
        sessions.setPendingPermission(perm.sessionId, true);
        void notifyPermissionRequest(perm);
        return;
      }
      case 'permission.resolved': {
        chat.resolvePermissionMsg(msg.sessionId, msg.requestId, {
          byDevice: msg.byDevice,
          optionId: msg.optionId,
          cancelled: msg.cancelled,
        });
        const remaining = useChatStore.getState().bySession[msg.sessionId]?.pendingPermissions.length ?? 0;
        if (remaining === 0) {
          sessions.setPendingPermission(msg.sessionId, false);
        }
        return;
      }
      case 'server.status': {
        conn.setServerStatus(msg);
        return;
      }
      case 'device.list': {
        conn.setDevices(msg.devices);
        return;
      }
      case 'workdir.list': {
        conn.setWorkdirs(msg.dirs);
        // add/remove 无专用成功响应 — server 处理后广播新清单; 按内容感知兑现:
        //   add    → 清单已含该路径 (归一比较) 才兑现 — 操作前的旧快照不误兑现
        //   remove → 清单已不含该路径 才兑现
        // 失败路径由 error (ref=请求路径) 拒绝, 双通道不会互踩
        if (this.pendingWorkdirs.length > 0) {
          const keys = new Set(msg.dirs.map((d) => normalizeFsKey(d.path)));
          const remaining: PendingWorkdir[] = [];
          for (const p of this.pendingWorkdirs) {
            const done = p.op === 'workdir.add' ? keys.has(p.key) : !keys.has(p.key);
            if (done) {
              clearTimeout(p.timer);
              p.resolve();
            } else {
              remaining.push(p);
            }
          }
          this.pendingWorkdirs = remaining;
        }
        return;
      }
      case 'device.deleted': {
        const idx = this.pendingDeletes.findIndex((p) => p.deviceId === msg.deviceId);
        if (idx >= 0) {
          const [pending] = this.pendingDeletes.splice(idx, 1);
          clearTimeout(pending.timer);
          pending.resolve();
        }
        return;
      }
      case 'account.quota': {
        this.resolveSimple('account.quota', msg);
        return;
      }
      case 'config.rules': {
        this.resolveSimple('config.rules', msg);
        return;
      }
      case 'config.mcp': {
        this.resolveSimple('config.mcp', msg);
        return;
      }
      case 'fs.list':
      case 'fs.read':
      case 'fs.write':
      case 'fs.delete':
      case 'fs.move':
      case 'fs.copy': {
        this.resolveFs(msg);
        return;
      }
      case 'error': {
        this.handleError(msg.code, msg.message, msg.ref);
        return;
      }
      default:
        return;
    }
  }

  private handleError(code: string, message: string, ref?: string): void {
    const conn = useConnectionStore.getState();
    const phase = conn.phase;

    // fs 请求级错误 — server 约定: ref = 请求 path (move/copy 为 "src -> dst" 输入原样串)
    if (ref) {
      const nref = normalizeFsKey(ref);
      const idx = this.pendingFs.findIndex((p) => p.key === nref);
      if (idx >= 0) {
        const [pending] = this.pendingFs.splice(idx, 1);
        clearTimeout(pending.timer);
        pending.reject(new Error(message || '操作失败'));
        return;
      }
    }

    // workdir.add/remove 错误 — ref = 请求路径原样串, 归一匹配
    if (ref && (code.startsWith('workdir_') || this.pendingWorkdirs.some((p) => p.key === normalizeFsKey(ref)))) {
      const nref = normalizeFsKey(ref);
      const idx = this.pendingWorkdirs.findIndex((p) => p.key === nref);
      if (idx >= 0) {
        const [pending] = this.pendingWorkdirs.splice(idx, 1);
        clearTimeout(pending.timer);
        pending.reject(new Error(message || '操作失败'));
        return;
      }
    }

    // 额度查询失败 — 无 ref, 按 type 归属全部在途等待者
    if (code === 'quota_failed') {
      this.rejectSimple('account.quota', new Error(message || '额度查询失败'));
      return;
    }

    // device.delete 失败 — delete_rejected 无 ref; 仅单个删除在途时可安全归属, 并发场景兜底超时
    if (code === 'delete_rejected' && this.pendingDeletes.length === 1) {
      const [pending] = this.pendingDeletes.splice(0, 1);
      clearTimeout(pending.timer);
      pending.reject(new Error(message || '删除失败'));
      return;
    }

    // config.rules/mcp 错误 — ref 为 cwd 或字面量 'rules'/'mcp'; 手机端查看器不带 cwd, 字面量精确归属
    if (ref === 'rules') {
      this.rejectSimple('config.rules', new Error(message || '读取规则配置失败'));
      return;
    }
    if (ref === 'mcp') {
      this.rejectSimple('config.mcp', new Error(message || '读取 MCP 配置失败'));
      return;
    }

    if (code === 'load_failed') {
      // 契约 v2: session.load 失败 — 拒绝全部在途加载 (错误无会话上下文, 并发加载场景罕见)
      const pendings = this.pendingLoads;
      this.pendingLoads = [];
      for (const p of pendings) {
        clearTimeout(p.timer);
        for (const w of p.waiters) w.reject(new Error(message || '加载会话失败'));
      }
      return;
    }
    if (FATAL_AUTH_CODES.has(code)) {
      // 设备被撤销或凭据失效 — 清除凭据, 回到配对态
      if (this.host) void deleteCredentials(this.host.id);
      this.cred = null;
      this.authed = false;
      conn.setIdentity(null, null);
      conn.setPhase('unpaired', message);
      return;
    }
    if (phase === 'pairing') {
      conn.setPhase('unpaired', message);
      return;
    }
    if (code === 'pairing' || code === 'pair_failed' || code === 'invalid_code') {
      conn.setPhase('unpaired', message);
      return;
    }
    // 运行期错误 — 保留相位, 仅展示消息
    conn.setPhase(phase, message);
  }

  /** auth.ok 后的引导: 拉会话/状态/设备 + devin 全量会话 + 重订阅 (sinceSeq = 已收最大 seq) */
  private bootstrap(): void {
    this.send({ type: 'session.list' });
    this.send({ type: 'devinSession.list' });
    this.send({ type: 'status.request' });
    this.send({ type: 'device.list' });
    const chat = useChatStore.getState();
    for (const [sessionId, sub] of this.subscriptions) {
      if (!sub.active) continue;
      const sinceSeq = chat.bySession[sessionId]?.maxSeq ?? 0;
      this.subscriptions.set(sessionId, { sinceSeq, active: true });
      const msg: ClientMessage = sinceSeq > 0
        ? { type: 'session.subscribe', sessionId, sinceSeq }
        : { type: 'session.subscribe', sessionId };
      this.send(msg);
    }
  }
}

export const client = new DevinClient();
