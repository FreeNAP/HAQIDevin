/**
 * 会话列表 store — 元数据按 lastActiveAt 排序, 待审批角标统计
 */
import { create } from 'zustand';
import type { SessionMeta } from '../protocol/wire';

export type SessionFilter = 'all' | 'running' | 'waiting' | 'done';

interface SessionsState {
  sessions: Record<string, SessionMeta>;
  filter: SessionFilter;

  setAll: (list: SessionMeta[]) => void;
  upsert: (meta: SessionMeta) => void;
  patchStatus: (sessionId: string, status: SessionMeta['status'], title?: string | null) => void;
  touchActivity: (sessionId: string, lastActiveAt: number, lastSeq: number) => void;
  setPendingPermission: (sessionId: string, pending: boolean) => void;
  setFilter: (f: SessionFilter) => void;
  clear: () => void;
}

export const useSessionsStore = create<SessionsState>((set) => ({
  sessions: {},
  filter: 'all',

  setAll: (list) => {
    const sessions: Record<string, SessionMeta> = {};
    for (const s of list) sessions[s.sessionId] = s;
    set({ sessions });
  },
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
  clear: () => set({ sessions: {}, filter: 'all' }),
}));

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
