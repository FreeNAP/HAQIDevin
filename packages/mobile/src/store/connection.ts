/**
 * 连接状态 store — 状态机:
 *   boot → idle → connecting → (unpaired → pairing) | (authenticating) → authed
 *                       ↓ error / disconnected(自动重连中)
 * 不在 store 中保存 deviceSecret (仅存在于 ws client 闭包与 SecureStore)
 */
import { create } from 'zustand';
import type { ServerStatus, DeviceInfo } from '../protocol/wire';
import type { HostEntry } from './storage';

export type ConnPhase =
  | 'boot'            // 启动加载持久化数据中
  | 'idle'            // 无活跃主机 / 未连接
  | 'connecting'      // socket 建连中 (含断线重连)
  | 'unpaired'        // socket 已通, 设备未配对, 等待配对码
  | 'pairing'         // 配对请求已发出
  | 'authenticating'  // HMAC 挑战响应进行中
  | 'authed'          // 已连接可用
  | 'error';          // 错误 (message 中说明)

export interface WorkdirEntry {
  path: string;
  label?: string;
  exists?: boolean;
}

interface ConnectionState {
  phase: ConnPhase;
  errorMessage: string | null;
  hosts: HostEntry[];
  activeHost: HostEntry | null;
  latencyMs: number | null;
  serverStatus: ServerStatus | null;
  devices: DeviceInfo[];
  workdirs: WorkdirEntry[];
  selfDeviceId: string | null;
  selfDeviceName: string | null;
  serverVersion: string | null;
  reconnectAttempt: number;

  setPhase: (phase: ConnPhase, errorMessage?: string | null) => void;
  setHosts: (hosts: HostEntry[]) => void;
  setActiveHost: (host: HostEntry | null) => void;
  setLatency: (ms: number | null) => void;
  setServerStatus: (s: ServerStatus | null) => void;
  setDevices: (d: DeviceInfo[]) => void;
  setWorkdirs: (w: WorkdirEntry[]) => void;
  setIdentity: (deviceId: string | null, deviceName: string | null) => void;
  setServerVersion: (v: string | null) => void;
  setReconnectAttempt: (n: number) => void;
}

export const useConnectionStore = create<ConnectionState>((set) => ({
  phase: 'boot',
  errorMessage: null,
  hosts: [],
  activeHost: null,
  latencyMs: null,
  serverStatus: null,
  devices: [],
  workdirs: [],
  selfDeviceId: null,
  selfDeviceName: null,
  serverVersion: null,
  reconnectAttempt: 0,

  setPhase: (phase, errorMessage = null) => set({ phase, errorMessage }),
  setHosts: (hosts) => set({ hosts }),
  setActiveHost: (activeHost) => set({ activeHost }),
  setLatency: (latencyMs) => set({ latencyMs }),
  setServerStatus: (serverStatus) => set({ serverStatus }),
  setDevices: (devices) => set({ devices }),
  setWorkdirs: (workdirs) => set({ workdirs }),
  setIdentity: (selfDeviceId, selfDeviceName) => set({ selfDeviceId, selfDeviceName }),
  setServerVersion: (serverVersion) => set({ serverVersion }),
  setReconnectAttempt: (reconnectAttempt) => set({ reconnectAttempt }),
}));

/** 状态机中文文案 (连接页状态展示用) */
export function phaseLabel(phase: ConnPhase): string {
  switch (phase) {
    case 'boot': return '启动中';
    case 'idle': return '未连接';
    case 'connecting': return '连接中';
    case 'unpaired': return '等待配对';
    case 'pairing': return '配对中';
    case 'authenticating': return '鉴权中';
    case 'authed': return '已连接';
    case 'error': return '错误';
  }
}
