/**
 * 输入栏组合件 — 对照 mockup input-bar: 2px 硬边白盒 + 朱红方块发送键
 *  - "/" 触发斜杠命令自动补全 (availableCommands 原样透传)
 *  - 运行中显示停止钮 ■, 长按触发 session.cancel (PRD M9)
 */
import React from 'react';
import { View, TextInput, Pressable, StyleSheet, ScrollView } from 'react-native';
import { colors } from '../theme/colors';
import { T, M } from './ui';
import { useFontTheme } from '../theme/fonts';
import type { AvailableCommand } from '../protocol/acp';

interface Props {
  commands: AvailableCommand[];
  running: boolean;
  disabled?: boolean;
  onSend: (text: string) => void;
  onCancel: () => void;
}

export function Composer({ commands, running, disabled, onSend, onCancel }: Props) {
  const fonts = useFontTheme();
  const [text, setText] = React.useState('');
  const [holdHint, setHoldHint] = React.useState(false);

  // 斜杠命令过滤: 输入以 / 开头且尚未输入空格 (仍在键入命令名)
  const slashMatch = /^\/(\S*)$/.exec(text);
  const filtered = slashMatch
    ? commands.filter((c) => c.name.toLowerCase().startsWith((slashMatch[1] ?? '').toLowerCase())).slice(0, 8)
    : [];

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed) return;
    onSend(trimmed);
    setText('');
  };

  return (
    <View style={styles.wrap}>
      {filtered.length > 0 && (
        <View style={styles.slashMenu}>
          <ScrollView keyboardShouldPersistTaps="always" style={{ maxHeight: 220 }}>
            {filtered.map((c) => (
              <Pressable
                key={c.name}
                onPress={() => setText(`/${c.name} `)}
                style={({ pressed }) => [styles.slashRow, pressed && { backgroundColor: colors.paper2 }]}
              >
                <M size={11.5} weight="bold" color={colors.acc}>
                  /{c.name}
                </M>
                <T size={10.5} color={colors.ink2} numberOfLines={1} style={{ flex: 1, marginLeft: 9 }}>
                  {c.description}
                  {c.input?.hint ? `  ‹${c.input.hint}›` : ''}
                </T>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      )}
      {holdHint && running && (
        <M size={9} color={colors.ink3} style={styles.holdHint}>
          长按 ■ 停止当前任务
        </M>
      )}
      <View style={styles.inputBar}>
        <TextInput
          style={[styles.input, { fontFamily: fonts.sans || undefined }]}
          value={text}
          onChangeText={setText}
          placeholder="输入消息，或 / 命令"
          placeholderTextColor={colors.ink3}
          multiline
          editable={!disabled}
          onSubmitEditing={submit}
          blurOnSubmit={false}
        />
        {running ? (
          <Pressable
            onPress={() => {
              setHoldHint(true);
              setTimeout(() => setHoldHint(false), 1800);
            }}
            onLongPress={onCancel}
            delayLongPress={450}
            style={({ pressed }) => [styles.sendBtn, { backgroundColor: colors.ink }, pressed && styles.sendBtnPressed]}
            accessibilityLabel="停止 — 长按"
          >
            <T size={12} weight="bold" color="#fff">■</T>
          </Pressable>
        ) : (
          <Pressable
            onPress={submit}
            disabled={disabled || !text.trim()}
            style={({ pressed }) => [
              styles.sendBtn,
              { backgroundColor: colors.acc },
              pressed && styles.sendBtnPressed,
              (!text.trim() || disabled) && { opacity: 0.35 },
            ]}
            accessibilityLabel="发送"
          >
            <T size={14} weight="bold" color="#fff">↑</T>
          </Pressable>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    paddingHorizontal: 12,
    paddingBottom: 10,
    paddingTop: 2,
    backgroundColor: colors.paper,
  },
  slashMenu: {
    backgroundColor: colors.card,
    borderWidth: 1.5,
    borderColor: colors.ink,
    marginBottom: 8,
  },
  slashRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 9,
    borderBottomWidth: 1,
    borderBottomColor: colors.hairline,
  },
  holdHint: { textAlign: 'right', marginBottom: 4 },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    backgroundColor: colors.card,
    borderWidth: 2,
    borderColor: colors.ink,
    paddingLeft: 11,
    paddingRight: 6,
    paddingVertical: 6,
    gap: 8,
  },
  input: {
    flex: 1,
    fontSize: 13,
    color: colors.ink,
    paddingVertical: 5,
    maxHeight: 110,
    lineHeight: 18,
  },
  sendBtn: {
    width: 30,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
  },
  sendBtnPressed: {
    transform: [{ translateY: 1 }],
    opacity: 0.85,
  },
});
