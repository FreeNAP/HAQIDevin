/**
 * 会话列表页 — 对照 mockup 界面 1 + PRD M2/M3
 *  - 顶部 app-bar: 标题 + host chip (连接状态点 + 域名)
 *  - 过滤 chip: 全部/运行中/待审批(角标)/已完成
 *  - 会话行: 标题/目录·时间/状态 badge, 待审批朱红左侧条+浅红底, 运行中黑左侧条
 *  - 下拉刷新重拉 session.list, 右上角 + 新建会话
 */
import React from 'react';
import { View, Pressable, FlatList, RefreshControl, StyleSheet } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { colors } from '../../src/theme/colors';
import { T, M, Badge, PulseDot } from '../../src/components/ui';
import { useConnectionStore } from '../../src/store/connection';
import { useSessionsStore, sortedSessions, filterSessions, waitingCount, SessionFilter } from '../../src/store/sessions';
import type { SessionMeta } from '../../src/protocol/wire';
import { relativeTime, dirName } from '../../src/util/time';
import { client } from '../../src/ws/client';

function statusBadge(s: SessionMeta): { text: string; tone: 'warn' | 'live' | 'done' | 'dim' | 'danger'; live?: boolean } {
  if (s.status === 'waiting_permission' || s.hasPendingPermission) return { text: '待审批', tone: 'warn' };
  if (s.status === 'running') return { text: '运行中', tone: 'live', live: true };
  if (s.status === 'error') return { text: '错误', tone: 'danger' };
  if (s.status === 'closed') return { text: '已关闭', tone: 'dim' };
  return { text: '已完成', tone: 'done' };
}

function SessionRow({ meta }: { meta: SessionMeta }) {
  const b = statusBadge(meta);
  const warn = b.tone === 'warn';
  const live = b.tone === 'live';
  const dim = meta.status === 'closed';
  return (
    <Pressable
      onPress={() => router.push(`/session/${encodeURIComponent(meta.sessionId)}`)}
      style={({ pressed }) => [
        styles.row,
        warn && styles.rowWarn,
        pressed && { backgroundColor: colors.paper2 },
        dim && { opacity: 0.55 },
      ]}
    >
      {(warn || live) && <View style={[styles.rowBar, { backgroundColor: warn ? colors.acc : colors.ink }]} />}
      <View style={styles.rowMain}>
        <T size={13.5} weight="semibold" ls={-0.1} numberOfLines={1}>
          {meta.title || '未命名会话'}
        </T>
        <M size={9.5} color={colors.ink3} uppercase ls={0.5} style={{ marginTop: 4 }} numberOfLines={1}>
          {dirName(meta.cwd)} · {relativeTime(meta.lastActiveAt)}
        </M>
        <M size={9} color={colors.ink3} style={{ marginTop: 3 }} numberOfLines={1}>
          {meta.cwd}
        </M>
      </View>
      <Badge text={b.text} tone={b.tone} pulse={b.live} />
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
  const filter = useSessionsStore((s) => s.filter);
  const setFilter = useSessionsStore((s) => s.setFilter);
  const [refreshing, setRefreshing] = React.useState(false);

  const all = sortedSessions(sessions);
  const list = filterSessions(all, filter);
  const pending = waitingCount(sessions);

  const onRefresh = React.useCallback(() => {
    setRefreshing(true);
    client.requestSessions();
    setTimeout(() => setRefreshing(false), 800);
  }, []);

  // 进入页面时若已认证, 主动刷新一次
  React.useEffect(() => {
    if (phase === 'authed') client.requestSessions();
  }, [phase]);

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
        renderItem={({ item }) => <SessionRow meta={item} />}
        refreshControl={
          <RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.acc} colors={[colors.acc]} />
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            <M size={20} color={colors.hairline}>◈</M>
            <T size={12} color={colors.ink3} style={{ marginTop: 10, textAlign: 'center' }}>
              {phase === 'authed' ? '暂无会话 — 点右上角 ＋ 新建' : '连接主机后查看会话'}
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
  empty: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingBottom: 80 },
});
