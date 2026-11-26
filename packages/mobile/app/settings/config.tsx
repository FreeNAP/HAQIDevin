/**
 * 规则与 MCP 配置查看页 — config.rules.get / config.mcp.get (只读)
 *  - 全局规则: 路径 / 存在状态 / 内容全文
 *  - MCP: 各配置层状态 + 合并生效的 mcpServers 清单
 *  - 写操作 (config.rules.set / config.mcp.set) 手机端暂不提供 — 纯查看
 */
import React from 'react';
import { View, ScrollView, Pressable, StyleSheet, RefreshControl, ActivityIndicator } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { colors } from '../../src/theme/colors';
import { T, M, Hairline, HardButton } from '../../src/components/ui';
import { useConnectionStore } from '../../src/store/connection';
import { client } from '../../src/ws/client';
import type { ConfigRulesMsg, ConfigMcpMsg } from '../../src/protocol/wire';

/** 长文本截断上限 — 避免巨型配置卡死渲染 */
const CONTENT_CAP = 8000;

function capText(s: string): string {
  if (s.length <= CONTENT_CAP) return s;
  return `${s.slice(0, CONTENT_CAP)}\n… (内容过长已截断, 共 ${s.length} 字符)`;
}

const SCOPE_LABEL: Record<string, string> = {
  user: '用户级',
  'legacy-windsurf': '遗留 windsurf',
  'legacy-claude': '遗留 claude',
  'legacy-cursor': '遗留 cursor',
  'legacy-opencode': '遗留 opencode',
  project: '项目级',
  local: '本地级',
};

export default function ConfigViewPage() {
  const insets = useSafeAreaInsets();
  const phase = useConnectionStore((s) => s.phase);
  const [rules, setRules] = React.useState<ConfigRulesMsg | null>(null);
  const [mcp, setMcp] = React.useState<ConfigMcpMsg | null>(null);
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
    // 两个查询独立 — 一个失败不拖死另一个
    const [rulesRes, mcpRes] = await Promise.allSettled([client.getRulesConfig(), client.getMcpConfig()]);
    if (rulesRes.status === 'fulfilled') setRules(rulesRes.value);
    if (mcpRes.status === 'fulfilled') setMcp(mcpRes.value);
    if (rulesRes.status === 'rejected' && mcpRes.status === 'rejected') {
      setError(rulesRes.reason instanceof Error ? rulesRes.reason.message : '读取配置失败');
    } else if (rulesRes.status === 'rejected' || mcpRes.status === 'rejected') {
      const bad = rulesRes.status === 'rejected' ? rulesRes.reason : mcpRes.status === 'rejected' ? mcpRes.reason : null;
      setError(`部分读取失败: ${bad instanceof Error ? bad.message : '未知错误'}`);
    }
    setLoading(false);
    setRefreshing(false);
  }, []);

  React.useEffect(() => {
    if (authed) void load(false);
    else {
      setRules(null);
      setMcp(null);
      setError(null);
    }
  }, [authed, load]);

  const onRefresh = React.useCallback(() => {
    setRefreshing(true);
    void load(true);
  }, [load]);

  const mcpServerNames = mcp && mcp.effective && typeof mcp.effective.mcpServers === 'object' && mcp.effective.mcpServers !== null
    ? Object.keys(mcp.effective.mcpServers)
    : [];

  return (
    <View style={[styles.page, { paddingTop: insets.top }]}>
      <View style={styles.appBar}>
        <Pressable onPress={() => router.back()} hitSlop={12}>
          <T size={21}>‹</T>
        </Pressable>
        <T size={15} weight="bold" ls={-0.2}>规则与 MCP</T>
        <View style={{ width: 21 }} />
      </View>

      <ScrollView
        contentContainerStyle={{ padding: 14, paddingBottom: 30 }}
        refreshControl={<RefreshControl refreshing={refreshing} onRefresh={onRefresh} tintColor={colors.acc} colors={[colors.acc]} />}
      >
        {!authed && (
          <View style={styles.warnBox}>
            <T size={11} color={colors.acc}>未连接主机 — 连接后可查看配置</T>
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

        {loading && !rules && !mcp && (
          <View style={{ alignItems: 'center', paddingVertical: 36 }}>
            <ActivityIndicator color={colors.acc} />
            <T size={11} color={colors.ink3} style={{ marginTop: 10 }}>正在读取配置…</T>
          </View>
        )}

        {/* 全局规则 */}
        {rules && (
          <>
            <T size={10} weight="bold" uppercase ls={1.6} color={colors.ink2} style={styles.sectionLabelFirst}>
              全局规则
            </T>
            <View style={styles.block}>
              <View style={styles.blockHead}>
                <M size={9} color={colors.ink2} style={{ flex: 1 }} numberOfLines={1}>
                  {rules.global?.path ?? '—'}
                </M>
                <View style={[styles.stateTag, !rules.global?.exists && styles.stateTagOff]}>
                  <T size={8} weight="bold" color={rules.global?.exists ? colors.ok : colors.ink3} uppercase ls={0.5}>
                    {rules.global?.exists ? '存在' : '未配置'}
                  </T>
                </View>
              </View>
              {rules.global?.exists && rules.global.content ? (
                <View style={styles.contentBox}>
                  <M size={9} color={colors.ink} style={{ lineHeight: 14 }}>
                    {capText(rules.global.content)}
                  </M>
                </View>
              ) : (
                <T size={10.5} color={colors.ink3} style={{ paddingHorizontal: 10, paddingVertical: 10 }}>
                  全局规则文件不存在或为空
                </T>
              )}
            </View>

            {rules.projects && rules.projects.length > 0 && (
              <>
                <T size={10} weight="bold" uppercase ls={1.6} color={colors.ink2} style={styles.sectionLabel}>
                  项目规则
                </T>
                {rules.projects.map((p) =>
                  p.files.map((f) => (
                    <View key={f.path} style={styles.block}>
                      <View style={styles.blockHead}>
                        <M size={9} color={colors.ink2} style={{ flex: 1 }} numberOfLines={1}>
                          {f.path}
                        </M>
                        <View style={styles.stateTag}>
                          <T size={8} weight="bold" color={colors.ink2} uppercase ls={0.5}>
                            {f.provider} · {f.activation}
                          </T>
                        </View>
                      </View>
                      <View style={styles.contentBox}>
                        <M size={9} color={colors.ink} style={{ lineHeight: 14 }}>{capText(f.content)}</M>
                      </View>
                    </View>
                  )),
                )}
              </>
            )}
          </>
        )}

        {/* MCP 配置 */}
        {mcp && (
          <>
            <T size={10} weight="bold" uppercase ls={1.6} color={colors.ink2} style={styles.sectionLabel}>
              MCP 服务器 · 生效 {mcpServerNames.length} 个
            </T>
            {mcpServerNames.length === 0 ? (
              <View style={styles.emptyBox}>
                <T size={11} color={colors.ink3}>生效配置中没有 MCP 服务器</T>
              </View>
            ) : (
              <View style={styles.block}>
                {mcpServerNames.map((name, idx) => (
                  <View key={name} style={[styles.serverRow, idx > 0 && styles.serverRowBorder]}>
                    <M size={11} weight="bold" color={colors.ink}>{name}</M>
                    <M size={8.5} color={colors.ink3} style={{ marginTop: 2 }} numberOfLines={2}>
                      {capText(JSON.stringify(mcp.effective.mcpServers[name] ?? null))}
                    </M>
                  </View>
                ))}
              </View>
            )}

            <T size={10} weight="bold" uppercase ls={1.6} color={colors.ink2} style={styles.sectionLabel}>
              配置层
            </T>
            <View style={styles.block}>
              {(mcp.layers ?? []).map((layer, idx) => (
                <View key={`${layer.scope}-${idx}`} style={[styles.serverRow, idx > 0 && styles.serverRowBorder]}>
                  <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
                    <T size={10.5} weight="bold">{SCOPE_LABEL[layer.scope] ?? layer.scope}</T>
                    <View style={[styles.stateTag, !layer.exists && styles.stateTagOff]}>
                      <T size={8} weight="bold" color={layer.exists ? colors.ok : colors.ink3} uppercase ls={0.5}>
                        {layer.exists ? '存在' : '无'}
                      </T>
                    </View>
                  </View>
                  <M size={8.5} color={colors.ink3} style={{ marginTop: 3 }} numberOfLines={1}>{layer.path}</M>
                  {layer.error ? (
                    <M size={8.5} color={colors.danger} style={{ marginTop: 2 }}>解析错误: {layer.error}</M>
                  ) : null}
                </View>
              ))}
            </View>
          </>
        )}

        <Hairline style={{ marginTop: 24 }} />
        <M size={8.5} color={colors.ink3} style={{ marginTop: 10, textAlign: 'center', lineHeight: 14 }}>
          配置为只读查看 · 修改请使用桌面端编辑器
        </M>
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
  sectionLabelFirst: { marginBottom: 8 },
  sectionLabel: { marginTop: 20, marginBottom: 8 },
  block: {
    borderWidth: 1.5,
    borderColor: colors.ink,
    backgroundColor: colors.card,
    marginBottom: 10,
  },
  blockHead: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.hairline,
  },
  stateTag: {
    borderWidth: 1,
    borderColor: colors.ok,
    paddingHorizontal: 4,
    paddingVertical: 1,
  },
  stateTagOff: { borderColor: colors.hairline },
  contentBox: {
    paddingHorizontal: 10,
    paddingVertical: 9,
    backgroundColor: colors.paper2,
  },
  serverRow: { paddingHorizontal: 10, paddingVertical: 9 },
  serverRowBorder: { borderTopWidth: 1, borderTopColor: colors.hairline },
  emptyBox: {
    borderWidth: 1.5,
    borderColor: colors.hairline,
    borderStyle: 'dashed',
    paddingVertical: 16,
    alignItems: 'center',
  },
});
