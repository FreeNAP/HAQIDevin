/**
 * 输入栏组合件 — 对照 mockup input-bar: 2px 硬边白盒 + 朱红方块发送键
 *  - "/" 触发斜杠命令自动补全 (availableCommands 原样透传)
 *  - 运行中显示停止钮 ■, 长按触发 session.cancel (PRD M9)
 *  - ＋附件菜单: 拍照/相册图片/文件, 缩略条展示可删除, 随 session.prompt attachments 发出 (契约 v2)
 */
import React from 'react';
import { View, TextInput, Pressable, StyleSheet, ScrollView, Image, Alert, ActivityIndicator } from 'react-native';
import { colors } from '../theme/colors';
import { T, M } from './ui';
import { ideColors } from './ide-tool-cards';
import { useFontTheme } from '../theme/fonts';
import type { AvailableCommand } from '../protocol/acp';
import {
  PendingAttachment,
  pickImageFromCamera,
  pickImageFromLibrary,
  pickDocument,
} from '../util/attachments';

interface Props {
  commands: AvailableCommand[];
  running: boolean;
  disabled?: boolean;
  /** 返回 false 表示拒绝本次发送 (如模型不支持图片) — 输入与附件保留不清空 */
  onSend: (text: string, attachments: PendingAttachment[]) => boolean | void;
  onCancel: () => void;
}

/** 命令式句柄 — 资源管理器引用文件时向输入框插入文本并聚焦 */
export interface ComposerHandle {
  /** 在现有文本末尾追加 (自动补空格分隔), 插入后聚焦输入框 */
  insertText: (t: string) => void;
  focus: () => void;
}

export const Composer = React.forwardRef<ComposerHandle, Props>(function Composer({ commands, running, disabled, onSend, onCancel }, ref) {
  const fonts = useFontTheme();
  const [text, setText] = React.useState('');
  const [holdHint, setHoldHint] = React.useState(false);
  const [attachments, setAttachments] = React.useState<PendingAttachment[]>([]);
  const [attachMenuOpen, setAttachMenuOpen] = React.useState(false);
  const [picking, setPicking] = React.useState(false);
  const inputRef = React.useRef<TextInput>(null);

  React.useImperativeHandle(
    ref,
    () => ({
      insertText: (t: string) => {
        setText((prev) => {
          if (!prev) return t;
          // 已有文本且不以空白结尾时补一个空格分隔, 避免与已有内容粘连
          return /\s$/.test(prev) ? prev + t : `${prev} ${t}`;
        });
        // 状态提交后再聚焦 — 同一帧内 focus 可能被渲染打断
        setTimeout(() => inputRef.current?.focus(), 60);
      },
      focus: () => inputRef.current?.focus(),
    }),
    [],
  );

  // 斜杠命令过滤: 输入以 / 开头且尚未输入空格 (仍在键入命令名)
  const slashMatch = /^\/(\S*)$/.exec(text);
  const filtered = slashMatch
    ? commands.filter((c) => c.name.toLowerCase().startsWith((slashMatch[1] ?? '').toLowerCase())).slice(0, 8)
    : [];

  const submit = () => {
    const trimmed = text.trim();
    if (!trimmed && attachments.length === 0) return;
    const result = onSend(trimmed, attachments);
    if (result === false) return; // 页面层拦截 (如模型不支持图片) — 保留现场
    setText('');
    setAttachments([]);
    setAttachMenuOpen(false);
  };

  async function runPick(kind: 'camera' | 'library' | 'document') {
    if (picking) return;
    setPicking(true);
    setAttachMenuOpen(false);
    try {
      const result =
        kind === 'camera' ? await pickImageFromCamera() : kind === 'library' ? await pickImageFromLibrary() : await pickDocument();
      if (result.error) {
        Alert.alert('附件', result.error);
      } else if (result.attachment) {
        setAttachments((prev) => [...prev, result.attachment!]);
      }
    } finally {
      setPicking(false);
    }
  }

  function removeAttachment(index: number) {
    setAttachments((prev) => prev.filter((_, i) => i !== index));
  }

  const canSend = (text.trim().length > 0 || attachments.length > 0) && !disabled;

  return (
    <View style={styles.wrap}>
      {filtered.length > 0 && (
        <View style={styles.slashMenu}>
          <ScrollView keyboardShouldPersistTaps="always" style={{ maxHeight: 220 }}>
            {filtered.map((c) => (
              <Pressable
                key={c.name}
                onPress={() => setText(`/${c.name} `)}
                style={({ pressed }) => [styles.slashRow, pressed && { backgroundColor: ideColors.card2 }]}
              >
                <M size={11.5} weight="bold" color={colors.acc}>
                  /{c.name}
                </M>
                <T size={10.5} color={ideColors.dim} numberOfLines={1} style={{ flex: 1, marginLeft: 9 }}>
                  {c.description}
                  {c.input?.hint ? `  ‹${c.input.hint}›` : ''}
                </T>
              </Pressable>
            ))}
          </ScrollView>
        </View>
      )}

      {/* 附件菜单 */}
      {attachMenuOpen && (
        <View style={styles.attachMenu}>
          {(
            [
              { key: 'camera', glyph: '▣', label: '拍照' },
              { key: 'library', glyph: '▤', label: '相册图片' },
              { key: 'document', glyph: '▦', label: '选择文件' },
            ] as const
          ).map((it) => (
            <Pressable
              key={it.key}
              onPress={() => void runPick(it.key)}
              disabled={picking}
              style={({ pressed }) => [styles.attachRow, pressed && { backgroundColor: ideColors.card2 }]}
            >
              <M size={12} color={ideColors.text}>{it.glyph}</M>
              <T size={11.5} weight="medium" color={ideColors.text} style={{ marginLeft: 10 }}>{it.label}</T>
            </Pressable>
          ))}
          <M size={8.5} color={ideColors.faint} style={styles.attachHint}>
            图片 quality 0.7 · 文本文件限 200KB
          </M>
        </View>
      )}

      {/* 附件缩略条 */}
      {attachments.length > 0 && (
        <ScrollView horizontal keyboardShouldPersistTaps="always" style={styles.attachStrip} contentContainerStyle={{ gap: 8 }}>
          {attachments.map((a, i) => (
            <View key={`${a.fileName}-${i}`} style={styles.attachItem}>
              {a.kind === 'image' ? (
                <Image source={{ uri: a.uri }} style={styles.attachThumb} />
              ) : (
                <View style={styles.attachFileChip}>
                  <M size={9.5} color={ideColors.text} numberOfLines={1} style={{ maxWidth: 110 }}>
                    {a.fileName}
                  </M>
                </View>
              )}
              <Pressable onPress={() => removeAttachment(i)} hitSlop={6} style={styles.attachRemove}>
                <M size={8} weight="bold" color="#fff">×</M>
              </Pressable>
            </View>
          ))}
        </ScrollView>
      )}

      {holdHint && running && (
        <M size={9} color={ideColors.faint} style={styles.holdHint}>
          长按 ■ 停止当前任务
        </M>
      )}
      <View style={styles.inputBar}>
        <Pressable
          onPress={() => setAttachMenuOpen((v) => !v)}
          disabled={disabled || picking}
          style={({ pressed }) => [
            styles.attachBtn,
            attachMenuOpen && { backgroundColor: ideColors.blue },
            pressed && styles.sendBtnPressed,
            (disabled || picking) && { opacity: 0.35 },
          ]}
          accessibilityLabel="添加附件"
        >
          {picking ? (
            <ActivityIndicator size="small" color={attachMenuOpen ? '#fff' : ideColors.text} />
          ) : (
            <T size={14} weight="bold" color={attachMenuOpen ? '#fff' : ideColors.text}>＋</T>
          )}
        </Pressable>
        <TextInput
          ref={inputRef}
          style={[styles.input, { fontFamily: fonts.sans || undefined }]}
          value={text}
          onChangeText={setText}
          placeholder="输入消息，或 / 命令"
          placeholderTextColor={ideColors.faint}
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
            style={({ pressed }) => [styles.sendBtn, { backgroundColor: ideColors.card2 }, pressed && styles.sendBtnPressed]}
            accessibilityLabel="停止 — 长按"
          >
            <T size={12} weight="bold" color="#fff">■</T>
          </Pressable>
        ) : (
          <Pressable
            onPress={submit}
            disabled={!canSend}
            style={({ pressed }) => [
              styles.sendBtn,
              { backgroundColor: colors.acc },
              pressed && styles.sendBtnPressed,
              !canSend && { opacity: 0.35 },
            ]}
            accessibilityLabel="发送"
          >
            <T size={14} weight="bold" color="#fff">↑</T>
          </Pressable>
        )}
      </View>
    </View>
  );
});

Composer.displayName = 'Composer';

const styles = StyleSheet.create({
  wrap: {
    paddingHorizontal: 12,
    paddingBottom: 10,
    paddingTop: 2,
    backgroundColor: '#111114',
  },
  slashMenu: {
    backgroundColor: ideColors.shell,
    borderWidth: 1,
    borderColor: ideColors.border,
    borderRadius: 9,
    marginBottom: 8,
  },
  slashRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 10,
    paddingVertical: 9,
    borderBottomWidth: 1,
    borderBottomColor: ideColors.borderSoft,
  },
  attachMenu: {
    backgroundColor: ideColors.shell,
    borderWidth: 1,
    borderColor: ideColors.border,
    borderRadius: 9,
    marginBottom: 8,
  },
  attachRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 12,
    paddingVertical: 10,
    borderBottomWidth: 1,
    borderBottomColor: ideColors.borderSoft,
  },
  attachHint: {
    paddingHorizontal: 12,
    paddingVertical: 6,
  },
  attachStrip: {
    marginBottom: 8,
    flexGrow: 0,
  },
  attachItem: {
    position: 'relative',
    marginTop: 6,
    marginRight: 4,
  },
  attachThumb: {
    width: 46,
    height: 46,
    borderWidth: 1,
    borderColor: ideColors.border,
    borderRadius: 6,
    backgroundColor: ideColors.card2,
  },
  attachFileChip: {
    height: 46,
    minWidth: 70,
    maxWidth: 130,
    justifyContent: 'center',
    paddingHorizontal: 8,
    borderWidth: 1,
    borderColor: ideColors.border,
    borderRadius: 6,
    backgroundColor: ideColors.card,
  },
  attachRemove: {
    position: 'absolute',
    top: -6,
    right: -6,
    width: 16,
    height: 16,
    borderRadius: 8,
    backgroundColor: ideColors.red,
    alignItems: 'center',
    justifyContent: 'center',
  },
  holdHint: { textAlign: 'right', marginBottom: 4 },
  inputBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    backgroundColor: ideColors.shell,
    borderWidth: 1,
    borderColor: ideColors.border,
    borderRadius: 10,
    paddingLeft: 6,
    paddingRight: 6,
    paddingVertical: 6,
    gap: 8,
  },
  attachBtn: {
    width: 30,
    height: 30,
    alignItems: 'center',
    justifyContent: 'center',
    borderWidth: 1,
    borderColor: ideColors.border,
    borderRadius: 7,
    backgroundColor: ideColors.card,
  },
  input: {
    flex: 1,
    fontSize: 13,
    color: ideColors.text,
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
