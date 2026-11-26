/**
 * 聊天气泡与卡片 — 对照 mockup 界面 2/3:
 *  - 用户气泡: 黑底白字靠右; agent 气泡: 白底黑框靠左, 流式时朱红边框+闪烁光标
 *  - 工具卡: 左侧 3px 黑条, mono 工具名+状态, diff 摘要 +X −Y
 *  - plan checklist; thought 折叠卡; notice 行内通知
 */
import React from 'react';
import { View, Pressable, StyleSheet } from 'react-native';
import { colors } from '../theme/colors';
import { T, M } from './ui';
import { Markdown } from './Markdown';
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
        <Markdown text={item.text} />
        {streaming && (
          <View style={{ position: 'absolute', right: 6, bottom: 4 }}>
            <BlinkCursor />
          </View>
        )}
      </Pressable>
    </View>
  );
}

// ---------- thought 折叠卡 ----------

export function ThoughtCard({ item }: { item: ThoughtItem }) {
  const [open, setOpen] = React.useState(false);
  const preview = item.text.trim().split('\n')[0] ?? '';
  return (
    <View style={styles.rowLeft}>
      <Pressable style={styles.thoughtCard} onPress={() => setOpen((v) => !v)}>
        <View style={styles.thoughtHead}>
          <M size={9} weight="medium" color={colors.ink3} uppercase ls={1}>
            思考 {open ? '−' : '+'}
          </M>
          {!open && (
            <M size={9.5} color={colors.ink3} numberOfLines={1} style={{ flex: 1, marginLeft: 8 }}>
              {preview.length > 60 ? preview.slice(0, 57) + '…' : preview}
            </M>
          )}
        </View>
        {open && (
          <View style={{ marginTop: 6 }}>
            <Markdown text={item.text} />
          </View>
        )}
      </Pressable>
    </View>
  );
}

// ---------- 工具卡 ----------

function toolStatusText(status: string): { text: string; color: string } {
  switch (status) {
    case 'completed':
      return { text: '✓ 完成', color: colors.ok };
    case 'failed':
      return { text: '✗ 失败', color: colors.danger };
    case 'in_progress':
      return { text: '● 执行中', color: colors.acc };
    case 'pending':
      return { text: '○ 等待', color: colors.ink3 };
    default:
      return { text: status, color: colors.ink3 };
  }
}

export function ToolCallCard({ item }: { item: ToolItem }) {
  const [open, setOpen] = React.useState(false);
  const st = toolStatusText(item.status);
  const pathLine = item.paths.join('  ');
  return (
    <View style={styles.rowLeft}>
      <Pressable
        style={styles.toolCard}
        onPress={() => setOpen((v) => !v)}
        disabled={!item.detail && !item.title}
      >
        <View style={styles.toolHead}>
          <M size={11} weight="bold" color={colors.ink}>
            {item.name}
          </M>
          <M size={9.5} color={st.color}>
            {st.text}
          </M>
        </View>
        {pathLine.length > 0 && (
          <M size={9.5} color={colors.ink2} style={styles.toolDetail} numberOfLines={2}>
            {pathLine}
            {item.hasDiff && (
              <>
                {'  '}
                <T mono size={9.5} weight="bold" color={colors.ok}>+{item.diffAdd}</T>
                {' '}
                <T mono size={9.5} weight="bold" color={colors.danger}>−{item.diffDel}</T>
              </>
            )}
          </M>
        )}
        {!pathLine && item.hasDiff && (
          <M size={9.5} style={styles.toolDetail}>
            <T mono size={9.5} weight="bold" color={colors.ok}>+{item.diffAdd}</T>
            {' '}
            <T mono size={9.5} weight="bold" color={colors.danger}>−{item.diffDel}</T>
          </M>
        )}
        {open && item.title ? (
          <M size={9.5} color={colors.ink2} style={styles.toolDetail}>
            {item.title}
          </M>
        ) : null}
        {open && item.detail ? (
          <M size={9.5} color={colors.ink2} style={styles.toolDetail} numberOfLines={4}>
            {item.detail}
          </M>
        ) : null}
      </Pressable>
    </View>
  );
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
        color={done ? colors.ink3 : doing ? colors.acc : colors.ink2}
      >
        {done ? '✓' : doing ? '●' : '○'}
      </M>
      <T
        size={11.5}
        weight={doing ? 'bold' : 'regular'}
        color={done ? colors.ink3 : doing ? colors.acc : colors.ink2}
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
        <M size={9} color={colors.ink3} uppercase ls={1} style={{ marginBottom: 7 }}>
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
  const color = item.tone === 'error' ? colors.danger : item.tone === 'warn' ? colors.warn : colors.ink3;
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
    backgroundColor: colors.ink,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  pendingTag: { marginBottom: 3 },
  deviceTag: { marginTop: 5 },
  agentBody: {
    maxWidth: '88%',
    backgroundColor: colors.card,
    borderWidth: 1.5,
    borderColor: colors.ink,
    paddingHorizontal: 12,
    paddingVertical: 9,
  },
  thoughtCard: {
    maxWidth: '88%',
    backgroundColor: colors.paper2,
    borderWidth: 1,
    borderColor: colors.hairline,
    borderStyle: 'dashed',
    paddingHorizontal: 10,
    paddingVertical: 7,
  },
  thoughtHead: { flexDirection: 'row', alignItems: 'center' },
  toolCard: {
    maxWidth: '92%',
    minWidth: '62%',
    backgroundColor: colors.card,
    borderWidth: 1,
    borderColor: colors.hairline,
    borderLeftWidth: 3,
    borderLeftColor: colors.ink,
    paddingHorizontal: 10,
    paddingVertical: 8,
  },
  toolHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 },
  toolDetail: { marginTop: 5 },
  planCard: {
    maxWidth: '92%',
    minWidth: '70%',
    backgroundColor: colors.card,
    borderWidth: 1.5,
    borderColor: colors.ink,
    paddingHorizontal: 12,
    paddingVertical: 10,
  },
  planRow: { flexDirection: 'row', alignItems: 'flex-start', paddingVertical: 3 },
  noticeRow: { alignItems: 'center', marginBottom: 10 },
});
