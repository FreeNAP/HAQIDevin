/**
 * 会话列表页 — 对照 mockup 界面 1 + PRD M2/M3 + 契约 v2
 *  - 数据源: devinSession.list (devin 侧全部会话) ∪ session.list (server 已加载会话)
 *  - 已加载会话显示在线状态点 + 实时状态 badge; isLocked 显示「桌面占用中」
 *  - 点击未加载会话 → session.load (locked 先确认冲突提示) → 成功跳对话页
 *  - 下拉刷新重拉两个列表, 右上角 + 新建会话
 */
import React from 'react';
import { View, Pressable, FlatList, RefreshControl, StyleSheet, Alert, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router, useFocusEffect } from 'expo-router';
import { colors } from '../../src/theme/colors';
import { T, M, Badge } from '../../src/components/ui';
import { useConnectionStore } from '../../src/store/connection';
import {
  useSessionsStore,
  mergeSessionRows,
  filterMergedRows,
  waitingCount,
  SessionFilter,
  MergedSessionRow,
} from '../../src/store/sessions';
import type { DevinSessionInfo } from '../../src/protocol/wire';
import { relativeTime, dirName } from '../../src/util/time';
import { client } from '../../src/ws/client';

function loadedBadge(row: MergedSessionRow): { text: string; tone: 'warn' | 'live' | 'done' | 'dim' | 'danger'; live?: boolean } | null {
  const s = row.loaded;
  if (!s) return null;
  if (s.status === 'waiting_permission' || s.hasPendingPermission) return { text: '待审批', tone: 'warn' };
  if (s.status === 'running') return { text: '运行中', tone: 'live', live: true };
  if (s.status === 'error') return { text: '错误', tone: 'danger' };
  if (s.status === 'closed') return { text: '已关闭', tone: 'dim' };
  return { text: '已完成', tone: 'done' };
}

function SessionRow({
  row,
  loading,
  disabled,
  onPress,
}: {
  row: MergedSessionRow;
  loading: boolean;
  disabled: boolean;
  onPress: () => void;
}) {
  const b = loadedBadge(row);
  const warn = b?.tone === 'warn';
  const live = b?.tone === 'live';
  const dim = row.loaded?.status === 'closed';
  const online = row.loaded !== undefined && row.loaded.status !== 'closed';
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      style={({ pressed }) => [
        styles.row,
        warn && styles.rowWarn,
        pressed && { backgroundColor: colors.paper2 },
        (dim || (disabled && !loading)) && { opacity: 0.55 },
      ]}
    >
      {(warn || live) && <View style={[styles.rowBar, { backgroundColor: warn ? colors.acc : colors.ink }]} />}
      <View style={styles.rowMain}>
        <View style={styles.titleRow}>
          {online && <View style={styles.onlineDot} />}
          <T size={13.5} weight="semibold" ls={-0.1} numberOfLines={1} style={{ flex: 1 }}>
            {row.title || '未命名会话'}
          </T>
        </View>
        <M size={9.5} color={colors.ink3} uppercase ls={0.5} style={{ marginTop: 4 }} numberOfLines={1}>
          {dirName(row.cwd)} · {row.sortTs > 0 ? relativeTime(row.sortTs) : '—'}
        </M>
        <M size={9} color={colors.ink3} style={{ marginTop: 3 }} numberOfLines={1}>
          {row.cwd}
        </M>
      </View>
      {loading ? (
        <ActivityIndicator size="small" color={colors.acc} />
      ) : row.loaded ? (
        b && <Badge text={b.text} tone={b.tone} pulse={b.live} />
      ) : row.isLocked ? (
        <Badge text="桌面端占用中" tone="warn" />
      ) : (
        <Badge text="未加载" tone="dim" />
      )}
    </Pressable>
  );
}

const FILTERS: { key: SessionFilter; label: string }[] = [
  { key: 'all', label: '全部' },
  { key: 'running', label: '运行中' },
  { key: 'waiting', label: '待审批' },
  { key: 'done', label: '已完成' },
];

export default function SessionsPage() {
  const insets = useSafeAreaInsets();
  const phase = useConnectionStore((s) => s.phase);
  const activeHost = useConnectionStore((s) => s.activeHost);
  const latency = useConnectionStore((s) => s.latencyMs);
  const sessions = useSessionsStore((s) => s.sessions);
  const devinSessions = useSessionsStore((s) => s.devinSessions);
  const devinListLoaded = useSessionsStore((s) => s.devinListLoaded);
  const filter = useSessionsStore((s) => s.filter);
  const setFilter = useSessionsStore((s) => s.setFilter);
  const [refreshing, setRefreshing] = React.useState(false);
  const [loadingId, setLoadingId] = React.useState<string | null>(null);

  const rows = React.useMemo(() => mergeSessionRows(devinSessions, sessions), [devinSessions, sessions]);
  const list = React.useMemo(() => filterMergedRows(rows, filter), [rows, filter]);
  const pending = waitingCount(sessions);

  const onRefresh = React.useCallback(() => {
    setRefreshing(true);
    client.requestSessions();
    client.requestDevinSessions();
    setTimeout(() => setRefreshing(false), 800);
  }, []);

  // 进入页面时若已认证, 主动刷新一次 (bootstrap 已拉过, 这里兜底刷新)
  React.useEffect(() => {
    if (phase === 'authed') {
      client.requestSessions();
      client.requestDevinSessions();
    }
  }, [phase]);

  // 页面重新聚焦 (从对话页/新建页返回, 或切回 tab) 也刷新 — 桌面端新建的会话才能同步出现
  useFocusEffect(
    React.useCallback(() => {
      if (useConnectionStore.getState().phase === 'authed') {
        client.requestSessions();
        client.requestDevinSessions();
      }
    }, []),
  );

  /** 加载会话并跳转 — contract: 透传 devinSessionId/cwd/additionalDirectories */
  const openSession = React.useCallback(async (row: MergedSessionRow) => {
    if (row.loaded) {
      router.push(`/session/${encodeURIComponent(row.sessionId)}`);
      return;
    }
    if (loadingId) return; // 一次只加载一个, 避免并发错配
    setLoadingId(row.sessionId);
    try {
      // 优先透传 devinSession.list 原始条目 (cwd/additionalDirectories 必须与创建时一致)
      const info: DevinSessionInfo = row.devinInfo ?? {
        sessionId: row.sessionId,
        cwd: row.cwd,
        title: row.title,
        updatedAt: new Date(row.sortTs).toISOString(),
        isLocked: row.isLocked,
        additionalDirectories: row.additionalDirectories,
      };
      const meta = await client.loadSession(info);
      router.push(`/session/${encodeURIComponent(meta.sessionId)}`);
    } catch (e) {
      Alert.alert('加载失败', e instanceof Error ? e.message : '加载会话失败, 请重试');
    } finally {
      setLoadingId(null);
    }
  }, [loadingId]);

  const onRowPress = React.useCallback((row: MergedSessionRow) => {
    if (row.loaded) {
      void openSession(row);
      return;
    }
    if (phase !== 'authed') {
      Alert.alert('未连接', '连接主机后才能加载会话');
      return;
    }
    if (row.isLocked) {
      Alert.alert(
        '会话被占用',
        '该会话正在 Devin Desktop 中打开，接管可能导致冲突，仍要继续吗？',
        [
          { text: '取消', style: 'cancel' },
          { text: '继续接管', style: 'destructive', onPress: () => void openSession(row) },
        ],
      );
      return;
    }
    void openSession(row);
  }, [openSession, phase]);

  return (
    <View style={[styles.page, { paddingTop: insets.top }]}>
      {/* app-bar */}
      <View style={styles.appBar}>
        <T size={16} weight="bold" ls={-0.4}>Devin Remote</T>
        <View style={styles.appBarRight}>
          <Pressable onPress={() => router.push('/connect')} style={styles.hostChip}>
            <View style={[styles.chipDot, { backgroundColor: phase === 'authed' ? colors.ok : phase === 'connecting' ? colors.warn : colors.ink3 }]} />
            <M size={9} color={colors.ink2} numberOfLines={1} style={{ maxWidth: 140 }}>
              {activeHost?.label ?? '未连接'}
              {latency !== null && phase === 'authed' ? ` ${latency}ms` : ''}
            </M>
          </Pressable>
          <Pressable onPress={() => router.push('/new-session')} style={styles.plusBtn} hitSlop={6}>
            <T size={17} weight="bold" color={colors.paper}>＋</T>
          </Pressable>
        </View>
      </View>

      {/* 过滤 chips */}
      <View style={styles.chipRow}>
        {FILTERS.map((f) => {
          const on = filter === f.key;
          const hot = f.key === 'waiting' && pending > 0;
          return (
            <Pressable key={f.key} onPress={() => setFilter(f.key)} style={[styles.chip, on && styles.chipOn]}>
              <T size={11} weight={on ? 'bold' : 'regular'} color={on ? colors.ink : colors.ink2}>
                {f.label}
              </T>
              {hot && (
                <View style={styles.hotBadge}>
                  <M size={8.5} weight="bold" color="#fff">{pending}</M>
                </View>
              )}
            </Pressable>
          );
        })}
      </View>

      {phase !== 'authed' && (
        <Pressable style={styles.offlineBanner} onPress={() => router.push('/connect')}>
          <T size={11} weight="semibold" color={colors.acc}>
            {phase === 'connecting' ? '正在连接主机…' : '未连接 — 点击去连接'}
          </T>
        </Pressable>
      )}

      <FlatList
        data={list}
        keyExtractor={(item) => item.sessionId}
        renderItem={({ item }) => (
          <SessionRow
            row={item}
            loading={loadingId === item.sessionId}
            disabled={loadingId !== null && !item.loaded}
            onPress={() => onRowPress(item)}
          />
        )}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.acc} colors={[colors.acc]} />
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <M size={20} color={colors.hairline}>◈</M>
            <T size={12} color={colors.ink3} style={{ marginTop: 10, textAlign: 'center' }}>
              {phase !== 'authed'
                ? '连接主机后查看会话'
                : !devinListLoaded
                  ? '正在加载会话列表…'
                  : filter === 'all'
                    ? 'Devin 上还没有会话 — 点右上角 ＋ 新建'
                    : '该过滤条件下暂无会话'}
            </T>
          </View>
        }
        contentContainerStyle={list.length === 0 ? { flex: 1 } : undefined}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.paper },
  appBar: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    paddingHorizontal: 14,
    paddingTop: 12,
    paddingBottom: 10,
    borderBottomWidth: 2,
    borderBottomColor: colors.ink,
  },
  appBarRight: { flexDirection: 'row', alignItems: 'center', gap: 10 },
  hostChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderWidth: 1,
    borderColor: colors.ink,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  chipDot: { width: 6, height: 6 },
  plusBtn: {
    width: 28,
    height: 28,
    backgroundColor: colors.ink,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipRow: {
    flexDirection: 'row',
    borderBottomWidth: 1,
    borderBottomColor: colors.hairline,
    paddingHorizontal: 14,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    paddingVertical: 9,
    paddingHorizontal: 10,
    borderBottomWidth: 2,
    borderBottomColor: 'transparent',
    marginBottom: -1,
  },
  chipOn: { borderBottomColor: colors.acc },
  hotBadge: {
    backgroundColor: colors.acc,
    minWidth: 14,
    height: 14,
    borderRadius: 7,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 3,
  },
  offlineBanner: {
    borderBottomWidth: 1,
    borderBottomColor: colors.hairline,
    backgroundColor: colors.accSoft,
    paddingVertical: 9,
    alignItems: 'center',
  },
  row: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: 14,
    paddingVertical: 13,
    borderBottomWidth: 1,
    borderBottomColor: colors.hairline,
    gap: 10,
  },
  rowWarn: { backgroundColor: colors.accSoft },
  rowBar: { position: 'absolute', left: 0, top: 0, bottom: 0, width: 3 },
  rowMain: { flex: 1, minWidth: 0 },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  onlineDot: { width: 6, height: 6, backgroundColor: colors.ok },
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingBottom: 80 },
});
