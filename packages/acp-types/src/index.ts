/**
 * ACP (Agent Client Protocol) 类型定义
 * 依据: https://agentclientprotocol.com + devin acp v3000.6.7 真实探针报文
 * 注意: devin 的扩展字段统一放在 _meta，前缀 cognition.ai/
 */

// ---------- JSON-RPC 2.0 基础 ----------

export type JsonRpcId = number | string;

export interface JsonRpcRequest<P = unknown> {
  jsonrpc: '2.0';
  id: JsonRpcId;
  method: string;
  params?: P;
}

export interface JsonRpcNotification<P = unknown> {
  jsonrpc: '2.0';
  method: string;
  params?: P;
}

export interface JsonRpcSuccess<R = unknown> {
  jsonrpc: '2.0';
  id: JsonRpcId;
  result: R;
}

export interface JsonRpcErrorObj {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcError {
  jsonrpc: '2.0';
  id: JsonRpcId;
  error: JsonRpcErrorObj;
}

export type JsonRpcMessage =
  | JsonRpcRequest
  | JsonRpcNotification
  | JsonRpcSuccess
  | JsonRpcError;

// ---------- initialize ----------

export interface ClientCapabilities {
  auth?: { terminal?: boolean };
  fs?: { readTextFile?: boolean; writeTextFile?: boolean };
  terminal?: boolean;
  elicitation?: Record<string, unknown> | null;
  plan?: Record<string, never>;
  subagents?: Record<string, never>;
  session?: {
    compaction?: Record<string, never> | null;
    notices?: Record<string, never> | null;
    configOptions?: { boolean?: Record<string, never> | null } | null;
  } | null;
}

export interface InitializeParams {
  protocolVersion: number;
  clientCapabilities: ClientCapabilities;
  clientInfo?: { name: string; title?: string; version?: string };
}

export interface AuthMethod {
  id: string;
  name: string;
  description?: string;
}

export interface AgentCapabilities {
  loadSession?: boolean;
  promptCapabilities?: { image?: boolean; audio?: boolean; embeddedContext?: boolean };
  mcpCapabilities?: { http?: boolean; sse?: boolean };
  sessionCapabilities?: {
    list?: Record<string, never>;
    delete?: Record<string, never>;
    additionalDirectories?: Record<string, never>;
  };
  auth?: Record<string, unknown>;
  _meta?: Record<string, unknown>;
}

export interface InitializeResult {
  protocolVersion: number;
  agentCapabilities: AgentCapabilities;
  authMethods: AuthMethod[];
  agentInfo?: { name: string; title?: string; version?: string };
  _meta?: Record<string, unknown>;
}

// ---------- authenticate ----------

export interface AuthenticateParams {
  methodId: string;
  /** devin 扩展: _meta.api_key 直接传 API key 跳过浏览器 PKCE */
  _meta?: { api_key?: string; [k: string]: unknown };
}

// ---------- session/new ----------

export interface SessionNewParams {
  cwd: string;
  mcpServers?: unknown[];
}

export interface ModeInfo {
  id: string;
  name: string;
  description?: string;
  _meta?: Record<string, unknown>;
}

export interface ConfigOptionValue {
  value: string;
  name: string;
  description?: string;
  _meta?: Record<string, unknown>;
}

export interface ConfigOption {
  id: string;
  name: string;
  description?: string;
  category?: string;
  type: string;
  currentValue?: string;
  options?: ConfigOptionValue[];
  _meta?: Record<string, unknown>;
}

export interface SessionNewResult {
  sessionId: string;
  modes?: {
    currentModeId: string;
    availableModes: ModeInfo[];
  };
  configOptions?: ConfigOption[];
  _meta?: Record<string, unknown>;
}

// ---------- session/prompt ----------

export interface ContentBlock {
  type: 'text' | 'image' | 'resource' | 'resource_link' | string;
  text?: string;
  data?: string;
  mimeType?: string;
  uri?: string;
  name?: string;
  [k: string]: unknown;
}

export interface SessionPromptParams {
  sessionId: string;
  prompt: ContentBlock[];
}

export type StopReason = 'end_turn' | 'cancelled' | 'max_tokens' | 'refusal' | string;

export interface SessionPromptResult {
  stopReason: StopReason;
  usage?: {
    totalTokens?: number;
    inputTokens?: number;
    outputTokens?: number;
    cachedReadTokens?: number;
  };
  _meta?: Record<string, unknown>;
}

// ---------- session/update 通知 ----------

export interface SessionUpdateBase {
  sessionUpdate: string;
}

export interface AgentMessageChunk extends SessionUpdateBase {
  sessionUpdate: 'agent_message_chunk';
  content: ContentBlock;
}

export interface AgentThoughtChunk extends SessionUpdateBase {
  sessionUpdate: 'agent_thought_chunk';
  content: ContentBlock;
}

export interface UserMessageChunk extends SessionUpdateBase {
  sessionUpdate: 'user_message_chunk';
  content: ContentBlock;
}

export interface ToolCallContent {
  type: 'content' | 'diff' | 'terminal' | string;
  content?: ContentBlock;
  path?: string;
  oldText?: string;
  newText?: string;
  terminalId?: string;
  [k: string]: unknown;
}

export type ToolKind =
  | 'read' | 'edit' | 'delete' | 'move' | 'search' | 'execute'
  | 'think' | 'fetch' | 'switch_mode' | 'other' | string;

export type ToolCallStatus = 'pending' | 'in_progress' | 'completed' | 'failed' | string;

export interface ToolCallUpdate extends SessionUpdateBase {
  sessionUpdate: 'tool_call';
  toolCallId: string;
  title?: string;
  kind?: ToolKind;
  status?: ToolCallStatus;
  content?: ToolCallContent[];
  rawInput?: Record<string, unknown>;
  rawOutput?: unknown;
  locations?: { path: string; line?: number }[];
  _meta?: {
    'cognition.ai/inferenceToolName'?: string;
    [k: string]: unknown;
  };
}

export interface ToolCallUpdateUpdate extends SessionUpdateBase {
  sessionUpdate: 'tool_call_update';
  toolCallId: string;
  title?: string;
  kind?: ToolKind;
  status?: ToolCallStatus;
  content?: ToolCallContent[];
  rawInput?: Record<string, unknown>;
  rawOutput?: unknown;
  locations?: { path: string; line?: number }[];
  _meta?: {
    'cognition.ai/inferenceToolName'?: string;
    [k: string]: unknown;
  };
}

export interface PlanEntry {
  content: string;
  status: 'pending' | 'in_progress' | 'completed' | string;
  priority?: string;
  [k: string]: unknown;
}

export interface PlanUpdate extends SessionUpdateBase {
  sessionUpdate: 'plan';
  entries: PlanEntry[];
}

export interface AvailableCommand {
  name: string;
  description: string;
  input?: { hint?: string } | null;
  _meta?: Record<string, unknown>;
}

export interface AvailableCommandsUpdate extends SessionUpdateBase {
  sessionUpdate: 'available_commands_update';
  availableCommands: AvailableCommand[];
}

export interface CurrentModeUpdate extends SessionUpdateBase {
  sessionUpdate: 'current_mode_update';
  currentModeId: string;
}

export interface ConfigOptionUpdate extends SessionUpdateBase {
  sessionUpdate: 'config_option_update';
  configOptions: ConfigOption[];
}

export interface UsageUpdate extends SessionUpdateBase {
  sessionUpdate: 'usage_update';
  used?: number;
  size?: number;
  _meta?: {
    'cognition.ai/inputTokens'?: number;
    'cognition.ai/outputTokens'?: number;
    [k: string]: unknown;
  };
}

export interface SessionInfoUpdate extends SessionUpdateBase {
  sessionUpdate: 'session_info_update';
  title?: string | null;
}

export type SessionUpdate =
  | AgentMessageChunk
  | AgentThoughtChunk
  | UserMessageChunk
  | ToolCallUpdate
  | ToolCallUpdateUpdate
  | PlanUpdate
  | AvailableCommandsUpdate
  | CurrentModeUpdate
  | ConfigOptionUpdate
  | UsageUpdate
  | SessionInfoUpdate
  | (SessionUpdateBase & Record<string, unknown>);

export interface SessionUpdateParams {
  sessionId: string;
  update: SessionUpdate;
}

// ---------- session/request_permission (agent→client 请求) ----------

export interface PermissionOption {
  optionId: string;
  name: string;
  kind?: 'allow_once' | 'allow_always' | 'reject_once' | 'reject_always' | string;
  [k: string]: unknown;
}

export interface RequestPermissionParams {
  sessionId: string;
  toolCall: {
    toolCallId: string;
    title?: string;
    kind?: ToolKind;
    rawInput?: Record<string, unknown>;
    content?: ToolCallContent[];
    [k: string]: unknown;
  };
  options: PermissionOption[];
  _meta?: Record<string, unknown>;
}

export interface RequestPermissionResult {
  outcome: {
    outcome: 'selected' | 'cancelled';
    optionId?: string;
  };
}

// ---------- fs 方法 (agent→client 请求) ----------

export interface FsReadParams {
  sessionId: string;
  path: string;
  line?: number;
  limit?: number;
  _meta?: Record<string, unknown>;
}

export interface FsReadResult {
  content: string;
}

export interface FsWriteParams {
  sessionId: string;
  path: string;
  content: string;
  _meta?: Record<string, unknown>;
}

// ---------- session/cancel ----------

export interface SessionCancelParams {
  sessionId: string;
}

// ---------- session/set_mode / set_config ----------

export interface SessionSetModeParams {
  sessionId: string;
  modeId: string;
}

/** ACP v2 风格: 配置项更新（devin 用此切模型/模式） */
export interface SessionSetConfigParams {
  sessionId: string;
  configId: string;
  value: string;
}

// ---------- devin 私有通知 (原样透传) ----------

export const COGNITION_METHODS = [
  '_cognition.ai/output',
  '_cognition.ai/thinking_complete',
  '_cognition.ai/agent_stopped',
  '_cognition.ai/mcp/serversChanged',
] as const;

// ---------- devin 私有 revert 方法 (cognition.ai/revert/*) ----------
// 私有协议无公开 schema — 按 devin.exe 二进制 serde 结构侦察宽松建模:
//   struct RevertStepInfo with 8 elements: stepNumber/kind/userMessageId/toolCallId/
//     questionNodeId/revertTargetNodeId/forkTargetNodeId/summary
//   struct RevertPreviewResponse with 3 elements: fileActions/irreversibleWarnings/conflicts
//   struct RevertExecuteResponse with 2 elements: forkedSessionId/outcomes
//   struct RevertForkFromStepResponse / RevertResumeResponse with 1 element
// 未知字段一律索引签名兜底, server 做宽松透传不做严格校验

export interface RevertStepInfo {
  stepNumber?: number;
  /** prompt | questionAnswer (RevertStepKind) */
  kind?: string;
  userMessageId?: string;
  toolCallId?: string;
  questionNodeId?: string;
  /** execute/preview 用的目标节点 id */
  revertTargetNodeId?: string;
  /** forkFromStep 用的目标节点 id */
  forkTargetNodeId?: string;
  summary?: string;
  [k: string]: unknown;
}

export interface RevertListStepsParams {
  sessionId: string;
  [k: string]: unknown;
}

export interface RevertListStepsResponse {
  steps?: RevertStepInfo[];
  [k: string]: unknown;
}

/** preview/execute/forkFromStep 共用参数形态 — client 额外字段原样透传 */
export interface RevertTargetParams {
  sessionId: string;
  targetNodeId: string;
  /** execute 专有: 跳过确认强制回撤 */
  force?: boolean;
  /** execute 专有: 不回滚文件改动只回滚对话 */
  skipFileUndo?: boolean;
  [k: string]: unknown;
}

/** FileRevertKindPayload: internally tagged enum — type: restore/delete/recreate */
export interface FileRevertActionPayload {
  path?: string;
  type?: 'restore' | 'delete' | 'recreate' | string;
  diffStats?: unknown;
  currentContent?: string;
  /** restore 变体专有 */
  originalContent?: string;
  [k: string]: unknown;
}

export interface IrreversibleWarningPayload {
  toolName?: string;
  description?: string;
  [k: string]: unknown;
}

export interface RevertPreviewResponse {
  fileActions?: FileRevertActionPayload[];
  irreversibleWarnings?: IrreversibleWarningPayload[];
  conflicts?: unknown[];
  [k: string]: unknown;
}

/** RevertUndoOutcomePayload: internally tagged enum — type: success/skipped/failed */
export interface RevertUndoOutcomePayload {
  type?: 'success' | 'skipped' | 'failed' | string;
  path?: string;
  [k: string]: unknown;
}

export interface RevertExecuteResponse {
  forkedSessionId?: string;
  outcomes?: RevertUndoOutcomePayload[];
  [k: string]: unknown;
}

export interface RevertForkFromStepResponse {
  forkedSessionId?: string;
  [k: string]: unknown;
}

export interface RevertResumeParams {
  sessionId: string;
  targetNodeId?: string;
  [k: string]: unknown;
}

export interface RevertResumeResponse {
  stopReason?: string;
  [k: string]: unknown;
}

/** 私有方法名常量 — 注意无下划线前缀 (与 _cognition.ai/* 通知不同) */
export const REVERT_METHODS = {
  listSteps: 'cognition.ai/revert/listSteps',
  preview: 'cognition.ai/revert/preview',
  execute: 'cognition.ai/revert/execute',
  forkFromStep: 'cognition.ai/revert/forkFromStep',
  resume: 'cognition.ai/revert/resume',
} as const;

/** agent capabilities _meta 中宣告 revert 支持的 key (best-effort 检测用) */
export const REVERT_SUPPORT_META_KEY = 'cognition.ai/revert';
