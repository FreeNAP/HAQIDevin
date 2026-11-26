import { copyFile, mkdir, readdir, readFile, rename, stat, writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type {
  ConfigMcpMsg,
  ConfigRulesMsg,
  McpConfigLayer,
  RuleFileInfo,
} from '@devin-remote/protocol';
import type { WorkdirEntry } from './config.js';
import { assertDirectoryInJail } from './fs/fsOps.js';
import { JailError } from './fs/jail.js';

/**
 * devin CLI 配置文件的读写适配层。
 * 侦察结论 (Windows 实证):
 *  - rules: 全局活动在 ~/.codeium/windsurf/memories/global_rules.md; 项目级 .windsurf/rules/*.md 与 .cursor/rules/*.md
 *  - MCP: devin 用户级 %APPDATA%/devin/mcp_config.json; 项目级 .devin/mcp_config.json / .devin/mcp_config.local.json
 *  - devin list 还会合并 Claude/Windsurf/Cursor/opencode 导入源, 读取时一并投影
 */

function isolatedUserConfigRoot(): string | null {
  // 实证探针用: 测试实例设置 DEVIN_REMOTE_DATA_DIR 时, 用户级配置也隔离, 避免改写真实全局规则/MCP
  return process.env.DEVIN_REMOTE_DATA_DIR ? join(process.env.DEVIN_REMOTE_DATA_DIR, 'user-config') : null;
}

function userMcpConfigPath(): string {
  const iso = isolatedUserConfigRoot();
  if (iso) return join(iso, 'devin', 'mcp_config.json');
  if (process.platform === 'win32' && process.env.APPDATA) {
    return join(process.env.APPDATA, 'devin', 'mcp_config.json');
  }
  return join(homedir(), '.config', 'devin', 'mcp_config.json');
}

function windsurfHome(): string {
  const iso = isolatedUserConfigRoot();
  return iso ? join(iso, 'codeium', 'windsurf') : join(homedir(), '.codeium', 'windsurf');
}

function claudeConfigPath(): string {
  const iso = isolatedUserConfigRoot();
  return iso ? join(iso, 'claude.json') : join(homedir(), '.claude.json');
}

function cursorHomeConfigPath(): string {
  const iso = isolatedUserConfigRoot();
  return iso ? join(iso, 'cursor', 'mcp.json') : join(homedir(), '.cursor', 'mcp.json');
}

function opencodeConfigPath(): string {
  const iso = isolatedUserConfigRoot();
  return iso ? join(iso, 'config', 'opencode', 'opencode.json') : join(homedir(), '.config', 'opencode', 'opencode.json');
}

function globalRulesPath(): string {
  return join(windsurfHome(), 'memories', 'global_rules.md');
}

async function pathExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function readTextIfExists(p: string): Promise<{ exists: boolean; content: string }> {
  try {
    return { exists: true, content: await readFile(p, 'utf8') };
  } catch {
    return { exists: false, content: '' };
  }
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

async function backupIfExists(p: string): Promise<string | undefined> {
  if (!await pathExists(p)) return undefined;
  const backup = `${p}.bak-${timestamp()}`;
  await copyFile(p, backup);
  return backup;
}

async function atomicWrite(p: string, content: string): Promise<void> {
  await mkdir(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  await writeFile(tmp, content, 'utf8');
  try {
    await rename(tmp, p);
  } catch {
    try { await writeFile(p, content, 'utf8'); } finally {
      try { await unlink(tmp); } catch { /* ignore */ }
    }
  }
}

async function listMarkdownFiles(dir: string, provider: RuleFileInfo['provider'], activation: RuleFileInfo['activation']): Promise<RuleFileInfo[]> {
  let names: string[] = [];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const out: RuleFileInfo[] = [];
  for (const name of names.sort()) {
    const lower = name.toLowerCase();
    if (!lower.endsWith('.md') && !lower.endsWith('.mdc')) continue;
    const p = join(dir, name);
    try {
      const st = await stat(p);
      if (!st.isFile()) continue;
      out.push({
        name: name.replace(/\.(md|mdc)$/i, ''),
        path: p,
        provider,
        activation,
        content: await readFile(p, 'utf8'),
      });
    } catch { /* 文件竞态删除则跳过 */ }
  }
  return out;
}

/** 读取全局 + 可选项目cwd 的 devin 规则体系 */
export async function readRulesConfig(workdirs: WorkdirEntry[], cwd?: string): Promise<ConfigRulesMsg> {
  const gp = globalRulesPath();
  const global = await readTextIfExists(gp);
  const projects: ConfigRulesMsg['projects'] = [];

  if (cwd) {
    const dir = await assertDirectoryInJail(cwd, workdirs);
    const root = dir.realPath;
    const files: RuleFileInfo[] = [
      ...await listMarkdownFiles(join(root, '.windsurf', 'rules'), 'windsurf', 'always-on'),
      ...await listMarkdownFiles(join(root, '.cursor', 'rules'), 'cursor', 'conditional'),
    ];
    projects.push({ cwd: dir.inputPath, files });
  }

  return {
    type: 'config.rules',
    global: {
      path: gp,
      exists: global.exists,
      content: global.content,
      provider: 'windsurf',
    },
    projects,
  };
}

function sanitizeRuleName(name?: string): string {
  const base = (name ?? 'mobile_rules').replace(/\.(md|mdc)$/i, '').trim() || 'mobile_rules';
  if (!/^[A-Za-z0-9_.-]+$/.test(base) || base.includes('..')) {
    throw new JailError('invalid_path', `规则名只允许字母/数字/._-: ${name}`);
  }
  return base;
}

/** 写 rules; 写前自动 .bak-时间戳, 写后返回最新完整视图 */
export async function writeRulesConfig(
  workdirs: WorkdirEntry[],
  req: { scope?: 'global' | 'project'; cwd?: string; name?: string; content: string },
): Promise<ConfigRulesMsg> {
  const scope = req.scope ?? 'global';
  let writtenPath: string;
  if (scope === 'global') {
    writtenPath = globalRulesPath();
  } else {
    if (!req.cwd) throw new JailError('invalid_path', 'project 规则写入需要 cwd');
    const dir = await assertDirectoryInJail(req.cwd, workdirs);
    writtenPath = join(dir.realPath, '.windsurf', 'rules', `${sanitizeRuleName(req.name)}.md`);
  }
  const backupPath = await backupIfExists(writtenPath);
  await atomicWrite(writtenPath, req.content);
  const view = await readRulesConfig(workdirs, req.cwd);
  return { ...view, writtenPath, backupPath };
}

async function readJsonObject(p: string): Promise<{ exists: boolean; config?: Record<string, unknown>; error?: string }> {
  if (!existsSync(p)) return { exists: false };
  try {
    const parsed = JSON.parse(await readFile(p, 'utf8')) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return { exists: true, error: '顶层不是 JSON object' };
    }
    return { exists: true, config: parsed as Record<string, unknown> };
  } catch (e) {
    return { exists: true, error: String((e as Error).message) };
  }
}

async function jsonLayer(scope: McpConfigLayer['scope'], p: string): Promise<McpConfigLayer> {
  const r = await readJsonObject(p);
  let config = r.config;
  // ~/.claude.json 是整份 Claude 客户端状态(很大且含账户状态), 只投影 mcpServers 到 wire
  if (config && scope === 'legacy-claude') {
    config = { mcpServers: asServerMap(config.mcpServers) };
  }
  return { scope, path: p, exists: r.exists, config, error: r.error };
}

function asServerMap(v: unknown): Record<string, unknown> {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {};
}

/** opencode 的 mcp 格式 command 是数组; 转成 devin/mcpServers 形状便于手机端统一展示 */
function normalizeOpencodeServers(config: Record<string, unknown>): Record<string, unknown> {
  const src = asServerMap(config.mcp);
  const out: Record<string, unknown> = {};
  for (const [name, raw] of Object.entries(src)) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      out[name] = raw;
      continue;
    }
    const r = raw as Record<string, unknown>;
    const cmd = Array.isArray(r.command) ? r.command.map(String) : [];
    out[name] = {
      ...r,
      command: cmd.length ? cmd[0] : r.command,
      args: cmd.length > 1 ? cmd.slice(1) : r.args,
      disabled: r.enabled === false,
    };
  }
  return out;
}

function serversFromLayer(layer: McpConfigLayer): Record<string, unknown> {
  if (!layer.config) return {};
  if (layer.scope === 'legacy-opencode') return normalizeOpencodeServers(layer.config);
  return asServerMap(layer.config.mcpServers);
}

/** 读取 MCP 分层配置并计算有效合并视图 (后者覆盖前者: legacy → user → project → local) */
export async function readMcpConfig(workdirs: WorkdirEntry[], cwd?: string): Promise<ConfigMcpMsg> {
  const layers: McpConfigLayer[] = [
    await jsonLayer('legacy-claude', claudeConfigPath()),
    await jsonLayer('legacy-windsurf', join(windsurfHome(), 'mcp_config.json')),
    await jsonLayer('legacy-cursor', cursorHomeConfigPath()),
    await jsonLayer('legacy-opencode', opencodeConfigPath()),
    await jsonLayer('user', userMcpConfigPath()),
  ];

  if (cwd) {
    const dir = await assertDirectoryInJail(cwd, workdirs);
    // devin CLI 的项目级导入源: Claude/Cursor/opencode 兼容层 + devin 原生 project/local
    layers.push(await jsonLayer('legacy-claude', join(dir.realPath, '.mcp.json')));
    layers.push(await jsonLayer('legacy-claude', join(dir.realPath, '.claude', 'settings.json')));
    layers.push(await jsonLayer('legacy-claude', join(dir.realPath, '.claude', 'settings.local.json')));
    layers.push(await jsonLayer('legacy-cursor', join(dir.realPath, '.cursor', 'mcp.json')));
    layers.push(await jsonLayer('legacy-opencode', join(dir.realPath, 'opencode', 'opencode.json')));
    layers.push(await jsonLayer('legacy-opencode', join(dir.realPath, 'opencode.json')));
    layers.push(await jsonLayer('project', join(dir.realPath, '.devin', 'mcp_config.json')));
    layers.push(await jsonLayer('local', join(dir.realPath, '.devin', 'mcp_config.local.json')));
  }

  const effective: Record<string, unknown> = {};
  for (const layer of layers) {
    Object.assign(effective, serversFromLayer(layer));
  }
  return {
    type: 'config.mcp',
    layers,
    effective: { mcpServers: effective },
  };
}

function validateMcpConfigObject(config: Record<string, unknown>): void {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new JailError('invalid_operation', 'MCP 配置必须是 JSON object');
  }
  if (!config.mcpServers || typeof config.mcpServers !== 'object' || Array.isArray(config.mcpServers)) {
    throw new JailError('invalid_operation', 'MCP 配置必须包含 object 类型的 mcpServers');
  }
}

/** 写 MCP 配置; scope=user 写 devin 用户级, project/local 写 .devin 下对应文件 */
export async function writeMcpConfig(
  workdirs: WorkdirEntry[],
  req: { scope?: 'user' | 'project' | 'local'; cwd?: string; config: Record<string, unknown> },
): Promise<ConfigMcpMsg> {
  validateMcpConfigObject(req.config);
  const scope = req.scope ?? 'user';
  let writtenPath: string;
  if (scope === 'user') {
    writtenPath = userMcpConfigPath();
  } else {
    if (!req.cwd) throw new JailError('invalid_path', `${scope} MCP 写入需要 cwd`);
    const dir = await assertDirectoryInJail(req.cwd, workdirs);
    writtenPath = join(dir.realPath, '.devin', scope === 'project' ? 'mcp_config.json' : 'mcp_config.local.json');
  }
  const backupPath = await backupIfExists(writtenPath);
  await atomicWrite(writtenPath, JSON.stringify(req.config, null, 2));
  const view = await readMcpConfig(workdirs, req.cwd);
  return { ...view, writtenPath, backupPath };
}
