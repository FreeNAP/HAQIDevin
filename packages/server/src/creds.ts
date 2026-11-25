import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 从 devin CLI 的凭据文件读取 windsurf_api_key。
 * 探针实证: devin acp 模式故意不读本地 CLI 凭据 (v3000.6.7),
 * 必须经 authenticate 的 _meta.api_key 或 WINDSURF_API_KEY 注入。
 */
export function loadDevinApiKey(): { key: string | null; source: string } {
  if (process.env.WINDSURF_API_KEY) {
    return { key: process.env.WINDSURF_API_KEY, source: 'env:WINDSURF_API_KEY' };
  }
  const candidates: string[] = [];
  if (process.platform === 'win32' && process.env.APPDATA) {
    candidates.push(join(process.env.APPDATA, 'devin', 'credentials.toml'));
  }
  candidates.push(join(process.env.HOME || '', '.config', 'devin', 'credentials.toml'));

  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const toml = readFileSync(p, 'utf8');
      const m = toml.match(/windsurf_api_key\s*=\s*"([^"]+)"/);
      if (m?.[1]) return { key: m[1], source: p };
    } catch { /* 忽略读取失败, 尝试下一个 */ }
  }
  return { key: null, source: 'none' };
}
