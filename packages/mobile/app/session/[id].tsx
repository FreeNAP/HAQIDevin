/**
 * 对话页 (核心) — 对照 mockup 界面 2/3
 *  - 顶栏: ‹ 返回 + 标题 + 模式/模型 pill (点击弹选择器) + context 用量
 *  - 消息流: 用户黑底靠右 / agent 白底黑框靠左 markdown / thought 折叠 / 工具卡 / plan 卡
 *  - 流式中 agent 气泡朱红边框 + 闪烁光标
 *  - 权限请求: 审批卡悬浮于输入栏上方, 竖排选项, 他端处理显示 "已由 XX 处理"
 *  - 进入订阅 session.subscribe (sinceSeq 补拉), 离开 unsubscribe
 */
import React from 'react';
import { View, FlatList, Pressable, StyleSheet, KeyboardAvoidingView, Platform, Keyboard, Alert, BackHandler } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useLocalSearchParams, router } from 'expo-router';
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
import { ConfigPickerModal } from '../../src/components/ConfigPickerModal';
import { FileExplorerSidebar } from '../../src/components/FileExplorerSidebar';
import { initChatState, ChatItem } from '../../src/reducers/chatReducer';
import type { ConfigOption } from '../../src/protocol/acp';
import { PendingAttachment, toWireAttachments, hasImageAttachment } from '../../src/util/attachments';

function renderItem(item: ChatItem, streamingAgentId: string | null) {
  switch (item.kind) {
    case 'user':
      return <UserBubble item={item} />;
    case 'agent':
      return <AgentBubble item={item} streaming={item.id === streamingAgentId} />;
    case 'thought':
      return <ThoughtCard item={item} />;
    case 'tool':
      return <ToolCallCard item={item} />;
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
  const prevPendingIds = React.useRef<string[]>([]);

  const listRef = React.useRef<FlatList<ChatItem>>(null);
  const composerRef = React.useRef<ComposerHandle>(null);

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
      style={{ flex: 1, backgroundColor: colors.paper }}
      behavior={Platform.OS === 'ios' ? 'padding' : undefined}
      keyboardVerticalOffset={0}
    >
      <View style={[styles.page, { paddingTop: insets.top }]}>
        {/* 顶栏 */}
        <View style={styles.chatBar}>
          <Pressable onPress={() => router.back()} hitSlop={12} style={styles.backBtn}>
            <T size={21} weight="regular" color={colors.ink}>‹</T>
          </Pressable>
          <View style={styles.chatBarMain}>
            <T size={13} weight="bold" ls={-0.1} numberOfLines={1}>
              {title}
            </T>
            <View style={styles.pillsRow}>
              {modeName && (
                <Pressable onPress={() => setPickerTarget('mode')} style={styles.pill}>
                  <M size={8.5} color={colors.ink} uppercase ls={0.4}>{modeName}</M>
                </Pressable>
              )}
              {modelName && (
                <Pressable onPress={() => setPickerTarget('model')} style={styles.pill}>
                  <M size={8.5} color={colors.ink} uppercase ls={0.4}>{modelName}</M>
                </Pressable>
              )}
              {!modeName && !modelName && (
                <M size={8.5} color={colors.ink3}>…</M>
              )}
            </View>
          </View>
          {usageText && (
            <M size={9} color={colors.ink3} style={{ marginLeft: 6 }}>
              {usageText}
            </M>
          )}
          {/* 资源管理器入口 — 有 cwd 才可用 (快照未到时禁用) */}
          <Pressable
            onPress={() => {
              if (!cwd) return;
              Keyboard.dismiss();
              setExplorerOpen(true);
            }}
            hitSlop={10}
            style={[styles.explorerBtn, explorerOpen && { backgroundColor: colors.ink }, !cwd && { opacity: 0.3 }]}
            accessibilityLabel="打开文件面板"
          >
            <M size={12} weight="bold" color={explorerOpen ? colors.paper : colors.ink}>▤</M>
          </Pressable>
          <View style={[styles.statusDot, { backgroundColor: running ? colors.acc : colors.ink3 }]} />
        </View>

        {/* 历史截断提示 */}
        {truncatedText && (
          <View style={styles.truncatedBar}>
            <T size={10.5} color={colors.ink2}>
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

        {/* 消息流 */}
        <FlatList
          ref={listRef}
          style={{ flex: 1 }}
          contentContainerStyle={styles.flowContent}
          data={reversed}
          inverted
          keyExtractor={(item) => item.id}
          renderItem={({ item }) => <View>{renderItem(item, streamingAgentId)}</View>}
          ListEmptyComponent={
            <View style={styles.emptyWrap}>
              {/* inverted 列表里这个组件是上下翻转的, 用 transform 翻回来 */}
              <View style={{ transform: [{ scaleY: -1 }] }}>
                <T size={11.5} color={colors.ink3} style={{ textAlign: 'center' }}>
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
            <T size={10.5} weight="semibold" color={colors.ink2}>
              权限请求已由 {resolvedFlash.byDevice} 处理
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
        <View style={{ height: Math.max(insets.bottom - 6, 0), backgroundColor: colors.paper }} />

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
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.paper },
  chatBar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 10,
    borderBottomWidth: 2,
    borderBottomColor: colors.ink,
  },
  backBtn: { paddingHorizontal: 2 },
  chatBarMain: { flex: 1, minWidth: 0 },
  pillsRow: { flexDirection: 'row', gap: 4, marginTop: 4 },
  pill: {
    borderWidth: 1,
    borderColor: colors.ink,
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
    borderColor: colors.ink,
    marginLeft: 6,
  },
  offlineBar: {
    backgroundColor: colors.accSoft,
    borderBottomWidth: 1,
    borderBottomColor: colors.hairline,
    paddingVertical: 7,
    alignItems: 'center',
  },
  truncatedBar: {
    backgroundColor: colors.paper2,
    borderBottomWidth: 1,
    borderBottomColor: colors.hairline,
    paddingVertical: 7,
    alignItems: 'center',
  },
  flowContent: { paddingHorizontal: 12, paddingVertical: 12 },
  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center' },
  resolvedBar: {
    borderTopWidth: 1,
    borderTopColor: colors.hairline,
    backgroundColor: colors.paper2,
    paddingVertical: 7,
    alignItems: 'center',
  },
});
