/**
 * 持久化层:
 *  - 主机清单 / 当前主机: AsyncStorage (非敏感)
 *  - 设备凭据 deviceId+deviceSecret: expo-secure-store (Android Keystore / iOS Keychain)
 * deviceSecret 绝不进日志, 不落 AsyncStorage
 */
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as SecureStore from 'expo-secure-store';
import { sha256Hex } from '../crypto/sha256';

export interface HostEntry {
  id: string;            // 稳定 id (url 的 sha256 前 16 位)
  url: string;           // 规范化后的 ws(s)://host[:port]/ws
  label: string;         // 用户输入的原始主机名 (展示用)
  addedAt: number;
  lastUsedAt: number;
}

export interface DeviceCredentials {
  deviceId: string;
  deviceSecret: string;
  deviceName: string;
}

const HOSTS_KEY = '@dr/hosts';
const ACTIVE_KEY = '@dr/activeHostId';

export function hostIdFor(url: string): string {
  return sha256Hex(url).slice(0, 16);
}

function credKey(hostId: string): string {
  // expo-secure-store key 约束: 字母数字 . _ -
  return `dr_cred_${hostId}`;
}

// ---------- 主机清单 ----------

export async function loadHosts(): Promise<HostEntry[]> {
  try {
    const raw = await AsyncStorage.getItem(HOSTS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as HostEntry[];
    return Array.isArray(arr) ? arr.filter((h) => h && typeof h.url === 'string') : [];
  } catch {
    return [];
  }
}

export async function saveHosts(hosts: HostEntry[]): Promise<void> {
  await AsyncStorage.setItem(HOSTS_KEY, JSON.stringify(hosts));
}

export async function loadActiveHostId(): Promise<string | null> {
  try {
    return await AsyncStorage.getItem(ACTIVE_KEY);
  } catch {
    return null;
  }
}

export async function saveActiveHostId(id: string | null): Promise<void> {
  if (id === null) await AsyncStorage.removeItem(ACTIVE_KEY);
  else await AsyncStorage.setItem(ACTIVE_KEY, id);
}

// ---------- 设备凭据 (安全存储) ----------

export async function saveCredentials(hostId: string, cred: DeviceCredentials): Promise<void> {
  await SecureStore.setItemAsync(credKey(hostId), JSON.stringify(cred));
}

export async function loadCredentials(hostId: string): Promise<DeviceCredentials | null> {
  try {
    const raw = await SecureStore.getItemAsync(credKey(hostId));
    if (!raw) return null;
    const obj = JSON.parse(raw) as DeviceCredentials;
    if (typeof obj.deviceId === 'string' && typeof obj.deviceSecret === 'string') return obj;
    return null;
  } catch {
    return null;
  }
}

export async function deleteCredentials(hostId: string): Promise<void> {
  try {
    await SecureStore.deleteItemAsync(credKey(hostId));
  } catch {
    // key 不存在等情况忽略
  }
}
