/**
 * Devin Remote 线协议 — server ↔ client (WebSocket, JSON 文本帧) — 手机端副本
 * 逐字复制自 packages/protocol/src/index.ts (仅 import 路径改为本地 acp 副本)
 * 设计原则:
 *  - ACP 语义无损嵌套: session event 的 payload 就是原始 ACP 报文
 *  - 每会话事件严格递增 seq, 客户端断线重连用 sinceSeq 补拉
 *  - 配对一次性下发 deviceSecret, 之后用 HMAC 挑战响应鉴权, 不再传输密钥
 */
import type {
  SessionUpdateParams,
  RequestPermissionParams,
  SessionNewResult,
  StopReason,
} from './acp';

export const PROTOCOL_VERSION = 1;

// ---------- 会话元数据 ----------

export interface SessionMeta {
  sessionId: string;          // devin acp 的 sessionId
  cwd: string;
  title: string | null;
  createdAt: number;          // unix ms
  lastActiveAt: number;
  status: 'idle' | 'running' | 'waiting_permission' | 'error' | 'closed';
  modeId?: string;
  modelId?: string;
  lastSeq: number;            // 当前最大事件序号
  hasPendingPermission: boolean;
  additionalDirectories?: string[];  // devin 会话附加工作目录 (fs 监狱一并放行)
}

// ---------- 事件封装 ----------

export type SessionEventKind =
  | 'acp-update'        // session/update 通知, payload = SessionUpdateParams['update']
  | 'acp-notification'  // devin 私有 _cognition.ai/* 通知, payload = {method, params}
  | 'prompt-result'     // 一个 turn 结束, payload = {stopReason, usage}
  | 'user-message'      // 用户消息回显(多端同步), payload = {text, clientMsgId, deviceName}
  | 'session-status';   // 会话状态变化, payload = {status, error?}

export interface SessionEvent {
  sessionId: string;
  seq: number;
  ts: number;
  kind: SessionEventKind;
  payload: unknown;
}

// ---------- client → server ----------

export interface PairRequest {
  type: 'pair';
  code: string;             // 8 位配对码 XXXX-XXXX
  deviceName: string;       // "iPhone 15 Pro"
  platform?: string;
}

export interface AuthHello {
  type: 'auth.hello';
  deviceId: string;
}

export interface AuthResponse {
  type: 'auth.response';
  deviceId: string;
  nonce: string;            // 回显服务器 nonce
  signature: string;        // hex HMAC-SHA256(deviceSecret, deviceId + ':' + nonce)
}

export interface SessionListRequest {
  type: 'session.list';
}

/** 契约 v2: 列出 devin 侧全部会话 (含未加载到 server 的) */
export interface DevinSessionListRequest {
  type: 'devinSession.list';
}

/** 契约 v2: 加载已有 devin 会话 — cwd 必须与创建时一致 (devinSession.list 原样透传) */
export interface SessionLoad {
  type: 'session.load';
  devinSessionId: string;
  cwd: string;
  additionalDirectories?: string[];
}

export interface SessionSubscribe {
  type: 'session.subscribe';
  sessionId: string;
  sinceSeq?: number;        // 断线重连: 从此 seq 之后补拉; 0/缺省 = 全量快照
}

export interface SessionUnsubscribe {
  type: 'session.unsubscribe';
  sessionId: string;
}

export interface SessionCreate {
  type: 'session.create';
  cwd: string;
}

// ---------- 契约 v2 扩展: prompt 附件 (docs/PROTOCOL-CONTRACT.md, 形状与 packages/protocol 对齐) ----------

/** prompt 附件: 图片走 ACP image block, 文本资源走 embedded context */
export interface PromptAttachment {
  type: 'image' | 'resource_text';
  mimeType: string;
  fileName?: string;
  data?: string;            // image: base64
  text?: string;            // resource_text: 文件内容
  uri?: string;             // resource_text: file:// uri
}

export interface SessionPromptMsg {
  type: 'session.prompt';
  sessionId: string;
  text: string;
  clientMsgId: string;      // 客户端生成, 幂等去重
  attachments?: PromptAttachment[];   // 契约 v2: 无附件时省略 (向后兼容)
}

export interface SessionCancelMsg {
  type: 'session.cancel';
  sessionId: string;
}

export interface SessionSetModeMsg {
  type: 'session.setMode';
  sessionId: string;
  modeId: string;
}

export interface SessionSetConfigMsg {
  type: 'session.setConfig';
  sessionId: string;
  configId: string;         // 'mode' | 'model' | 其他 configOptions id
  value: string;
}

export interface PermissionRespond {
  type: 'permission.respond';
  sessionId: string;
  requestId: string;        // server 侧的权限请求 id
  optionId?: string;        // 缺省 = 取消
  cancelled?: boolean;
}

export interface PingMsg {
  type: 'ping';
  ts?: number;
}

export interface StatusRequest {
  type: 'status.request';
}

export interface DeviceListRequest {
  type: 'device.list';
}

export interface DeviceRevokeMsg {
  type: 'device.revoke';
  deviceId: string;
}

/** 删除设备 — 仅已撤销设备可删, 成功响应 device.deleted */
export interface DeviceDeleteMsg {
  type: 'device.delete';
  deviceId: string;
}

export interface WorkdirListRequest {
  type: 'workdir.list';
}

/** 新增工作目录 — 必须绝对路径且已存在; 重复拒绝; 成功后 server 广播新 workdir.list */
export interface WorkdirAddRequest {
  type: 'workdir.add';
  path: string;
  label?: string;
}

/** 移除工作目录 — 至少保留一个; 成功后 server 广播新 workdir.list */
export interface WorkdirRemoveRequest {
  type: 'workdir.remove';
  path: string;
}

/** 读取规则配置 (global windsurf 规则 + 可选项目级) — 宽松解析, 字段缺失不崩 */
export interface ConfigRulesGetRequest {
  type: 'config.rules.get';
  cwd?: string;
}

export interface ConfigRulesSetRequest {
  type: 'config.rules.set';
  scope?: 'global' | 'project';
  cwd?: string;
  name?: string;
  content: string;
}

/** 读取 MCP 配置 — 多层合并视图 */
export interface ConfigMcpGetRequest {
  type: 'config.mcp.get';
  cwd?: string;
}

export interface ConfigMcpSetRequest {
  type: 'config.mcp.set';
  scope?: 'user' | 'project' | 'local';
  cwd?: string;
  config: Record<string, unknown>;
}

/** 查询账户额度 — connect-RPC 优先, events 统计作 fallback */
export interface AccountQuotaRequest {
  type: 'account.quota';
}

// ---------- 契约 v2: 文件系统 (对话页资源管理器) — 形状与 packages/protocol 对齐 ----------
// 关联机制: 无请求 id — 响应复用请求同名 type, 按 type+path 匹配在途请求;
// 失败走统一 error 消息, ref = 请求 path (move/copy 为 "src -> dst" 原样输入串)

/** 列目录 — path 必须是绝对路径且落在 server workdirs 监狱内 */
export interface FsListRequest {
  type: 'fs.list';
  path: string;
  showHidden?: boolean;
}

/** 读文件内容 — 默认 256KB, 上限 1MB; 二进制返回 base64 */
export interface FsReadRequest {
  type: 'fs.read';
  path: string;
  maxBytes?: number;
}

/** 写文本文件 (utf8) — mobile UI 暂未使用, 镜像保留 */
export interface FsWriteRequest {
  type: 'fs.write';
  path: string;
  content: string;
}

export interface FsDeleteRequest {
  type: 'fs.delete';
  path: string;
  /** 默认 false; 非空目录必须显式 true */
  recursive?: boolean;
}

export interface FsMoveRequest {
  type: 'fs.move';
  src: string;
  dst: string;              // 完整目标路径 (含末段名), 非目标目录; 已存在则报 exists 除非 overwrite
  overwrite?: boolean;
}

export interface FsCopyRequest {
  type: 'fs.copy';
  src: string;
  dst: string;
  overwrite?: boolean;
}

export type ClientMessage =
  | PairRequest
  | AuthHello
  | AuthResponse
  | SessionListRequest
  | DevinSessionListRequest
  | SessionLoad
  | SessionSubscribe
  | SessionUnsubscribe
  | SessionCreate
  | SessionPromptMsg
  | SessionCancelMsg
  | SessionSetModeMsg
  | SessionSetConfigMsg
  | PermissionRespond
  | PingMsg
  | StatusRequest
  | DeviceListRequest
  | DeviceRevokeMsg
  | DeviceDeleteMsg
  | WorkdirListRequest
  | WorkdirAddRequest
  | WorkdirRemoveRequest
  | ConfigRulesGetRequest
  | ConfigRulesSetRequest
  | ConfigMcpGetRequest
  | ConfigMcpSetRequest
  | AccountQuotaRequest
  | FsListRequest
  | FsReadRequest
  | FsWriteRequest
  | FsDeleteRequest
  | FsMoveRequest
  | FsCopyRequest;

// ---------- server → client ----------

export interface PairOk {
  type: 'pair.ok';
  deviceId: string;
  deviceSecret: string;     // 仅此次传输, 客户端存入安全存储
  deviceName: string;
}

export interface AuthChallenge {
  type: 'auth.challenge';
  nonce: string;
}

export interface AuthOk {
  type: 'auth.ok';
  deviceId: string;
  deviceName: string;
  serverVersion: string;
}

export interface SessionListMsg {
  type: 'session.list';
  sessions: SessionMeta[];
}

/** 契约 v2: devin 侧全部会话条目 (devinSession.list 响应) — 字段可选性与 packages/protocol 对齐, 客户端宽容处理缺省 */
export interface DevinSessionInfo {
  sessionId: string;
  cwd: string;
  title?: string | null;
  updatedAt?: string;             // ISO 8601 时间串
  isLocked?: boolean;             // true = 正被 Devin Desktop 占用, 加载可能冲突
  additionalDirectories?: string[];
}

export interface DevinSessionListMsg {
  type: 'devinSession.list';
  sessions: DevinSessionInfo[];   // 按 updatedAt 降序
}

export interface SessionCreated {
  type: 'session.created';
  session: SessionMeta;
  acp?: SessionNewResult;   // 附带 modes/configOptions 供渲染选择器
}

/** 契约 v2: session.load 成功广播 — 结构同 session.created */
export interface SessionLoaded {
  type: 'session.loaded';
  session: SessionMeta;
  acp?: SessionNewResult;
}

export interface SessionSnapshot {
  type: 'session.snapshot';
  sessionId: string;
  session: SessionMeta;
  events: SessionEvent[];   // 全量或 sinceSeq 之后的事件 (大会话仅最近 400 条)
  truncated?: boolean;      // 快照被限量截断时为 true
  totalEvents?: number;     // 事件总数 (截断时 > events.length)
  acp?: SessionNewResult | null;
  configOptions?: unknown;
  availableCommands?: unknown;
  pendingPermissions: PendingPermission[];
}

export interface SessionEventMsg {
  type: 'session.event';
  event: SessionEvent;
}

export interface SessionStatusMsg {
  type: 'session.status';
  sessionId: string;
  status: SessionMeta['status'];
  title?: string | null;
}

export interface PendingPermission {
  requestId: string;
  sessionId: string;
  toolCall: RequestPermissionParams['toolCall'];
  options: RequestPermissionParams['options'];
  requestedAt: number;
}

export interface PermissionRequestMsg {
  type: 'permission.request';
  request: PendingPermission;
}

export interface PermissionResolvedMsg {
  type: 'permission.resolved';
  sessionId: string;
  requestId: string;
  optionId?: string;
  cancelled?: boolean;
  byDevice: string;
}

export interface ServerStatus {
  type: 'server.status';
  uptimeSec: number;
  host: string;
  port: number;
  hostname?: string;        // 配置的公网域名
  activeSessions: number;
  onlineDevices: number;
  version: string;
}

export interface DeviceInfo {
  deviceId: string;
  deviceName: string;
  platform?: string;
  pairedAt: number;
  lastActiveAt: number;
  online: boolean;
}

export interface DeviceListMsg {
  type: 'device.list';
  devices: DeviceInfo[];
}

export interface WorkdirListMsg {
  type: 'workdir.list';
  dirs: { path: string; label?: string; exists?: boolean }[];
}

/** device.delete 成功响应 — 仅发给请求方 */
export interface DeviceDeletedMsg {
  type: 'device.deleted';
  deviceId: string;
}

// ---------- 配置查看 (规则 / MCP) — 宽松解析镜像, 字段缺失/畸形不崩 ----------

export interface RuleFileInfo {
  name: string;
  path: string;
  provider: 'windsurf' | 'cursor' | 'devin';
  activation: 'always-on' | 'conditional' | 'unknown';
  content: string;
}

export interface RulesProjectInfo {
  cwd: string;
  files: RuleFileInfo[];
}

export interface ConfigRulesMsg {
  type: 'config.rules';
  global: {
    path: string;
    exists: boolean;
    content: string;
    provider: 'windsurf';
  };
  projects: RulesProjectInfo[];
  writtenPath?: string;
  backupPath?: string;
}

export interface McpConfigLayer {
  scope: 'user' | 'legacy-windsurf' | 'legacy-claude' | 'legacy-cursor' | 'legacy-opencode' | 'project' | 'local';
  path: string;
  exists: boolean;
  config?: Record<string, unknown>;
  error?: string;
}

export interface ConfigMcpMsg {
  type: 'config.mcp';
  layers: McpConfigLayer[];
  effective: {
    mcpServers: Record<string, unknown>;
  };
  writtenPath?: string;
  backupPath?: string;
}

// ---------- 账户额度 ----------

export interface AccountUsageAggregate {
  totalCreditCost: number;
  totalAcuCost: number;
  inputTokens: number;
  eventCount: number;
  sessions: number;
}

export interface AccountQuotaMsg {
  type: 'account.quota';
  source: 'connect-rpc' | 'events-fallback' | 'none';
  weeklyRemainingPercent: number | null;
  dailyRemainingPercent: number | null;
  /** unix ms; 探不到为 null */
  dailyResetAt: number | null;
  weeklyResetAt: number | null;
  /** overage 余额, 单位 micros (1/1e6 美元; 负 = 透支) */
  overageBalance: number | null;
  overageBalanceMicros: number | null;
  acuConsumed: number | null;
  acuLimit: number | null;
  planName: string | null;
  sessionUsage: AccountUsageAggregate;
  /** connect-RPC 原始响应的安全截断投影; 不含敏感信息 */
  raw: unknown;
}

// ---------- 契约 v2: fs 响应 — 形状与 packages/protocol 对齐 ----------
// 响应 type 与请求同名 (如 fs.list 的响应也是 fs.list), 按 type+path 关联;
// 失败不产生结果消息, 而是统一 error 消息 (ref=path / "src -> dst")
// 容错约定: 客户端宽松解析, 字段缺失/畸形不崩

export interface FsEntry {
  name: string;
  path: string;             // 条目绝对路径 (server 已拼接, 优先于客户端 joinPath)
  type: 'file' | 'directory' | 'symlink' | 'other';
  size: number;             // 字节
  mtimeMs: number;          // unix ms
}

export interface FsListResult {
  type: 'fs.list';
  path: string;             // 经 server resolve 归一后的输入路径
  entries: FsEntry[];
}

export interface FsReadResult {
  type: 'fs.read';
  path: string;
  content: string;          // utf8 文本或 base64 (二进制)
  encoding: 'utf8' | 'base64';
  size: number;
  mtimeMs: number;
  truncated: boolean;
}

export interface FsWriteResult {
  type: 'fs.write';
  path: string;
  bytes: number;
  mtimeMs: number;
}

export interface FsDeleteResult {
  type: 'fs.delete';
  path: string;
  deleted: true;
}

export interface FsMoveResult {
  type: 'fs.move';
  src: string;
  dst: string;
  moved: true;
}

export interface FsCopyResult {
  type: 'fs.copy';
  src: string;
  dst: string;
  copied: true;
}

export interface ErrorMsg {
  type: 'error';
  code: string;
  message: string;
  ref?: string;             // 关联的请求上下文
}

export interface PongMsg {
  type: 'pong';
  ts: number;
}

export type ServerMessage =
  | PairOk
  | AuthChallenge
  | AuthOk
  | SessionListMsg
  | DevinSessionListMsg
  | SessionCreated
  | SessionLoaded
  | SessionSnapshot
  | SessionEventMsg
  | SessionStatusMsg
  | PermissionRequestMsg
  | PermissionResolvedMsg
  | ServerStatus
  | DeviceListMsg
  | DeviceDeletedMsg
  | WorkdirListMsg
  | ConfigRulesMsg
  | ConfigMcpMsg
  | AccountQuotaMsg
  | FsListResult
  | FsReadResult
  | FsWriteResult
  | FsDeleteResult
  | FsMoveResult
  | FsCopyResult
  | ErrorMsg
  | PongMsg;

// ---------- 工具函数 ----------

export function isClientMessage(v: unknown): v is ClientMessage {
  return typeof v === 'object' && v !== null && typeof (v as { type?: unknown }).type === 'string';
}

/** 事件载荷类型窄化助手 */
export function asAcpUpdatePayload(payload: unknown): SessionUpdateParams['update'] | null {
  if (typeof payload === 'object' && payload !== null && 'sessionUpdate' in payload) {
    return payload as SessionUpdateParams['update'];
  }
  return null;
}

export type { StopReason };
