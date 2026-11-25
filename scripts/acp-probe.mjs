// ACP 协议探针 v2 — 用真实 `devin acp` 验证协议行为，dump 全部报文
// 用法: node scripts/acp-probe.mjs [--prompt "自定义提示词"]
// 注意: 会消耗极少量 ACU（一条微型 prompt）
import { spawn } from 'node:child_process';
import { writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const probeCwd = join(root, '.probe-workspace');
mkdirSync(probeCwd, { recursive: true });

const customPrompt = process.argv.includes('--prompt')
  ? process.argv[process.argv.indexOf('--prompt') + 1]
  : 'Reply with exactly one word: ok';

// 从 devin CLI 凭据文件读 api key
function loadApiKey() {
  if (process.env.WINDSURF_API_KEY) return process.env.WINDSURF_API_KEY;
  try {
    const toml = readFileSync(join(process.env.APPDATA, 'devin', 'credentials.toml'), 'utf8');
    const m = toml.match(/windsurf_api_key\s*=\s*"([^"]+)"/);
    return m?.[1] ?? null;
  } catch { return null; }
}
const apiKey = loadApiKey();
console.log('api key loaded:', apiKey ? `yes (${apiKey.slice(0, 6)}… len ${apiKey.length})` : 'NO — 将无法认证');

const log = [];
const record = (dir, obj) => {
  log.push({ t: new Date().toISOString(), dir, msg: obj });
  const summary = obj.method || (obj.result !== undefined ? 'result' : obj.error ? 'error' : '?');
  const extra = obj.method === 'session/update' ? ' :: ' + obj.params?.update?.sessionUpdate : '';
  console.log(`[${dir}] ${summary}${extra}`);
};

const devinExe = process.platform === 'win32'
  ? join(process.env.LOCALAPPDATA || '', 'devin', 'cli', 'bin', 'devin.exe')
  : 'devin';

console.log(`spawning: ${devinExe} acp  (cwd: ${probeCwd})`);
const child = spawn(devinExe, ['acp'], {
  cwd: probeCwd,
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, WINDSURF_API_KEY: apiKey || '' },
});

child.stderr.on('data', (d) => {
  const line = d.toString().trim();
  if (line && /ERROR|WARN/.test(line)) console.log(`[stderr] ${line.slice(0, 240)}`);
});

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
    try { msg = JSON.parse(line); } catch { console.log(`[non-json] ${line.slice(0, 200)}`); continue; }
    record('agent→client', msg);
    if (msg.method && msg.id !== undefined) {
      handleAgentRequest(msg);
    } else if (msg.id !== undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) p.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
      else p.resolve(msg.result);
    }
  }
});

function send(method, params) {
  const id = nextId++;
  const msg = { jsonrpc: '2.0', id, method, params };
  record('client→agent', msg);
  child.stdin.write(JSON.stringify(msg) + '\n');
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error(`timeout waiting for ${method}`)); } }, 90000);
  });
}

function sendNotification(method, params) {
  const msg = { jsonrpc: '2.0', method, params };
  record('client→agent(notif)', msg);
  child.stdin.write(JSON.stringify(msg) + '\n');
}

function respond(id, result) {
  const msg = { jsonrpc: '2.0', id, result };
  record('client→agent(resp)', msg);
  child.stdin.write(JSON.stringify(msg) + '\n');
}

function respondError(id, code, message) {
  const msg = { jsonrpc: '2.0', id, error: { code, message } };
  record('client→agent(resp-err)', msg);
  child.stdin.write(JSON.stringify(msg) + '\n');
}

async function handleAgentRequest(msg) {
  switch (msg.method) {
    case 'session/request_permission': {
      console.log(`  !! 权限请求: ${JSON.stringify(msg.params).slice(0, 600)}`);
      const opts = msg.params?.options ?? [];
      const cmdStr = JSON.stringify(msg.params);
      const safe = /(type|cat|echo|dir|ls)[\s"']/i.test(cmdStr) && !/(rm|del|format|curl|wget|npm|git|node|python)/i.test(cmdStr);
      const pick = safe
        ? (opts.find(o => /allow|approve|yes|once/i.test(o.optionId || o.name || '')) ?? opts[0])
        : (opts.find(o => /reject|deny/i.test(o.optionId || o.name || '')) ?? opts[opts.length - 1]);
      console.log(`  -> ${safe ? '放行(只读命令)' : '拒绝'} optionId=${pick?.optionId}`);
      respond(msg.id, { outcome: { outcome: 'selected', optionId: pick?.optionId } });
      break;
    }
    case 'fs/read_text_file': {
      try {
        const p = msg.params.path;
        if (!p.startsWith(probeCwd)) throw new Error('path escape blocked: ' + p);
        respond(msg.id, { content: readFileSync(p, 'utf8') });
      } catch (e) { respondError(msg.id, -32602, 'probe fs read: ' + e.message); }
      break;
    }
    case 'fs/write_text_file': {
      try {
        const p = msg.params.path;
        if (!p.startsWith(probeCwd)) throw new Error('path escape blocked: ' + p);
        writeFileSync(p, msg.params.content);
        console.log(`  fs/write_text_file: ${p} (${msg.params.content.length} chars)`);
        respond(msg.id, {});
      } catch (e) { respondError(msg.id, -32602, 'probe fs write: ' + e.message); }
      break;
    }
    default: {
      console.log(`  ?? 未知 agent 请求: ${msg.method} ${JSON.stringify(msg.params).slice(0, 200)}`);
      respondError(msg.id, -32601, `probe: method not implemented: ${msg.method}`);
    }
  }
}

async function main() {
  console.log('\n=== 1. initialize ===');
  const initResult = await send('initialize', {
    protocolVersion: 1,
    clientCapabilities: {
      fs: { readTextFile: true, writeTextFile: true },
    },
    clientInfo: { name: 'devin-remote-probe', title: 'Devin Remote Probe', version: '0.1.0' },
  }).catch((e) => { console.error('initialize 失败:', e.message); return null; });
  if (!initResult) return finish(1);

  console.log('\n=== 2. authenticate (meta.api_key) ===');
  try {
    const r = await send('authenticate', { methodId: 'devin-browser', _meta: { api_key: apiKey } });
    console.log('authenticate 成功:', JSON.stringify(r));
  } catch (e) {
    console.error('authenticate 失败:', e.message, '— 继续尝试 session/new（可能 env 已生效）');
  }

  console.log('\n=== 3. session/new ===');
  let sessionId;
  try {
    const r = await send('session/new', { cwd: probeCwd, mcpServers: [] });
    sessionId = r?.sessionId;
    console.log('sessionId =', sessionId);
    console.log('session/new 完整响应:', JSON.stringify(r).slice(0, 800));
  } catch (e) {
    console.error('session/new 失败:', e.message);
    return finish(1);
  }

  console.log(`\n=== 4. session/prompt: "${customPrompt}" ===`);
  try {
    const r = await send('session/prompt', {
      sessionId,
      prompt: [{ type: 'text', text: customPrompt }],
    });
    console.log('prompt turn 结束, 响应 =', JSON.stringify(r));
  } catch (e) {
    console.error('session/prompt 失败:', e.message);
  }

  setTimeout(() => finish(0), 2500);
}

function finish(code) {
  const outPath = join(root, 'scripts', 'probe-log.json');
  writeFileSync(outPath, JSON.stringify(log, null, 2));
  console.log(`\n完整报文已写入 scripts/probe-log.json （${log.length} 条）`);
  try { child.kill(); } catch {}
  process.exit(code);
}

child.on('error', (e) => { console.error('spawn 失败:', e.message); finish(1); });
child.on('exit', (code) => { console.log(`\n[devin acp 退出 code=${code}]`); });

setTimeout(() => { console.error('整体超时 150s'); finish(2); }, 150000);
main();
