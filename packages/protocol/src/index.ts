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
}

export interface SessionUnsubscribe {
  type: 'session.unsubscribe';
  sessionId: string;
}

export interface SessionCreate {
  type: 'session.create';
  cwd: string;
}

export interface SessionPromptMsg {
  type: 'session.prompt';
  sessionId: string;
  text: string;
  clientMsgId: string;      // 客户端生成, 幂等去重
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

export interface WorkdirListRequest {
  type: 'workdir.list';
}

export type ClientMessage =
  | PairRequest
  | AuthHello
  | AuthResponse
  | SessionListRequest
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
  | WorkdirListRequest;

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

export interface SessionSnapshot {
  type: 'session.snapshot';
  sessionId: string;
  session: SessionMeta;
  events: SessionEvent[];   // 全量或 sinceSeq 之后的事件
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
  | SessionSnapshot
  | SessionEventMsg
  | SessionStatusMsg
  | PermissionRequestMsg
  | PermissionResolvedMsg
  | ServerStatus
  | DeviceListMsg
  | WorkdirListMsg
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
