/**
 * 设备页 — 对照 mockup 界面 4 + PRD M13
 *  - 主机信息卡: 域名 / TLS / 延迟 / 隧道类型
 *  - server.status 服务器卡: 版本/在线时长/会话数/设备数
 *  - 已配对设备列表: 当前设备标记, 撤销其他设备 (Alert 确认)
 *  - 重新配对入口: 清本地凭据回配对态
 */
import React from 'react';
import { View, ScrollView, Pressable, StyleSheet, Alert, RefreshControl } from 'react-native';
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
          // 服务器处理后广播 device.list 更新; 此处即时刷新一次
          setTimeout(() => client.requestDevices(), 600);
        },
      },
    ]);
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
