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
  /** 最后一个 thought chunk 的事件时间; ts→endTs 作为思考耗时近似值 */
  endTs?: number;
  text: string;
}

export interface ToolDiffData {
  path: string;
  oldText?: string;
  newText: string;
  linesAdded: number;
  linesRemoved: number;
  fileDeleted: boolean;
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
  inferenceName?: string;
  status: string;
  paths: string[];
  diffAdd: number;
  diffDel: number;
  hasDiff: boolean;
  detail?: string;
  /** execute/bash 类工具的命令全文与输出 (输出优先 rawOutput, 其次 content text) */
  command?: string;
  inputPreview?: string;
  output?: string;
  cwd?: string;
  diffs: ToolDiffData[];
  /** cognition.ai/timestamp 解析出的毫秒时间; 用于 IDE 风格 Worked for Xs */
  startedAtMs?: number;
  finishedAtMs?: number;
  durationMs?: number;
  exitCode?: number | null;
  exitSignal?: string | number | null;
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

function fallbackLineCount(text: string): number {
  if (!text) return 0;
  const lines = text.split('\n');
  return lines.length > 1 && lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
}

/** diff content → 渲染数据; +/- 统计优先使用 devin _meta, 缺失时才按文本行数兜底 */
function extractDiffs(content: ToolCallContent[] | undefined): ToolDiffData[] {
  if (!Array.isArray(content)) return [];
  const out: ToolDiffData[] = [];
  for (const c of content) {
    if (!c || typeof c !== 'object' || c.type !== 'diff') continue;
    if (typeof c.path !== 'string' || !c.path) continue;
    const meta = asRecord(c._meta);
    const newText = typeof c.newText === 'string' ? c.newText : '';
    const oldText = typeof c.oldText === 'string' ? c.oldText : undefined;
    const metaAdd = meta?.['cognition.ai/linesAdded'];
    const metaDel = meta?.['cognition.ai/linesRemoved'];
    out.push({
      path: c.path,
      oldText,
      newText,
      linesAdded: typeof metaAdd === 'number' ? metaAdd : fallbackLineCount(newText),
      linesRemoved: typeof metaDel === 'number' ? metaDel : fallbackLineCount(oldText ?? ''),
      fileDeleted: meta?.['cognition.ai/fileDeleted'] === true,
    });
  }
  return out;
}

function diffStats(diffs: ToolDiffData[]): { add: number; del: number; hasDiff: boolean; paths: string[] } {
  return {
    add: diffs.reduce((n, d) => n + d.linesAdded, 0),
    del: diffs.reduce((n, d) => n + d.linesRemoved, 0),
    hasDiff: diffs.length > 0,
    paths: diffs.map((d) => d.path),
  };
}

/** content[] 中的文本输出原样拼接; 空白/换行对终端输出有意义, 不做 trim */
function extractContentOutput(content: ToolCallContent[] | undefined): string | undefined {
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const c of content) {
    if (!c || typeof c !== 'object') continue;
    if (c.type === 'content' && c.content && typeof c.content.text === 'string' && c.content.text.length > 0) {
      parts.push(c.content.text);
    }
  }
  return parts.length > 0 ? parts.join('\n') : undefined;
}

function contentDetail(content: ToolCallContent[] | undefined): string | undefined {
  const output = extractContentOutput(content);
  if (output?.trim()) {
    const firstLine = output.trim().split('\n')[0] ?? '';
    return firstLine.length > 120 ? firstLine.slice(0, 117) + '…' : firstLine;
  }
  if (!Array.isArray(content)) return undefined;
  for (const c of content) {
    if (!c || typeof c !== 'object') continue;
    if (c.type === 'terminal' && typeof c.terminalId === 'string') {
      return `terminal ${c.terminalId}`;
    }
  }
  return undefined;
}

function clipPreview(text: string, max = 1000): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function rawInputRecord(rawInput: unknown): { record: Record<string, unknown> | null; plainText?: string } {
  if (typeof rawInput === 'string') {
    const trimmed = rawInput.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        const rec = asRecord(parsed);
        if (rec) return { record: rec };
      } catch {
        // 非 JSON 字符串按命令原文处理
      }
    }
    return { record: null, plainText: rawInput };
  }
  return { record: asRecord(rawInput), plainText: undefined };
}

function stringOrJoined(value: unknown): string | undefined {
  if (typeof value === 'string' && value) return value;
  if (Array.isArray(value) && value.every((x) => typeof x === 'string')) return (value as string[]).join(' ');
  return undefined;
}

/** execute 命令全文 + 通用输入摘要; rawInput 在样本中通常是对象, 但兼容 JSON/纯文本字符串 */
function rawInputInfo(rawInput: unknown): { command?: string; preview?: string; cwd?: string } {
  const { record, plainText } = rawInputRecord(rawInput);
  if (!record) {
    return plainText ? { command: plainText, preview: clipPreview(plainText) } : {};
  }
  const cwd = stringOrJoined(record.cwd) ?? stringOrJoined(record.workDir);
  for (const key of ['command', 'cmd']) {
    const command = stringOrJoined(record[key]);
    if (command) return { command, preview: clipPreview(command), cwd };
  }
  for (const key of ['file_path', 'filePath', 'path', 'query', 'url', 'pattern']) {
    const value = stringOrJoined(record[key]);
    if (value) return { preview: clipPreview(value), cwd };
  }
  const parts: string[] = [];
  for (const [key, value] of Object.entries(record).slice(0, 8)) {
    if (typeof value === 'string') parts.push(`${key}: ${clipPreview(value, 160)}`);
    else if (typeof value === 'number' || typeof value === 'boolean') parts.push(`${key}: ${String(value)}`);
  }
  return parts.length > 0 ? { preview: clipPreview(parts.join('\n')), cwd } : { cwd };
}

/** rawOutput 形态在 devin 版本中不稳定: 字符串 / content block / {stdout,stderr} / 普通对象都尽量转文本 */
function rawOutputText(value: unknown, depth = 0): string | undefined {
  if (typeof value === 'string') return value.length > 0 ? value : undefined;
  if (value == null || depth > 3) return undefined;
  if (Array.isArray(value)) {
    const parts = value.map((x) => rawOutputText(x, depth + 1)).filter((x): x is string => Boolean(x));
    return parts.length > 0 ? parts.join('\n') : undefined;
  }
  const rec = asRecord(value);
  if (!rec) return undefined;
  const preferred: string[] = [];
  for (const key of ['output', 'text', 'stdout', 'stderr', 'error', 'message']) {
    const text = stringOrJoined(rec[key]);
    if (text) preferred.push(text);
  }
  if (preferred.length > 0) return preferred.join('\n');
  const nested = rawOutputText(rec.content, depth + 1) ?? rawOutputText(rec.result, depth + 1);
  if (nested) return nested;
  try {
    return clipPreview(JSON.stringify(rec, null, 2), 4000);
  } catch {
    return undefined;
  }
}

function cognitionTimestampMs(meta: unknown): number | undefined {
  const rec = asRecord(meta);
  const value = rec?.['cognition.ai/timestamp'];
  if (typeof value !== 'string') return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

function terminalExitMeta(meta: unknown): { exitCode?: number | null; exitSignal?: string | number | null } {
  const rec = asRecord(meta);
  const terminal = asRecord(rec?.terminal_exit);
  if (!terminal) return {};
  const code = terminal.exit_code;
  const signal = terminal.signal;
  return {
    exitCode: typeof code === 'number' || code === null ? code : undefined,
    exitSignal: typeof signal === 'string' || typeof signal === 'number' || signal === null ? signal : undefined,
  };
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
    if (merged.kind === 'thought') merged.endTs = ts;
    return [...items.slice(0, -1), merged];
  }
  // 用首个 chunk 的 seq 生成确定性 id — 历史翻页全量重放后 key 不变, FlatList 不整列重挂载
  const item = { kind, id: `${kind}_seq_${seq}`, seq, ts, text } as ChatItem;
  if (item.kind === 'thought') item.endTs = ts;
  return [...items, item];
}

interface ToolCallLike {
  sessionUpdate?: string;
  toolCallId: string;
  title?: string;
  kind?: string;
  status?: string;
  content?: ToolCallContent[];
  rawInput?: unknown;
  rawOutput?: unknown;
  locations?: { path: string; line?: number }[];
  _meta?: { 'cognition.ai/inferenceToolName'?: string; [k: string]: unknown };
}

/** 同一路径的后续 diff 视为终态覆盖; 不同路径保留顺序, 支持一次工具调用修改多个文件 */
function mergeDiffData(prev: ToolDiffData[], incoming: ToolDiffData[]): ToolDiffData[] {
  if (incoming.length === 0) return prev;
  if (prev.length === 0) return incoming;
  const order: string[] = [];
  const byPath = new Map<string, ToolDiffData>();
  for (const d of prev) {
    order.push(d.path);
    byPath.set(d.path, d);
  }
  for (const d of incoming) {
    if (!byPath.has(d.path)) order.push(d.path);
    byPath.set(d.path, d);
  }
  return order.map((path) => byPath.get(path)!).filter(Boolean);
}

/** tool_call / tool_call_update → 按 toolCallId 合并 */
function upsertToolItem(items: ChatItem[], upd: ToolCallLike, seq: number, ts: number): ChatItem[] {
  const idx = items.findIndex((it) => it.kind === 'tool' && it.toolCallId === upd.toolCallId);
  const prev: ToolItem | undefined = idx >= 0 ? (items[idx] as ToolItem) : undefined;

  const inferenceName = upd._meta?.['cognition.ai/inferenceToolName'];
  const name = upd.kind ?? prev?.name ?? inferenceName ?? upd.title ?? 'tool';
  const input = rawInputInfo(upd.rawInput);
  const diffs = mergeDiffData(prev?.diffs ?? [], extractDiffs(upd.content));
  const diff = diffStats(diffs);
  const locPaths = Array.isArray(upd.locations)
    ? upd.locations.map((l) => l?.path).filter((p): p is string => typeof p === 'string' && !!p)
    : [];
  const paths = diff.paths.length > 0 ? diff.paths : locPaths.length > 0 ? locPaths : prev?.paths ?? [];
  const detail = contentDetail(upd.content) ?? prev?.detail;
  const output = rawOutputText(upd.rawOutput) ?? extractContentOutput(upd.content) ?? prev?.output;

  const meta = asRecord(upd._meta);
  const metaCwd = meta?.['cognition.ai/cwd'];
  const eventMs = cognitionTimestampMs(upd._meta);
  const status = upd.status ?? prev?.status ?? (upd.sessionUpdate === 'tool_call' ? 'in_progress' : 'pending');
  const terminal = status === 'completed' || status === 'failed';
  const startedAtMs = upd.sessionUpdate === 'tool_call' ? eventMs ?? ts : prev?.startedAtMs;
  const finishedAtMs = terminal ? eventMs ?? ts : prev?.finishedAtMs;
  const durationMs = typeof startedAtMs === 'number' && typeof finishedAtMs === 'number'
    ? Math.max(0, finishedAtMs - startedAtMs)
    : prev?.durationMs;
  const exit = terminalExitMeta(upd._meta);

  const next: ToolItem = {
    kind: 'tool',
    id: prev?.id ?? `tool_${upd.toolCallId}`,
    seq: prev?.seq ?? seq,
    ts,
    toolCallId: upd.toolCallId,
    name: typeof name === 'string' ? name : 'tool',
    title: upd.title ?? prev?.title,
    toolKind: upd.kind ?? prev?.toolKind,
    inferenceName: typeof inferenceName === 'string' ? inferenceName : prev?.inferenceName,
    status,
    paths,
    diffAdd: diff.add,
    diffDel: diff.del,
    hasDiff: diff.hasDiff,
    detail,
    command: input.command ?? prev?.command,
    inputPreview: input.preview ?? prev?.inputPreview,
    output,
    cwd: typeof metaCwd === 'string' && metaCwd ? metaCwd : input.cwd ?? prev?.cwd,
    diffs,
    startedAtMs,
    finishedAtMs,
    durationMs,
    exitCode: exit.exitCode !== undefined ? exit.exitCode : prev?.exitCode,
    exitSignal: exit.exitSignal !== undefined ? exit.exitSignal : prev?.exitSignal,
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

const CACHE_COMMAND_CHARS = 24_000;
const CACHE_OUTPUT_CHARS = 50_000;
const CACHE_SCALAR_CHARS = 1_200;

function capCacheString(text: string, limit: number): string {
  return text.length > limit ? text.slice(0, limit) : text;
}

function cacheStringLimit(key: string | undefined): number {
  if (key === 'command' || key === 'cmd') return CACHE_COMMAND_CHARS;
  if (key === 'content' || key === 'oldText' || key === 'newText') return 4_000;
  return CACHE_SCALAR_CHARS;
}

/** rawInput/rawOutput 的有界副本 — 保留渲染需要的命令/路径/输出, 不把超长写入内容原样塞进历史缓存 */
function cacheBoundedValue(value: unknown, key?: string, depth = 0): unknown {
  if (typeof value === 'string') return capCacheString(value, cacheStringLimit(key));
  if (typeof value === 'number' || typeof value === 'boolean' || value === null) return value;
  if (Array.isArray(value)) {
    if (depth >= 2) return undefined;
    return value.slice(0, 16).map((x) => cacheBoundedValue(x, key, depth + 1)).filter((x) => x !== undefined);
  }
  const rec = asRecord(value);
  if (!rec || depth >= 2) return undefined;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(rec).slice(0, 16)) {
    const cached = cacheBoundedValue(v, k, depth + 1);
    if (cached !== undefined) out[k] = cached;
  }
  return out;
}

function rawInputForCache(value: unknown): unknown {
  if (typeof value === 'string') return capCacheString(value, CACHE_COMMAND_CHARS);
  return cacheBoundedValue(value);
}

function rawOutputForCache(value: unknown): unknown {
  if (typeof value === 'string') return capCacheString(value, CACHE_OUTPUT_CHARS);
  return cacheBoundedValue(value);
}

/**
 * 入缓存前裁剪事件 — acp-notification 不参与渲染重放直接清空;
 * rawInput/rawOutput 现在参与 IDE 风格渲染, 因此保留有界副本而不是整段丢弃,
 * 避免长会话翻页后移动端内存被原始工具输入/输出拖垮
 */
function eventForCache(event: SessionEvent): SessionEvent {
  if (event.kind === 'acp-notification') {
    return { ...event, payload: null };
  }
  if (event.kind !== 'acp-update') return event;
  const payload = asRecord(event.payload);
  if (!payload || (!('rawInput' in payload) && !('rawOutput' in payload))) return event;
  const copy = { ...payload };
  if ('rawInput' in copy) copy.rawInput = rawInputForCache(copy.rawInput);
  if ('rawOutput' in copy) copy.rawOutput = rawOutputForCache(copy.rawOutput);
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
          // 历史批量导出的事件 ts 常常是拉取时间; thought 携带 cognition.ai/timestamp, 用它估算流式思考耗时
          items = appendChunk(items, 'thought', extractText(u.content), seq, cognitionTimestampMs(u._meta) ?? ts);
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
