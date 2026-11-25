import { writeFileSync, readFileSync, existsSync, mkdirSync, appendFileSync, renameSync, chmodSync, unlinkSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { dataDir } from '../config.js';
import type { SessionMeta, SessionEvent, DeviceInfo } from '@devin-remote/protocol';

/**
 * JSONL 持久层 — v1 规模（数十会话 × 数千事件）下零依赖、崩溃安全:
 *  - 事件: 每会话一个 events/<sid>.jsonl, 只追加, 启动时回放建索引
 *  - 会话/设备/配对码: state.json 快照, 写时先 tmp 后 rename (原子替换)
 *  - state.json 权限 600: 内含 deviceSecret, 属敏感文件
 */

interface StateFile {
  sessions: Record<string, SessionMeta & { acpCache?: unknown }>;
  devices: Record<string, DeviceRecord>;
  pairingCodes: Record<string, PairingCodeRecord>;
}

export interface DeviceRecord {
  deviceId: string;
  deviceName: string;
  platform?: string;
  deviceSecret: string;
  pairedAt: number;
  lastActiveAt: number;
  revokedAt?: number;
}

export interface PairingCodeRecord {
  code: string;
  createdAt: number;
  expiresAt: number;
  usedAt?: number;
}

export class Store {
  private dir: string;
  private eventsDir: string;
  private state: StateFile = { sessions: {}, devices: {}, pairingCodes: {} };
  private eventCache = new Map<string, SessionEvent[]>();
  private writeQueue: Promise<void> = Promise.resolve();

  constructor() {
    this.dir = dataDir();
    this.eventsDir = join(this.dir, 'events');
    mkdirSync(this.eventsDir, { recursive: true });
  }

  private statePath(): string {
    return join(this.dir, 'state.json');
  }

  async load(): Promise<void> {
    const p = this.statePath();
    if (existsSync(p)) {
      try {
        this.state = JSON.parse(await readFile(p, 'utf8'));
      } catch {
        this.state = { sessions: {}, devices: {}, pairingCodes: {} };
      }
    }
    this.restrictPermissions(p);
  }

  private restrictPermissions(p: string) {
    if (process.platform !== 'win32' && existsSync(p)) {
      try { chmodSync(p, 0o600); } catch { /* best effort */ }
    }
  }

  /** 串行化写盘, 防并发撕裂 */
  private persist(): Promise<void> {
    this.writeQueue = this.writeQueue.then(async () => {
      const p = this.statePath();
      const tmp = p + '.tmp';
      await writeFile(tmp, JSON.stringify(this.state));
      try {
        renameSync(tmp, p);
      } catch {
        // Windows 上目标存在时 rename 可能失败: 先删后换
        try {
          await writeFile(p, JSON.stringify(this.state));
        } catch { /* 下次再写 */ }
        try { unlinkSync(tmp); } catch { /* ignore */ }
      }
      this.restrictPermissions(p);
    }).catch(() => {});
    return this.writeQueue;
  }

  // ---------- sessions ----------

  upsertSession(meta: SessionMeta, acpCache?: unknown): void {
    const existing = this.state.sessions[meta.sessionId];
    this.state.sessions[meta.sessionId] = {
      ...meta,
      acpCache: acpCache ?? existing?.acpCache,
    };
    void this.persist();
  }

  getSession(sessionId: string): (SessionMeta & { acpCache?: unknown }) | undefined {
    return this.state.sessions[sessionId];
  }

  listSessions(): (SessionMeta & { acpCache?: unknown })[] {
    return Object.values(this.state.sessions).sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  }

  // ---------- events ----------

  private eventsPath(sessionId: string): string {
    return join(this.eventsDir, `${sessionId.replace(/[^a-zA-Z0-9_-]/g, '_')}.jsonl`);
  }

  /** 追加事件: 缓存 + JSONL。seq 由调用方分配（SessionRuntime 保证单调） */
  appendEvent(ev: SessionEvent): void {
    let arr = this.eventCache.get(ev.sessionId);
    if (!arr) {
      arr = this.readEventsSync(ev.sessionId);
      this.eventCache.set(ev.sessionId, arr);
    }
    if (arr.some((e) => e.seq === ev.seq)) return; // 幂等
    arr.push(ev);
    try {
      appendFileSync(this.eventsPath(ev.sessionId), JSON.stringify(ev) + '\n');
    } catch { /* 下次启动以 jsonl 为准重建 */ }
  }

  private readEventsSync(sessionId: string): SessionEvent[] {
    const p = this.eventsPath(sessionId);
    if (!existsSync(p)) return [];
    try {
      const lines = readFileSync(p, 'utf8').split('\n').filter(Boolean);
      return lines.map((l) => JSON.parse(l) as SessionEvent);
    } catch {
      return [];
    }
  }

  /** 翻页: 取 beforeSeq 之前的最近 limit 条 (升序返回) */
  eventsBefore(sessionId: string, beforeSeq: number, limit: number): SessionEvent[] {
    let arr = this.eventCache.get(sessionId);
    if (!arr) {
      arr = this.readEventsSync(sessionId);
      this.eventCache.set(sessionId, arr);
    }
    const earlier = arr.filter((e) => e.seq < beforeSeq);
    return earlier.slice(-limit);
  }

  eventsSince(sessionId: string, sinceSeq = 0): SessionEvent[] {
    let arr = this.eventCache.get(sessionId);
    if (!arr) {
      arr = this.readEventsSync(sessionId);
      this.eventCache.set(sessionId, arr);
    }
    return arr.filter((e) => e.seq > sinceSeq);
  }

  lastSeq(sessionId: string): number {
    const arr = this.eventCache.get(sessionId) ?? this.readEventsSync(sessionId);
    return arr.length ? arr[arr.length - 1].seq : 0;
  }

  // ---------- devices ----------

  putDevice(d: DeviceRecord): void {
    this.state.devices[d.deviceId] = d;
    void this.persist();
  }

  getDevice(deviceId: string): DeviceRecord | undefined {
    return this.state.devices[deviceId];
  }

  listDevices(): DeviceRecord[] {
    return Object.values(this.state.devices);
  }

  revokeDevice(deviceId: string): boolean {
    const d = this.state.devices[deviceId];
    if (!d) return false;
    d.revokedAt = Date.now();
    void this.persist();
    return true;
  }

  touchDevice(deviceId: string): void {
    const d = this.state.devices[deviceId];
    if (d) {
      d.lastActiveAt = Date.now();
      void this.persist();
    }
  }

  // ---------- pairing codes ----------

  putPairingCode(rec: PairingCodeRecord): void {
    this.state.pairingCodes[rec.code] = rec;
    void this.persist();
  }

  getPairingCode(code: string): PairingCodeRecord | undefined {
    return this.state.pairingCodes[code];
  }

  consumePairingCode(code: string): void {
    const rec = this.state.pairingCodes[code];
    if (rec) {
      rec.usedAt = Date.now();
      void this.persist();
    }
  }

  pruneExpiredCodes(): void {
    const now = Date.now();
    let dirty = false;
    for (const [code, rec] of Object.entries(this.state.pairingCodes)) {
      if (rec.expiresAt < now || rec.usedAt) {
        delete this.state.pairingCodes[code];
        dirty = true;
      }
    }
    if (dirty) void this.persist();
  }

  listPairingCodes(): PairingCodeRecord[] {
    return Object.values(this.state.pairingCodes);
  }
}

// 事件/设备类型重导出便于其他模块引用
export type { SessionEvent, SessionMeta, DeviceInfo };
