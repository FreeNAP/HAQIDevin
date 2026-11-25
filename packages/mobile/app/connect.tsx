/**
 * 连接/配对页 — 对照 mockup 界面 4 的配对部分 + PRD M1
 *  - 主机地址输入 (局域网 ws:// 自动识别, 域名默认 wss://)
 *  - 多台主机记忆 (AsyncStorage), 点击切换
 *  - 配对码 XXXX-XXXX 自动格式化输入
 *  - 扫码配对: devinremote://pair?host=…&code=… 自动填主机+配对码并发起配对
 *  - 连接状态机实时展示: 连接中/未配对/已连接/错误
 *
 * 保存按钮可用性契约: 无论首次还是重进, 输入合法主机后按钮必可用
 * (连接中/配对中不再禁用按钮 — 重复点击 = 主动重连; 仅在保存落盘进行中禁用)
 */
import React from 'react';
import { View, TextInput, Pressable, ScrollView, StyleSheet, KeyboardAvoidingView, Platform } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { colors } from '../src/theme/colors';
import { T, M, HardButton, HardCard } from '../src/components/ui';
import { useFontTheme } from '../src/theme/fonts';
import { useConnectionStore, phaseLabel } from '../src/store/connection';
import { normalizeHostInput, ParsedHost } from '../src/ws/hostUrl';
import { client } from '../src/ws/client';
import { HostEntry, saveHosts, saveActiveHostId, hostIdFor } from '../src/store/storage';
import { QrScannerModal } from '../src/components/QrScannerModal';
import { parsePairQr, normalizePairCode } from '../src/util/pairQr';

function phaseColor(phase: string): string {
  switch (phase) {
    case 'authed': return colors.ok;
    case 'connecting': case 'authenticating': case 'pairing': return colors.warn;
    case 'unpaired': return colors.acc;
    case 'error': return colors.danger;
    default: return colors.ink3;
  }
}

export default function ConnectPage() {
  const insets = useSafeAreaInsets();
  const fonts = useFontTheme();
  const phase = useConnectionStore((s) => s.phase);
  const errorMessage = useConnectionStore((s) => s.errorMessage);
  const hosts = useConnectionStore((s) => s.hosts);
  const activeHost = useConnectionStore((s) => s.activeHost);
  const reconnectAttempt = useConnectionStore((s) => s.reconnectAttempt);

  const [hostInput, setHostInput] = React.useState('');
  const [pairCode, setPairCode] = React.useState('');
  const [inputError, setInputError] = React.useState<string | null>(null);
  const [scanOpen, setScanOpen] = React.useState(false);
  const [saving, setSaving] = React.useState(false);
  const [saveFeedback, setSaveFeedback] = React.useState<string | null>(null);
  const autoConnectTried = React.useRef(false);
  const hostInputTouched = React.useRef(false);
  /** 用户主动发起过连接 — 即使进页时已 authed, 再次连接成功后也要跳转会话列表 */
  const userInitiated = React.useRef(false);
  /** 扫码带入的配对码 — socket 进入 unpaired 态时自动发起配对 */
  const pendingPairRef = React.useRef<string | null>(null);

  const parsed: ParsedHost | { error: string } | null = hostInput.trim()
    ? normalizeHostInput(hostInput)
    : null;
  const parsedOk = parsed && 'url' in parsed ? parsed : null;

  // 配对/连接完成后自动进会话列表:
  //  - 进页时尚未认证 (冷启动自动连) → 认证成功即跳
  //  - 进页后用户主动连接/切换主机 → 认证成功也跳
  const initialPhase = React.useRef(phase);
  React.useEffect(() => {
    if (phase === 'authed' && (initialPhase.current !== 'authed' || userInitiated.current)) {
      router.replace('/(tabs)/sessions');
    }
  }, [phase]);

  // 进入页面: 有活跃主机且处于 idle → 自动连接一次
  React.useEffect(() => {
    if (!autoConnectTried.current && activeHost && phase === 'idle') {
      autoConnectTried.current = true;
      void connectHost(activeHost, { automatic: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeHost, phase]);

  // 回填: 已有活跃主机且用户未动过输入框 → 预填主机地址, 保证重进后输入合法、按钮立即可用
  React.useEffect(() => {
    if (activeHost && !hostInputTouched.current && !hostInput) {
      setHostInput(activeHost.label);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeHost]);

  // 扫码带入配对码后, socket 进入 unpaired 态 → 自动发起配对
  React.useEffect(() => {
    if (phase === 'unpaired' && pendingPairRef.current) {
      const code = pendingPairRef.current;
      pendingPairRef.current = null;
      client.pair(code);
    }
    if (phase === 'authed') {
      // 已认证则不再需要配对码 — 清掉避免后续误用过期的一次性码
      pendingPairRef.current = null;
    }
  }, [phase]);

  // 连接失败/状态变化时清除保存反馈 (成功则由跳转接管)
  React.useEffect(() => {
    if (phase === 'authed' || phase === 'unpaired' || phase === 'error') {
      setSaveFeedback(null);
    }
  }, [phase]);

  async function persistHosts(next: HostEntry[]) {
    useConnectionStore.getState().setHosts(next);
    await saveHosts(next);
  }

  async function connectHost(entry: HostEntry, opts?: { automatic?: boolean }) {
    if (!opts?.automatic) userInitiated.current = true;
    const fresh = useConnectionStore.getState().hosts;
    const next = fresh.map((h) => (h.id === entry.id ? { ...h, lastUsedAt: Date.now() } : h));
    await persistHosts(next);
    await saveActiveHostId(entry.id);
    await client.connect({ ...entry, lastUsedAt: Date.now() });
  }

  /**
   * 保存主机并连接 — 输入合法时永远可用:
   * 连接中重复点击 = 放弃当前重连循环重新发起 (client.connect 内部安全 teardown)
   */
  async function saveAndConnect(rawInput: string) {
    setInputError(null);
    if (!rawInput.trim()) {
      setInputError('请输入主机地址');
      return;
    }
    const p = normalizeHostInput(rawInput);
    if ('error' in p) {
      setInputError(p.error);
      return;
    }
    setSaving(true);
    try {
      const id = hostIdFor(p.url);
      const entry: HostEntry = {
        id,
        url: p.url,
        label: p.label,
        addedAt: Date.now(),
        lastUsedAt: Date.now(),
      };
      const rest = useConnectionStore.getState().hosts.filter((h) => h.id !== id);
      await persistHosts([...rest, entry]);
      await saveActiveHostId(id);
      userInitiated.current = true;
      setSaveFeedback('主机已保存 — 正在连接…');
      await client.connect(entry);
    } finally {
      setSaving(false);
    }
  }

  function onConnectPress() {
    void saveAndConnect(hostInput);
  }

  async function removeHost(entry: HostEntry) {
    const next = hosts.filter((h) => h.id !== entry.id);
    await persistHosts(next);
  }

  function onHostInputChange(v: string) {
    hostInputTouched.current = true;
    setHostInput(v);
    if (saveFeedback) setSaveFeedback(null);
  }

  function onPairCodeChange(v: string) {
    // 自动格式化为 XXXX-XXXX
    const clean = v.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
    const formatted = clean.length > 4 ? `${clean.slice(0, 4)}-${clean.slice(4)}` : clean;
    setPairCode(formatted);
  }

  function submitPair() {
    client.pair(pairCode);
  }

  /** 扫码回调 — 解析 host/code, 自动填表并发起连接; code 待 unpaired 态自动配对 */
  function onQrScanned(data: string) {
    setScanOpen(false);
    const result = parsePairQr(data);
    if (!result || (!result.host && !result.code)) {
      setInputError('二维码内容无法识别 — 期望 devinremote://pair?host=…&code=XXXX-XXXX');
      return;
    }
    setInputError(null);
    if (result.code) {
      setPairCode(result.code);
      pendingPairRef.current = result.code;
    }
    if (result.host) {
      hostInputTouched.current = true;
      setHostInput(result.host);
      void saveAndConnect(result.host);
    } else if (result.code) {
      // 纯配对码: 当前 socket 已通则等待 unpaired 态自动配对; 未连主机则提示先连
      if (phase === 'unpaired') {
        const code = pendingPairRef.current;
        pendingPairRef.current = null;
        if (code) client.pair(code);
      } else if (phase !== 'pairing' && phase !== 'authenticating' && phase !== 'authed') {
        setInputError('配对码已填入 — 请先连接主机');
      }
    }
  }

  const showPairing = phase === 'unpaired' || phase === 'pairing';
  const inputValid = parsedOk !== null;
  // 契约: 输入合法主机后保存按钮必可用 — 仅在保存落盘进行中禁用
  const connectDisabled = !inputValid || saving;

  return (
    <KeyboardAvoidingView style={{ flex: 1, backgroundColor: colors.paper }} behavior={Platform.OS === 'ios' ? 'padding' : undefined}>
      <ScrollView
        contentContainerStyle={{ paddingTop: insets.top + 28, paddingHorizontal: 20, paddingBottom: 40 }}
        keyboardShouldPersistTaps="handled"
      >
        {/* 板头 — 对照 mockup board-head */}
        <View style={styles.brandRow}>
          <View style={styles.indexChip}>
            <M size={10} color={colors.paper} ls={1.4}>01</M>
          </View>
          <T size={34} weight="bold" ls={-1.2}>Devin Remote</T>
        </View>
        <T size={12} color={colors.ink2} style={styles.philosophy}>
          手机远程驱动桌面上的 Devin — 连接你的 devin-remote-server
        </T>

        {/* 连接状态机 */}
        <View style={styles.statusRow}>
          <View style={[styles.statusDot, { backgroundColor: phaseColor(phase) }]} />
          <M size={10} color={colors.ink2} uppercase ls={1}>
            {phaseLabel(phase)}
            {phase === 'connecting' && reconnectAttempt > 1 ? ` · 第 ${reconnectAttempt} 次重试` : ''}
          </M>
        </View>
        {errorMessage ? (
          <View style={styles.errorBox}>
            <T size={11} color={colors.danger}>{errorMessage}</T>
          </View>
        ) : null}

        {/* 主机输入 */}
        <T size={10} weight="bold" uppercase ls={1.6} style={styles.sectionLabel}>主机地址</T>
        <View style={styles.inputBox}>
          <TextInput
            style={[styles.input, { fontFamily: fonts.mono || undefined }]}
            value={hostInput}
            onChangeText={onHostInputChange}
            placeholder="devin.example.com 或 192.168.1.8:8787"
            placeholderTextColor={colors.ink3}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
          />
        </View>
        {parsedOk && (
          <M size={9.5} color={colors.ink3} style={{ marginTop: 5 }}>
            → {parsedOk.url} {parsedOk.secure ? '· TLS' : '· 明文 (局域网)'}
          </M>
        )}
        {inputError && (
          <T size={10.5} color={colors.danger} style={{ marginTop: 5 }}>{inputError}</T>
        )}
        {saveFeedback && (
          <T size={10.5} weight="semibold" color={colors.ok} style={{ marginTop: 5 }}>{saveFeedback}</T>
        )}
        <View style={{ marginTop: 10, gap: 8 }}>
          <HardButton
            text={saving ? '保存中…' : phase === 'connecting' ? '连 接 (重试)' : '连 接'}
            primary
            onPress={onConnectPress}
            disabled={connectDisabled}
          />
          <HardButton text="扫码配对" onPress={() => setScanOpen(true)} />
        </View>

        {/* 已保存主机 */}
        {hosts.length > 0 && (
          <>
            <T size={10} weight="bold" uppercase ls={1.6} style={[styles.sectionLabel, { marginTop: 26 }]}>已保存的主机</T>
            {hosts.map((h, idx) => (
              <Pressable
                key={h.id}
                onPress={() => void connectHost(h)}
                style={({ pressed }) => [
                  styles.hostRow,
                  idx === hosts.length - 1 && { borderBottomWidth: 1.5 },
                  activeHost?.id === h.id && styles.hostRowActive,
                  pressed && { backgroundColor: colors.paper2 },
                ]}
              >
                <View style={{ flex: 1 }}>
                  <M size={12} weight="bold" color={colors.ink}>{h.label}</M>
                  <M size={8.5} color={colors.ink3} style={{ marginTop: 3 }}>{h.url}</M>
                </View>
                {activeHost?.id === h.id && (
                  <View style={[styles.statusDot, { backgroundColor: phaseColor(phase), marginRight: 8 }]} />
                )}
                <Pressable onPress={() => void removeHost(h)} hitSlop={8} style={styles.hostRemove}>
                  <T size={13} color={colors.ink3}>×</T>
                </Pressable>
              </Pressable>
            ))}
          </>
        )}

        {/* 配对卡片 */}
        {showPairing && (
          <>
            <T size={10} weight="bold" uppercase ls={1.6} style={[styles.sectionLabel, { marginTop: 26 }]}>设备配对</T>
            <HardCard
              borderWidth={2}
              borderColor={colors.ink}
              shadowOffset={5}
              shadowColor={colors.shadowInk}
              contentStyle={styles.pairCard}
            >
              <T size={10.5} weight="bold" uppercase ls={1.4} style={{ textAlign: 'center' }}>
                输入配对码
              </T>
              <TextInput
                style={[styles.pairInput, { fontFamily: fonts.monoBold || undefined }]}
                value={pairCode}
                onChangeText={onPairCodeChange}
                placeholder="XXXX-XXXX"
                placeholderTextColor={colors.ink3}
                autoCapitalize="characters"
                autoCorrect={false}
                maxLength={9}
                textAlign="center"
              />
              <T size={9.5} color={colors.ink3} style={{ textAlign: 'center', marginTop: 8, lineHeight: 15 }}>
                配对码在桌面端「Devin Remote」面板生成{'\n'}5 分钟内有效, 一次性使用{'\n'}也可点上方「扫码配对」自动填入
              </T>
              <View style={{ marginTop: 12 }}>
                <HardButton
                  text={phase === 'pairing' ? '配对中…' : '配 对'}
                  primary
                  disabled={normalizePairCode(pairCode) === undefined || phase === 'pairing'}
                  onPress={submitPair}
                />
              </View>
            </HardCard>
          </>
        )}

        {/* 底部说明 */}
        <M size={8.5} color={colors.ink3} style={{ marginTop: 30, textAlign: 'center', lineHeight: 14 }}>
          连接通道由你自己的 Cloudflare Tunnel 或局域网承载{'\n'}设备凭据存储于系统安全存储, 配对码绝不落盘
        </M>
      </ScrollView>

      {/* 扫码配对弹层 */}
      <QrScannerModal visible={scanOpen} onScanned={onQrScanned} onClose={() => setScanOpen(false)} />
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  brandRow: { flexDirection: 'row', alignItems: 'center', gap: 14 },
  indexChip: {
    backgroundColor: colors.ink,
    paddingHorizontal: 8,
    paddingVertical: 4,
  },
  philosophy: {
    borderLeftWidth: 3,
    borderLeftColor: colors.acc,
    paddingLeft: 12,
    marginTop: 14,
    lineHeight: 19,
  },
  statusRow: { flexDirection: 'row', alignItems: 'center', gap: 8, marginTop: 22 },
  statusDot: { width: 7, height: 7 },
  errorBox: {
    marginTop: 10,
    borderWidth: 1.5,
    borderColor: colors.danger,
    backgroundColor: 'rgba(194,47,30,0.05)',
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  sectionLabel: { marginTop: 22, marginBottom: 8, color: colors.ink2 },
  inputBox: {
    borderWidth: 2,
    borderColor: colors.ink,
    backgroundColor: colors.card,
    paddingHorizontal: 11,
    paddingVertical: 2,
  },
  input: { fontSize: 13, color: colors.ink, paddingVertical: 9 },
  hostRow: {
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1.5,
    borderColor: colors.ink,
    borderBottomWidth: 0,
    backgroundColor: colors.card,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  hostRowActive: { backgroundColor: colors.accSoft },
  hostRemove: { paddingHorizontal: 4 },
  pairCard: { paddingHorizontal: 14, paddingVertical: 14 },
  pairInput: {
    fontSize: 22,
    letterSpacing: 5,
    color: colors.ink,
    borderBottomWidth: 2,
    borderBottomColor: colors.ink,
    marginTop: 12,
    paddingVertical: 6,
    alignSelf: 'center',
    minWidth: 200,
  },
});
