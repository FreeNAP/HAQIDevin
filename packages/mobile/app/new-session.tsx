/**
 * 新建会话 — 从 workdir.list 选择工作目录 → session.create → 跳对话页
 * PRD M3: 选择主机上预设的工作目录
 */
import React from 'react';
import { View, Pressable, ScrollView, StyleSheet, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { colors } from '../src/theme/colors';
import { T, M, HardButton } from '../src/components/ui';
import { useConnectionStore } from '../src/store/connection';
import { client } from '../src/ws/client';
import { dirName } from '../src/util/time';

export default function NewSessionPage() {
  const insets = useSafeAreaInsets();
  const workdirs = useConnectionStore((s) => s.workdirs);
  const phase = useConnectionStore((s) => s.phase);
  const [creating, setCreating] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    if (phase === 'authed') client.requestWorkdirs();
  }, [phase]);

  async function pick(path: string) {
    if (creating) return;
    setCreating(path);
    setError(null);
    try {
      const session = await client.createSession(path);
      setCreating(null);
      router.replace(`/session/${encodeURIComponent(session.sessionId)}`);
    } catch (e) {
      setCreating(null);
      setError(e instanceof Error ? e.message : '创建会话失败');
    }
  }

  return (
    <View style={[styles.page, { paddingTop: insets.top }]}>
      <View style={styles.appBar}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <T size={21}>‹</T>
        </Pressable>
        <T size={15} weight="bold" ls={-0.2}>新建会话</T>
        <View style={{ width: 21 }} />
      </View>

      <ScrollView contentContainerStyle={{ padding: 14 }}>
        <T size={10} weight="bold" uppercase ls={1.6} color={colors.ink2} style={{ marginBottom: 9 }}>
          选择工作目录
        </T>
        <T size={10.5} color={colors.ink3} style={{ marginBottom: 12, lineHeight: 16 }}>
          目录清单由服务器端配置 (VSIX 面板可管理)
        </T>

        {phase !== 'authed' && (
          <View style={styles.warnBox}>
            <T size={11} color={colors.acc}>未连接主机 — 无法创建会话</T>
          </View>
        )}
        {error && (
          <View style={styles.warnBox}>
            <T size={11} color={colors.danger}>{error}</T>
          </View>
        )}

        {workdirs.length === 0 && phase === 'authed' && (
          <View style={{ alignItems: 'center', paddingVertical: 30 }}>
            <ActivityIndicator color={colors.acc} />
            <T size={11} color={colors.ink3} style={{ marginTop: 10 }}>正在获取目录清单…</T>
          </View>
        )}

        {workdirs.map((d, idx) => {
          const missing = d.exists === false;
          const busy = creating === d.path;
          return (
            <Pressable
              key={d.path + idx}
              disabled={missing || creating !== null}
              onPress={() => void pick(d.path)}
              style={({ pressed }) => [
                styles.dirRow,
                idx === workdirs.length - 1 && { borderBottomWidth: 1.5 },
                pressed && { backgroundColor: colors.paper2 },
                (missing || (creating !== null && !busy)) && { opacity: 0.45 },
              ]}
            >
              <View style={{ flex: 1 }}>
                <T size={13} weight="semibold">
                  {d.label ?? dirName(d.path)}
                </T>
                <M size={9.5} color={colors.ink3} style={{ marginTop: 3 }} numberOfLines={1}>
                  {d.path}
                </M>
              </View>
              {busy ? (
                <ActivityIndicator size="small" color={colors.acc} />
              ) : missing ? (
                <M size={9} color={colors.danger}>不存在</M>
              ) : (
                <M size={11} color={colors.acc}>→</M>
              )}
            </Pressable>
          );
        })}
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
  dirRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
    borderWidth: 1.5,
    borderColor: colors.ink,
    borderBottomWidth: 0,
    backgroundColor: colors.card,
    paddingHorizontal: 13,
    paddingVertical: 13,
  },
});
