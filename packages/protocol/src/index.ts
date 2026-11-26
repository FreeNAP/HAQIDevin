/**
 * Devin Remote 线协议 — server ↔ client (WebSocket, JSON 文本帧)
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
} from '@devin-remote/acp-types';

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

export interface SessionSubscribe {
  type: 'session.subscribe';
  sessionId: string;
  sinceSeq?: number;        // 断线重连: 从此 seq 之后补拉; 0/缺省 = 全量快照
  limit?: number;           // 全量快照事件上限: 取最新 N 条; 默认 400, 上限 400 (增量补拉不截断)
}

/** 历史翻页请求 — 拉取 beforeSeq 之前的一批 */
export interface SessionHistoryReq {
  type: 'session.history';
  sessionId: string;
  beforeSeq: number;        // 拉此 seq 之前的事件
  limit?: number;           // 默认 200, 上限 400
}

export interface SessionUnsubscribe {
  type: 'session.unsubscribe';
  sessionId: string;
}

export interface SessionCreate {
  type: 'session.create';
  cwd: string;
}

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
  attachments?: PromptAttachment[];
}

/** devin 侧会话 (session/list 返回项) — 含 Devin Desktop 创建的会话 */
export interface DevinSessionInfo {
  sessionId: string;
  cwd: string;
  title?: string;
  updatedAt?: string;
  isLocked?: boolean;
  additionalDirectories?: string[];
}

export interface DevinSessionListRequest {
  type: 'devinSession.list';
}

/** 加载已有 devin 会话 (cwd 必须与创建时一致) */
export interface SessionLoadMsg {
  type: 'session.load';
  devinSessionId: string;
  cwd: string;
  additionalDirectories?: string[];
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

export interface DeviceDeleteMsg {
  type: 'device.delete';
  deviceId: string;
}

export interface WorkdirListRequest {
  type: 'workdir.list';
}

// ---------- v2: 文件系统 / 工作目录 / 配置 / git / 账户额度 ----------

export interface FsListRequest {
  type: 'fs.list';
  path: string;
  showHidden?: boolean;
}

export interface FsReadRequest {
  type: 'fs.read';
  path: string;
  /** 默认 256KB, 上限 1MB; 超出截断 */
  maxBytes?: number;
}

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
  dst: string;
  overwrite?: boolean;
}

export interface FsCopyRequest {
  type: 'fs.copy';
  src: string;
  dst: string;
  overwrite?: boolean;
}

export interface WorkdirAddRequest {
  type: 'workdir.add';
  path: string;
  label?: string;
}

export interface WorkdirRemoveRequest {
  type: 'workdir.remove';
  path: string;
}

export interface ConfigRulesGetRequest {
  type: 'config.rules.get';
  /** 可选: 同时读取该项目目录下的 .windsurf/.cursor 规则; 必须在 workdirs 监狱内 */
  cwd?: string;
}

export interface ConfigRulesSetRequest {
  type: 'config.rules.set';
  /** 默认 global; project 需要 cwd + name */
  scope?: 'global' | 'project';
  cwd?: string;
  /** project 规则文件名 (可省略 .md) */
  name?: string;
  content: string;
}

export interface ConfigMcpGetRequest {
  type: 'config.mcp.get';
  /** 可选: 同时读取项目级 .devin/mcp_config*.json; 必须在 workdirs 监狱内 */
  cwd?: string;
}

export interface ConfigMcpSetRequest {
  type: 'config.mcp.set';
  /** 默认 user; project/local 需要 cwd */
  scope?: 'user' | 'project' | 'local';
  cwd?: string;
  /** 完整配置对象, 必须包含 mcpServers; 写前自动 .bak-时间戳 */
  config: Record<string, unknown>;
}

export interface GitStatusRequest {
  type: 'git.status';
  cwd: string;
}

export interface GitDiffRequest {
  type: 'git.diff';
  cwd: string;
  file?: string;
  staged?: boolean;
}

export interface GitCommitRequest {
  type: 'git.commit';
  cwd: string;
  message: string;
  /** 缺省提交当前已暂存内容; 传入文件列表则先 add 这些文件 */
  files?: string[];
}

export interface GitPushRequest {
  type: 'git.push';
  cwd: string;
  remote?: string;
  branch?: string;
}

export interface GitPullRequest {
  type: 'git.pull';
  cwd: string;
  remote?: string;
  branch?: string;
}

export interface AccountQuotaRequest {
  type: 'account.quota';
}

// ---------- revert (devin 私有 ACP 方法 cognition.ai/revert/* 的 ws 转发) ----------
// 宽松透传设计: server 不严格校验 params, client 额外字段原样进 JSON-RPC params,
// agent 错误响应原样透传回 client — 便于私有 schema 偏差时的真机调试

export interface SessionRevertListStepsMsg {
  type: 'session.revert.listSteps';
  sessionId: string;
}

export interface SessionRevertPreviewMsg {
  type: 'session.revert.preview';
  sessionId: string;
  /** 取 RevertStepInfo.revertTargetNodeId */
  targetNodeId: string;
  [k: string]: unknown;
}

export interface SessionRevertExecuteMsg {
  type: 'session.revert.execute';
  sessionId: string;
  /** 取 RevertStepInfo.revertTargetNodeId */
  targetNodeId: string;
  force?: boolean;
  skipFileUndo?: boolean;
  [k: string]: unknown;
}

/** forkFromStep — 创建分叉会话而不动原会话, 最安全的回撤方式 */
export interface SessionRevertForkMsg {
  type: 'session.revert.fork';
  sessionId: string;
  /** 取 RevertStepInfo.forkTargetNodeId */
  targetNodeId: string;
  [k: string]: unknown;
}

export type ClientMessage =
  | PairRequest
  | AuthHello
  | AuthResponse
  | SessionListRequest
  | SessionSubscribe
  | SessionHistoryReq
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
  | FsListRequest
  | FsReadRequest
  | FsWriteRequest
  | FsDeleteRequest
  | FsMoveRequest
  | FsCopyRequest
  | WorkdirAddRequest
  | WorkdirRemoveRequest
  | ConfigRulesGetRequest
  | ConfigRulesSetRequest
  | ConfigMcpGetRequest
  | ConfigMcpSetRequest
  | GitStatusRequest
  | GitDiffRequest
  | GitCommitRequest
  | GitPushRequest
  | GitPullRequest
  | AccountQuotaRequest
  | DevinSessionListRequest
  | SessionLoadMsg
  | SessionRevertListStepsMsg
  | SessionRevertPreviewMsg
  | SessionRevertExecuteMsg
  | SessionRevertForkMsg;

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

export interface SessionCreated {
  type: 'session.created';
  session: SessionMeta;
  acp?: SessionNewResult;   // 附带 modes/configOptions 供渲染选择器
}

/** 加载已有 devin 会话成功广播 (结构与 session.created 一致) */
export interface SessionLoaded {
  type: 'session.loaded';
  session: SessionMeta;
  acp?: SessionNewResult;
}

export interface DevinSessionListMsg {
  type: 'devinSession.list';
  sessions: DevinSessionInfo[];
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

/** 历史翻页响应 — beforeSeq 之前的一批事件 (按 seq 升序) */
export interface SessionHistoryBatchMsg {
  type: 'session.history.batch';
  sessionId: string;
  events: SessionEvent[];
  /** 是否还有更早的事件可翻页 */
  hasMore: boolean;
  /** 本批最小 seq — 下次翻页用它作 beforeSeq */
  oldestSeq: number;
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

// ---------- v2 响应类型 ----------

export interface FsEntry {
  name: string;
  path: string;
  type: 'file' | 'directory' | 'symlink' | 'other';
  size: number;
  mtimeMs: number;
}

export interface FsListMsg {
  type: 'fs.list';
  path: string;
  entries: FsEntry[];
}

export interface FsReadMsg {
  type: 'fs.read';
  path: string;
  content: string;
  encoding: 'utf8' | 'base64';
  size: number;
  mtimeMs: number;
  truncated: boolean;
}

export interface FsWriteMsg {
  type: 'fs.write';
  path: string;
  bytes: number;
  mtimeMs: number;
}

export interface FsDeleteResultMsg {
  type: 'fs.delete';
  path: string;
  deleted: true;
}

export interface FsMoveResultMsg {
  type: 'fs.move';
  src: string;
  dst: string;
  moved: true;
}

export interface FsCopyResultMsg {
  type: 'fs.copy';
  src: string;
  dst: string;
  copied: true;
}

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

export interface GitChangedFile {
  path: string;
  oldPath?: string;
  /** porcelain XY 两列状态, 如 ' M' / 'M ' / '??' */
  xy: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'untracked' | 'ignored' | 'unmerged' | 'unknown';
  staged: boolean;
  unstaged: boolean;
}

export interface GitStatusMsg {
  type: 'git.status';
  cwd: string;
  repoRoot: string;
  branch: string | null;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  files: GitChangedFile[];
  clean: boolean;
}

export interface GitDiffMsg {
  type: 'git.diff';
  cwd: string;
  file?: string;
  diff: string;
  truncated: boolean;
}

export interface GitResultMsg {
  type: 'git.result';
  op: 'commit' | 'push' | 'pull';
  cwd: string;
  ok: true;
  stdout: string;
  stderr: string;
  commitHash?: string;
}

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
  /** overage 余额, 单位 micros (原始响应整数; 可为负表示透支) */
  overageBalance: number | null;
  overageBalanceMicros: number | null;
  acuConsumed: number | null;
  acuLimit: number | null;
  planName: string | null;
  sessionUsage: AccountUsageAggregate;
  /** connect-RPC 原始响应的安全截断投影; 不含 Authorization/apiKey */
  raw: unknown;
}

export interface DeviceDeletedMsg {
  type: 'device.deleted';
  deviceId: string;
}

// ---------- revert 响应 ----------
// result/preview 字段直接承载 agent 原始响应 (宽松建模见 acp-types Revert*Response)

export interface SessionRevertStepsMsg {
  type: 'session.revert.steps';
  sessionId: string;
  /** agent 原始响应中的 steps 数组 (RevertStepInfo[]); agent 未返回时为 null */
  steps: unknown[] | null;
  /** agent 完整原始响应, 便于调试 schema 偏差 */
  raw: unknown;
}

export interface SessionRevertPreviewResultMsg {
  type: 'session.revert.previewResult';
  sessionId: string;
  targetNodeId: string;
  /** agent 原始 RevertPreviewResponse: fileActions/irreversibleWarnings/conflicts */
  preview: unknown;
}

export interface SessionRevertResultMsg {
  type: 'session.revert.result';
  sessionId: string;
  targetNodeId: string;
  /** agent 原始 RevertExecuteResponse: outcomes (+ 可能的 forkedSessionId) */
  result: unknown;
}

export interface SessionRevertForkedMsg {
  type: 'session.revert.forked';
  sessionId: string;
  targetNodeId: string;
  /** 新分叉会话 id (提取自 agent 响应, 可能缺失) */
  forkedSessionId?: string;
  /** agent 原始 RevertForkFromStepResponse */
  raw: unknown;
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
  | SessionCreated
  | SessionLoaded
  | DevinSessionListMsg
  | SessionSnapshot
  | SessionHistoryBatchMsg
  | SessionEventMsg
  | SessionStatusMsg
  | PermissionRequestMsg
  | PermissionResolvedMsg
  | ServerStatus
  | DeviceListMsg | DeviceDeletedMsg
  | WorkdirListMsg
  | FsListMsg
  | FsReadMsg
  | FsWriteMsg
  | FsDeleteResultMsg
  | FsMoveResultMsg
  | FsCopyResultMsg
  | ConfigRulesMsg
  | ConfigMcpMsg
  | GitStatusMsg
  | GitDiffMsg
  | GitResultMsg
  | AccountQuotaMsg
  | SessionRevertStepsMsg
  | SessionRevertPreviewResultMsg
  | SessionRevertResultMsg
  | SessionRevertForkedMsg
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
