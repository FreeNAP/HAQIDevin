/**
 * 本地通知 — App 在后台收到 permission.request 时触发
 * 全部调用 try/catch 包裹: Expo Go / 未授权 / 模拟器环境下静默降级, 不影响主流程
 */
import { AppState, Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import type { PendingPermission } from './protocol/wire';

let configured = false;
let permissionGranted = false;

/** 提取权限请求的关键命令/路径用于通知正文 */
function permSummary(perm: PendingPermission): string {
  const raw = perm.toolCall.rawInput;
  if (raw) {
    for (const key of ['command', 'cmd', 'path', 'file', 'query']) {
      const v = raw[key];
      if (typeof v === 'string' && v) return v.length > 80 ? v.slice(0, 77) + '…' : v;
      if (Array.isArray(v) && v.every((x) => typeof x === 'string')) {
        const joined = (v as string[]).join(' ');
        return joined.length > 80 ? joined.slice(0, 77) + '…' : joined;
      }
    }
  }
  return perm.toolCall.title ?? perm.toolCall.kind ?? '工具调用';
}

export async function setupNotifications(): Promise<void> {
  if (configured) return;
  configured = true;
  try {
    Notifications.setNotificationHandler({
      handleNotification: async () => ({
        shouldShowAlert: true,
        shouldPlaySound: true,
        shouldSetBadge: true,
        shouldShowBanner: true,
        shouldShowList: true,
      }),
    });
    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('permission', {
        name: '权限审批',
        importance: Notifications.AndroidImportance.HIGH,
        vibrationPattern: [0, 250, 250, 250],
      });
    }
    const perm = await Notifications.getPermissionsAsync();
    if (perm.granted) {
      permissionGranted = true;
    } else {
      const req = await Notifications.requestPermissionsAsync();
      permissionGranted = req.granted;
    }
  } catch {
    permissionGranted = false;
  }
}

/** App 在后台时, 权限请求触发本地通知; 前台静默 (UI 卡片已展示) */
export async function notifyPermissionRequest(perm: PendingPermission): Promise<void> {
  if (AppState.currentState === 'active') return;
  if (!permissionGranted) return;
  try {
    const toolLabel = perm.toolCall.kind ?? perm.toolCall.title ?? 'tool';
    await Notifications.scheduleNotificationAsync({
      content: {
        title: 'Devin 需要你的批准',
        body: `${toolLabel} · ${permSummary(perm)}`,
        sound: true,
        ...(Platform.OS === 'android' ? { channelId: 'permission' } : {}),
      },
      trigger: null, // 立即
    });
  } catch {
    // 通知调度失败不影响业务
  }
}
