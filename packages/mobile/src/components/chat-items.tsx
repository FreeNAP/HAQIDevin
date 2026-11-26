/**
 * 聊天气泡与卡片 — 用户/agent 气泡保留高对比可读性;
 * 工具卡/思考/plan 使用 devin IDE 深色体系: 命令块、红绿 diff、折叠与耗时
 */
import React from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import { colors } from '../theme/colors';
import { T, M } from './ui';
import { Markdown } from './Markdown';
import { IdeToolCallCard, ideColors, formatWorkDuration } from './ide-tool-cards';
import type { UserItem, AgentItem, ThoughtItem, ToolItem, PlanItem, NoticeItem } from '../reducers/chatReducer';
import type { PlanEntry } from '../protocol/acp';

// ---------- 用户气泡 ----------

export function UserBubble({ item, onLongPress }: { item: UserItem; onLongPress?: () => void }) {
  return (
    <View style={styles.rowRight}>
      <Pressable style={styles.userBody} onLongPress={onLongPress} delayLongPress={420}>
        {item.pending && (
          <M size={8.5} color="rgba(250,250,247,0.6)" style={styles.pendingTag}>
            发送中…
          </M>
        )}
        <Markdown text={item.text} inverted />
        {item.deviceName ? (
          <M size={8.5} color="rgba(250,250,247,0.55)" style={styles.deviceTag}>
            来自 {item.deviceName}
          </M>
        ) : null}
      </Pressable>
    </View>
  );
}

// ---------- agent 气泡 (流式光标) ----------

function BlinkCursor() {
  const [on, setOn] = React.useState(true);
  React.useEffect(() => {
    const t = setInterval(() => setOn((v) => !v), 530);
    return () => clearInterval(t);
  }, []);
  return <T size={13} color={colors.acc} style={{ opacity: on ? 1 : 0 }}>▍</T>;
}

export function AgentBubble({ item, streaming, onLongPress }: { item: AgentItem; streaming?: boolean; onLongPress?: () => void }) {
  return (
    <View style={styles.rowLeft}>
      <Pressable style={[styles.agentBody, streaming && { borderColor: colors.acc }]} onLongPress={onLongPress} delayLongPress={420}>
        <Markdown text={item.text} inverted />
        {streaming && (
          <View style={{ position: 'absolute', right: 6, bottom: 4 }}>
            <BlinkCursor />
          </View>
        )}
      </Pressable>
    </View>
  );
}

// ---------- thought 折叠卡 (IDE 深色, 默认折叠) ----------

const THOUGHT_MAX_CHARS = 50_000;

export function ThoughtCard({ item }: { item: ThoughtItem }) {
  const [open, setOpen] = React.useState(false);
  const preview = item.text.trim().split('\n')[0] ?? '';
  const durationMs = typeof item.endTs === 'number' && item.endTs > item.ts ? item.endTs - item.ts : null;
  const truncated = item.text.length > THOUGHT_MAX_CHARS;
  const text = truncated ? item.text.slice(0, THOUGHT_MAX_CHARS) : item.text;
  return (
    <View style={styles.rowLeft}>
      <Pressable style={styles.thoughtCard} onPress={() => setOpen((v) => !v)}>
        <View style={styles.thoughtHead}>
          <M size={9.5} weight="medium" color={ideColors.dim}>
            Thoughts
          </M>
          {durationMs !== null && durationMs >= 250 && (
            <M size={8.5} color={ideColors.faint} style={{ marginLeft: 7 }}>
              {formatWorkDuration(durationMs)}
            </M>
          )}
          {!open && preview && (
            <M size={9} color={ideColors.faint} numberOfLines={1} style={{ flex: 1, marginLeft: 8 }}>
              {preview.length > 58 ? preview.slice(0, 55) + '…' : preview}
            </M>
          )}
          <M size={10} color={ideColors.faint} style={{ marginLeft: 'auto' }}>
            {open ? '⌄' : '›'}
          </M>
        </View>
        {open && (
          <View style={{ marginTop: 7 }}>
            <M size={9.5} color={ideColors.dim} style={styles.thoughtText} selectable>
              {text}
            </M>
            {truncated && (
              <M size={8.5} color={ideColors.yellow} style={{ marginTop: 5 }}>
                思考内容超过 50KB，仅显示前 50KB
              </M>
            )}
          </View>
        )}
      </Pressable>
    </View>
  );
}

// ---------- 工具卡 (devin IDE 深色渲染) ----------

export function ToolCallCard({ item, cwd }: { item: ToolItem; cwd?: string }) {
  return <IdeToolCallCard item={item} cwd={cwd} />;
}

// ---------- plan checklist ----------

function PlanRow({ entry }: { entry: PlanEntry }) {
  const done = entry.status === 'completed';
  const doing = entry.status === 'in_progress';
  return (
    <View style={styles.planRow}>
      <M
        size={11}
        weight={doing ? 'bold' : 'regular'}
        color={done ? ideColors.faint : doing ? ideColors.blue : ideColors.dim}
      >
        {done ? '✓' : doing ? '●' : '○'}
      </M>
      <T
        size={11.5}
        weight={doing ? 'bold' : 'regular'}
        color={done ? ideColors.faint : doing ? ideColors.blue : ideColors.dim}
        style={[done && { textDecorationLine: 'line-through' }, { flex: 1, marginLeft: 7 }]}
      >
        {entry.content}
      </T>
    </View>
  );
}

export function PlanCard({ item }: { item: PlanItem }) {
  const doneCount = item.entries.filter((e) => e.status === 'completed').length;
  return (
    <View style={styles.rowLeft}>
      <View style={styles.planCard}>
        <M size={9} color={ideColors.dim} uppercase ls={1} style={{ marginBottom: 7 }}>
          计划 · {doneCount}/{item.entries.length}
        </M>
        {item.entries.map((e, i) => (
          <PlanRow key={i} entry={e} />
        ))}
      </View>
    </View>
  );
}

// ---------- 行内通知 ----------

export function NoticeRow({ item }: { item: NoticeItem }) {
  const color = item.tone === 'error' ? ideColors.red : item.tone === 'warn' ? ideColors.yellow : ideColors.dim;
  return (
    <View style={styles.noticeRow}>
      <M size={9.5} color={color} uppercase ls={0.6}>
        — {item.text} —
      </M>
    </View>
  );
}

const styles = StyleSheet.create({
  rowRight: { flexDirection: 'row', justifyContent: 'flex-end', marginBottom: 10 },
  rowLeft: { flexDirection: 'row', justifyContent: 'flex-start', marginBottom: 10 },
  userBody: {
    maxWidth: '88%',
    backgroundColor: '#2a2a32',
    borderWidth: 1,
    borderColor: '#3c3c46',
    borderRadius: 11,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  pendingTag: { marginBottom: 3 },
  deviceTag: { marginTop: 5 },
  agentBody: {
    maxWidth: '88%',
    backgroundColor: ideColors.shell,
    borderWidth: 1,
    borderColor: ideColors.border,
    borderRadius: 11,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  thoughtCard: {
    maxWidth: '92%',
    minWidth: '58%',
    backgroundColor: ideColors.shell,
    borderWidth: 1,
    borderColor: ideColors.borderSoft,
    borderRadius: 9,
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  thoughtHead: { flexDirection: 'row', alignItems: 'center' },
  thoughtText: { lineHeight: 15 },
  planCard: {
    maxWidth: '92%',
    minWidth: '70%',
    backgroundColor: ideColors.shell,
    borderWidth: 1,
    borderColor: ideColors.borderSoft,
    borderRadius: 9,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  planRow: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 3 },
  noticeRow: { alignItems: 'center', marginBottom: 10 },
});
