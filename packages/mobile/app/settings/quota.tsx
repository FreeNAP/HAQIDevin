/**
 * 额度用量页 — account.quota 查询展示
 *  - 计划名 / 日限·周限剩余百分比 (硬边进度条) / 透支余额 (负值红色警示)
 *  - 重置时间: 绝对时刻 + 相对倒计时
 *  - 会话消耗聚合统计 (server events 侧 fallback 数据)
 *  - 下拉刷新; null 字段一律显示 "—"; loading/错误态完备
 */
import React from 'react';
import { View, ScrollView, Pressable, StyleSheet, RefreshControl, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { colors } from '../../src/theme/colors';
import { T, M, HardCard, HardButton, Hairline } from '../../src/components/ui';
import { useConnectionStore } from '../../src/store/connection';
import { client } from '../../src/ws/client';
import { dateTimeText, futureText } from '../../src/util/time';
import type { AccountQuotaMsg } from '../../src/protocol/wire';

/** 剩余百分比进度条 — 硬边填充, 低余额转红色警示 */
function QuotaBar({ percent }: { percent: number | null }) {
  if (percent === null) {
    return (
      <View style={barStyles.track}>
        <View style={barStyles.emptyHint}>
          <M size={8.5} color={colors.ink3}>—</M>
        </View>
      </View>
    );
  }
  const pct = Math.max(0, Math.min(100, percent));
  const fillColor = pct <= 10 ? colors.danger : pct <= 25 ? colors.acc : colors.ink;
  return (
    <View style={barStyles.track}>
      {pct > 0 && <View style={[barStyles.fill, { width: `${pct}%`, backgroundColor: fillColor }]} />}
    </View>
  );
}

const barStyles = StyleSheet.create({
  track: {
    height: 14,
    borderWidth: 1.5,
    borderColor: colors.ink,
    backgroundColor: colors.paper2,
    overflow: 'hidden',
    justifyContent: 'center',
  },
  fill: { height: '100%' },
  emptyHint: { alignItems: 'center' },
});

/** 单条配额行: 标签 + 百分比数字 + 进度条 + 重置时间 */
function QuotaRow({
  label,
  percent,
  resetAt,
}: {
  label: string;
  percent: number | null;
  resetAt: number | null;
}) {
  const validReset = resetAt !== null && resetAt > 0 ? resetAt : null;
  const rel = validReset !== null ? futureText(validReset) : null;
  return (
    <View style={styles.quotaRow}>
      <View style={styles.quotaRowHead}>
        <T size={10} weight="bold" uppercase ls={1.2} color={colors.ink2}>{label}</T>
        <M size={13} weight="bold" color={percent === null ? colors.ink3 : colors.ink}>
          {percent === null ? '—' : `${Math.round(percent)}%`}
        </M>
      </View>
      <QuotaBar percent={percent} />
      <View style={styles.quotaRowFoot}>
        <M size={8.5} color={colors.ink3}>剩余</M>
        <M size={8.5} color={colors.ink2}>
          {validReset === null
            ? '重置时间 —'
            : rel
              ? `重置 ${dateTimeText(validReset)} · ${rel}`
              : `重置 ${dateTimeText(validReset)}`}
        </M>
      </View>
    </View>
  );
}

/** 透支余额文案 — micros (1/1e6 美元) 转美元; 负 = 透支 */
function overageText(micros: number): { text: string; danger: boolean } {
  const usd = micros / 1e6;
  if (usd < 0) {
    return { text: `$${Math.abs(usd).toFixed(2)} 透支`, danger: true };
  }
  return { text: `$${usd.toFixed(2)} 剩余`, danger: false };
}

function numText(v: number | null | undefined): string {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—';
  return v.toLocaleString('en-US');
}

export default function QuotaPage() {
  const insets = useSafeAreaInsets();
  const phase = useConnectionStore((s) => s.phase);
  const [quota, setQuota] = React.useState<AccountQuotaMsg | null>(null);
  const [loading, setLoading] = React.useState(false);
  const [refreshing, setRefreshing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const authed = phase === 'authed';

  const load = React.useCallback(async (silent: boolean) => {
    if (useConnectionStore.getState().phase !== 'authed') {
      setError('尚未连接到主机');
      setLoading(false);
      setRefreshing(false);
      return;
    }
    if (!silent) setLoading(true);
    setError(null);
    try {
      const q = await client.requestQuota();
      setQuota(q);
    } catch (e) {
      setError(e instanceof Error ? e.message : '额度查询失败');
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, []);

  React.useEffect(() => {
    if (authed) void load(false);
    else {
      setQuota(null);
      setError(null);
    }
  }, [authed, load]);

  const onRefresh = React.useCallback(() => {
    setRefreshing(true);
    void load(true);
  }, [load]);

  const sourceLabel =
    quota?.source === 'connect-rpc' ? 'Connect RPC 实时' : quota?.source === 'events-fallback' ? '本地事件估算' : quota ? '无数据' : null;

  const overageMicros = quota?.overageBalanceMicros ?? quota?.overageBalance ?? null;
  const overage = overageMicros !== null && Number.isFinite(overageMicros) ? overageText(overageMicros) : null;
  const usage = quota?.sessionUsage ?? null;
  const hasUsage = usage !== null && (usage.eventCount > 0 || usage.totalCreditCost > 0 || usage.totalAcuCost > 0);

  return (
    <View style={[styles.page, { paddingTop: insets.top }]}>
      <View style={styles.appBar}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <T size={21}>‹</T>
        </Pressable>
        <T size={15} weight="bold" ls={-0.2}>额度用量</T>
        <View style={{ width: 21 }} />
      </View>

      <ScrollView
        contentContainerStyle={{ padding: 14, paddingBottom: 30 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.acc} colors={[colors.acc]} />}
      >
        {!authed && (
          <View style={styles.warnBox}>
            <T size={11} color={colors.acc}>未连接主机 — 连接后可查询额度</T>
          </View>
        )}
        {error && authed ? (
          <View style={styles.warnBox}>
            <T size={11} color={colors.danger}>{error}</T>
            <View style={{ marginTop: 8 }}>
              <HardButton text="重试" small onPress={() => void load(false)} />
            </View>
          </View>
        ) : null}

        {loading && !quota && (
          <View style={{ alignItems: 'center', paddingVertical: 36 }}>
            <ActivityIndicator color={colors.acc} />
            <T size={11} color={colors.ink3} style={{ marginTop: 10 }}>正在查询账户额度…</T>
          </View>
        )}

        {quota && (
          <>
            {/* 计划卡 */}
            <HardCard borderWidth={2} shadowOffset={3} contentStyle={styles.planCard}>
              <View style={{ flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' }}>
                <T size={9.5} weight="bold" uppercase ls={1.6} color={colors.ink2}>当前计划</T>
                {sourceLabel && (
                  <M size={8} color={colors.ink3}>{sourceLabel}</M>
                )}
              </View>
              <T size={26} weight="bold" ls={-0.5} style={{ marginTop: 6 }}>
                {quota.planName ?? '—'}
              </T>
              {overage && (
                <View style={[styles.overageTag, overage.danger && styles.overageTagDanger]}>
                  <T size={10} weight="bold" color={overage.danger ? colors.danger : colors.ok}>
                    {overage.danger ? '⚠ ' : ''}{overage.text}
                  </T>
                </View>
              )}
            </HardCard>

            {/* 配额进度 */}
            <T size={10} weight="bold" uppercase ls={1.6} color={colors.ink2} style={styles.sectionLabel}>
              配额剩余
            </T>
            <HardCard borderWidth={1.5} contentStyle={{ paddingHorizontal: 12, paddingVertical: 4 }}>
              <QuotaRow label="日限" percent={quota.dailyRemainingPercent} resetAt={quota.dailyResetAt} />
              <View style={styles.quotaDivider} />
              <QuotaRow label="周限" percent={quota.weeklyRemainingPercent} resetAt={quota.weeklyResetAt} />
            </HardCard>

            {/* ACU 消耗 */}
            {(quota.acuConsumed !== null || quota.acuLimit !== null) && (
              <>
                <T size={10} weight="bold" uppercase ls={1.6} color={colors.ink2} style={styles.sectionLabel}>
                  ACU 用量
                </T>
                <View style={styles.statGrid}>
                  <View style={styles.statCell}>
                    <T size={9} weight="bold" color={colors.ink3} uppercase ls={1}>已消耗</T>
                    <M size={15} weight="bold" style={{ marginTop: 5 }}>{numText(quota.acuConsumed)}</M>
                  </View>
                  <View style={[styles.statCell, styles.statCellBorder]}>
                    <T size={9} weight="bold" color={colors.ink3} uppercase ls={1}>上限</T>
                    <M size={15} weight="bold" style={{ marginTop: 5 }}>{numText(quota.acuLimit)}</M>
                  </View>
                </View>
              </>
            )}

            {/* 会话消耗统计 */}
            <T size={10} weight="bold" uppercase ls={1.6} color={colors.ink2} style={styles.sectionLabel}>
              会话消耗统计
            </T>
            {hasUsage && usage ? (
              <View style={styles.statGrid}>
                <View style={styles.statCell}>
                  <T size={9} weight="bold" color={colors.ink3} uppercase ls={1}>Credit</T>
                  <M size={15} weight="bold" style={{ marginTop: 5 }}>{numText(usage.totalCreditCost)}</M>
                  <M size={8.5} color={colors.ink2} style={{ marginTop: 3 }}>累计消耗</M>
                </View>
                <View style={[styles.statCell, styles.statCellBorder]}>
                  <T size={9} weight="bold" color={colors.ink3} uppercase ls={1}>ACU</T>
                  <M size={15} weight="bold" style={{ marginTop: 5 }}>{numText(usage.totalAcuCost)}</M>
                  <M size={8.5} color={colors.ink2} style={{ marginTop: 3 }}>累计消耗</M>
                </View>
                <View style={[styles.statCell, styles.statCellBorder]}>
                  <T size={9} weight="bold" color={colors.ink3} uppercase ls={1}>会话</T>
                  <M size={15} weight="bold" style={{ marginTop: 5 }}>{numText(usage.sessions)}</M>
                  <M size={8.5} color={colors.ink2} style={{ marginTop: 3 }}>{numText(usage.eventCount)} 事件</M>
                </View>
              </View>
            ) : (
              <View style={styles.emptyBox}>
                <T size={11} color={colors.ink3}>暂无可聚合的会话消耗数据</T>
              </View>
            )}

            <Hairline style={{ marginTop: 24 }} />
            <M size={8.5} color={colors.ink3} style={{ marginTop: 10, textAlign: 'center', lineHeight: 14 }}>
              数据来自主机账户探针 · 下拉刷新重新查询
            </M>
          </>
        )}

        {!quota && !loading && !error && authed && (
          <View style={styles.emptyBox}>
            <T size={11} color={colors.ink3}>暂无额度数据 — 下拉刷新重试</T>
          </View>
        )}
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  page: { flex: 1, backgroundColor: colors.paper },
  appBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: 12,
    paddingTop: 10,
    paddingBottom: 10,
    borderBottomWidth: 2,
    borderBottomColor: colors.ink,
  },
  warnBox: {
    borderWidth: 1.5,
    borderColor: colors.acc,
    backgroundColor: colors.accSoft,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginBottom: 12,
  },
  planCard: { paddingHorizontal: 13, paddingVertical: 12 },
  overageTag: {
    alignSelf: 'flex-start',
    borderWidth: 1.5,
    borderColor: colors.ok,
    paddingHorizontal: 7,
    paddingVertical: 3,
    marginTop: 9,
  },
  overageTagDanger: {
    borderColor: colors.danger,
    backgroundColor: 'rgba(194, 47, 30, 0.07)',
  },
  sectionLabel: { marginTop: 20, marginBottom: 8 },
  quotaRow: { paddingVertical: 11 },
  quotaRowHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 7 },
  quotaRowFoot: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: 6 },
  quotaDivider: { height: 1, backgroundColor: colors.hairline },
  statGrid: {
    flexDirection: 'row',
    borderWidth: 2,
    borderColor: colors.ink,
    backgroundColor: colors.card,
  },
  statCell: { flex: 1, paddingHorizontal: 10, paddingVertical: 11 },
  statCellBorder: { borderLeftWidth: 2, borderLeftColor: colors.ink },
  emptyBox: {
    borderWidth: 1.5,
    borderColor: colors.hairline,
    borderStyle: 'dashed',
    paddingVertical: 16,
    alignItems: 'center',
  },
});
