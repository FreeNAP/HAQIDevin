import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
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
  const dir = join(homedir(), '.devin-remote');
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

/** devin 可执行文件探测 */
export function resolveDevinPath(cfg: ServerConfig): string {
  if (cfg.devinPath) return cfg.devinPath;
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA || '', 'devin', 'cli', 'bin', 'devin.exe');
  }
  return 'devin';
}
