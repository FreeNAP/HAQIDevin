/**
 * 对话页 (核心) — 对照 mockup 界面 2/3
 *  - 顶栏: ‹ 返回 + 标题 + 模式/模型 pill (点击弹选择器) + context 用量
 *  - 消息流: 用户黑底靠右 / agent 白底黑框靠左 markdown / thought 折叠 / 工具卡 / plan 卡
 *  - 流式中 agent 气泡朱红边框 + 闪烁光标
 *  - 权限请求: 审批卡悬浮于输入栏上方, 竖排选项, 他端处理显示 "已由 XX 处理"
 *  - 进入订阅 session.subscribe (sinceSeq 补拉), 离开 unsubscribe
 */
import React from 'react';
import {
  View,
  FlatList,
  Pressable,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
  Keyboard,
  Alert,
  BackHandler,
  ActivityIndicator,
  Clipboard,
  Modal,
  ScrollView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { colors } from '../../src/theme/colors';
import { T, M } from '../../src/components/ui';
import { useChatStore } from '../../src/store/chat';
import { useSessionsStore } from '../../src/store/sessions';
import { useConnectionStore } from '../../src/store/connection';
import { client } from '../../src/ws/client';
import {
  UserBubble,
  AgentBubble,
  ThoughtCard,
  ToolCallCard,
  PlanCard,
  NoticeRow,
} from '../../src/components/chat-items';
import { PermissionCard } from '../../src/components/PermissionCard';
import { Composer, ComposerHandle } from '../../src/components/Composer';
import { ideColors } from '../../src/components/ide-tool-cards';
import { ConfigPickerModal } from '../../src/components/ConfigPickerModal';
import { FileExplorerSidebar } from '../../src/components/FileExplorerSidebar';
import { initChatState, ChatItem } from '../../src/reducers/chatReducer';
import type { ConfigOption } from '../../src/protocol/acp';
import { PendingAttachment, toWireAttachments, hasImageAttachment } from '../../src/util/attachments';

interface MessageActionTarget {
  itemId: string;
  kind: 'user' | 'agent';
  title: string;
  text: string;
}

interface HistoryPageResult {
  loadedCount: number;
  hasMore: boolean;
}

interface TimelineBucket {
  key: string;
  startTs: number;
  firstTs: number;
  lastTs: number;
  count: number;
}

interface ScrollToIndexFailedInfo {
  index: number;
  highestMeasuredFrameIndex: number;
  averageItemLength: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function startOfDay(ts: number): number {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

function formatDate(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}/${pad2(d.getMonth() + 1)}/${pad2(d.getDate())}`;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/** 从已加载 items 汇总日期锚点; firstTs 用作跳到某天开头的目标 */
function buildTimelineBuckets(items: ChatItem[]): TimelineBucket[] {
  const map = new Map<string, TimelineBucket>();
  for (const item of items) {
    if (typeof item.ts !== 'number' || item.ts <= 0) continue;
    const startTs = startOfDay(item.ts);
    const key = `${startTs}`;
    const cur = map.get(key);
    if (cur) {
      cur.firstTs = Math.min(cur.firstTs, item.ts);
      cur.lastTs = Math.max(cur.lastTs, item.ts);
      cur.count += 1;
    } else {
      map.set(key, { key, startTs, firstTs: item.ts, lastTs: item.ts, count: 1 });
    }
  }
  return Array.from(map.values()).sort((a, b) => b.startTs - a.startTs);
}

/**
 * items 按 seq 排列而非严格按 ts 排列 (工具卡会原地更新 ts), 因此不用二分;
 * 直接扫描找 ts 最接近者 — 千级消息量成本可忽略且不受乱序 ts 影响
 */
function nearestItemIndexByTs(items: ChatItem[], targetTs: number): number {
  if (items.length === 0) return -1;
  let best = 0;
  let bestDiff = Number.POSITIVE_INFINITY;
  for (let i = 0; i < items.length; i += 1) {
    const diff = Math.abs(items[i]!.ts - targetTs);
    if (diff < bestDiff) {
      best = i;
      bestDiff = diff;
    }
  }
  return best;
}

const REASK_CONTEXT_MAX_CHARS = 7000;
const REASK_SINGLE_ITEM_MAX_CHARS = 1200;

function clipReaskText(text: string, maxChars: number): string {
  const clean = text.trim();
  return clean.length > maxChars ? `${clean.slice(0, maxChars - 1)}…` : clean;
}

/**
 * revert 降级分支 prompt — server 尚未暴露 devin 私有 revert ACP 时:
 * 复制目标用户消息之前的最近对话上下文, 在新会话中重新提出该问题。
 * 只带 user/agent 文本; 工具执行细节与图片附件无法从历史事件中无损复原, 明确标注为摘要上下文。
 */
function buildReaskPrompt(items: ChatItem[], targetItemId: string): string | null {
  const targetIndex = items.findIndex((it) => it.id === targetItemId);
  if (targetIndex < 0) return null;
  const target = items[targetIndex]!;
  if (target.kind !== 'user' || !target.text.trim()) return null;

  const lines: string[] = [];
  for (const it of items.slice(0, targetIndex)) {
    if ((it.kind !== 'user' && it.kind !== 'agent') || !it.text.trim()) continue;
    const role = it.kind === 'user' ? '用户' : 'Agent';
    lines.push(`${role}: ${clipReaskText(it.text, REASK_SINGLE_ITEM_MAX_CHARS)}`);
  }
  const question = target.text.trim();
  if (lines.length === 0) return question;

  const selected = lines.slice(-12);
  while (selected.length > 1 && selected.join('\n\n').length > REASK_CONTEXT_MAX_CHARS) {
    selected.shift();
  }
  let context = selected.join('\n\n');
  if (context.length > REASK_CONTEXT_MAX_CHARS) {
    context = `${context.slice(0, REASK_CONTEXT_MAX_CHARS - 40)}\n…[更早上下文已省略]`;
  }
  return [
    '以下是从另一个会话复制的上下文摘要。请先利用这些上下文理解背景, 然后重新回答最后的用户问题; 不要复述本说明。',
    '',
    '[上下文摘要]',
    context,
    '',
    '[需要重新回答的用户问题]',
    question,
  ].join('\n');
}

function renderItem(
  item: ChatItem,
  streamingAgentId: string | null,
  onMessageLongPress: (item: ChatItem) => void,
  sessionCwd: string,
) {
  switch (item.kind) {
    case 'user':
      return <UserBubble item={item} onLongPress={() => onMessageLongPress(item)} />;
    case 'agent':
      return <AgentBubble item={item} streaming={item.id === streamingAgentId} onLongPress={() => onMessageLongPress(item)} />;
    case 'thought':
      return <ThoughtCard item={item} />;
    case 'tool':
      return <ToolCallCard item={item} cwd={sessionCwd} />;
    case 'plan':
      return <PlanCard item={item} />;
    case 'notice':
      return <NoticeRow item={item} />;
    default:
      return null;
  }
}

/** 从 configOptions 提取 category 匹配的 select 配置 */
function findConfig(configOptions: ConfigOption[], category: string): ConfigOption | null {
  const byCategory = configOptions.find((o) => o.category === category && o.type === 'select');
  if (byCategory) return byCategory;
  // 兜底: id 直接匹配 (devin 的 configOptions id 常为 'mode'/'model')
  return configOptions.find((o) => o.id === category) ?? null;
}

function currentValueName(option: ConfigOption | null): string | null {
  if (!option) return null;
  const cur = option.currentValue;
  if (!cur) return null;
  return option.options?.find((o) => o.value === cur)?.name ?? cur;
}

function formatUsage(used?: number, size?: number): string | null {
  if (typeof used !== 'number' || typeof size !== 'number' || size <= 0) return null;
  const fmt = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : `${n}`);
  return `${fmt(used)}/${fmt(size)}`;
}

/**
 * 当前模型是否支持图片 — 契约: configOptions 里 cognition.ai/supportsImages 为 false 时不支持
 * 检查当前选中 option value 的 _meta 与配置项本身的 _meta, 缺省视为支持 (不阻塞发送)
 */
function currentModelSupportsImages(modelOption: ConfigOption | null): boolean {
  if (!modelOption) return true;
  const cur = modelOption.options?.find((o) => o.value === modelOption.currentValue);
  const valueFlag = cur?._meta?.['cognition.ai/supportsImages'];
  const optionFlag = modelOption._meta?.['cognition.ai/supportsImages'];
  return valueFlag !== false && optionFlag !== false;
}

export default function ChatPage() {
  const insets = useSafeAreaInsets();
  const params = useLocalSearchParams<{ id: string }>();
  const sessionId = typeof params.id === 'string' ? decodeURIComponent(params.id) : '';

  const chat = useChatStore((s) => (sessionId ? s.bySession[sessionId] : undefined));
  const meta = useSessionsStore((s) => (sessionId ? s.sessions[sessionId] : undefined));
  const phase = useConnectionStore((s) => s.phase);

  const [pickerTarget, setPickerTarget] = React.useState<'mode' | 'model' | null>(null);
  const [resolvedFlash, setResolvedFlash] = React.useState<{ requestId: string; byDevice: string; key: number } | null>(null);
  const [explorerOpen, setExplorerOpen] = React.useState(false);
  const [timelineOpen, setTimelineOpen] = React.useState(false);
  const [historyLoading, setHistoryLoading] = React.useState(false);
  const [historyError, setHistoryError] = React.useState<string | null>(null);
  const [timelineJumping, setTimelineJumping] = React.useState(false);
  const [forking, setForking] = React.useState(false);
  const [revertSteps, setRevertSteps] = React.useState<import('../../src/protocol/wire').RevertStepInfo[] | null>(null);
  const [revertOpen, setRevertOpen] = React.useState(false);
  const [revertLoading, setRevertLoading] = React.useState(false);
  const [revertBusy, setRevertBusy] = React.useState(false);
  const [messageAction, setMessageAction] = React.useState<MessageActionTarget | null>(null);
  const [copyFlash, setCopyFlash] = React.useState(false);
  const [highlightItemId, setHighlightItemId] = React.useState<string | null>(null);
  const prevPendingIds = React.useRef<string[]>([]);

  const listRef = React.useRef<FlatList<ChatItem>>(null);
  const composerRef = React.useRef<ComposerHandle>(null);
  const historyRequestRef = React.useRef<Promise<HistoryPageResult | null> | null>(null);
  const mountedRef = React.useRef(true);
  const copyTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const highlightTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const scrollRetryRef = React.useRef(new Map<number, number>());
  const forkingRef = React.useRef(false);

  React.useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    };
  }, []);

  /**
   * 向上翻一页历史 — 组件级共享在途 Promise:
   * onEndReached 与时间线跳转可能同时触发, 共享同一个请求而不是并发重复拉取
   */
  const loadEarlier = React.useCallback(async (): Promise<HistoryPageResult | null> => {
    if (historyRequestRef.current) return historyRequestRef.current;

    const run = async (): Promise<HistoryPageResult | null> => {
      const cur = useChatStore.getState().bySession[sessionId];
      if (!cur || !cur.truncated) return { loadedCount: 0, hasMore: false };
      const beforeSeq = cur.events[0]?.seq;
      if (!beforeSeq || beforeSeq <= 1) return { loadedCount: 0, hasMore: false };

      if (mountedRef.current) {
        setHistoryLoading(true);
        setHistoryError(null);
      }
      try {
        const batch = await client.requestSessionHistory(sessionId, beforeSeq, 200);
        useChatStore.getState().applyHistoryPage(batch.sessionId, batch.events, batch.hasMore);
        return { loadedCount: batch.events.length, hasMore: batch.hasMore };
      } catch (err) {
        if (mountedRef.current) {
          setHistoryError(err instanceof Error ? err.message : '历史加载失败');
        }
        return null;
      } finally {
        if (mountedRef.current) setHistoryLoading(false);
      }
    };

    const request = Promise.resolve().then(run);
    historyRequestRef.current = request;
    // 必须覆盖所有早退路径; 否则“本无更多历史”的一次调用会把在途锁永久卡死
    void request.then(
      () => {
        if (historyRequestRef.current === request) historyRequestRef.current = null;
      },
      () => {
        if (historyRequestRef.current === request) historyRequestRef.current = null;
      },
    );
    return request;
  }, [sessionId]);

  // 订阅生命周期
  React.useEffect(() => {
    if (!sessionId) return;
    useChatStore.getState().ensure(sessionId);
    client.subscribe(sessionId);
    return () => {
      client.unsubscribe(sessionId);
    };
  }, [sessionId]);

  // 键盘弹起时消息列表自动滚到底 (inverted 列表 offset 0 即底部)
  React.useEffect(() => {
    const event = Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow';
    const sub = Keyboard.addListener(event, () => {
      requestAnimationFrame(() => listRef.current?.scrollToOffset({ offset: 0, animated: true }));
    });
    return () => sub.remove();
  }, []);

  // 侧栏打开时拦截安卓硬件返回 — 关闭面板而非退出页面
  // (后注册先触发, 优先于 expo-router 的返回导航)
  React.useEffect(() => {
    if (!explorerOpen) return;
    const sub = BackHandler.addEventListener('hardwareBackPress', () => {
      setExplorerOpen(false);
      return true;
    });
    return () => sub.remove();
  }, [explorerOpen]);

  const state = chat ?? initChatState(sessionId);

  // 权限消失检测 → 若为他端/本机处理完成, 闪现 "已由 XX 处理"
  React.useEffect(() => {
    const cur = state.pendingPermissions.map((p) => p.requestId);
    const disappeared = prevPendingIds.current.filter((id) => !cur.includes(id));
    if (disappeared.length > 0) {
      const id = disappeared[0]!;
      const info = state.resolvedBy[id];
      if (info) {
        setResolvedFlash({ requestId: id, byDevice: info.byDevice, key: Date.now() });
        const timer = setTimeout(() => setResolvedFlash(null), 6000);
        prevPendingIds.current = cur;
        return () => clearTimeout(timer);
      }
    }
    prevPendingIds.current = cur;
    return undefined;
  }, [state.pendingPermissions, state.resolvedBy]);

  const running = state.status === 'running' || state.status === 'waiting_permission';

  // 流式光标: 仅当会话在跑且尾部是 agent 气泡
  const lastItem = state.items.length > 0 ? state.items[state.items.length - 1] : undefined;
  const streamingAgentId = running && lastItem?.kind === 'agent' ? lastItem.id : null;

  const modeOption = findConfig(state.configOptions, 'mode');
  const modelOption = findConfig(state.configOptions, 'model');
  const modeName =
    currentValueName(modeOption) ??
    state.modes?.availableModes.find((m) => m.id === state.currentModeId)?.name ??
    meta?.modeId ??
    null;
  const modelName = currentValueName(modelOption) ?? meta?.modelId ?? null;

  const title = state.title ?? meta?.title ?? '未命名会话';
  // 资源管理器根 — 优先 chat store 快照里的 session.meta.cwd, 回退会话列表 meta
  const cwd = state.meta?.cwd ?? meta?.cwd ?? '';
  const usageText = formatUsage(state.usage?.used, state.usage?.size);
  const truncatedText = state.truncated
    ? `仅显示最近部分历史${typeof state.totalEvents === 'number' ? `（共 ${state.totalEvents} 条事件）` : ''}`
    : null;

  const reversed = React.useMemo(() => [...state.items].reverse(), [state.items]);
  const firstPending = state.pendingPermissions[0] ?? null;

  // 模式选择器数据源: 优先 configOptions (set_config_option), 无则用 ACP modes 合成 (set_mode)
  const synthModeOption: ConfigOption | null = React.useMemo(() => {
    if (modeOption || !state.modes) return null;
    return {
      id: '__mode__',
      name: 'Mode',
      type: 'select',
      currentValue: state.currentModeId ?? state.modes.currentModeId,
      options: state.modes.availableModes.map((m) => ({ value: m.id, name: m.name, description: m.description })),
    } as ConfigOption;
  }, [modeOption, state.modes, state.currentModeId]);

  const pickerOption =
    pickerTarget === 'mode'
      ? modeOption ?? synthModeOption
      : pickerTarget === 'model'
        ? modelOption
        : null;

  const timelineBuckets = React.useMemo(() => buildTimelineBuckets(state.items), [state.items]);
  const oldestLoadedTs = state.events[0]?.ts ?? state.items[0]?.ts ?? null;
  const newestLoadedTs = state.items[state.items.length - 1]?.ts ?? null;

  /** 历史翻页门控 — RN FlatList 的 onEndReached 在内容不足一屏时挂载即触发, 会形成自动连续翻页链;
   *  改为 onScroll 用户真实滚动驱动: 滚近最旧端才触发, 触发后解除武装, 离开顶部区域再进入才重新允许 */
  const userDraggedRef = React.useRef(false);
  const lastLoadTsRef = React.useRef(0);
  const historyArmedRef = React.useRef(true);
  const onListScroll = React.useCallback((e: { nativeEvent: { contentOffset: { y: number }; contentSize: { height: number }; layoutMeasurement: { height: number } } }) => {
    const { contentOffset, contentSize, layoutMeasurement } = e.nativeEvent;
    const distFromOldest = contentSize.height - (contentOffset.y + layoutMeasurement.height);
    if (distFromOldest > 500) {
      historyArmedRef.current = true;
      return;
    }
    if (!userDraggedRef.current || !historyArmedRef.current) return;
    const cur = useChatStore.getState().bySession[sessionId];
    if (!cur?.truncated || historyLoading || historyError) return;
    if (Date.now() - lastLoadTsRef.current < 1200) return; // prepend 布局稳定冷却, 防连锁触发
    historyArmedRef.current = false;
    lastLoadTsRef.current = Date.now();
    void loadEarlier();
  }, [sessionId, historyLoading, historyError, loadEarlier]);
  const onListDragBegin = React.useCallback(() => {
    userDraggedRef.current = true;
  }, []);

  const onMessageLongPress = React.useCallback((item: ChatItem) => {
    if ((item.kind !== 'user' && item.kind !== 'agent') || !item.text.trim()) return;
    setMessageAction({
      itemId: item.id,
      kind: item.kind,
      title: item.kind === 'user' ? '用户消息' : 'Agent 消息',
      text: item.text,
    });
  }, []);

  const copyMessageAction = React.useCallback(() => {
    if (!messageAction) return;
    Clipboard.setString(messageAction.text);
    setMessageAction(null);
    if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    setCopyFlash(true);
    copyTimerRef.current = setTimeout(() => {
      if (mountedRef.current) setCopyFlash(false);
    }, 1600);
  }, [messageAction]);

  /**
   * “从此处重新提问”降级实现 — devin 二进制里确有私有 revert ACP, 但 server 当前未暴露;
   * 因此新建同 cwd 会话, 复制目标问题前的文本上下文并重发该问题 (不动原会话/文件)
   */
  const reaskFromMessage = React.useCallback(async (target: MessageActionTarget) => {
    if (forkingRef.current) return;
    setMessageAction(null);
    if (!client.isAuthed()) {
      Alert.alert('无法创建分支', '当前未连接到主机');
      return;
    }
    if (!cwd) {
      Alert.alert('无法创建分支', '会话工作目录尚未加载, 请稍后重试');
      return;
    }
    const cur = useChatStore.getState().bySession[sessionId];
    const prompt = cur ? buildReaskPrompt(cur.items, target.itemId) : null;
    if (!prompt) {
      Alert.alert('无法定位该消息', '历史翻页重建后消息已变化, 请重新长按目标消息');
      return;
    }
    forkingRef.current = true;
    setForking(true);
    try {
      const created = await client.createSession(cwd);
      const sent = client.sendPrompt(created.sessionId, prompt);
      if (!sent) throw new Error('连接已断开, 未能发送分支问题');
      router.push(`/session/${encodeURIComponent(created.sessionId)}`);
    } catch (err) {
      Alert.alert('创建分支失败', err instanceof Error ? err.message : '请稍后重试');
    } finally {
      forkingRef.current = false;
      if (mountedRef.current) setForking(false);
    }
  }, [cwd, sessionId]);

  /** 真实回撤: 拉步骤列表 — server a0cf964 起透传 devin 私有 ACP cognition.ai/revert/listSteps */
  const openRevertSteps = React.useCallback(async () => {
    if (revertLoading) return;
    setMessageAction(null);
    if (!client.isAuthed()) {
      Alert.alert('无法回撤', '当前未连接到主机');
      return;
    }
    setRevertLoading(true);
    try {
      const res = await client.revertListSteps(sessionId);
      const steps = (res.steps ?? []).filter((st) => st.forkTargetNodeId);
      if (steps.length === 0) {
        Alert.alert('暂无可回撤步骤', res.steps === null ? 'agent 不支持或未返回步骤' : '步骤缺少分叉节点');
        return;
      }
      setRevertSteps(steps);
      setRevertOpen(true);
    } catch (err) {
      Alert.alert('回撤不可用', err instanceof Error ? err.message : '请稍后重试');
    } finally {
      if (mountedRef.current) setRevertLoading(false);
    }
  }, [sessionId, revertLoading]);

  /** 真实回撤: 从选定步骤分叉新会话(不动原会话与文件以外状态) */
  const forkFromStep = React.useCallback(async (step: import('../../src/protocol/wire').RevertStepInfo) => {
    if (revertBusy || !step.forkTargetNodeId) return;
    setRevertBusy(true);
    try {
      const res = await client.revertFork(sessionId, step.forkTargetNodeId);
      if (!res.forkedSessionId) throw new Error('agent 未返回分叉会话 id');
      setRevertOpen(false);
      router.push(`/session/${encodeURIComponent(res.forkedSessionId)}`);
    } catch (err) {
      Alert.alert('分叉失败', err instanceof Error ? err.message : '请稍后重试');
    } finally {
      if (mountedRef.current) setRevertBusy(false);
    }
  }, [sessionId, revertBusy]);

  /** 高亮并滚动到 items 中的目标 — inverted data 是逆序, FlatList index 需要倒算 */
  const focusItem = React.useCallback((itemId: string): boolean => {
    const cur = useChatStore.getState().bySession[sessionId];
    if (!cur) return false;
    const itemIndex = cur.items.findIndex((it) => it.id === itemId);
    if (itemIndex < 0) return false;
    const listIndex = cur.items.length - 1 - itemIndex;
    scrollRetryRef.current.delete(listIndex);
    if (highlightTimerRef.current) clearTimeout(highlightTimerRef.current);
    setHighlightItemId(itemId);
    // 历史批次刚注入时先让一帧渲染完成; scrollToIndex 对未渲染行的失败由 onScrollToIndexFailed 近似兜底
    setTimeout(() => {
      listRef.current?.scrollToIndex({ index: listIndex, animated: true, viewPosition: 0.5 });
    }, 120);
    highlightTimerRef.current = setTimeout(() => {
      if (mountedRef.current) setHighlightItemId(null);
    }, 2800);
    return true;
  }, [sessionId]);

  /**
   * scrollToIndex 对高度不等且未渲染的行不可靠 — RN 官方兜底:
   * 先按平均高度滚到近似位置, 渲染出目标附近后再重试; 最多 2 次, 之后保留近似位置+高亮
   */
  const onScrollToIndexFailed = React.useCallback((info: ScrollToIndexFailedInfo) => {
    const attempts = (scrollRetryRef.current.get(info.index) ?? 0) + 1;
    scrollRetryRef.current.set(info.index, attempts);
    const approximateOffset = Math.max(0, info.averageItemLength * info.index);
    listRef.current?.scrollToOffset({ offset: approximateOffset, animated: false });
    if (attempts <= 2) {
      setTimeout(() => {
        listRef.current?.scrollToIndex({ index: info.index, animated: true, viewPosition: 0.5 });
      }, 140);
    }
  }, []);

  /**
   * 时间线定位 — 若目标时间早于已加载范围, 先逐页向前回溯;
   * 完成后按 ts 找最近 item 并滚动到近似/精确位置
   */
  const jumpToTimestamp = React.useCallback(async (targetTs: number) => {
    setTimelineOpen(false);
    const initial = useChatStore.getState().bySession[sessionId];
    if (!initial || initial.items.length === 0) return;
    setTimelineJumping(true);
    let failed = false;
    try {
      const totalEvents = initial.totalEvents ?? Math.max(initial.events.length, 400);
      const maxPages = Math.min(100, Math.max(4, Math.ceil(totalEvents / 200) + 2));
      let pages = 0;
      while (pages < maxPages) {
        const cur = useChatStore.getState().bySession[sessionId];
        if (!cur) break;
        const oldestTs = cur.events[0]?.ts ?? cur.items[0]?.ts ?? 0;
        if (!cur.truncated || oldestTs <= targetTs) break;
        const beforeSeq = cur.events[0]?.seq ?? 0;
        const page = await loadEarlier();
        if (!page) {
          failed = true;
          break;
        }
        pages += 1;
        const after = useChatStore.getState().bySession[sessionId];
        const afterSeq = after?.events[0]?.seq ?? beforeSeq;
        if (!page.hasMore || page.loadedCount === 0 || afterSeq >= beforeSeq) break;
      }

      const finalState = useChatStore.getState().bySession[sessionId];
      if (!finalState) return;
      // targetTs=0 是“会话开头”语义: 直接取首个 item, 避免工具卡 ts 被后续 update 改写后误选第二条
      const itemIndex = targetTs <= 0
        ? (finalState.items.length > 0 ? 0 : -1)
        : nearestItemIndexByTs(finalState.items, targetTs);
      if (itemIndex >= 0) {
        focusItem(finalState.items[itemIndex]!.id);
      }
      if (failed) {
        Alert.alert('历史回溯失败', '已定位到当前已加载的最接近消息; 可上翻后重试');
      }
    } finally {
      if (mountedRef.current) setTimelineJumping(false);
    }
  }, [sessionId, loadEarlier, focusItem]);

  /**
   * 发送 — 组装契约 v2 attachments 随 session.prompt 发出
   * 返回 false 让 Composer 保留现场 (模型不支持图片时拦截)
   */
  const onSend = React.useCallback((text: string, attachments: PendingAttachment[]): boolean => {
    if (hasImageAttachment(attachments) && !currentModelSupportsImages(modelOption)) {
      Alert.alert(
        '当前模型不支持图片',
        '请切换到 SWE-1.6 Slow 或移除图片后再发送',
        [{ text: '知道了', style: 'cancel' }],
      );
      return false;
    }
    // 纯附件无文字时合成占位文本, 保证 agent 有文本上下文且回声气泡内容一致
    const finalText = text || (attachments.length > 0 ? `[附件] ${attachments.map((a) => a.fileName).join(', ')}` : '');
    if (!finalText) return false;
    const wire = toWireAttachments(attachments);
    const id = client.sendPrompt(sessionId, finalText, wire.length > 0 ? wire : undefined);
    return id !== null;
  }, [sessionId, modelOption]);

  return (
    // Android 端 keyboardVerticalOffset/behavior 保持 undefined:
    // app.json softwareKeyboardLayoutMode=pan 让系统平移窗口, Expo Go 的 adjustResize 直接压缩布局,
    // 两种模式下 composer 均不被遮挡; JS 侧再做 height 补偿会造成双重上移
    <KeyboardAvoidingView
      style={{ flex: 1, backgroundColor: '#111114' }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={0}
    >
      <StatusBar style="light" />
      <View style={[styles.page, { paddingTop: insets.top }]}>
        {/* 顶栏 */}
        <View style={styles.chatBar}>
          <Pressable onPress={() => router.back()} hitSlop={12} style={styles.backBtn}>
            <T size={21} weight="regular" color={ideColors.text}>‹</T>
          </Pressable>
          <View style={styles.chatBarMain}>
            <T size={13} weight="bold" ls={-0.1} numberOfLines={1} color={ideColors.text}>
              {title}
            </T>
            <View style={styles.pillsRow}>
              {modeName && (
                <Pressable onPress={() => setPickerTarget('mode')} style={styles.pill}>
                  <M size={8.5} color={ideColors.text} uppercase ls={0.4}>{modeName}</M>
                </Pressable>
              )}
              {modelName && (
                <Pressable onPress={() => setPickerTarget('model')} style={styles.pill}>
                  <M size={8.5} color={ideColors.text} uppercase ls={0.4}>{modelName}</M>
                </Pressable>
              )}
              {!modeName && !modelName && (
                <M size={8.5} color={ideColors.faint}>…</M>
              )}
            </View>
          </View>
          {usageText && (
            <M size={9} color={ideColors.faint} style={{ marginLeft: 6 }}>
              {usageText}
            </M>
          )}
          {/* 时间线入口 — 按日期/快捷时间点定位 */}
          <Pressable
            onPress={() => {
              Keyboard.dismiss();
              setTimelineOpen(true);
            }}
            hitSlop={10}
            disabled={state.items.length === 0}
            style={[styles.explorerBtn, timelineOpen && { backgroundColor: ideColors.blue }, state.items.length === 0 && { opacity: 0.3 }]}
            accessibilityLabel="打开时间线"
          >
            <M size={10.5} weight="bold" color={timelineOpen ? '#fff' : ideColors.text}>时</M>
          </Pressable>
          {/* 资源管理器入口 — 有 cwd 才可用 (快照未到时禁用) */}
          <Pressable
            onPress={() => {
              if (!cwd) return;
              Keyboard.dismiss();
              setExplorerOpen(true);
            }}
            hitSlop={10}
            style={[styles.explorerBtn, explorerOpen && { backgroundColor: ideColors.blue }, !cwd && { opacity: 0.3 }]}
            accessibilityLabel="打开文件面板"
          >
            <M size={12} weight="bold" color={explorerOpen ? '#fff' : ideColors.text}>▤</M>
          </Pressable>
          <View style={[styles.statusDot, { backgroundColor: running ? colors.acc : ideColors.faint }]} />
        </View>

        {/* 历史截断提示 */}
        {truncatedText && (
          <View style={styles.truncatedBar}>
            <T size={10.5} color={ideColors.dim}>
              {truncatedText}
            </T>
          </View>
        )}

        {/* 断线提示 */}
        {phase !== 'authed' && (
          <Pressable style={styles.offlineBar} onPress={() => router.push('/connect')}>
            <T size={10.5} weight="semibold" color={colors.acc}>
              {phase === 'connecting' ? '连接中断 — 正在重连, 消息将自动补拉' : '未连接 — 点击去连接'}
            </T>
          </Pressable>
        )}

        {/* 时间线回溯中提示 */}
        {timelineJumping && (
          <View style={styles.jumpBar}>
            <ActivityIndicator size="small" color={colors.acc} />
            <T size={10.5} weight="semibold" color={ideColors.dim} style={{ marginLeft: 7 }}>
              正在回溯历史并定位…
            </T>
          </View>
        )}

        {/* revert 降级分支创建中 */}
        {forking && (
          <View style={styles.jumpBar}>
            <ActivityIndicator size="small" color={colors.acc} />
            <T size={10.5} weight="semibold" color={ideColors.dim} style={{ marginLeft: 7 }}>
              正在创建新会话并复制上下文…
            </T>
          </View>
        )}

        {/* 消息流 */}
        <FlatList
          ref={listRef}
          style={{ flex: 1 }}
          contentContainerStyle={styles.flowContent}
          data={reversed}
          inverted
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => (
            <View style={item.id === highlightItemId ? styles.highlightWrap : undefined}>
              {renderItem(item, streamingAgentId, onMessageLongPress, cwd)}
            </View>
          )}
          maintainVisibleContentPosition={{ minIndexForVisible: 0 }}
          onScroll={onListScroll}
          scrollEventThrottle={200}
          onScrollBeginDrag={onListDragBegin}
          onScrollToIndexFailed={onScrollToIndexFailed}
          ListFooterComponent={
            state.items.length > 0 ? (
              <View style={styles.historyFooter}>
                {historyLoading ? (
                  <View style={styles.historyLoadingRow}>
                    <ActivityIndicator size="small" color={colors.acc} />
                    <M size={9.5} color={ideColors.faint} style={{ marginLeft: 7 }}>
                      正在加载更早历史…
                    </M>
                  </View>
                ) : historyError ? (
                  <Pressable onPress={() => void loadEarlier()} hitSlop={8}>
                    <M size={9.5} weight="bold" color={colors.acc} style={{ textAlign: 'center' }}>
                      历史加载失败 — 点击重试
                    </M>
                    <M size={8.5} color={ideColors.faint} numberOfLines={1} style={{ marginTop: 3, textAlign: 'center' }}>
                      {historyError}
                    </M>
                  </Pressable>
                ) : state.truncated ? (
                  <M size={9.5} color={ideColors.faint}>
                    继续上翻加载更早历史
                  </M>
                ) : (
                  <M size={9.5} color={ideColors.faint}>
                    — 已到会话开头 —
                  </M>
                )}
              </View>
            ) : null
          }
          ListEmptyComponent={
            <View style={styles.emptyWrap}>
              {/* inverted 列表里这个组件是上下翻转的, 用 transform 翻回来 */}
              <View style={{ transform: [{ scaleY: -1 }] }}>
                <T size={11.5} color={ideColors.faint} style={{ textAlign: 'center' }}>
                  {phase === 'authed' ? '加载会话历史…' : '等待连接…'}
                </T>
              </View>
            </View>
          }
          keyboardShouldPersistTaps="handled"
        />

        {/* 他端处理通告 */}
        {resolvedFlash && !firstPending && (
          <View style={styles.resolvedBar}>
            <T size={10.5} weight="semibold" color={ideColors.dim}>
              权限请求已由 {resolvedFlash.byDevice} 处理
            </T>
          </View>
        )}

        {/* 复制成功轻提示 */}
        {copyFlash && (
          <View style={styles.resolvedBar}>
            <T size={10.5} weight="semibold" color={ideColors.dim}>
              已复制到剪贴板
            </T>
          </View>
        )}

        {/* 权限审批卡 */}
        {firstPending && (
          <PermissionCard
            perm={firstPending}
            queueSize={state.pendingPermissions.length - 1}
            onSelect={(optionId) => client.respondPermission(sessionId, firstPending.requestId, optionId)}
          />
        )}

        {/* 输入栏 */}
        <Composer
          ref={composerRef}
          commands={state.availableCommands}
          running={running}
          disabled={phase !== 'authed'}
          onSend={onSend}
          onCancel={() => client.cancel(sessionId)}
        />
        <View style={{ height: Math.max(insets.bottom - 6, 0), backgroundColor: '#111114' }} />

        {/* 资源管理器侧边栏 — 引用把 @相对路径 插入输入框并收起面板聚焦输入 */}
        <FileExplorerSidebar
          visible={explorerOpen}
          root={cwd}
          onClose={() => setExplorerOpen(false)}
          onReference={(relPath) => {
            setExplorerOpen(false);
            composerRef.current?.insertText(`@${relPath} `);
          }}
        />

        {/* 模式/模型选择器 */}
        <ConfigPickerModal
          visible={pickerTarget !== null}
          title={pickerTarget === 'mode' ? '切换模式' : '切换模型'}
          option={pickerOption}
          onSelect={(value) => {
            if (!pickerTarget) return;
            if (pickerTarget === 'mode' && !modeOption) {
              // ACP modes 路径: 服务器 session/set_mode
              useChatStore.getState().optimisticMode(sessionId, value);
              client.setMode(sessionId, value);
              return;
            }
            const option = pickerTarget === 'mode' ? modeOption : modelOption;
            const configId = option?.id ?? pickerTarget;
            useChatStore.getState().optimisticConfigValue(sessionId, configId, value);
            client.setConfig(sessionId, configId, value);
          }}
          onClose={() => setPickerTarget(null)}
        />

        {/* 消息长按菜单 — 复制原始 markdown 文本 */}
        <Modal visible={messageAction !== null} transparent animationType="fade" onRequestClose={() => setMessageAction(null)}>
          <Pressable style={styles.menuBackdrop} onPress={() => setMessageAction(null)}>
            {messageAction && (
              <Pressable onPress={(e) => e.stopPropagation()} style={styles.menuSheet}>
                <View style={styles.menuHead}>
                  <M size={10.5} weight="bold" color={ideColors.text}>
                    {messageAction.title}
                  </M>
                  <T size={11} color={ideColors.dim} numberOfLines={4} style={{ marginTop: 7 }}>
                    {messageAction.text}
                  </T>
                </View>
                <Pressable onPress={copyMessageAction} style={({ pressed }) => [styles.menuRow, pressed && { backgroundColor: ideColors.card2 }]}>
                  <T size={12} weight="medium" color={ideColors.text}>
                    复制文本
                  </T>
                </Pressable>
                {messageAction.kind === 'user' && (
                  <Pressable
                    onPress={() => void reaskFromMessage(messageAction)}
                    disabled={forking}
                    style={({ pressed }) => [styles.menuRow, pressed && { backgroundColor: ideColors.card2 }, forking && { opacity: 0.45 }]}
                  >
                    <T size={12} weight="medium" color={ideColors.text}>
                      从此处重新提问（新会话）
                    </T>
                    <M size={8.5} color={ideColors.faint} style={{ marginTop: 3 }}>
                      复制此前文本上下文; 不改动原会话与文件
                    </M>
                  </Pressable>
                )}
                <Pressable
                  onPress={() => void openRevertSteps()}
                  disabled={revertLoading}
                  style={({ pressed }) => [styles.menuRow, pressed && { backgroundColor: ideColors.card2 }, revertLoading && { opacity: 0.45 }]}
                >
                  <T size={12} weight="medium" color={ideColors.text}>
                    {revertLoading ? '正在读取可回撤步骤…' : '分叉回撤（真实 · 实验）'}
                  </T>
                  <M size={8.5} color={ideColors.faint} style={{ marginTop: 3 }}>
                    devin 私有 revert 协议; 分叉新会话不动原会话
                  </M>
                </Pressable>
                <Pressable onPress={() => setMessageAction(null)} style={({ pressed }) => [styles.menuRow, pressed && { backgroundColor: ideColors.card2 }]}>
                  <T size={12} color={ideColors.faint} style={{ textAlign: 'center' }}>
                    取消
                  </T>
                </Pressable>
              </Pressable>
            )}
          </Pressable>
        </Modal>

        {/* 回撤步骤 — devin 私有 revert/listSteps; 选步分叉新会话 */}
        <Modal visible={revertOpen} transparent animationType="fade" onRequestClose={() => setRevertOpen(false)}>
          <Pressable style={styles.menuBackdrop} onPress={() => setRevertOpen(false)}>
            <Pressable onPress={(e) => e.stopPropagation()} style={styles.timelineSheet}>
              <View style={styles.menuHead}>
                <M size={10.5} weight="bold" uppercase ls={0.8} color={ideColors.text}>
                  分叉回撤
                </M>
                <M size={8.5} color={ideColors.faint} style={{ marginTop: 4 }}>
                  选择步骤从该处分叉新会话; 原会话与历史不受影响
                </M>
              </View>
              {(revertSteps ?? []).map((step) => (
                <Pressable
                  key={step.forkTargetNodeId ?? String(step.stepNumber)}
                  onPress={() => void forkFromStep(step)}
                  disabled={revertBusy}
                  style={({ pressed }) => [styles.menuRow, pressed && { backgroundColor: ideColors.card2 }, revertBusy && { opacity: 0.45 }]}
                >
                  <T size={12} weight="medium" color={ideColors.text} numberOfLines={2}>
                    #{step.stepNumber} {step.summary || step.kind || '步骤'}
                  </T>
                  {step.kind ? (
                    <M size={8.5} color={ideColors.faint} style={{ marginTop: 2 }}>
                      {step.kind}
                    </M>
                  ) : null}
                </Pressable>
              ))}
              <Pressable onPress={() => setRevertOpen(false)} style={({ pressed }) => [styles.menuRow, pressed && { backgroundColor: ideColors.card2 }]}>
                <T size={12} color={ideColors.faint} style={{ textAlign: 'center' }}>
                  取消
                </T>
              </Pressable>
            </Pressable>
          </Pressable>
        </Modal>

        {/* 时间线 — 快捷时间点 + 已加载日期锚点; 目标超出已加载范围时自动向前翻页 */}
        <Modal visible={timelineOpen} transparent animationType="fade" onRequestClose={() => setTimelineOpen(false)}>
          <Pressable style={styles.menuBackdrop} onPress={() => setTimelineOpen(false)}>
            <Pressable onPress={(e) => e.stopPropagation()} style={styles.timelineSheet}>
              <View style={styles.menuHead}>
                <M size={10.5} weight="bold" uppercase ls={0.8} color={ideColors.text}>
                  时间线定位
                </M>
                <M size={8.5} color={ideColors.faint} style={{ marginTop: 4 }}>
                  {oldestLoadedTs && newestLoadedTs
                    ? `已加载 ${formatDate(oldestLoadedTs)} ${formatTime(oldestLoadedTs)} — ${formatDate(newestLoadedTs)} ${formatTime(newestLoadedTs)}`
                    : '暂无可定位消息'}
                </M>
                {state.truncated && (
                  <M size={8.5} color={ideColors.yellow} style={{ marginTop: 3 }}>
                    更早历史尚未加载, 选择时间点会自动回溯
                  </M>
                )}
              </View>

              <View style={styles.quickGrid}>
                {([
                  { key: 'latest', label: '最新', ts: null },
                  { key: 'today', label: '今天', ts: startOfDay(Date.now()) },
                  { key: 'yesterday', label: '昨天', ts: startOfDay(Date.now() - DAY_MS) },
                  { key: 'week', label: '7 天前', ts: startOfDay(Date.now() - 7 * DAY_MS) },
                  { key: 'month', label: '30 天前', ts: startOfDay(Date.now() - 30 * DAY_MS) },
                  { key: 'start', label: '会话开头', ts: 0 },
                ] as const).map((action) => (
                  <Pressable
                    key={action.key}
                    onPress={() => {
                      if (action.ts === null) {
                        setTimelineOpen(false);
                        listRef.current?.scrollToOffset({ offset: 0, animated: true });
                      } else {
                        void jumpToTimestamp(action.ts);
                      }
                    }}
                    style={({ pressed }) => [styles.quickBtn, pressed && { backgroundColor: ideColors.card2 }]}
                  >
                    <M size={9.5} weight="bold" color={ideColors.text}>
                      {action.label}
                    </M>
                  </Pressable>
                ))}
              </View>

              <ScrollView style={styles.timelineList} keyboardShouldPersistTaps="handled">
                {timelineBuckets.length === 0 ? (
                  <M size={9.5} color={ideColors.faint} style={{ textAlign: 'center', paddingVertical: 18 }}>
                    暂无日期锚点
                  </M>
                ) : (
                  timelineBuckets.map((bucket) => (
                    <Pressable
                      key={bucket.key}
                      onPress={() => void jumpToTimestamp(bucket.firstTs)}
                      style={({ pressed }) => [styles.timelineRow, pressed && { backgroundColor: ideColors.card2 }]}
                    >
                      <View style={{ flex: 1, minWidth: 0 }}>
                        <T size={12} weight="semibold" color={ideColors.text}>
                          {formatDate(bucket.startTs)}
                        </T>
                        <M size={8.5} color={ideColors.faint} style={{ marginTop: 2 }}>
                          {formatTime(bucket.firstTs)} — {formatTime(bucket.lastTs)}
                        </M>
                      </View>
                      <M size={9} color={ideColors.faint}>
                        {bucket.count} 项
                      </M>
                    </Pressable>
                  ))
                )}
              </ScrollView>

              <Pressable onPress={() => setTimelineOpen(false)} style={({ pressed }) => [styles.menuRow, pressed && { backgroundColor: ideColors.card2 }]}>
                <T size={12} color={ideColors.faint} style={{ textAlign: 'center' }}>
                  关闭
                </T>
              </Pressable>
            </Pressable>
          </Pressable>
        </Modal>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: '#111114' },
  chatBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    backgroundColor: '#141418',
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 10,
    borderBottomWidth: 2,
    borderBottomColor: ideColors.border,
  },
  backBtn: { paddingHorizontal: 2 },
  chatBarMain: { flex: 1, minWidth: 0 },
  pillsRow: { flexDirection: 'row', gap: 4, marginTop: 4 },
  pill: {
    borderWidth: 1,
    borderColor: ideColors.border,
    paddingHorizontal: 5,
    paddingVertical: 2,
  },
  statusDot: { width: 7, height: 7, marginLeft: 6 },
  explorerBtn: {
    width: 26,
    height: 26,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1.5,
    borderColor: ideColors.border,
    marginLeft: 6,
  },
  offlineBar: {
    backgroundColor: colors.accSoft,
    borderBottomWidth: 1,
    borderBottomColor: ideColors.borderSoft,
    paddingVertical: 7,
    alignItems: 'center',
  },
  truncatedBar: {
    backgroundColor: ideColors.card2,
    borderBottomWidth: 1,
    borderBottomColor: ideColors.borderSoft,
    paddingVertical: 7,
    alignItems: 'center',
  },
  jumpBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: colors.accSoft,
    borderBottomWidth: 1,
    borderBottomColor: ideColors.borderSoft,
    paddingVertical: 7,
  },
  flowContent: { paddingHorizontal: 12, paddingVertical: 12 },
  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  historyFooter: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingVertical: 16,
    minHeight: 42,
  },
  historyLoadingRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'center' },
  highlightWrap: {
    borderLeftWidth: 3,
    borderLeftColor: colors.acc,
    backgroundColor: colors.accSoft,
    paddingLeft: 5,
    marginLeft: -5,
  },
  resolvedBar: {
    borderTopWidth: 1,
    borderTopColor: ideColors.borderSoft,
    backgroundColor: ideColors.card2,
    paddingVertical: 7,
    alignItems: 'center',
  },
  menuBackdrop: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.58)',
    justifyContent: 'flex-end',
  },
  menuSheet: {
    backgroundColor: ideColors.shell,
    borderTopWidth: 2,
    borderTopColor: ideColors.border,
    paddingBottom: 10,
  },
  timelineSheet: {
    backgroundColor: ideColors.shell,
    borderTopWidth: 2,
    borderTopColor: ideColors.border,
    paddingBottom: 10,
    maxHeight: '78%',
  },
  menuHead: {
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: ideColors.border,
  },
  menuRow: {
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderBottomWidth: 1,
    borderBottomColor: ideColors.borderSoft,
  },
  quickGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: 7,
    paddingHorizontal: 14,
    paddingVertical: 11,
    borderBottomWidth: 1,
    borderBottomColor: ideColors.borderSoft,
  },
  quickBtn: {
    borderWidth: 1.5,
    borderColor: ideColors.border,
    paddingHorizontal: 9,
    paddingVertical: 6,
    backgroundColor: ideColors.card,
  },
  timelineList: { maxHeight: 310 },
  timelineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 14,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: ideColors.borderSoft,
  },
});
