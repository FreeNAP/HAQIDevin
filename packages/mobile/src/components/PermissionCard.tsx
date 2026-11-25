/**
 * 权限审批卡 — 对照 mockup 界面 3:
 * 朱红硬边框 + 硬阴影, 盾牌图标, mono 命令块, 选项按钮竖排 (原样渲染服务器下发的 options)
 * 其他设备已处理 → "已由 XX 处理"
 */
import React from 'react';
import { View, StyleSheet, Pressable } from 'react-native';
import { colors } from '../theme/colors';
import { T, M, HardCard } from './ui';
import type { PendingPermission } from '../protocol/wire';
import type { PermissionOption } from '../protocol/acp';

interface Props {
  perm: PendingPermission;
  /** 已被处理 (本机或其他设备) — 展示处理者信息而非按钮 */
  resolved?: { byDevice: string; optionId?: string; cancelled?: boolean };
  queueSize?: number;
  onSelect: (optionId?: string) => void;
}

/** 从 rawInput 提取最关键的一行命令/路径 */
export function extractCommand(perm: PendingPermission): string | null {
  const raw = perm.toolCall.rawInput;
  if (!raw) return null;
  for (const key of ['command', 'cmd']) {
    const v = raw[key];
    if (typeof v === 'string' && v) return v;
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) return (v as string[]).join(' ');
  }
  for (const key of ['path', 'file', 'filePath', 'file_path']) {
    const v = raw[key];
    if (typeof v === 'string' && v) return v;
  }
  for (const key of ['query', 'url', 'pattern']) {
    const v = raw[key];
    if (typeof v === 'string' && v) return v;
  }
  return null;
}

function optionTone(opt: PermissionOption): 'primary' | 'danger' | 'plain' {
  const kind = opt.kind ?? '';
  if (kind.startsWith('reject')) return 'danger';
  if (kind === 'allow_once') return 'primary';
  // devin 特有选项无 kind 时按 optionId 推断
  const id = opt.optionId.toLowerCase();
  if (id.includes('reject') || id.includes('deny')) return 'danger';
  if (id.includes('once') || id.includes('allow')) return 'primary';
  return 'plain';
}

function ShieldIcon() {
  // unicode 盾牌, 灰度化以贴合 mono 风格
  return <T size={22} style={{ opacity: 0.85 }}>🛡</T>;
}

export function PermissionCard({ perm, resolved, queueSize = 0, onSelect }: Props) {
  const cmd = extractCommand(perm);
  const toolLabel = perm.toolCall.kind ?? perm.toolCall.title ?? 'tool';
  const options = Array.isArray(perm.options) ? perm.options : [];

  return (
    <HardCard
      borderWidth={2.5}
      borderColor={colors.acc}
      shadowOffset={5}
      shadowColor={colors.shadowAcc}
      contentStyle={styles.card}
      style={styles.wrap}
    >
      <View style={{ alignItems: 'center' }}>
        <ShieldIcon />
        <T size={15} weight="bold" ls={-0.3} style={{ marginTop: 5 }}>
          需要你的批准
        </T>
        <View style={styles.toolChip}>
          <M size={9} color={colors.paper} uppercase>
            {toolLabel}
          </M>
        </View>
        {cmd && (
          <View style={styles.cmdBox}>
            <M size={12} weight="medium" color={colors.ink} style={{ textAlign: 'center' }}>
              {cmd}
            </M>
          </View>
        )}
        {perm.toolCall.title && perm.toolCall.title !== cmd && (
          <T size={10.5} color={colors.ink2} style={{ marginTop: 8, textAlign: 'center', lineHeight: 16 }}>
            {perm.toolCall.title}
          </T>
        )}
        <M size={8.5} color={colors.ink3} uppercase ls={0.6} style={{ marginTop: 6 }}>
          请求于 {new Date(perm.requestedAt).toLocaleTimeString()}
        </M>
      </View>

      {resolved ? (
        <View style={styles.resolvedBox}>
          <T size={11} weight="semibold" color={colors.ink2}>
            {resolved.cancelled ? '已取消' : '已处理'} · 由 {resolved.byDevice}
          </T>
          {resolved.optionId && (
            <M size={9} color={colors.ink3} style={{ marginTop: 3 }}>
              {resolved.optionId}
            </M>
          )}
        </View>
      ) : (
        <View style={styles.actions}>
          {options.map((opt) => {
            const tone = optionTone(opt);
            return (
              <Pressable
                key={opt.optionId}
                onPress={() => onSelect(opt.optionId)}
                style={({ pressed }) => [
                  styles.optButton,
                  tone === 'primary' && styles.optPrimary,
                  tone === 'danger' && styles.optDanger,
                  pressed && { transform: [{ translateX: 1 }, { translateY: 1 }] },
                ]}
              >
                <T
                  size={11.5}
                  weight="bold"
                  uppercase
                  ls={0.5}
                  color={tone === 'primary' ? colors.paper : tone === 'danger' ? colors.danger : colors.ink}
                >
                  {opt.name}
                </T>
              </Pressable>
            );
          })}
          <Pressable onPress={() => onSelect(undefined)} style={({ pressed }) => [styles.cancelBtn, pressed && { opacity: 0.6 }]}>
            <T size={10} color={colors.ink3} uppercase ls={0.8}>
              忽略 (取消)
            </T>
          </Pressable>
        </View>
      )}

      {queueSize > 0 && (
        <M size={8.5} color={colors.ink3} style={styles.queue} numberOfLines={1}>
          还有 {queueSize} 条待审批
        </M>
      )}
    </HardCard>
  );
}

const styles = StyleSheet.create({
  wrap: { marginHorizontal: 12, marginTop: 10, marginBottom: 6 },
  card: { paddingHorizontal: 14, paddingVertical: 15 },
  toolChip: {
    backgroundColor: colors.ink,
    paddingHorizontal: 8,
    paddingVertical: 2,
    marginTop: 9,
  },
  cmdBox: {
    backgroundColor: colors.paper2,
    borderWidth: 1.5,
    borderColor: colors.ink,
    paddingHorizontal: 10,
    paddingVertical: 8,
    marginTop: 8,
    alignSelf: 'stretch',
  },
  actions: { marginTop: 13, gap: 7 },
  optButton: {
    borderWidth: 2,
    borderColor: colors.ink,
    backgroundColor: colors.card,
    paddingVertical: 10,
    paddingHorizontal: 8,
    alignItems: 'center',
  },
  optPrimary: {
    backgroundColor: colors.ink,
  },
  optDanger: {
    borderColor: colors.danger,
  },
  cancelBtn: { alignItems: 'center', paddingVertical: 6 },
  resolvedBox: {
    marginTop: 13,
    borderWidth: 1.5,
    borderColor: colors.hairline,
    backgroundColor: colors.paper2,
    alignItems: 'center',
    paddingVertical: 10,
  },
  queue: {
    marginTop: 9,
    borderWidth: 1,
    borderColor: colors.ink3,
    borderStyle: 'dashed',
    paddingHorizontal: 8,
    paddingVertical: 5,
    textAlign: 'center',
  },
});
