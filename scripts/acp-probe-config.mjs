// 配置切换探针 — 验证 session/set_mode 与 configOption 切换方法（零 ACU 消耗，不发 prompt）
import { spawn } from 'node:child_process';
import { readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const probeCwd = join(root, '.probe-workspace');
mkdirSync(probeCwd, { recursive: true });

const toml = readFileSync(join(process.env.APPDATA, 'devin', 'credentials.toml'), 'utf8');
const apiKey = toml.match(/windsurf_api_key\s*=\s*"([^"]+)"/)?.[1];

const devinExe = join(process.env.LOCALAPPDATA || '', 'devin', 'cli', 'bin', 'devin.exe');
const child = spawn(devinExe, ['acp'], { cwd: probeCwd, stdio: ['pipe', 'pipe', 'pipe'] });
child.stderr.on('data', () => {});

let buffer = '';
const pending = new Map();
let nextId = 1;
child.stdout.on('data', (d) => {
  buffer += d.toString();
  let idx;
  while ((idx = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, idx).trim();
    buffer = buffer.slice(idx + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    if (msg.method && msg.id !== undefined) {
      // 自动回应 agent 请求
      if (msg.method === 'session/request_permission') {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { outcome: { outcome: 'cancelled' } } }) + '\n');
      } else {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'nope' } }) + '\n');
      }
    } else if (msg.id !== undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
      else p.resolve(msg.result);
    }
    if (msg.method === 'session/update' && /mode|config/.test(msg.params?.update?.sessionUpdate || '')) {
      console.log(`  [update] ${msg.params.update.sessionUpdate}:`, JSON.stringify(msg.params.update).slice(0, 200));
    }
  }
});

function send(method, params) {
  const id = nextId++;
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout')); } }, 30000);
  });
}

async function tryMethod(label, method, params) {
  try {
    const r = await send(method, params);
    console.log(`✔ ${label}: 成功 —`, JSON.stringify(r).slice(0, 300));
    return true;
  } catch (e) {
    console.log(`✘ ${label}: ${e.message.slice(0, 160)}`);
    return false;
  }
}

async function main() {
  await send('initialize', {
    protocolVersion: 1,
    clientCapabilities: { fs: { readTextFile: true, writeTextFile: true } },
    clientInfo: { name: 'probe-config', version: '0.1.0' },
  });
  await send('authenticate', { methodId: 'devin-browser', _meta: { api_key: apiKey } });
  const sess = await send('session/new', { cwd: probeCwd, mcpServers: [] });
  const sessionId = sess.sessionId;
  console.log('session =', sessionId, '\n');

  console.log('--- 测试 mode/model 切换方法 ---');
  await tryMethod('session/set_mode {modeId: plan}', 'session/set_mode', { sessionId, modeId: 'plan' });
  await tryMethod('session/set_config_option (mode=smart)', 'session/set_config_option', { sessionId, configId: 'mode', value: 'smart' });
  await tryMethod('session/set_config (mode=ask)', 'session/set_config', { sessionId, configId: 'mode', value: 'ask' });
  await tryMethod('session/setConfigOption (model)', 'session/setConfigOption', { sessionId, configId: 'model', value: 'swe-2-flash-medium' });
  await tryMethod('_cognition.ai/setConfigOption', '_cognition.ai/session/set_config_option', { sessionId, configId: 'mode', value: 'accept-edits' });

  console.log('\n--- 测试 session/list (会话恢复能力) ---');
  await tryMethod('session/list', 'session/list', {});
  await tryMethod('session/list {cwd}', 'session/list', { cwd: probeCwd });

  console.log('\n--- 测试 session/load ---');
  await tryMethod('session/load', 'session/load', { sessionId, cwd: probeCwd, mcpServers: [] });

  child.kill();
  process.exit(0);
}
setTimeout(() => { console.error('超时'); child.kill(); process.exit(2); }, 60000);
main();
