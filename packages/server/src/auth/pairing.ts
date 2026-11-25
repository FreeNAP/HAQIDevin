import { randomBytes, createHmac, timingSafeEqual, randomUUID } from 'node:crypto';
import type { Store, DeviceRecord } from '../store/db.js';

/**
 * 配对与设备鉴权
 *  - 配对码: XXXX-XXXX 8位 Crockford base32 (去混淆字符), 5分钟一次性
 *  - 防爆破: 每远程地址 1分钟5次尝试, 累计失败10次锁15分钟
 *  - 设备证书: deviceId + deviceSecret(32B random), HMAC-SHA256 挑战响应
 *  - 30天未活跃设备自动失效 (需重新配对)
 */

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // Crockford, 无 0O1IL
const CODE_TTL_MS = 5 * 60 * 1000;
const DEVICE_IDLE_EXPIRY_MS = 30 * 24 * 60 * 60 * 1000;

export function generatePairingCode(): string {
  const bytes = randomBytes(8);
  let raw = '';
  for (let i = 0; i < 8; i++) raw += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return `${raw.slice(0, 4)}-${raw.slice(4)}`;
}

export function normalizeCode(input: string): string {
  return input.trim().toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^(.{4})(.{4}).*/, '$1-$2');
}

// ---------- 防爆破 ----------

interface AttemptRecord {
  count: number;
  windowStart: number;
  failures: number;
  lockedUntil: number;
}

export class PairingGuard {
  private attempts = new Map<string, AttemptRecord>();

  checkAllowed(remoteKey: string): { allowed: boolean; retryAfterSec?: number } {
    const rec = this.attempts.get(remoteKey);
    if (!rec) return { allowed: true };
    if (rec.lockedUntil > Date.now()) {
      return { allowed: false, retryAfterSec: Math.ceil((rec.lockedUntil - Date.now()) / 1000) };
    }
    return { allowed: true };
  }

  recordAttempt(remoteKey: string, success: boolean): void {
    const now = Date.now();
    let rec = this.attempts.get(remoteKey);
    if (!rec) {
      rec = { count: 0, windowStart: now, failures: 0, lockedUntil: 0 };
      this.attempts.set(remoteKey, rec);
    }
    if (now - rec.windowStart > 60_000) {
      rec.count = 0;
      rec.windowStart = now;
    }
    rec.count++;
    if (!success) {
      rec.failures++;
      if (rec.failures >= 10) {
        rec.lockedUntil = now + 15 * 60_000;
        rec.failures = 0;
      }
    }
  }

  rateLimited(remoteKey: string): boolean {
    const rec = this.attempts.get(remoteKey);
    if (!rec) return false;
    if (Date.now() - rec.windowStart > 60_000) return false;
    return rec.count > 5;
  }
}

// ---------- 设备证书 ----------

export function issueDevice(deviceName: string, platform?: string): DeviceRecord {
  return {
    deviceId: randomUUID(),
    deviceName: deviceName.slice(0, 80) || 'unknown device',
    platform,
    deviceSecret: randomBytes(32).toString('hex'),
    pairedAt: Date.now(),
    lastActiveAt: Date.now(),
  };
}

export function deviceUsable(d: DeviceRecord): { ok: boolean; reason?: string } {
  if (d.revokedAt) return { ok: false, reason: '设备已被撤销' };
  if (Date.now() - d.lastActiveAt > DEVICE_IDLE_EXPIRY_MS) return { ok: false, reason: '设备超过 30 天未活跃, 需重新配对' };
  return { ok: true };
}

export function signChallenge(deviceSecret: string, deviceId: string, nonce: string): string {
  return createHmac('sha256', deviceSecret).update(`${deviceId}:${nonce}`).digest('hex');
}

export function verifySignature(secret: string, deviceId: string, nonce: string, signature: string): boolean {
  const expect = signChallenge(secret, deviceId, nonce);
  const a = Buffer.from(expect, 'utf8');
  const b = Buffer.from(signature, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export function newNonce(): string {
  return randomBytes(24).toString('hex');
}

// ---------- 配对流程服务 ----------

export class PairingService {
  public readonly guard = new PairingGuard();

  constructor(private store: Store) {
    store.pruneExpiredCodes();
  }

  /** 桌面端调用: 生成新配对码 */
  createCode(): { code: string; expiresAt: number } {
    const code = generatePairingCode();
    const expiresAt = Date.now() + CODE_TTL_MS;
    this.store.putPairingCode({ code, createdAt: Date.now(), expiresAt });
    return { code, expiresAt };
  }

  /** 客户端配对尝试: 成功返回新设备记录 (含 deviceSecret, 仅本次下发) */
  tryPair(codeInput: string, deviceName: string, platform: string | undefined, remoteKey: string):
    { ok: true; device: DeviceRecord } | { ok: false; reason: string; retryAfterSec?: number } {

    const gate = this.guard.checkAllowed(remoteKey);
    if (!gate.allowed) {
      return { ok: false, reason: `尝试过多, ${gate.retryAfterSec}s 后再试`, retryAfterSec: gate.retryAfterSec };
    }
    if (this.guard.rateLimited(remoteKey)) {
      this.guard.recordAttempt(remoteKey, false);
      return { ok: false, reason: '尝试频率过高, 请稍后再试', retryAfterSec: 60 };
    }

    const code = normalizeCode(codeInput);
    const rec = this.store.getPairingCode(code);
    const valid = rec && !rec.usedAt && rec.expiresAt > Date.now();
    this.guard.recordAttempt(remoteKey, !!valid);

    if (!valid) {
      return { ok: false, reason: '配对码无效或已过期' };
    }

    this.store.consumePairingCode(code);
    const device = issueDevice(deviceName, platform);
    this.store.putDevice(device);
    return { ok: true, device };
  }

  listActiveCodes(): { code: string; expiresAt: number }[] {
    return this.store.listPairingCodes().filter((r) => !r.usedAt && r.expiresAt > Date.now());
  }
}
