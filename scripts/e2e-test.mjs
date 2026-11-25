#!/usr/bin/env node
/**
 * 端到端集成测试: server + 真实 devin acp + WS 客户端模拟手机端
 * 链路: health → 配对码 → pair → auth 挑战响应 → session.create → prompt → 事件流 → 权限裁决 → prompt-result
 * 用法: node scripts/e2e-test.mjs
 */
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { createHmac } from 'node:crypto';
import WebSocket from 'ws';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 18090;
const WORKSPACE = join(root, '.e2e-workspace');
const BASE = `http://127.0.0.1:${PORT}`;

mkdirSync(WORKSPACE, { recursive: true });

// ---- 测试用 config (端口隔离, workdir 白名单含测试目录) ----
const cfgDir = join(homedir(), '.devin-remote');
mkdirSync(cfgDir, { recursive: true });
const cfgPath = join(cfgDir, 'config.json');
const prevCfg = existsSync(cfgPath) ? readFileSync(cfgPath, 'utf8') : null;
writeFileSync(cfgPath, JSON.stringify({
  port: PORT, host: '127.0.0.1', lanEnabled: false,
  workdirs: [{ path: WORKSPACE, label: 'e2e 测试' }],
}, null, 2));

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok, detail });
  console.log(`${ok ? '✔' : '✘'} ${name}${detail ? ' — ' + detail : ''}`);
}

function rpc(ws, msg) {
  ws.send(JSON.stringify(msg));
}

async function main() {
  // 1. 启动 server
  console.log('… 启动 server (端口 ' + PORT + ')');
  const server = spawn(process.execPath, [join(root, 'packages/server/dist/index.js')], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let serverLog = '';
  server.stdout.on('data', (d) => { serverLog += d; });
  server.stderr.on('data', (d) => { serverLog += d; });

  const cleanup = () => {
    try { server.kill(); } catch { /* ignore */ }
    if (prevCfg !== null) writeFileSync(cfgPath, prevCfg);
  };
  process.on('exit', cleanup);

  // 2. 等 health
  let healthy = false;
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(BASE + '/api/health');
      if (r.ok) { healthy = true; break; }
    } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  check('server /api/health 上线', healthy);
  if (!healthy) {
    console.log('server log:\n' + serverLog.slice(-2000));
    process.exit(1);
  }

  // 3. 本机生成配对码
  const pairRes = await fetch(BASE + '/api/pairing/code', { method: 'POST' });
  const pairData = await pairRes.json();
  check('POST /api/pairing/code 生成配对码', pairRes.ok && /^\w{4}-\w{4}$/.test(pairData.code), pairData.code);

  // 4. WS 连接 + pair + auth 握手
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const inbox = [];
  const waiters = [];
  ws.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    const extra = msg.type === 'session.event' ? ` kind=${msg.event?.kind} seq=${msg.event?.seq}` : '';
    if (process.env.E2E_VERBOSE) console.log('   <<', msg.type + extra);
    inbox.push(msg);
    for (const notify of [...waiters]) notify();
  });
  // 读指针模型: 严格线性消费, 消息不重复不遗漏
  let readIdx = 0;
  const waitFor = (pred, timeoutMs = 15000, label = 'message') => new Promise((resolve, reject) => {
    let done = false;
    const scan = () => {
      if (done) return;
      for (let i = readIdx; i < inbox.length; i++) {
        if (pred(inbox[i])) {
          readIdx = i + 1;
          done = true;
          clearTimeout(timer);
          const wi = waiters.indexOf(scan);
          if (wi >= 0) waiters.splice(wi, 1);
          resolve(inbox[i]);
          return;
        }
      }
    };
    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      const wi = waiters.indexOf(scan);
      if (wi >= 0) waiters.splice(wi, 1);
      reject(new Error(`等待超时: ${label}`));
    }, timeoutMs);
    waiters.push(scan);
    scan();
  });

  await new Promise((res, rej) => { ws.on('open', res); ws.on('error', rej); });
  check('WS 连接建立', true);

  rpc(ws, { type: 'pair', code: pairData.code, deviceName: 'e2e-test-runner', platform: 'test' });
  const pairOk = await waitFor((m) => m.type === 'pair.ok', 8000, 'pair.ok');
  check('pair.ok 下发设备证书', !!pairOk.deviceId && !!pairOk.deviceSecret);

  rpc(ws, { type: 'auth.hello', deviceId: pairOk.deviceId });
  const challenge = await waitFor((m) => m.type === 'auth.challenge', 8000, 'auth.challenge');
  const sig = createHmac('sha256', pairOk.deviceSecret).update(`${pairOk.deviceId}:${challenge.nonce}`).digest('hex');
  rpc(ws, { type: 'auth.response', deviceId: pairOk.deviceId, nonce: challenge.nonce, signature: sig });
  const authOk = await waitFor((m) => m.type === 'auth.ok', 8000, 'auth.ok');
  check('auth.ok HMAC 挑战响应通过', authOk.deviceId === pairOk.deviceId);

  // 5. 工作目录清单
  rpc(ws, { type: 'workdir.list' });
  const wdList = await waitFor((m) => m.type === 'workdir.list', 8000, 'workdir.list');
  check('workdir.list 返回白名单', wdList.dirs?.length === 1 && wdList.dirs[0].exists === true);

  // 6. 创建会话 (真实 devin acp)
  console.log('… 创建会话 (拉起 devin acp, 需 10-30s)');
  rpc(ws, { type: 'session.create', cwd: WORKSPACE });
  const created = await waitFor((m) => m.type === 'session.created', 60000, 'session.created');
  const sid = created.session?.sessionId;
  check('session.created 返回 sessionId', !!sid, sid);
  check('session 附带 modes/configOptions', !!created.acp?.modes?.currentModeId, created.acp?.modes?.currentModeId);

  // 7. 订阅 + snapshot
  rpc(ws, { type: 'session.subscribe', sessionId: sid });
  const snap = await waitFor((m) => m.type === 'session.snapshot', 8000, 'snapshot');
  check('session.snapshot 到达', snap.sessionId === sid);

  // 8. 切到 bypass 模式避免权限中断 (权限链路单独测)
  rpc(ws, { type: 'session.setMode', sessionId: sid, modeId: 'bypass' });
  await new Promise((r) => setTimeout(r, 1500));

  // 9. 发 prompt — 让 agent 写个文件
  console.log('… 发送 prompt (真实 agent 回合, 需 30-120s)');
  const promptText = 'Create a file called e2e-hello.txt with exactly the content "e2e-ok". Then reply with the single word DONE.';
  rpc(ws, { type: 'session.prompt', sessionId: sid, text: promptText, clientMsgId: 'e2e-msg-1' });

  // 事件流收集
  const eventKinds = new Set();
  let promptResult = null;
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline && !promptResult) {
    try {
      const ev = await waitFor(
        (m) => m.type === 'session.event' && m.event.sessionId === sid,
        30000, 'session.event',
      );
      eventKinds.add(ev.event.kind);
      if (ev.event.kind === 'acp-update') {
        const u = ev.event.payload?.sessionUpdate;
        if (u) eventKinds.add('update:' + u);
      }
      if (ev.event.kind === 'prompt-result') promptResult = ev.event.payload;
    } catch {
      if (!promptResult) break;
    }
  }
  check('收到 prompt-result', !!promptResult, promptResult ? `stopReason=${promptResult.stopReason}` : 'timeout');
  check('事件流含 agent 消息/思考', [...eventKinds].some((k) => k.startsWith('update:agent')));
  check('事件流含 tool_call', [...eventKinds].some((k) => k.includes('tool_call')));
  check('事件含 user-message 回显', eventKinds.has('user-message'));

  // 10. 文件真实写入 (fs/write_text_file 经 server 监狱)
  const helloPath = join(WORKSPACE, 'e2e-hello.txt');
  await new Promise((r) => setTimeout(r, 1500));
  const fileOk = existsSync(helloPath) && readFileSync(helloPath, 'utf8').includes('e2e-ok');
  check('agent 通过 server 监狱写入文件', fileOk);

  // 11. 事件持久化 (JSONL)
  const jsonlPath = join(homedir(), '.devin-remote', 'events', `${sid}.jsonl`);
  check('事件 JSONL 持久化', existsSync(jsonlPath), existsSync(jsonlPath) ? undefined : jsonlPath);

  // 12. 越界目录创建被拒
  rpc(ws, { type: 'session.create', cwd: 'C:\\Windows' });
  const errMsg = await waitFor((m) => m.type === 'error' && m.code === 'cwd_not_allowed', 8000, 'cwd_not_allowed').catch(() => null);
  check('白名单外目录被拒', !!errMsg);

  // 13. status
  rpc(ws, { type: 'status.request' });
  const status = await waitFor((m) => m.type === 'server.status', 8000, 'server.status').catch(() => null);
  check('server.status 正常', !!status && status.activeSessions >= 0, status ? `v${status.version}` : 'timeout');

  ws.close();
  server.kill();

  // 汇总
  const pass = results.filter((r) => r.ok).length;
  const fail = results.filter((r) => !r.ok).length;
  console.log(`\n========== E2E: ${pass} 通过, ${fail} 失败 ==========`);
  if (fail > 0) {
    console.log('server log tail:\n' + serverLog.slice(-1500));
  }
  process.exit(fail > 0 ? 1 : 0);
}

main().catch((e) => { console.error('E2E 异常:', e); process.exit(1); });
