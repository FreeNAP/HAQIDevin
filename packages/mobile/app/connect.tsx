/**
 * 连接/配对页 — 对照 mockup 界面 4 的配对部分 + PRD M1
 *  - 主机地址输入 (局域网 ws:// 自动识别, 域名默认 wss://)
 *  - 多台主机记忆 (AsyncStorage), 点击切换
 *  - 配对码 XXXX-XXXX 自动格式化输入
 *  - 连接状态机实时展示: 连接中/未配对/已连接/错误
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
import { HostEntry, loadHosts, saveHosts, saveActiveHostId, hostIdFor } from '../src/store/storage';

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
  const autoConnectTried = React.useRef(false);

  const parsed: ParsedHost | { error: string } | null = hostInput.trim()
    ? normalizeHostInput(hostInput)
    : null;
  const parsedOk = parsed && 'url' in parsed ? parsed : null;

  // 配对/连接完成后自动进会话列表 — 仅当进入页面时尚未认证
  // (已认证用户手动来切主机时不踢走)
  const initialPhase = React.useRef(phase);
  React.useEffect(() => {
    if (phase === 'authed' && initialPhase.current !== 'authed') {
      router.replace('/(tabs)/sessions');
    }
  }, [phase]);

  // 进入页面: 有活跃主机且处于 idle → 自动连接一次
  React.useEffect(() => {
    if (!autoConnectTried.current && activeHost && phase === 'idle') {
      autoConnectTried.current = true;
      void connectHost(activeHost);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeHost, phase]);

  async function persistHosts(next: HostEntry[]) {
    useConnectionStore.getState().setHosts(next);
    await saveHosts(next);
  }

  async function connectHost(entry: HostEntry) {
    const fresh = useConnectionStore.getState().hosts;
    const next = fresh.map((h) => (h.id === entry.id ? { ...h, lastUsedAt: Date.now() } : h));
    await persistHosts(next);
    await saveActiveHostId(entry.id);
    await client.connect({ ...entry, lastUsedAt: Date.now() });
  }

  async function onConnectPress() {
    setInputError(null);
    if (!hostInput.trim()) {
      setInputError('请输入主机地址');
      return;
    }
    const p = normalizeHostInput(hostInput);
    if ('error' in p) {
      setInputError(p.error);
      return;
    }
    const id = hostIdFor(p.url);
    const entry: HostEntry = {
      id,
      url: p.url,
      label: p.label,
      addedAt: Date.now(),
      lastUsedAt: Date.now(),
    };
    const rest = hosts.filter((h) => h.id !== id);
    await persistHosts([...rest, entry]);
    await saveActiveHostId(id);
    await client.connect(entry);
  }

  async function removeHost(entry: HostEntry) {
    const next = hosts.filter((h) => h.id !== entry.id);
    await persistHosts(next);
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

  const showPairing = phase === 'unpaired' || phase === 'pairing';
  const busy = phase === 'connecting' || phase === 'authenticating' || phase === 'pairing';

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
            onChangeText={setHostInput}
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
        <View style={{ marginTop: 10 }}>
          <HardButton text={busy ? '连接中…' : '连 接'} primary onPress={onConnectPress} disabled={busy} />
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
                配对码在桌面端「Devin Remote」面板生成{'\n'}5 分钟内有效, 一次性使用
              </T>
              <View style={{ marginTop: 12 }}>
                <HardButton
                  text={phase === 'pairing' ? '配对中…' : '配 对'}
                  primary
                  disabled={pairCode.length !== 9 || phase === 'pairing'}
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
