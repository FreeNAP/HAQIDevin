/**
 * 会话列表 store — 元数据按 lastActiveAt 排序, 待审批角标统计
 * devinSessions: devin 侧全部会话 (含未加载到 server 的), 由 devinSession.list 驱动
 */
import { create } from 'zustand';
import type { SessionMeta, DevinSessionInfo } from '../protocol/wire';

export type SessionFilter = 'all' | 'running' | 'waiting' | 'done';

interface SessionsState {
  sessions: Record<string, SessionMeta>;
  devinSessions: DevinSessionInfo[];
  devinListLoaded: boolean;   // 是否已收到过 devinSession.list 响应 (区分加载中与真空)
  filter: SessionFilter;

  setAll: (list: SessionMeta[]) => void;
  setDevinSessions: (list: DevinSessionInfo[]) => void;
  upsert: (meta: SessionMeta) => void;
  patchStatus: (sessionId: string, status: SessionMeta['status'], title?: string | null) => void;
  touchActivity: (sessionId: string, lastActiveAt: number, lastSeq: number) => void;
  setPendingPermission: (sessionId: string, pending: boolean) => void;
  setFilter: (f: SessionFilter) => void;
  clear: () => void;
}

export const useSessionsStore = create<SessionsState>((set) => ({
  sessions: {},
  devinSessions: [],
  devinListLoaded: false,
  filter: 'all',

  setAll: (list) => {
    const sessions: Record<string, SessionMeta> = {};
    for (const s of list) sessions[s.sessionId] = s;
    set({ sessions });
  },
  setDevinSessions: (list) => set({ devinSessions: list, devinListLoaded: true }),
  upsert: (meta) => set((st) => ({ sessions: { ...st.sessions, [meta.sessionId]: meta } })),
  patchStatus: (sessionId, status, title) =>
    set((st) => {
      const prev = st.sessions[sessionId];
      if (!prev) return st;
      return {
        sessions: {
          ...st.sessions,
          [sessionId]: {
            ...prev,
            status,
            title: title === undefined ? prev.title : title,
            hasPendingPermission: status === 'waiting_permission' ? true : status === 'running' || status === 'idle' ? false : prev.hasPendingPermission,
          },
        },
      };
    }),
  touchActivity: (sessionId, lastActiveAt, lastSeq) =>
    set((st) => {
      const prev = st.sessions[sessionId];
      if (!prev) return st;
      return {
        sessions: {
          ...st.sessions,
          [sessionId]: { ...prev, lastActiveAt, lastSeq },
        },
      };
    }),
  setPendingPermission: (sessionId, pending) =>
    set((st) => {
      const prev = st.sessions[sessionId];
      if (!prev || prev.hasPendingPermission === pending) return st;
      return {
        sessions: {
          ...st.sessions,
          [sessionId]: { ...prev, hasPendingPermission: pending },
        },
      };
    }),
  setFilter: (filter) => set({ filter }),
  clear: () => set({ sessions: {}, devinSessions: [], devinListLoaded: false, filter: 'all' }),
}));

// ---------- 合并视图: devin 侧全量会话 ∪ server 已加载会话 ----------

export interface MergedSessionRow {
  sessionId: string;
  title: string | null;
  cwd: string;
  /** 展示/排序用时间 (ms): devin updatedAt 与 server lastActiveAt 取新 */
  sortTs: number;
  isLocked: boolean;
  additionalDirectories?: string[];
  /** devinSession.list 原始条目 — session.load 透传用; 仅 server 侧有的行无此字段 */
  devinInfo?: DevinSessionInfo;
  /** 已加载到 server 的实时元数据; undefined = 未加载 */
  loaded?: SessionMeta;
}

function parseIsoMs(iso: string | undefined): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

/**
 * 合并 devinSession.list (全量) 与 session.list (已加载) 为统一行模型:
 *  - 同 id 两行合并, loaded 携带状态/角标
 *  - server 有而 devin 列表没有的会话 (如手机端刚新建) 也并入
 *  - 按活动时间降序
 */
export function mergeSessionRows(
  devinSessions: DevinSessionInfo[],
  sessions: Record<string, SessionMeta>,
): MergedSessionRow[] {
  const rows = new Map<string, MergedSessionRow>();
  for (const d of devinSessions) {
    const loaded = sessions[d.sessionId];
    const devinTs = parseIsoMs(d.updatedAt);
    rows.set(d.sessionId, {
      sessionId: d.sessionId,
      title: loaded?.title ?? d.title ?? null,
      cwd: d.cwd || loaded?.cwd || '',
      sortTs: Math.max(devinTs, loaded?.lastActiveAt ?? 0),
      isLocked: d.isLocked === true,
      additionalDirectories: d.additionalDirectories,
      devinInfo: d,
      loaded,
    });
  }
  for (const s of Object.values(sessions)) {
    if (rows.has(s.sessionId)) continue;
    rows.set(s.sessionId, {
      sessionId: s.sessionId,
      title: s.title,
      cwd: s.cwd,
      sortTs: s.lastActiveAt,
      isLocked: false,
      loaded: s,
    });
  }
  return Array.from(rows.values()).sort((a, b) => b.sortTs - a.sortTs);
}

/** 合并行视图上的过滤: 状态过滤仅命中已加载行, all 显示全部 */
export function filterMergedRows(rows: MergedSessionRow[], filter: SessionFilter): MergedSessionRow[] {
  switch (filter) {
    case 'all':
      return rows.filter((r) => r.loaded?.status !== 'closed');
    case 'running':
      return rows.filter((r) => r.loaded?.status === 'running');
    case 'waiting':
      return rows.filter((r) => r.loaded?.status === 'waiting_permission' || r.loaded?.hasPendingPermission === true);
    case 'done':
      return rows.filter((r) => r.loaded && (r.loaded.status === 'idle' || r.loaded.status === 'closed'));
    default:
      return rows;
  }
}

// ---------- selectors ----------

export function sortedSessions(sessions: Record<string, SessionMeta>): SessionMeta[] {
  return Object.values(sessions).sort((a, b) => b.lastActiveAt - a.lastActiveAt);
}

export function filterSessions(list: SessionMeta[], filter: SessionFilter): SessionMeta[] {
  switch (filter) {
    case 'all':
      return list.filter((s) => s.status !== 'closed');
    case 'running':
      return list.filter((s) => s.status === 'running');
    case 'waiting':
      return list.filter((s) => s.status === 'waiting_permission' || s.hasPendingPermission);
    case 'done':
      return list.filter((s) => s.status === 'idle' || s.status === 'closed');
    default:
      return list;
  }
}

export function waitingCount(sessions: Record<string, SessionMeta>): number {
  return Object.values(sessions).filter((s) => s.status === 'waiting_permission' || s.hasPendingPermission).length;
}
