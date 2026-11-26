/**
 * 每会话聊天状态 store — 事件经纯 reducer 归约, key 为 sessionId
 * reducer 纯函数在 src/reducers/chatReducer.ts, 本文件只做 zustand 封装
 */
import { create } from 'zustand';
import type { SessionEvent, PendingPermission } from '../protocol/wire';
import {
  ChatState,
  SnapshotInput,
  initChatState,
  applyEvent,
  applySnapshot,
  addPendingPermission,
  resolvePermission,
  applyOptimisticUserMessage,
  applyHistoryBatch,
} from '../reducers/chatReducer';

interface ChatStoreState {
  bySession: Record<string, ChatState>;

  ensure: (sessionId: string) => void;
  applyEventMsg: (event: SessionEvent) => void;
  applySnapshotMsg: (sessionId: string, snap: SnapshotInput, reset: boolean) => void;
  applyHistoryPage: (sessionId: string, events: SessionEvent[], hasMore: boolean) => void;
  addPermission: (perm: PendingPermission) => void;
  resolvePermissionMsg: (sessionId: string, requestId: string, info: { byDevice: string; optionId?: string; cancelled?: boolean }) => void;
  optimisticUser: (sessionId: string, text: string, clientMsgId: string) => void;
  setSessionStatus: (sessionId: string, status: ChatState['status']) => void;
  optimisticConfigValue: (sessionId: string, configId: string, value: string) => void;
  optimisticMode: (sessionId: string, modeId: string) => void;
  clearSession: (sessionId: string) => void;
  clearAll: () => void;
}

export const useChatStore = create<ChatStoreState>((set) => ({
  bySession: {},

  ensure: (sessionId) =>
    set((st) => {
      if (st.bySession[sessionId]) return st;
      return { bySession: { ...st.bySession, [sessionId]: initChatState(sessionId) } };
    }),

  applyEventMsg: (event) =>
    set((st) => {
      const sid = event.sessionId;
      const prev = st.bySession[sid] ?? initChatState(sid);
      const next = applyEvent(prev, event);
      if (next === prev && st.bySession[sid]) return st;
      return { bySession: { ...st.bySession, [sid]: next } };
    }),

  applySnapshotMsg: (sessionId, snap, reset) =>
    set((st) => {
      const prev = st.bySession[sessionId] ?? initChatState(sessionId);
      const next = applySnapshot(prev, snap, reset);
      return { bySession: { ...st.bySession, [sessionId]: next } };
    }),

  applyHistoryPage: (sessionId, events, hasMore) =>
    set((st) => {
      const prev = st.bySession[sessionId] ?? initChatState(sessionId);
      const next = applyHistoryBatch(prev, events, hasMore);
      if (next === prev && st.bySession[sessionId]) return st;
      return { bySession: { ...st.bySession, [sessionId]: next } };
    }),

  addPermission: (perm) =>
    set((st) => {
      const sid = perm.sessionId;
      const prev = st.bySession[sid] ?? initChatState(sid);
      return { bySession: { ...st.bySession, [sid]: addPendingPermission(prev, perm) } };
    }),

  resolvePermissionMsg: (sessionId, requestId, info) =>
    set((st) => {
      const prev = st.bySession[sessionId];
      if (!prev) return st;
      return { bySession: { ...st.bySession, [sessionId]: resolvePermission(prev, requestId, info) } };
    }),

  optimisticUser: (sessionId, text, clientMsgId) =>
    set((st) => {
      const prev = st.bySession[sessionId] ?? initChatState(sessionId);
      return { bySession: { ...st.bySession, [sessionId]: applyOptimisticUserMessage(prev, text, clientMsgId) } };
    }),

  setSessionStatus: (sessionId, status) =>
    set((st) => {
      const prev = st.bySession[sessionId];
      if (!prev || prev.status === status) return st;
      return { bySession: { ...st.bySession, [sessionId]: { ...prev, status } } };
    }),

  optimisticConfigValue: (sessionId, configId, value) =>
    set((st) => {
      const prev = st.bySession[sessionId];
      if (!prev) return st;
      const configOptions = prev.configOptions.map((o) => (o.id === configId ? { ...o, currentValue: value } : o));
      const currentModeId = configId === 'mode' ? value : prev.currentModeId;
      return { bySession: { ...st.bySession, [sessionId]: { ...prev, configOptions, currentModeId } } };
    }),

  optimisticMode: (sessionId, modeId) =>
    set((st) => {
      const prev = st.bySession[sessionId];
      if (!prev) return st;
      return { bySession: { ...st.bySession, [sessionId]: { ...prev, currentModeId: modeId } } };
    }),

  clearSession: (sessionId) =>
    set((st) => {
      if (!st.bySession[sessionId]) return st;
      const copy = { ...st.bySession };
      delete copy[sessionId];
      return { bySession: copy };
    }),

  clearAll: () => set({ bySession: {} }),
}));

/** 当前各会话待审批总数 (tab 角标) */
export function totalPendingCount(bySession: Record<string, ChatState>): number {
  let n = 0;
  for (const sid of Object.keys(bySession)) {
    n += bySession[sid]!.pendingPermissions.length;
  }
  return n;
}
