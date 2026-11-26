import { readFileSync, writeFileSync, mkdirSync, existsSync, renameSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export interface WorkdirEntry {
  path: string;
  label?: string;
}

export interface ServerConfig {
  /** 监听端口 */
  port: number;
  /** 绑定地址: 127.0.0.1 = 仅隧道回源; 0.0.0.0 = 同时开放 LAN 直连 */
  host: string;
  /** LAN 直连开关 */
  lanEnabled: boolean;
  /** 公网域名 (Cloudflare hostname, 仅展示用) */
  publicHostname?: string;
  /** 允许手机端选择的工作目录清单 */
  workdirs: WorkdirEntry[];
  /** 额外的 devin acp 启动参数模型 (可选) */
  defaultModel?: string;
  /** devin 可执行文件路径 (缺省自动探测) */
  devinPath?: string;
}

export const DEFAULT_CONFIG: ServerConfig = {
  port: 8787,
  host: '127.0.0.1',
  lanEnabled: true,
  workdirs: [],
};

export function dataDir(): string {
  // 测试实例可用 DEVIN_REMOTE_DATA_DIR 隔离 state/config; 生产缺省仍是 ~/.devin-remote
  const dir = process.env.DEVIN_REMOTE_DATA_DIR || join(homedir(), '.devin-remote');
  mkdirSync(dir, { recursive: true });
  return dir;
}

export function configPath(): string {
  return join(dataDir(), 'config.json');
}

export function loadConfig(): ServerConfig {
  const p = configPath();
  if (!existsSync(p)) {
    writeFileSync(p, JSON.stringify(DEFAULT_CONFIG, null, 2));
    return { ...DEFAULT_CONFIG };
  }
  try {
    const raw = JSON.parse(readFileSync(p, 'utf8'));
    return { ...DEFAULT_CONFIG, ...raw };
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

export function saveConfig(cfg: ServerConfig): void {
  writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
}

function atomicWriteText(p: string, text: string): void {
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, text);
  try {
    renameSync(tmp, p);
  } catch {
    // Windows 上目标已存在时 rename 可能失败: 直写兜底并清 tmp
    try { writeFileSync(p, text); } catch { /* 保留 tmp 便于下轮排查 */ }
    try { unlinkSync(tmp); } catch { /* ignore */ }
  }
}

/**
 * 只更新 config.json 的 workdirs 字段。
 * 必须读-改-写: VSIX syncConfig/defaultModel/publicHostname 等字段可能并发存在, 不能用内存模型整文件覆盖。
 */
export function writeWorkdirsToConfigFile(workdirs: WorkdirEntry[]): void {
  const p = configPath();
  let raw: Record<string, unknown> = {};
  if (existsSync(p)) {
    try {
      const parsed = JSON.parse(readFileSync(p, 'utf8')) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        raw = parsed as Record<string, unknown>;
      }
    } catch {
      raw = {};
    }
  }
  raw.workdirs = workdirs;
  atomicWriteText(p, JSON.stringify(raw, null, 2));
}

/** devin 可执行文件探测 */
export function resolveDevinPath(cfg: ServerConfig): string {
  if (cfg.devinPath) return cfg.devinPath;
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA || '', 'devin', 'cli', 'bin', 'devin.exe');
  }
  return 'devin';
}
