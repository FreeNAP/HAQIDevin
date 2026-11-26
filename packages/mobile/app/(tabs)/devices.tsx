/**
 * 设备页 — 对照 mockup 界面 4 + PRD M13
 *  - 主机信息卡: 域名 / TLS / 延迟 / 隧道类型
 *  - server.status 服务器卡: 版本/在线时长/会话数/设备数
 *  - 已配对设备列表: 当前设备标记, 撤销其他设备 (Alert 确认)
 *  - 已撤销设备: server 过滤不返回, 本地跟踪本次会话内刚撤销的设备 → 可彻底删除 (device.delete)
 *  - 主机配置入口: 额度用量 / 工作目录 / 规则与 MCP
 *  - 重新配对入口: 清本地凭据回配对态
 */
import React from 'react';
import { View, ScrollView, Pressable, StyleSheet, Alert, RefreshControl, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { colors } from '../../src/theme/colors';
import { T, M, HardCard, HardButton, Hairline } from '../../src/components/ui';
import { useConnectionStore } from '../../src/store/connection';
import { client } from '../../src/ws/client';
import { relativeTime, durationText } from '../../src/util/time';
import type { DeviceInfo } from '../../src/protocol/wire';

function DeviceRow({ dev, isSelf, onRevoke }: { dev: DeviceInfo; isSelf: boolean; onRevoke: () => void }) {
  return (
    <View style={[styles.devRow, isSelf && styles.devRowSelf]}>
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
          <T size={12.5} weight="bold">{dev.deviceName}</T>
          {dev.online && <View style={styles.onlineDot} />}
        </View>
        <M size={9} color={colors.ink3} style={{ marginTop: 3 }}>
          {isSelf ? '本机' : dev.platform ?? '设备'} · {dev.online ? '活跃中' : `${relativeTime(dev.lastActiveAt)}活跃`}
        </M>
      </View>
      {isSelf ? (
        <View style={styles.selfTag}>
          <T size={8.5} weight="bold" color={colors.acc} uppercase ls={0.5}>当前设备</T>
        </View>
      ) : (
        <HardButton text="撤销" small danger onPress={onRevoke} />
      )}
    </View>
  );
}

/** 已撤销设备行 — 本地跟踪, 提供彻底删除入口 */
function RevokedDeviceRow({ dev, deleting, onDelete }: { dev: DeviceInfo; deleting: boolean; onDelete: () => void }) {
  return (
    <View style={[styles.devRow, styles.devRowRevoked]}>
      <View style={{ flex: 1 }}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 7 }}>
          <T size={12.5} weight="bold" color={colors.ink2}>{dev.deviceName}</T>
          <View style={styles.revokedTag}>
            <T size={8} weight="bold" color={colors.danger} uppercase ls={0.5}>已撤销</T>
          </View>
        </View>
        <M size={9} color={colors.ink3} style={{ marginTop: 3 }}>
          {dev.platform ?? '设备'} · 访问权限已回收
        </M>
      </View>
      {deleting ? (
        <ActivityIndicator size="small" color={colors.danger} />
      ) : (
        <HardButton text="删除" small danger onPress={onDelete} />
      )}
    </View>
  );
}

/** 配置入口行 — 硬边列表项 + 右侧箭头 */
function ConfigEntryRow({
  title,
  desc,
  last,
  onPress,
}: {
  title: string;
  desc: string;
  last?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => [
        styles.entryRow,
        last && { borderBottomWidth: 1.5 },
        pressed && { backgroundColor: colors.paper2 },
      ]}
    >
      <View style={{ flex: 1 }}>
        <T size={12.5} weight="bold">{title}</T>
        <M size={8.5} color={colors.ink3} style={{ marginTop: 3 }}>{desc}</M>
      </View>
      <M size={12} color={colors.acc}>→</M>
    </Pressable>
  );
}

export default function DevicesPage() {
  const insets = useSafeAreaInsets();
  const phase = useConnectionStore((s) => s.phase);
  const activeHost = useConnectionStore((s) => s.activeHost);
  const latency = useConnectionStore((s) => s.latencyMs);
  const serverStatus = useConnectionStore((s) => s.serverStatus);
  const devices = useConnectionStore((s) => s.devices);
  const selfDeviceId = useConnectionStore((s) => s.selfDeviceId);
  const selfDeviceName = useConnectionStore((s) => s.selfDeviceName);
  const serverVersion = useConnectionStore((s) => s.serverVersion);
  const [refreshing, setRefreshing] = React.useState(false);
  /** 本次会话内刚撤销的设备快照 — server 的 device.list 过滤已撤销设备,
   *  撤销后行会消失; 本地保留快照展示"删除"入口, 彻底删除或离开页面后消失 */
  const [revokedLocal, setRevokedLocal] = React.useState<DeviceInfo[]>([]);
  const [deletingId, setDeletingId] = React.useState<string | null>(null);

  const authed = phase === 'authed';

  React.useEffect(() => {
    if (authed) {
      client.requestDevices();
      client.requestStatus();
    }
  }, [authed]);

  const onRefresh = React.useCallback(() => {
    setRefreshing(true);
    client.requestDevices();
    client.requestStatus();
    setTimeout(() => setRefreshing(false), 700);
  }, []);

  function confirmRevoke(dev: DeviceInfo) {
    Alert.alert('撤销设备', `撤销「${dev.deviceName}」的配对？该设备将立即失去访问权限。`, [
      { text: '取消', style: 'cancel' },
      {
        text: '撤销',
        style: 'destructive',
        onPress: () => {
          client.revokeDevice(dev.deviceId);
          // 乐观快照: 撤销后 server 列表过滤该设备, 本地保留行以提供"彻底删除"入口
          setRevokedLocal((prev) =>
            prev.some((d) => d.deviceId === dev.deviceId) ? prev : [...prev, { ...dev, online: false }],
          );
          // 服务器处理后广播 device.list 更新; 此处即时刷新一次
          setTimeout(() => client.requestDevices(), 600);
        },
      },
    ]);
  }

  function confirmDelete(dev: DeviceInfo) {
    Alert.alert(
      '彻底删除设备',
      `删除「${dev.deviceName}」的全部配对记录？删除后该设备必须重新配对才能接入。`,
      [
        { text: '取消', style: 'cancel' },
        {
          text: '删除',
          style: 'destructive',
          onPress: () => {
            setDeletingId(dev.deviceId);
            void client
              .deleteDevice(dev.deviceId)
              .then(() => {
                setRevokedLocal((prev) => prev.filter((d) => d.deviceId !== dev.deviceId));
                client.requestDevices();
              })
              .catch((e) => {
                Alert.alert('删除失败', e instanceof Error ? e.message : '删除设备失败, 请重试');
              })
              .finally(() => setDeletingId(null));
          },
        },
      ],
    );
  }

  function confirmRePair() {
    Alert.alert('重新配对', '将清除本机的设备凭据并重新走配对流程。当前连接会断开。', [
      { text: '取消', style: 'cancel' },
      {
        text: '重新配对',
        style: 'destructive',
        onPress: () => {
          void client.resetPairing().then(() => router.replace('/connect'));
        },
      },
    ]);
  }

  const isTls = activeHost?.url.startsWith('wss://') ?? false;
  // 已撤销快照中若某 id 重新出现在配对清单 (重新配对), 本地行隐藏 — 以 server 清单为准
  const revokedVisible = revokedLocal.filter((r) => !devices.some((d) => d.deviceId === r.deviceId));

  return (
    <View style={[styles.page, { paddingTop: insets.top }]}>
      <View style={styles.appBar}>
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: 8 }}>
          <T size={16} weight="bold" ls={-0.4}>设备</T>
          {selfDeviceName && (
            <View style={styles.selfChip}>
              <M size={8.5} weight="bold" color={colors.acc} uppercase ls={0.5} numberOfLines={1}>
                本机 · {selfDeviceName}
              </M>
            </View>
          )}
        </View>
        <View style={styles.hostChip}>
          <View style={[styles.chipDot, { backgroundColor: authed ? colors.ok : colors.ink3 }]} />
          <M size={9} color={colors.ink2}>
            {isTls ? 'TLS' : '明文'}{latency !== null ? ` · ${latency}ms` : ''}
          </M>
        </View>
      </View>

      <ScrollView
        contentContainerStyle={{ padding: 14, paddingBottom: 30 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.acc} colors={[colors.acc]} />}
      >
        {/* 主机卡 */}
        <HardCard borderWidth={1.5} contentStyle={styles.hostCard}>
          <M size={13} weight="bold" color={colors.ink}>
            {activeHost?.label ?? '未连接'}
          </M>
          <T size={10.5} color={colors.ink2} style={{ marginTop: 5 }}>
            {isTls ? 'Cloudflare Tunnel / 自定义域名' : '局域网直连'} · {authed ? '已连接' : '未连接'}
          </T>
          {serverStatus?.hostname ? (
            <M size={9} color={colors.ink3} style={{ marginTop: 4 }}>
              公网域名 {serverStatus.hostname}
            </M>
          ) : null}
        </HardCard>

        {/* 服务器状态 */}
        <T size={10} weight="bold" uppercase ls={1.6} color={colors.ink2} style={styles.sectionLabel}>
          服务器
        </T>
        <View style={styles.statGrid}>
          <View style={styles.statCell}>
            <T size={9} weight="bold" color={colors.ink3} uppercase ls={1}>状态</T>
            <T size={15} weight="bold" color={authed ? colors.ok : colors.ink3} style={{ marginTop: 5 }}>
              {authed ? '运行中' : '离线'}
            </T>
            <M size={8.5} color={colors.ink2} style={{ marginTop: 3 }}>
              {serverStatus ? `${serverStatus.host}:${serverStatus.port}` : '—'}
            </M>
          </View>
          <View style={[styles.statCell, styles.statCellBorder]}>
            <T size={9} weight="bold" color={colors.ink3} uppercase ls={1}>在线时长</T>
            <T size={15} weight="bold" style={{ marginTop: 5 }}>
              {serverStatus ? durationText(serverStatus.uptimeSec) : '—'}
            </T>
            <M size={8.5} color={colors.ink2} style={{ marginTop: 3 }}>
              v{serverStatus?.version ?? serverVersion ?? '?'}
            </M>
          </View>
          <View style={[styles.statCell, styles.statCellBorder]}>
            <T size={9} weight="bold" color={colors.ink3} uppercase ls={1}>会话/设备</T>
            <T size={15} weight="bold" style={{ marginTop: 5 }}>
              {serverStatus ? `${serverStatus.activeSessions} / ${serverStatus.onlineDevices}` : '—'}
            </T>
            <M size={8.5} color={colors.ink2} style={{ marginTop: 3 }}>活跃 / 在线</M>
          </View>
        </View>

        {/* 设备列表 */}
        <T size={10} weight="bold" uppercase ls={1.6} color={colors.ink2} style={styles.sectionLabel}>
          已配对设备
        </T>
        {devices.length === 0 && (
          <View style={styles.emptyBox}>
            <T size={11} color={colors.ink3}>{authed ? '暂无设备数据 — 下拉刷新' : '连接主机后查看'}</T>
          </View>
        )}
        {devices.map((d, idx) => (
          <View key={d.deviceId} style={idx === devices.length - 1 ? { borderBottomWidth: 1.5, borderBottomColor: colors.ink } : undefined}>
            <DeviceRow dev={d} isSelf={d.deviceId === selfDeviceId} onRevoke={() => confirmRevoke(d)} />
          </View>
        ))}

        {/* 已撤销设备 (本地跟踪) — server 列表过滤已撤销设备, 仅在本次会话内撤销的可见 */}
        {revokedVisible.length > 0 && (
          <>
            <T size={10} weight="bold" uppercase ls={1.6} color={colors.ink2} style={styles.sectionLabel}>
              已撤销 · 可彻底删除
            </T>
            {revokedVisible.map((d, idx) => (
              <View key={d.deviceId} style={idx === revokedVisible.length - 1 ? { borderBottomWidth: 1.5, borderBottomColor: colors.ink } : undefined}>
                <RevokedDeviceRow dev={d} deleting={deletingId === d.deviceId} onDelete={() => confirmDelete(d)} />
              </View>
            ))}
            <M size={8.5} color={colors.ink3} style={{ marginTop: 6 }}>
              已撤销设备不再出现在配对清单 · 删除后须重新配对
            </M>
          </>
        )}

        {/* 主机配置入口 */}
        <T size={10} weight="bold" uppercase ls={1.6} color={colors.ink2} style={styles.sectionLabel}>
          主机配置
        </T>
        <ConfigEntryRow
          title="额度用量"
          desc="计划 / 日限周限剩余 / 透支余额"
          onPress={() => router.push('/settings/quota')}
        />
        <ConfigEntryRow
          title="工作目录"
          desc="会话可创建的目录清单管理"
          onPress={() => router.push('/settings/workdirs')}
        />
        <ConfigEntryRow
          title="规则与 MCP"
          desc="全局规则 / MCP 服务器配置查看"
          last
          onPress={() => router.push('/settings/config')}
        />

        {/* 重新配对 */}
        <View style={{ marginTop: 22 }}>
          <HardButton text="重新配对本机" danger onPress={confirmRePair} />
        </View>

        <Hairline style={{ marginTop: 24 }} />
        <M size={8.5} color={colors.ink3} style={{ marginTop: 10, textAlign: 'center', lineHeight: 14 }}>
          设备 30 天未活跃自动失效 · 撤销即时生效并踢掉在线连接
        </M>
      </ScrollView>
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
  hostChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    borderWidth: 1,
    borderColor: colors.ink,
    paddingHorizontal: 7,
    paddingVertical: 3,
  },
  selfChip: {
    borderWidth: 1.5,
    borderColor: colors.acc,
    backgroundColor: colors.accSoft,
    paddingHorizontal: 6,
    paddingVertical: 2,
    maxWidth: 180,
  },
  chipDot: { width: 6, height: 6 },
  hostCard: { paddingHorizontal: 12, paddingVertical: 11 },
  sectionLabel: { marginTop: 20, marginBottom: 8 },
  statGrid: {
    flexDirection: 'row',
    borderWidth: 2,
    borderColor: colors.ink,
    backgroundColor: colors.card,
  },
  statCell: { flex: 1, paddingHorizontal: 10, paddingVertical: 11 },
  statCellBorder: { borderLeftWidth: 2, borderLeftColor: colors.ink },
  devRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    borderWidth: 1.5,
    borderColor: colors.ink,
    borderBottomWidth: 0,
    backgroundColor: colors.card,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  devRowSelf: { backgroundColor: colors.accSoft },
  devRowRevoked: { backgroundColor: colors.paper2 },
  revokedTag: {
    borderWidth: 1,
    borderColor: colors.danger,
    paddingHorizontal: 4,
    paddingVertical: 1,
  },
  entryRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1.5,
    borderColor: colors.ink,
    borderBottomWidth: 0,
    backgroundColor: colors.card,
    paddingHorizontal: 12,
    paddingVertical: 11,
  },
  onlineDot: { width: 6, height: 6, backgroundColor: colors.ok },
  selfTag: {
    borderWidth: 1.5,
    borderColor: colors.acc,
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  emptyBox: {
    borderWidth: 1.5,
    borderColor: colors.hairline,
    borderStyle: 'dashed',
    paddingVertical: 16,
    alignItems: 'center',
  },
});
