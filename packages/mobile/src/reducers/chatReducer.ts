/**
 * 会话事件 reducer — append-only 事件流 → 可渲染的聊天状态
 *
 * 设计要点:
 *  - 每会话事件 seq 严格递增 → 去重规则: seq <= maxSeq 的事件丢弃
 *  - applySnapshot(reset=true) 全量重放; (reset=false) 断线补拉增量合并, 复用同一套事件逻辑
 *  - 工具卡片按 toolCallId 合并 tool_call / tool_call_update
 *  - plan 单卡滚动更新; agent/thought chunk 向尾部同类 item 追加文本
 *  - 本模块为纯函数, 不依赖 react/react-native, 可在 node 下单测
 */
import type {
  SessionEvent,
  SessionMeta,
  PendingPermission,
} from '../protocol/wire';
import type {
  PlanEntry,
  ConfigOption,
  AvailableCommand,
  ToolCallContent,
  ModeInfo,
  ContentBlock,
  StopReason,
  SessionNewResult,
} from '../protocol/acp';

// ---------- 渲染 item ----------

export interface UserItem {
  kind: 'user';
  id: string;
  seq: number;
  ts: number;
  text: string;
  deviceName?: string;
  clientMsgId?: string;
  pending?: boolean;
}

export interface AgentItem {
  kind: 'agent';
  id: string;
  seq: number;
  ts: number;
  text: string;
}

export interface ThoughtItem {
  kind: 'thought';
  id: string;
  seq: number;
  ts: number;
  text: string;
}

export interface ToolItem {
  kind: 'tool';
  id: string;
  seq: number;
  ts: number;
  toolCallId: string;
  /** 显示名: 优先 kind (mono 小写), 其次 inferenceToolName / title */
  name: string;
  title?: string;
  toolKind?: string;
  status: string;
  paths: string[];
  diffAdd: number;
  diffDel: number;
  hasDiff: boolean;
  detail?: string;
}

export interface PlanItem {
  kind: 'plan';
  id: string;
  seq: number;
  ts: number;
  entries: PlanEntry[];
}

export interface NoticeItem {
  kind: 'notice';
  id: string;
  seq: number;
  ts: number;
  text: string;
  tone: 'info' | 'warn' | 'error';
}

export type ChatItem = UserItem | AgentItem | ThoughtItem | ToolItem | PlanItem | NoticeItem;

// ---------- 状态 ----------

export interface UsageInfo {
  used?: number;
  size?: number;
  inputTokens?: number;
  outputTokens?: number;
}

export interface ModesInfo {
  currentModeId: string;
  availableModes: ModeInfo[];
}

export interface ChatState {
  sessionId: string;
  meta: SessionMeta | null;
  items: ChatItem[];
  maxSeq: number;
  status: SessionMeta['status'] | 'unknown';
  title: string | null;
  configOptions: ConfigOption[];
  availableCommands: AvailableCommand[];
  modes: ModesInfo | null;
  currentModeId: string | null;
  usage: UsageInfo | null;
  pendingPermissions: PendingPermission[];
  /** permission.resolved 通告: requestId → byDevice, 用于 "已由 XX 处理" 展示 */
  resolvedBy: Record<string, { byDevice: string; optionId?: string; cancelled?: boolean }>;
}

export function initChatState(sessionId: string): ChatState {
  return {
    sessionId,
    meta: null,
    items: [],
    maxSeq: 0,
    status: 'unknown',
    title: null,
    configOptions: [],
    availableCommands: [],
    modes: null,
    currentModeId: null,
    usage: null,
    pendingPermissions: [],
    resolvedBy: {},
  };
}

// ---------- payload 形状窄化 (unknown → 具体类型, 宽容失败) ----------

function asRecord(v: unknown): Record<string, unknown> | null {
  return typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : null;
}

function extractText(content: unknown): string {
  const c = asRecord(content) as ContentBlock | null;
  if (!c) return '';
  if (typeof c.text === 'string') return c.text;
  return '';
}

interface AcpUpdatePayload {
  sessionUpdate: string;
  [k: string]: unknown;
}

function asAcpUpdate(payload: unknown): AcpUpdatePayload | null {
  const r = asRecord(payload);
  if (r && typeof r.sessionUpdate === 'string') return r as AcpUpdatePayload;
  return null;
}

/** diff 摘要: 统计 newText / oldText 行数作为 +/- 估算 */
function diffStats(content: ToolCallContent[] | undefined): { add: number; del: number; hasDiff: boolean; paths: string[] } {
  let add = 0;
  let del = 0;
  let hasDiff = false;
  const paths: string[] = [];
  if (!Array.isArray(content)) return { add, del, hasDiff, paths };
  for (const c of content) {
    if (!c || typeof c !== 'object') continue;
    if (c.type === 'diff') {
      hasDiff = true;
      if (typeof c.path === 'string' && c.path) paths.push(c.path);
      const newLines = typeof c.newText === 'string' && c.newText.length > 0 ? c.newText.split('\n').length : 0;
      const oldLines = typeof c.oldText === 'string' && c.oldText.length > 0 ? c.oldText.split('\n').length : 0;
      add += newLines;
      del += oldLines;
    }
  }
  return { add, del, hasDiff, paths };
}

function contentDetail(content: ToolCallContent[] | undefined): string | undefined {
  if (!Array.isArray(content)) return undefined;
  for (const c of content) {
    if (!c || typeof c !== 'object') continue;
    if (c.type === 'content' && c.content && typeof c.content.text === 'string' && c.content.text.trim()) {
      const firstLine = c.content.text.trim().split('\n')[0] ?? '';
      return firstLine.length > 120 ? firstLine.slice(0, 117) + '…' : firstLine;
    }
    if (c.type === 'terminal' && typeof c.terminalId === 'string') {
      return `terminal ${c.terminalId}`;
    }
  }
  return undefined;
}

// ---------- item 级操作 ----------

let itemCounter = 0;
function nextId(prefix: string): string {
  itemCounter += 1;
  return `${prefix}_${itemCounter}_${Date.now().toString(36)}`;
}

/** 向尾部追加流式文本: 尾部为同类 item 则拼接, 否则新开 */
function appendChunk(items: ChatItem[], kind: 'agent' | 'thought', text: string, seq: number, ts: number): ChatItem[] {
  if (!text) return items;
  const last = items.length > 0 ? items[items.length - 1] : undefined;
  if (last && last.kind === kind) {
    const merged = { ...last, text: last.text + text } as ChatItem;
    return [...items.slice(0, -1), merged];
  }
  const item = { kind, id: nextId(kind), seq, ts, text } as ChatItem;
  return [...items, item];
}

interface ToolCallLike {
  toolCallId: string;
  title?: string;
  kind?: string;
  status?: string;
  content?: ToolCallContent[];
  locations?: { path: string; line?: number }[];
  _meta?: { 'cognition.ai/inferenceToolName'?: string; [k: string]: unknown };
}

/** tool_call / tool_call_update → 按 toolCallId 合并 */
function upsertToolItem(items: ChatItem[], upd: ToolCallLike, seq: number, ts: number): ChatItem[] {
  const idx = items.findIndex((it) => it.kind === 'tool' && it.toolCallId === upd.toolCallId);
  const prev: ToolItem | undefined = idx >= 0 ? (items[idx] as ToolItem) : undefined;

  const inferenceName = upd._meta?.['cognition.ai/inferenceToolName'];
  const name = upd.kind ?? prev?.name ?? inferenceName ?? upd.title ?? 'tool';
  const diff = diffStats(upd.content);
  const locPaths = Array.isArray(upd.locations)
    ? upd.locations.map((l) => l?.path).filter((p): p is string => typeof p === 'string' && !!p)
    : [];
  const paths = diff.paths.length > 0 ? diff.paths : locPaths.length > 0 ? locPaths : prev?.paths ?? [];
  const detail = contentDetail(upd.content) ?? prev?.detail;

  const next: ToolItem = {
    kind: 'tool',
    id: prev?.id ?? nextId('tool'),
    seq: prev?.seq ?? seq,
    ts,
    toolCallId: upd.toolCallId,
    name: typeof name === 'string' ? name : 'tool',
    title: upd.title ?? prev?.title,
    toolKind: upd.kind ?? prev?.toolKind,
    status: upd.status ?? prev?.status ?? 'pending',
    paths,
    diffAdd: diff.hasDiff ? diff.add : prev?.diffAdd ?? 0,
    diffDel: diff.hasDiff ? diff.del : prev?.diffDel ?? 0,
    hasDiff: diff.hasDiff || (prev?.hasDiff ?? false),
    detail,
  };

  if (idx >= 0) {
    const copy = [...items];
    copy[idx] = next;
    return copy;
  }
  return [...items, next];
}

const PLAN_ITEM_ID = 'plan-current';

function upsertPlanItem(items: ChatItem[], entries: PlanEntry[], seq: number, ts: number): ChatItem[] {
  const idx = items.findIndex((it) => it.kind === 'plan' && it.id === PLAN_ITEM_ID);
  if (idx >= 0) {
    const prev = items[idx] as PlanItem;
    const copy = [...items];
    copy[idx] = { ...prev, entries, ts };
    return copy;
  }
  return [...items, { kind: 'plan', id: PLAN_ITEM_ID, seq, ts, entries }];
}

function appendUserMessage(
  items: ChatItem[],
  text: string,
  seq: number,
  ts: number,
  deviceName?: string,
  clientMsgId?: string,
): ChatItem[] {
  // 幂等: 命中待确认的本地乐观回显 → 原位替换
  if (clientMsgId) {
    const idx = items.findIndex((it) => it.kind === 'user' && it.clientMsgId === clientMsgId);
    if (idx >= 0) {
      const copy = [...items];
      copy[idx] = {
        kind: 'user',
        id: (items[idx] as UserItem).id,
        seq,
        ts,
        text,
        deviceName,
        clientMsgId,
        pending: false,
      };
      return copy;
    }
  }
  return [...items, { kind: 'user', id: nextId('user'), seq, ts, text, deviceName, clientMsgId }];
}

function appendNotice(items: ChatItem[], text: string, tone: NoticeItem['tone'], seq: number, ts: number): ChatItem[] {
  return [...items, { kind: 'notice', id: nextId('notice'), seq, ts, text, tone }];
}

// ---------- 配置/命令数组的宽松校验 ----------

function asConfigOptions(v: unknown): ConfigOption[] | null {
  if (!Array.isArray(v)) return null;
  const out: ConfigOption[] = [];
  for (const it of v) {
    const r = asRecord(it);
    if (r && typeof r.id === 'string' && typeof r.type === 'string') {
      out.push(it as ConfigOption);
    }
  }
  return out.length > 0 || v.length === 0 ? out : null;
}

function asAvailableCommands(v: unknown): AvailableCommand[] | null {
  if (!Array.isArray(v)) return null;
  const out: AvailableCommand[] = [];
  for (const it of v) {
    const r = asRecord(it);
    if (r && typeof r.name === 'string' && typeof r.description === 'string') {
      out.push(it as AvailableCommand);
    }
  }
  return out.length > 0 || v.length === 0 ? out : null;
}

function mergeConfigOptions(prev: ConfigOption[], next: ConfigOption[]): ConfigOption[] {
  const map = new Map<string, ConfigOption>();
  for (const o of prev) map.set(o.id, o);
  for (const o of next) {
    const existing = map.get(o.id);
    if (existing) {
      // 增量更新可能只带 currentValue — 缺省字段沿用已有值, 避免丢 options 列表
      map.set(o.id, {
        ...existing,
        ...o,
        options: Array.isArray(o.options) && o.options.length > 0 ? o.options : existing.options,
        name: o.name ?? existing.name,
        description: o.description ?? existing.description,
        category: o.category ?? existing.category,
      });
    } else {
      map.set(o.id, o);
    }
  }
  return Array.from(map.values());
}

// ---------- 事件应用 ----------

/**
 * 应用单条会话事件 (带 seq 去重)
 * @returns 新状态; 重复/乱序事件返回原状态引用
 */
export function applyEvent(state: ChatState, event: SessionEvent): ChatState {
  if (typeof event.seq !== 'number' || event.seq <= state.maxSeq) {
    return state; // 去重: 每会话 seq 严格递增, 小于等于已见最大 seq 的一律丢弃
  }

  let next: ChatState = { ...state, maxSeq: event.seq };
  let items = next.items;
  const seq = event.seq;
  const ts = event.ts;

  switch (event.kind) {
    case 'user-message': {
      const p = asRecord(event.payload);
      if (p && typeof p.text === 'string') {
        items = appendUserMessage(
          items,
          p.text,
          seq,
          ts,
          typeof p.deviceName === 'string' ? p.deviceName : undefined,
          typeof p.clientMsgId === 'string' ? p.clientMsgId : undefined,
        );
      }
      break;
    }
    case 'acp-update': {
      const u = asAcpUpdate(event.payload);
      if (!u) break;
      switch (u.sessionUpdate) {
        case 'agent_message_chunk':
          items = appendChunk(items, 'agent', extractText(u.content), seq, ts);
          break;
        case 'agent_thought_chunk':
          items = appendChunk(items, 'thought', extractText(u.content), seq, ts);
          break;
        case 'user_message_chunk':
          // 用户消息已由 'user-message' 信封事件回显, 忽略避免重复
          break;
        case 'tool_call':
        case 'tool_call_update':
          items = upsertToolItem(items, u as unknown as ToolCallLike, seq, ts);
          break;
        case 'plan':
          if (Array.isArray(u.entries)) {
            items = upsertPlanItem(items, u.entries as PlanEntry[], seq, ts);
          }
          break;
        case 'usage_update': {
          const meta = asRecord(u._meta);
          next.usage = {
            used: typeof u.used === 'number' ? u.used : undefined,
            size: typeof u.size === 'number' ? u.size : undefined,
            inputTokens: typeof meta?.['cognition.ai/inputTokens'] === 'number' ? (meta['cognition.ai/inputTokens'] as number) : undefined,
            outputTokens: typeof meta?.['cognition.ai/outputTokens'] === 'number' ? (meta['cognition.ai/outputTokens'] as number) : undefined,
          };
          break;
        }
        case 'session_info_update':
          if (typeof u.title === 'string' || u.title === null) {
            next.title = u.title as string | null;
          }
          break;
        case 'config_option_update': {
          const opts = asConfigOptions(u.configOptions);
          if (opts) next.configOptions = mergeConfigOptions(next.configOptions, opts);
          break;
        }
        case 'available_commands_update': {
          const cmds = asAvailableCommands(u.availableCommands);
          if (cmds) next.availableCommands = cmds;
          break;
        }
        case 'current_mode_update':
          if (typeof u.currentModeId === 'string') next.currentModeId = u.currentModeId;
          break;
        default:
          // 未知/未来 update 类型 — 静默忽略保持前向兼容
          break;
      }
      break;
    }
    case 'acp-notification':
      // devin 私有 _cognition.ai/* 通知 — 渲染层不需要, 忽略
      break;
    case 'prompt-result': {
      const p = asRecord(event.payload);
      const stopReason = (p?.stopReason ?? 'end_turn') as StopReason;
      if (stopReason === 'cancelled') {
        items = appendNotice(items, '已停止 — 用户取消', 'info', seq, ts);
      } else if (stopReason === 'max_tokens') {
        items = appendNotice(items, '输出达到 token 上限', 'warn', seq, ts);
      } else if (stopReason === 'refusal') {
        items = appendNotice(items, '模型拒绝了该请求', 'error', seq, ts);
      }
      const usage = asRecord(p?.usage);
      if (usage) {
        next.usage = {
          ...next.usage,
          inputTokens: typeof usage.inputTokens === 'number' ? usage.inputTokens : next.usage?.inputTokens,
          outputTokens: typeof usage.outputTokens === 'number' ? usage.outputTokens : next.usage?.outputTokens,
        };
      }
      if (next.status === 'running' || next.status === 'waiting_permission') {
        next.status = 'idle';
      }
      break;
    }
    case 'session-status': {
      const p = asRecord(event.payload);
      if (p && typeof p.status === 'string') {
        next.status = p.status as SessionMeta['status'];
      }
      if (p && typeof p.error === 'string' && p.error) {
        items = appendNotice(items, p.error, 'error', seq, ts);
      }
      break;
    }
    default:
      break;
  }

  next.items = items;
  return next;
}

// ---------- 快照应用 ----------

export interface SnapshotInput {
  session: SessionMeta;
  events: SessionEvent[];
  acp?: SessionNewResult | null;
  configOptions?: unknown;
  availableCommands?: unknown;
  pendingPermissions: PendingPermission[];
}

/**
 * 应用快照
 * @param reset true = 全量快照 (sinceSeq 0/缺省订阅) 清空重放; false = 断线补拉增量合并
 */
export function applySnapshot(state: ChatState, snap: SnapshotInput, reset: boolean): ChatState {
  let base: ChatState = reset ? initChatState(state.sessionId) : state;

  // 全量重置时保留未确认的乐观用户消息 (服务器尚未回显, 避免闪烁消失)
  const carryOptimistic = reset
    ? state.items.filter((it): it is UserItem => it.kind === 'user' && Boolean(it.pending))
    : [];

  base = {
    ...base,
    meta: snap.session,
    status: snap.session.status,
    title: snap.session.title ?? base.title,
    pendingPermissions: Array.isArray(snap.pendingPermissions) ? snap.pendingPermissions : [],
  };

  // 快照附带的 ACP 会话能力数据
  if (snap.acp) {
    if (snap.acp.modes) {
      base.modes = snap.acp.modes;
      base.currentModeId = snap.acp.modes.currentModeId;
    }
    const acpOpts = asConfigOptions(snap.acp.configOptions);
    if (acpOpts) base.configOptions = mergeConfigOptions(base.configOptions, acpOpts);
  }
  const snapOpts = asConfigOptions(snap.configOptions);
  if (snapOpts) base.configOptions = mergeConfigOptions(base.configOptions, snapOpts);
  const snapCmds = asAvailableCommands(snap.availableCommands);
  if (snapCmds) base.availableCommands = snapCmds;

  // 事件重放/补拉 — 按 seq 排序后逐条走 applyEvent (自带去重)
  const sorted = [...snap.events].sort((a, b) => a.seq - b.seq);
  for (const ev of sorted) {
    base = applyEvent(base, ev);
  }
  // 追加保留的乐观消息 (echo 事件到达时按 clientMsgId 原位替换)
  for (const it of carryOptimistic) {
    const echoExists = base.items.some(
      (x): x is UserItem => x.kind === 'user' && x.clientMsgId === it.clientMsgId,
    );
    if (!echoExists) {
      base = { ...base, items: [...base.items, it] };
    }
  }
  return base;
}

// ---------- 权限 (不走事件流, 由独立消息驱动) ----------

export function addPendingPermission(state: ChatState, perm: PendingPermission): ChatState {
  if (state.pendingPermissions.some((p) => p.requestId === perm.requestId)) return state;
  return { ...state, pendingPermissions: [...state.pendingPermissions, perm] };
}

export function resolvePermission(
  state: ChatState,
  requestId: string,
  info: { byDevice: string; optionId?: string; cancelled?: boolean },
): ChatState {
  return {
    ...state,
    pendingPermissions: state.pendingPermissions.filter((p) => p.requestId !== requestId),
    resolvedBy: { ...state.resolvedBy, [requestId]: info },
  };
}

// ---------- 乐观用户消息 ----------

export function applyOptimisticUserMessage(state: ChatState, text: string, clientMsgId: string): ChatState {
  const item: UserItem = {
    kind: 'user',
    id: nextId('user'),
    seq: -1,
    ts: Date.now(),
    text,
    clientMsgId,
    pending: true,
  };
  return { ...state, items: [...state.items, item] };
}
