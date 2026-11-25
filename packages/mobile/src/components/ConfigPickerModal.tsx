/**
 * 模式/模型选择弹层 — 数据来自 configOptions (category='mode'/'model' 的 select)
 * 选择后发送 session.setConfig {configId, value}
 */
import React from 'react';
import { View, Modal, Pressable, ScrollView, StyleSheet } from 'react-native';
import { colors } from '../theme/colors';
import { T, M, HardCard } from './ui';
import type { ConfigOption } from '../protocol/acp';

interface Props {
  visible: boolean;
  title: string;
  option: ConfigOption | null;
  onSelect: (value: string) => void;
  onClose: () => void;
}

export function ConfigPickerModal({ visible, title, option, onSelect, onClose }: Props) {
  const values = option?.options ?? [];
  return (
    <Modal visible={visible} transparent animationType="fade" onRequestClose={onClose}>
      <Pressable style={styles.backdrop} onPress={onClose}>
        <Pressable onPress={(e) => e.stopPropagation()}>
          <HardCard
            borderWidth={2}
            borderColor={colors.ink}
            shadowOffset={6}
            shadowColor={colors.shadowInk}
            contentStyle={styles.sheet}
            style={styles.sheetWrap}
          >
            <View style={styles.head}>
              <T size={11} weight="bold" uppercase ls={1.4}>
                {title}
              </T>
              <Pressable onPress={onClose} hitSlop={10}>
                <T size={14} color={colors.ink3}>×</T>
              </Pressable>
            </View>
            <ScrollView style={{ maxHeight: 340 }}>
              {values.length === 0 && (
                <T size={11} color={colors.ink3} style={{ paddingVertical: 14 }}>
                  暂无可用选项 — 等待会话数据
                </T>
              )}
              {values.map((v) => {
                const active = v.value === option?.currentValue;
                return (
                  <Pressable
                    key={v.value}
                    onPress={() => {
                      onSelect(v.value);
                      onClose();
                    }}
                    style={({ pressed }) => [
                      styles.row,
                      active && styles.rowActive,
                      pressed && { backgroundColor: colors.paper2 },
                    ]}
                  >
                    <View style={{ flex: 1 }}>
                      <T size={12.5} weight={active ? 'bold' : 'medium'} color={active ? colors.acc : colors.ink}>
                        {v.name}
                      </T>
                      {v.description ? (
                        <T size={10} color={colors.ink3} style={{ marginTop: 2 }} numberOfLines={2}>
                          {v.description}
                        </T>
                      ) : null}
                    </View>
                    {active && (
                      <M size={11} weight="bold" color={colors.acc}>
                        ●
                      </M>
                    )}
                  </Pressable>
                );
              })}
            </ScrollView>
            {option && (
              <M size={8.5} color={colors.ink3} style={styles.footnote} numberOfLines={1}>
                {option.id} · 当前 {option.currentValue ?? '—'}
              </M>
            )}
          </HardCard>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    flex: 1,
    backgroundColor: 'rgba(17,19,17,0.35)',
    justifyContent: 'center',
    padding: 28,
  },
  sheetWrap: { alignSelf: 'stretch' },
  sheet: { paddingHorizontal: 14, paddingVertical: 12 },
  head: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: colors.ink,
    paddingBottom: 9,
    marginBottom: 4,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingVertical: 10,
    paddingHorizontal: 8,
    borderBottomWidth: 1,
    borderBottomColor: colors.hairline,
    gap: 8,
  },
  rowActive: {
    backgroundColor: colors.accSoft,
  },
  footnote: { marginTop: 8, textAlign: 'center' },
});
