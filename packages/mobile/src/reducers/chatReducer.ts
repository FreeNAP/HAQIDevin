/**
 * 会话事件 reducer — append-only 事件流 → 可渲染的聊天状态
 *
 * 设计要点:
 *  - 每会话事件 seq 严格递增 → 新事件去重规则: seq <= maxSeq 的事件丢弃
 *  - 已消化事件保留在 events 数组 (按 seq 升序); 历史翻页拿到更早点序批次后合并并全量重放,
 *    让跨分页边界的流式 chunk / tool_call_update / plan 仍按原始事件顺序正确归并
 *  - applySnapshot(reset=true) 全量重放; (reset=false) 断线补拉增量合并, 复用同一套事件逻辑
 *  - 工具卡片按 toolCallId 合并 tool_call / tool_call_update
 *  - plan 单卡滚动更新; user/agent/thought chunk 向尾部同类 item 追加文本
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
  /** 已加载的原始事件 (按 seq 升序) — 历史向前翻页后用于全量重放, 保证跨批次 chunk/工具卡合并正确 */
  events: SessionEvent[];
  maxSeq: number;
  status: SessionMeta['status'] | 'unknown';
  title: string | null;
  configOptions: ConfigOption[];
  availableCommands: AvailableCommand[];
  modes: ModesInfo | null;
  currentModeId: string | null;
  usage: UsageInfo | null;
  /** 全量快照被 server 限量截断: 本地历史不完整 */
  truncated: boolean;
  /** server 侧事件总数 (truncated 时用于提示) */
  totalEvents: number | null;
  pendingPermissions: PendingPermission[];
  /** permission.resolved 通告: requestId → byDevice, 用于 "已由 XX 处理" 展示 */
  resolvedBy: Record<string, { byDevice: string; optionId?: string; cancelled?: boolean }>;
}

export function initChatState(sessionId: string): ChatState {
  return {
    sessionId,
    meta: null,
    items: [],
    events: [],
    maxSeq: 0,
    status: 'unknown',
    title: null,
    configOptions: [],
    availableCommands: [],
    modes: null,
    currentModeId: null,
    usage: null,
    truncated: false,
    totalEvents: null,
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

/** prompt-result 的 error 字段宽容取文本: server 当前传 string, 兼容 Error 形对象 */
function errorText(v: unknown): string {
  if (typeof v === 'string') return v;
  const r = asRecord(v);
  return r && typeof r.message === 'string' ? r.message : '';
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
function appendChunk(items: ChatItem[], kind: 'agent' | 'thought' | 'user', text: string, seq: number, ts: number): ChatItem[] {
  if (!text) return items;
  const last = items.length > 0 ? items[items.length - 1] : undefined;
  if (last && last.kind === kind) {
    const merged = { ...last, text: last.text + text } as ChatItem;
    return [...items.slice(0, -1), merged];
  }
  // 用首个 chunk 的 seq 生成确定性 id — 历史翻页全量重放后 key 不变, FlatList 不整列重挂载
  const item = { kind, id: `${kind}_seq_${seq}`, seq, ts, text } as ChatItem;
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
    id: prev?.id ?? `tool_${upd.toolCallId}`,
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
  return [...items, { kind: 'user', id: `user_seq_${seq}`, seq, ts, text, deviceName, clientMsgId }];
}

function appendNotice(items: ChatItem[], text: string, tone: NoticeItem['tone'], seq: number, ts: number): ChatItem[] {
  return [...items, { kind: 'notice', id: `notice_seq_${seq}`, seq, ts, text, tone }];
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
 * 入缓存前裁剪事件 — rawInput/rawOutput/acp-notification 不参与渲染重放且可能很大;
 * seq/ts/kind 与渲染所需 payload 原样保留, 避免长会话翻页后移动端内存被原始工具输出拖垮
 */
function eventForCache(event: SessionEvent): SessionEvent {
  if (event.kind === 'acp-notification') {
    return { ...event, payload: null };
  }
  if (event.kind !== 'acp-update') return event;
  const payload = asRecord(event.payload);
  if (!payload || (!('rawInput' in payload) && !('rawOutput' in payload))) return event;
  const copy = { ...payload };
  delete copy.rawInput;
  delete copy.rawOutput;
  return { ...event, payload: copy };
}

/**
 * 事件归约核心 — 不做 seq 去重/事件入缓存。
 * 快照重放与历史翻页全量重放直接走这里; 新到事件请走 exported applyEvent。
 */
function reduceEvent(state: ChatState, event: SessionEvent): ChatState {
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
          // 加载的 devin 历史走 ACP user chunk; live prompt 的 echo 已由 server 过滤, 不会与信封事件双显
          items = appendChunk(items, 'user', extractText(u.content), seq, ts);
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
      } else if (stopReason === 'error') {
        const detail = errorText(p?.error);
        items = appendNotice(items, detail ? `执行出错 — ${detail}` : '执行出错', 'error', seq, ts);
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

/**
 * 应用单条新到会话事件 (带 seq 去重) — 同时写入原始事件缓存。
 * 早于 maxSeq 的历史批次不能走这里 (会被当作重复丢弃), 由 applyHistoryBatch 合并后重放。
 * @returns 新状态; 重复/乱序事件返回原状态引用
 */
export function applyEvent(state: ChatState, event: SessionEvent): ChatState {
  if (typeof event.seq !== 'number' || event.seq <= state.maxSeq) {
    return state; // 去重: 每会话 seq 严格递增, 小于等于已见最大 seq 的一律丢弃
  }
  const cached = eventForCache(event);
  const withEvent: ChatState = { ...state, events: [...state.events, cached] };
  return reduceEvent(withEvent, event);
}

// ---------- 快照应用 ----------

export interface SnapshotInput {
  session: SessionMeta;
  events: SessionEvent[];
  truncated?: boolean;
  totalEvents?: number;
  acp?: SessionNewResult | null;
  configOptions?: unknown;
  availableCommands?: unknown;
  pendingPermissions: PendingPermission[];
}

/** 按 seq 合并事件并升序返回; 同 seq 以已加载事件为准 (事件 append-only, 内容应相同) */
function mergeEventsBySeq(existing: SessionEvent[], incoming: SessionEvent[]): SessionEvent[] {
  const bySeq = new Map<number, SessionEvent>();
  for (const ev of existing) {
    if (typeof ev.seq === 'number') bySeq.set(ev.seq, ev);
  }
  for (const ev of incoming) {
    if (typeof ev.seq === 'number' && !bySeq.has(ev.seq)) bySeq.set(ev.seq, ev);
  }
  return Array.from(bySeq.values()).sort((a, b) => a.seq - b.seq);
}

/** 用一组已按 seq 排序的原始事件重建渲染 items (丢弃 usage/status 等信封, 调用方保留权威现值) */
function replayItems(sessionId: string, events: SessionEvent[]): ChatItem[] {
  let replay = initChatState(sessionId);
  for (const ev of events) {
    replay = reduceEvent(replay, ev);
  }
  return replay.items;
}

/** 乐观用户消息不是服务器事件; 全量重建后按 clientMsgId 去重补回 */
function appendOptimisticItems(items: ChatItem[], optimistic: UserItem[]): ChatItem[] {
  let out = items;
  for (const it of optimistic) {
    const echoExists = out.some(
      (x): x is UserItem => x.kind === 'user' && x.clientMsgId === it.clientMsgId,
    );
    if (!echoExists) out = [...out, it];
  }
  return out;
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

  // 增量快照不截断; 一旦历史缺头, 截断标记保留到下一次全量快照重新判定
  const snapTruncated = snap.truncated === true;
  const truncated = reset ? snapTruncated : base.truncated || snapTruncated;
  // server 当前总会回传 totalEvents; 没有该字段的增量/能力刷新消息则保留原值
  const totalEvents = typeof snap.totalEvents === 'number'
    ? snap.totalEvents
    : truncated
      ? base.totalEvents
      : null;

  base = {
    ...base,
    meta: snap.session,
    status: snap.session.status,
    title: snap.session.title ?? base.title,
    truncated,
    totalEvents,
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

  // 事件重放/补拉 — 按 seq 排序后逐条走 applyEvent (自带去重并写 events 缓存)
  const sorted = [...snap.events].sort((a, b) => a.seq - b.seq);
  for (const ev of sorted) {
    base = applyEvent(base, ev);
  }

  // 全量快照只有最近 400 条; 若本地已向前翻过页, 重置快照不得把已加载的更早点序丢掉。
  // 事件 append-only, 直接按 seq 合并后重放, 分页边界两侧的 chunk/工具卡才能连续归并。
  if (reset && state.events.length > 0) {
    const merged = mergeEventsBySeq(state.events, base.events);
    if (merged.length !== base.events.length) {
      const reachedHead = (merged[0]?.seq ?? 0) <= 1
        || (typeof base.totalEvents === 'number' && merged.length >= base.totalEvents);
      base = {
        ...base,
        events: merged,
        items: replayItems(state.sessionId, merged),
        maxSeq: Math.max(base.maxSeq, merged[merged.length - 1]?.seq ?? 0),
        // 本地一旦经 hasMore=false 判定完整, 后续限量快照自身的 truncated 不得让完整历史重新缺头
        truncated: !state.truncated || reachedHead ? false : base.truncated,
      };
    }
  }

  // 追加保留的乐观消息 (echo 事件到达时按 clientMsgId 原位替换/去重)
  base = { ...base, items: appendOptimisticItems(base.items, carryOptimistic) };
  return base;
}

// ---------- 历史翻页 ----------

/**
 * 合并一批更早的历史事件并重建渲染 items。
 * 这些事件 seq 都小于当前 maxSeq, 不能走 applyEvent 的增量路径; 全量重放是最简单且正确的方案:
 * 跨分页边界的 agent/user chunk 会重新拼接, tool_call_update 会落回较早创建的同一个工具卡。
 * hasMore=false 表示已经翻到会话开头, 本地历史完整, truncated 标记随之清除。
 */
export function applyHistoryBatch(state: ChatState, batchEvents: SessionEvent[], hasMore: boolean): ChatState {
  const valid = batchEvents
    .filter((ev) => ev && ev.sessionId === state.sessionId && typeof ev.seq === 'number')
    .map(eventForCache);
  const seen = new Set(state.events.map((ev) => ev.seq));
  const hasNewEvents = valid.some((ev) => !seen.has(ev.seq));

  if (!hasNewEvents) {
    if (state.truncated === hasMore) return state;
    return { ...state, truncated: hasMore };
  }

  const merged = mergeEventsBySeq(state.events, valid);
  const carryOptimistic = state.items.filter((it): it is UserItem => it.kind === 'user' && Boolean(it.pending));
  const replayed = replayItems(state.sessionId, merged);
  const reachedHead = (merged[0]?.seq ?? 0) <= 1
    || (typeof state.totalEvents === 'number' && merged.length >= state.totalEvents);

  return {
    ...state,
    events: merged,
    items: appendOptimisticItems(replayed, carryOptimistic),
    maxSeq: Math.max(state.maxSeq, merged[merged.length - 1]?.seq ?? 0),
    truncated: hasMore && !reachedHead,
  };
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
