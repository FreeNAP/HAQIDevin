/**
 * devin IDE 风格工具调用渲染 — 深色命令块 / 红绿逐行 diff / 输出折叠 / Worked for 耗时
 * 数据来源: chatReducer 归约后的 ToolItem (rawInput/rawOutput/content/_meta 已合并)
 */
import React from 'react';
import { ActivityIndicator, Clipboard, Pressable, StyleSheet, View } from 'react-native';
import { M } from './ui';
import type { ToolDiffData, ToolItem } from '../reducers/chatReducer';
import { diffLines, splitLines, type DiffLine } from '../util/lineDiff';

/** IDE 深色局部色板 — 只用于工具/思考卡, 不强改全 App 浅色 mono 主题 */
export const ideColors = {
  shell: '#17171b',
  card: '#202027',
  card2: '#24242c',
  border: '#34343c',
  borderSoft: '#2a2a31',
  text: '#e7e7eb',
  dim: '#90939b',
  faint: '#666a73',
  blue: '#78a6ff',
  green: '#8fce7a',
  red: '#ef6f73',
  yellow: '#d6b66a',
  output: '#9eb79f',
  addBg: '#1e3325',
  delBg: '#3a1f24',
  contextBg: 'transparent',
} as const;

const MAX_RENDER_CHARS = 50_000;
const OUTPUT_COLLAPSE_LINES = 8;
const DIFF_COLLAPSE_LINES = 30;
const DIFF_EDGE_LINES = 10;

interface CappedText {
  text: string;
  truncated: boolean;
  originalLength: number;
}

function capRenderText(text: string | undefined): CappedText {
  const source = text ?? '';
  return {
    text: source.length > MAX_RENDER_CHARS ? source.slice(0, MAX_RENDER_CHARS) : source,
    truncated: source.length > MAX_RENDER_CHARS,
    originalLength: source.length,
  };
}

function terminalStatus(status: string): boolean {
  return status === 'completed' || status === 'failed';
}

function activeStatus(status: string): boolean {
  return status === 'pending' || status === 'in_progress';
}

export function formatWorkDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) {
    const sec = ms / 1000;
    return `${sec < 10 ? sec.toFixed(1).replace(/\.0$/, '') : Math.round(sec)}s`;
  }
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
}

function useNow(active: boolean): number {
  const [now, setNow] = React.useState(() => Date.now());
  React.useEffect(() => {
    if (!active) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function workTimeLabel(item: ToolItem, now: number): string {
  if (terminalStatus(item.status)) {
    if (typeof item.durationMs === 'number') return `Worked for ${formatWorkDuration(item.durationMs)}`;
    return item.status === 'failed' ? 'Failed' : 'Completed';
  }
  if (activeStatus(item.status)) {
    if (typeof item.startedAtMs === 'number') {
      return `${item.status === 'pending' ? 'Waiting' : 'Working'} for ${formatWorkDuration(Math.max(0, now - item.startedAtMs))}`;
    }
    return item.status === 'pending' ? 'Waiting' : 'Working';
  }
  return item.status;
}

function StatusIcon({ status }: { status: string }) {
  if (status === 'completed') {
    return <M size={11} weight="bold" color={ideColors.green}>✓</M>;
  }
  if (status === 'failed') {
    return <M size={11} weight="bold" color={ideColors.red}>✕</M>;
  }
  if (status === 'in_progress') {
    return <ActivityIndicator size="small" color={ideColors.blue} style={styles.statusSpinner} />;
  }
  return <M size={10.5} color={ideColors.dim}>○</M>;
}

function CopyButton({ text, label }: { text?: string; label: string }) {
  const [copied, setCopied] = React.useState(false);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  if (!text) return null;
  return (
    <Pressable
      onPress={() => {
        Clipboard.setString(text);
        setCopied(true);
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => setCopied(false), 1200);
      }}
      hitSlop={8}
      style={({ pressed }) => [styles.copyBtn, pressed && { opacity: 0.65 }]}
      accessibilityLabel={`复制${label}`}
    >
      <M size={10.5} weight="bold" color={copied ? ideColors.green : ideColors.dim}>
        {copied ? '✓' : '⧉'}
      </M>
    </Pressable>
  );
}

function TruncationNote({ originalLength }: { originalLength: number }) {
  return (
    <M size={8.5} color={ideColors.yellow} style={styles.truncationNote}>
      源文本超过 50KB（{originalLength} 字符），仅显示前 50KB
    </M>
  );
}

function OutputPanel({ output, status }: { output?: string; status: string }) {
  const capped = React.useMemo(() => capRenderText(output), [output]);
  const lines = React.useMemo(() => splitLines(capped.text), [capped.text]);
  const collapsible = lines.length > OUTPUT_COLLAPSE_LINES || capped.text.length > 8_000;
  const [expanded, setExpanded] = React.useState(false);
  const open = !collapsible || expanded;
  const collapsedPreview = React.useMemo(() => {
    const first = lines.slice(0, 4).join('\n');
    return first.length > 1200 ? `${first.slice(0, 1200)}\n…` : first;
  }, [lines]);
  const visibleText = open ? capped.text : collapsedPreview;

  return (
    <View>
      <View style={styles.sectionDivider} />
      <View style={styles.outputHead}>
        <M size={10} weight="medium" color={ideColors.dim}>
          Output
        </M>
        <View style={styles.headActions}>
          {collapsible && (
            <Pressable onPress={() => setExpanded((v) => !v)} hitSlop={7} style={styles.inlineAction}>
              <M size={8.5} color={ideColors.blue}>
                {open ? '收起' : `展开 ${lines.length} 行`}
              </M>
            </Pressable>
          )}
          <CopyButton text={output} label="输出" />
        </View>
      </View>
      {output && output.length > 0 ? (
        <>
          <M size={10.5} color={ideColors.output} style={styles.outputText} selectable>
            {visibleText}
          </M>
          {!open && (
            <M size={8.5} color={ideColors.faint} style={styles.moreHint}>
              {lines.length > 4 ? `… 已折叠其余 ${lines.length - 4} 行` : '… 已折叠剩余输出'}
            </M>
          )}
          {capped.truncated && <TruncationNote originalLength={capped.originalLength} />}
        </>
      ) : (
        <M size={9} color={ideColors.faint} style={styles.emptyText}>
          {activeStatus(status) ? '等待输出…' : '(无输出)'}
        </M>
      )}
    </View>
  );
}

function CommandSection({ item, cwd }: { item: ToolItem; cwd?: string }) {
  const commandCap = React.useMemo(() => capRenderText(item.command), [item.command]);
  const effectiveCwd = item.cwd ?? cwd;
  return (
    <View style={styles.sectionCard}>
      <View style={styles.sectionHead}>
        <M size={9.5} weight="medium" color={ideColors.dim} numberOfLines={1} style={{ flex: 1 }}>
          Command{effectiveCwd ? ` in ${effectiveCwd}` : ''}
        </M>
        <View style={styles.headActions}>
          <StatusIcon status={item.status} />
          <CopyButton text={item.command} label="命令" />
        </View>
      </View>
      {item.command ? (
        <>
          <M size={11} weight="medium" color={ideColors.text} style={styles.commandText} selectable>
            {commandCap.text}
          </M>
          {commandCap.truncated && <TruncationNote originalLength={commandCap.originalLength} />}
        </>
      ) : (
        <M size={9} color={ideColors.faint} style={styles.emptyText}>
          (历史缓存中未保留命令原文)
        </M>
      )}
      {typeof item.exitCode === 'number' && item.exitCode !== 0 && (
        <M size={8.5} color={ideColors.red} style={styles.exitLine}>
          exit code {item.exitCode}{item.exitSignal ? ` · signal ${String(item.exitSignal)}` : ''}
        </M>
      )}
      <OutputPanel output={item.output} status={item.status} />
    </View>
  );
}

function diffLineSign(type: DiffLine['type']): string {
  return type === 'add' ? '+' : type === 'del' ? '-' : ' ';
}

function DiffLineRow({ line }: { line: DiffLine }) {
  const add = line.type === 'add';
  const del = line.type === 'del';
  return (
    <View style={[styles.diffLine, add && { backgroundColor: ideColors.addBg }, del && { backgroundColor: ideColors.delBg }]}>
      <M size={9.5} weight="bold" color={add ? ideColors.green : del ? ideColors.red : ideColors.faint} style={styles.diffSign}>
        {diffLineSign(line.type)}
      </M>
      <M
        size={9.5}
        color={add ? ideColors.green : del ? ideColors.red : ideColors.dim}
        style={[styles.diffText, line.type === 'context' && { opacity: 0.72 }]}
      >
        {line.text.length > 2000 ? `${line.text.slice(0, 2000)}…` : line.text.length > 0 ? line.text : ' '}
      </M>
    </View>
  );
}

function DiffRows({ lines }: { lines: DiffLine[] }) {
  return (
    <>
      {lines.map((line, index) => (
        <DiffLineRow key={`${index}:${line.type}:${line.text.length}`} line={line} />
      ))}
    </>
  );
}

function DiffBlock({ diff }: { diff: ToolDiffData }) {
  const oldCap = React.useMemo(() => capRenderText(diff.oldText), [diff.oldText]);
  const newCap = React.useMemo(() => capRenderText(diff.newText), [diff.newText]);
  const [showAll, setShowAll] = React.useState(false);

  const lines = React.useMemo(() => {
    if (typeof diff.oldText !== 'string') {
      return splitLines(newCap.text).map((text) => ({ type: 'add' as const, text }));
    }
    return diffLines(oldCap.text, newCap.text);
  }, [diff.oldText, oldCap.text, newCap.text]);

  const collapsible = lines.length > DIFF_COLLAPSE_LINES;
  const head = collapsible ? lines.slice(0, DIFF_EDGE_LINES) : lines;
  const tail = collapsible ? lines.slice(-DIFF_EDGE_LINES) : [];
  const truncated = (typeof diff.oldText === 'string' && oldCap.truncated) || newCap.truncated;

  return (
    <View style={styles.sectionCard}>
      <View style={styles.diffHead}>
        <M size={9.5} weight="medium" color={ideColors.blue} numberOfLines={2} style={styles.diffPath}>
          {diff.path}
        </M>
        <View style={styles.diffBadges}>
          {diff.fileDeleted && (
            <M size={8.5} weight="bold" color={ideColors.red} style={styles.deletedBadge}>
              deleted
            </M>
          )}
          <M size={9.5} weight="bold" color={ideColors.green}>+{diff.linesAdded}</M>
          <M size={9.5} weight="bold" color={ideColors.red}>−{diff.linesRemoved}</M>
        </View>
      </View>

      {truncated && (
        <M size={8.5} color={ideColors.yellow} style={styles.truncationNote}>
          源文本超过 50KB，仅显示前 50KB；行级 diff 基于截断内容
        </M>
      )}

      {lines.length === 0 ? (
        <M size={9} color={ideColors.faint} style={styles.emptyText}>
          空文件或二进制内容，无文本 diff
        </M>
      ) : !collapsible || showAll ? (
        <>
          <View style={styles.diffBody}>
            <DiffRows lines={lines} />
          </View>
          {collapsible && (
            <Pressable onPress={() => setShowAll(false)} hitSlop={7} style={styles.collapseButton}>
              <M size={9} weight="bold" color={ideColors.blue}>
                收起 diff
              </M>
            </Pressable>
          )}
        </>
      ) : (
        <>
          <View style={styles.diffBody}>
            <DiffRows lines={head} />
          </View>
          <Pressable onPress={() => setShowAll(true)} hitSlop={7} style={styles.collapseButton}>
            <M size={9} weight="bold" color={ideColors.blue}>
              显示全部 {lines.length} 行（已折叠 {lines.length - DIFF_EDGE_LINES * 2} 行）
            </M>
          </Pressable>
          <View style={styles.diffBody}>
            <DiffRows lines={tail} />
          </View>
        </>
      )}
    </View>
  );
}

function GenericSection({ item, compact }: { item: ToolItem; compact?: boolean }) {
  return (
    <View style={styles.sectionCard}>
      <View style={styles.sectionHead}>
        <M size={9.5} weight="medium" color={ideColors.dim} numberOfLines={1} style={{ flex: 1 }}>
          {item.inferenceName ?? item.name}{item.toolKind ? ` · ${item.toolKind}` : ''}
        </M>
      </View>
      {!compact && item.inputPreview ? (
        <M size={10} color={ideColors.text} style={styles.genericInput} selectable>
          {item.inputPreview}
        </M>
      ) : null}
      {!compact && item.paths.length > 0 && (
        <M size={9} color={ideColors.blue} numberOfLines={3} style={styles.genericPaths}>
          {item.paths.join('\n')}
        </M>
      )}
      {item.detail && !item.output && (
        <M size={9} color={ideColors.dim} numberOfLines={3} style={styles.emptyText}>
          {item.detail}
        </M>
      )}
      <OutputPanel output={item.output} status={item.status} />
    </View>
  );
}

function commandLike(item: ToolItem): boolean {
  const inference = (item.inferenceName ?? '').toLowerCase();
  const kind = (item.toolKind ?? item.name ?? '').toLowerCase();
  return Boolean(item.command)
    || kind === 'execute'
    || ['exec', 'bash', 'shell', 'execute', 'run_command', 'terminal'].includes(inference);
}

function displayTitle(item: ToolItem): string {
  if (item.title?.trim()) return item.title;
  if (item.inferenceName) return item.inferenceName;
  return item.name || 'tool';
}

export function IdeToolCallCard({ item, cwd }: { item: ToolItem; cwd?: string }) {
  const [open, setOpen] = React.useState(true);
  const active = activeStatus(item.status);
  const now = useNow(active);
  const isCommand = commandLike(item);
  const title = displayTitle(item);
  const work = workTimeLabel(item, now);

  return (
    <View style={styles.outer}>
      <View style={styles.shell}>
        <Pressable onPress={() => setOpen((v) => !v)} style={({ pressed }) => [styles.shellHead, pressed && { opacity: 0.78 }]}>
          <M size={10} color={ideColors.faint} style={styles.chevron}>
            {open ? '⌄' : '›'}
          </M>
          <View style={styles.statusSlot}>
            <StatusIcon status={item.status} />
          </View>
          <M size={9.5} color={active ? ideColors.blue : ideColors.dim} numberOfLines={1} style={styles.workText}>
            {work} · {title}
          </M>
          {item.hasDiff && (
            <M size={8.5} color={ideColors.faint} style={styles.headerDiffStat}>
              <M size={8.5} weight="bold" color={ideColors.green}>+{item.diffAdd}</M>
              {' '}
              <M size={8.5} weight="bold" color={ideColors.red}>−{item.diffDel}</M>
            </M>
          )}
        </Pressable>

        {open && (
          <View style={styles.shellBody}>
            <M size={10.5} weight="medium" color={ideColors.text} numberOfLines={2} style={styles.toolTitle}>
              {title}
            </M>
            {isCommand && <CommandSection item={item} cwd={cwd} />}
            {item.diffs.map((diff) => (
              <DiffBlock key={`${item.toolCallId}:${diff.path}`} diff={diff} />
            ))}
            {!isCommand && <GenericSection item={item} compact={item.diffs.length > 0} />}
          </View>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  outer: {
    width: '100%',
    marginBottom: 10,
  },
  shell: {
    backgroundColor: ideColors.shell,
    borderWidth: 1,
    borderColor: ideColors.borderSoft,
    borderRadius: 10,
    overflow: 'hidden',
  },
  shellHead: {
    minHeight: 31,
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: 9,
    paddingVertical: 6,
    gap: 6,
  },
  chevron: { width: 12 },
  statusSlot: { width: 16, alignItems: 'center', justifyContent: 'center' },
  statusSpinner: { transform: [{ scale: 0.55 }] },
  workText: { flex: 1, minWidth: 0 },
  headerDiffStat: { marginLeft: 5 },
  shellBody: {
    paddingHorizontal: 8,
    paddingBottom: 8,
    borderTopWidth: 1,
    borderTopColor: ideColors.borderSoft,
  },
  toolTitle: {
    marginTop: 7,
    marginBottom: 7,
    lineHeight: 15,
  },
  sectionCard: {
    backgroundColor: ideColors.card,
    borderWidth: 1,
    borderColor: ideColors.border,
    borderRadius: 9,
    paddingHorizontal: 9,
    paddingVertical: 8,
    marginBottom: 8,
  },
  sectionHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  headActions: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  copyBtn: {
    width: 24,
    height: 22,
    borderRadius: 5,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: ideColors.card2,
    borderWidth: 1,
    borderColor: ideColors.border,
  },
  commandText: {
    marginTop: 7,
    lineHeight: 16,
  },
  exitLine: { marginTop: 6 },
  sectionDivider: {
    height: 1,
    backgroundColor: ideColors.borderSoft,
    marginTop: 9,
    marginBottom: 6,
    marginHorizontal: -9,
  },
  outputHead: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: 8,
  },
  inlineAction: {
    paddingHorizontal: 4,
    paddingVertical: 2,
  },
  outputText: {
    marginTop: 5,
    lineHeight: 15,
  },
  moreHint: { marginTop: 4 },
  emptyText: {
    marginTop: 6,
    lineHeight: 14,
  },
  truncationNote: {
    marginTop: 6,
    lineHeight: 13,
  },
  diffHead: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: 8,
  },
  diffPath: {
    flex: 1,
    minWidth: 0,
    lineHeight: 14,
  },
  diffBadges: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 7,
    marginLeft: 6,
  },
  deletedBadge: {
    borderWidth: 1,
    borderColor: ideColors.red,
    borderRadius: 4,
    paddingHorizontal: 4,
    paddingVertical: 1,
    overflow: 'hidden',
  },
  diffBody: {
    marginTop: 7,
    borderRadius: 5,
    overflow: 'hidden',
    borderWidth: 1,
    borderColor: ideColors.borderSoft,
  },
  diffLine: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    paddingHorizontal: 5,
    paddingVertical: 1.5,
  },
  diffSign: {
    width: 13,
    marginRight: 2,
  },
  diffText: {
    flex: 1,
    lineHeight: 14,
  },
  collapseButton: {
    marginTop: 6,
    alignItems: 'center',
    paddingVertical: 6,
    borderWidth: 1,
    borderColor: ideColors.borderSoft,
    borderRadius: 5,
    backgroundColor: ideColors.card2,
  },
  genericInput: {
    marginTop: 7,
    lineHeight: 15,
  },
  genericPaths: {
    marginTop: 6,
    lineHeight: 14,
  },
});
