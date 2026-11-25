/* Devin Remote PWA 客户端 — 原生 JS, 无构建依赖 */
'use strict';

// ---------- 状态 ----------
const state = {
  ws: null,
  device: null,          // { deviceId, deviceSecret, deviceName }
  sessions: [],
  workdirs: [],
  currentSession: null,  // sessionId
  currentAcp: null,      // modes/configOptions cache
  renderedSeq: 0,        // 已渲染到 chatFlow 的事件 seq
  streaming: {},         // 流式拼接缓冲
  pendingPerms: new Map(),
  reconnectTimer: null,
  msgCounter: 0,
};

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function toast(text, isErr = false) {
  const t = $('toast');
  t.textContent = text;
  t.className = 'show' + (isErr ? ' err' : '');
  setTimeout(() => { t.className = ''; }, 2600);
}

function showError(text) {
  const b = $('errorBanner');
  if (!text) { b.className = 'error-banner'; return; }
  b.textContent = text;
  b.className = 'error-banner show';
  setTimeout(() => { b.className = 'error-banner'; }, 5000);
}

function setView(name) {
  for (const v of document.querySelectorAll('.view')) v.classList.remove('active');
  $('view-' + name).classList.add('active');
  $('composer').style.display = name === 'chat' ? '' : 'none';
  if (name !== 'chat') document.querySelector('main').scrollTop = 0;
}

// ---------- 设备证书存储 ----------
function loadDevice() {
  try {
    const raw = localStorage.getItem('devin-remote-device');
    state.device = raw ? JSON.parse(raw) : null;
  } catch { state.device = null; }
}
function saveDevice(d) {
  state.device = d;
  localStorage.setItem('devin-remote-device', JSON.stringify(d));
}

// ---------- WS 连接层 ----------
async function hmacSha256Hex(secret, message) {
  // 注意: 与 server 端 node createHmac('sha256', deviceSecret) 保持一致 — hex 字符串本身(utf8)作密钥
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message));
  return bytesToHex(new Uint8Array(sig));
}
function hexToBytes(hex) {
  const b = new Uint8Array(hex.length / 2);
  for (let i = 0; i < b.length; i++) b[i] = parseInt(hex.substr(i * 2, 2), 16);
  return b;
}
function bytesToHex(bytes) {
  return [...bytes].map((x) => x.toString(16).padStart(2, '0')).join('');
}

function wsUrl() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${location.host}/ws`;
}

function connect() {
  if (state.ws && state.ws.readyState <= 1) return;
  const ws = new WebSocket(wsUrl());
  state.ws = ws;
  updateConnDot('off');

  ws.onopen = () => {
    if (state.device) {
      send({ type: 'auth.hello', deviceId: state.device.deviceId });
    } else {
      setView('pair');
    }
  };
  ws.onclose = () => {
    updateConnDot('off');
    scheduleReconnect();
  };
  ws.onerror = () => { /* onclose 会跟进 */ };
  ws.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    handleMessage(msg);
  };
}

function scheduleReconnect() {
  if (state.reconnectTimer) return;
  state.reconnectTimer = setTimeout(() => {
    state.reconnectTimer = null;
    connect();
  }, 2500);
}

function send(msg) {
  if (state.ws && state.ws.readyState === 1) {
    state.ws.send(JSON.stringify(msg));
  }
}

function updateConnDot(status) {
  const d = $('connDot');
  d.className = 'conn-dot' + (status === 'on' ? ' on' : status === 'off' ? ' off' : '');
}

// ---------- 消息处理 ----------
async function handleMessage(msg) {
  switch (msg.type) {
    case 'auth.challenge': {
      const sig = await hmacSha256Hex(state.device.deviceSecret, `${state.device.deviceId}:${msg.nonce}`);
      send({ type: 'auth.response', deviceId: state.device.deviceId, nonce: msg.nonce, signature: sig });
      break;
    }
    case 'auth.ok': {
      updateConnDot('on');
      $('whoLabel').textContent = msg.deviceName;
      bootAuthed();
      break;
    }
    case 'pair.ok': {
      saveDevice({ deviceId: msg.deviceId, deviceSecret: msg.deviceSecret, deviceName: msg.deviceName });
      toast('配对成功');
      send({ type: 'auth.hello', deviceId: msg.deviceId });
      break;
    }
    case 'session.list': {
      state.sessions = msg.sessions;
      renderSessionList();
      break;
    }
    case 'session.created': {
      state.sessions.unshift(msg.session);
      renderSessionList();
      openSession(msg.session.sessionId);
      break;
    }
    case 'session.snapshot': {
      if (msg.sessionId !== state.currentSession) break;
      state.currentAcp = msg.acp;
      $('chatFlow').innerHTML = '';
      state.renderedSeq = 0;
      state.streaming = {};
      state.pendingPerms.clear();
      for (const p of msg.pendingPermissions ?? []) {
        state.pendingPerms.set(p.requestId, p);
      }
      for (const ev of msg.events ?? []) renderEvent(ev);
      renderPerms();
      renderModeSelect();
      updateChatHead(msg.session);
      scrollBottom();
      break;
    }
    case 'session.event': {
      if (msg.event.sessionId === state.currentSession) {
        renderEvent(msg.event);
        scrollBottom();
      }
      // 列表页状态同步
      const s = state.sessions.find((x) => x.sessionId === msg.event.sessionId);
      if (s) s.lastActiveAt = msg.event.ts;
      break;
    }
    case 'session.status': {
      const s = state.sessions.find((x) => x.sessionId === msg.sessionId);
      if (s) {
        s.status = msg.status;
        if (msg.title) s.title = msg.title;
        renderSessionList();
      }
      if (msg.sessionId === state.currentSession) {
        $('runningHint').style.display = msg.status === 'running' ? '' : 'none';
        $('btnCancel').style.display = msg.status === 'running' ? '' : 'none';
        if (msg.title) $('chatTitle').textContent = msg.title;
      }
      break;
    }
    case 'permission.request': {
      state.pendingPerms.set(msg.request.requestId, msg.request);
      if (msg.request.sessionId === state.currentSession) {
        renderPerms();
        scrollBottom();
      } else {
        toast('有会话等待审批');
      }
      break;
    }
    case 'permission.resolved': {
      state.pendingPerms.delete(msg.requestId);
      renderPerms();
      break;
    }
    case 'workdir.list': {
      state.workdirs = msg.dirs;
      renderWorkdirs();
      break;
    }
    case 'error': {
      if (msg.code === 'auth_rejected') {
        localStorage.removeItem('devin-remote-device');
        state.device = null;
        setView('pair');
        showError('设备凭证失效: ' + msg.message);
      } else {
        showError(msg.message);
      }
      break;
    }
  }
}

function bootAuthed() {
  send({ type: 'workdir.list' });
  send({ type: 'session.list' });
  if (!state.currentSession) setView('list');
}

// ---------- 渲染: 列表 ----------
function renderWorkdirs() {
  const el = $('workdirList');
  const sel = $('newSessionCwd');
  sel.innerHTML = '';
  el.innerHTML = '';
  for (const w of state.workdirs) {
    const row = document.createElement('div');
    row.className = 'mono tiny';
    row.style.padding = '4px 0';
    row.textContent = (w.label ? w.label + ' — ' : '') + w.path + (w.exists ? '' : ' (不存在)');
    el.appendChild(row);
    const opt = document.createElement('option');
    opt.value = w.path;
    opt.textContent = (w.label ? w.label + ' — ' : '') + w.path;
    sel.appendChild(opt);
  }
}

function renderSessionList() {
  const el = $('sessionList');
  el.innerHTML = '';
  if (!state.sessions.length) {
    el.innerHTML = '<div class="empty"><div class="big">□</div>还没有会话 — 选择一个工作目录新建</div>';
    return;
  }
  const sorted = [...state.sessions].sort((a, b) => b.lastActiveAt - a.lastActiveAt);
  for (const s of sorted) {
    const item = document.createElement('div');
    item.className = 'session-item';
    const time = new Date(s.lastActiveAt).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
    item.innerHTML = `
      <div class="s-title">${esc(s.title || s.sessionId)}</div>
      <div class="s-meta">
        <span class="badge ${esc(s.status)}">${esc(statusLabel(s.status))}</span>
        <span class="dot-sep">·</span><span class="mono">${esc(shortPath(s.cwd))}</span>
        <span class="dot-sep">·</span><span>${esc(time)}</span>
      </div>`;
    item.onclick = () => openSession(s.sessionId);
    el.appendChild(item);
  }
}

function statusLabel(s) {
  return { idle: '空闲', running: '运行中', waiting_permission: '待审批', error: '错误' }[s] || s;
}
function shortPath(p) {
  const parts = String(p).split(/[\\/]/).filter(Boolean);
  return parts.length > 2 ? '…/' + parts.slice(-2).join('/') : p;
}

// ---------- 渲染: 会话 ----------
function openSession(sessionId) {
  state.currentSession = sessionId;
  setView('chat');
  $('chatFlow').innerHTML = '<div class="empty">载入中…</div>';
  $('chatTitle').textContent = '载入中…';
  send({ type: 'session.subscribe', sessionId, sinceSeq: 0 });
}

function updateChatHead(session) {
  if (!session) return;
  $('chatTitle').textContent = session.title || session.sessionId;
  $('runningHint').style.display = session.status === 'running' ? '' : 'none';
  $('btnCancel').style.display = session.status === 'running' ? '' : 'none';
}

function renderModeSelect() {
  const sel = $('modeSelect');
  sel.innerHTML = '';
  const modes = state.currentAcp?.modes;
  if (!modes?.availableModes) { sel.style.display = 'none'; return; }
  sel.style.display = '';
  for (const m of modes.availableModes) {
    const opt = document.createElement('option');
    opt.value = m.id;
    opt.textContent = m.name;
    if (m.id === modes.currentModeId) opt.selected = true;
    sel.appendChild(opt);
  }
}

function scrollBottom() {
  const main = document.querySelector('main');
  main.scrollTop = main.scrollHeight;
}

// ---------- 事件渲染核心 ----------
function renderEvent(ev) {
  if (ev.seq <= state.renderedSeq) return;
  state.renderedSeq = ev.seq;
  const flow = $('chatFlow');
  const empty = flow.querySelector('.empty');
  if (empty) empty.remove();

  if (ev.kind === 'user-message') {
    const p = ev.payload;
    flow.appendChild(div(`msg user`, `
      <div class="m-who">${esc(p.deviceName || '你')}</div>
      <div class="m-body">${esc(p.text)}</div>`));
    return;
  }

  if (ev.kind === 'prompt-result') {
    flushStreaming();
    return;
  }

  if (ev.kind === 'session-status') {
    const st = ev.payload.status;
    $('runningHint').style.display = st === 'running' ? '' : 'none';
    $('btnCancel').style.display = st === 'running' ? '' : 'none';
    return;
  }

  if (ev.kind === 'acp-update') {
    renderAcpUpdate(ev.payload, flow);
    return;
  }
}

function div(cls, html) {
  const d = document.createElement('div');
  d.className = cls;
  d.innerHTML = html;
  return d;
}

function renderAcpUpdate(u, flow) {
  const kind = u.sessionUpdate;

  if (kind === 'agent_message_chunk' && u.content?.type === 'text') {
    appendStream('agent-msg', 'msg agent', u.content.text, flow);
    return;
  }
  if (kind === 'agent_thought_chunk' && u.content?.type === 'text') {
    appendStream('agent-thought', 'msg thought', u.content.text, flow);
    return;
  }

  if (kind === 'tool_call') {
    flushStreaming();
    flow.appendChild(renderToolCard(u));
    return;
  }
  if (kind === 'tool_call_update') {
    const card = flow.querySelector(`[data-tool="${cssEsc(u.toolCallId)}"]`);
    if (card) updateToolCard(card, u);
    else flow.appendChild(renderToolCard(u));
    return;
  }

  if (kind === 'session_info_update' && u.title) {
    $('chatTitle').textContent = u.title;
    return;
  }

  if (kind === 'current_mode_update') {
    const sel = $('modeSelect');
    if (sel) sel.value = u.currentModeId;
    return;
  }

  if (kind === 'usage_update') {
    const used = u.used, size = u.size;
    if (used && size) {
      $('composerStatus').textContent = `上下文 ${Math.round(used / 1000)}k/${Math.round(size / 1000)}k`;
    }
    return;
  }
}

function cssEsc(s) {
  return String(s).replace(/["\\\]]/g, '\\$&');
}

function appendStream(key, cls, text, flow) {
  let buf = state.streaming[key];
  if (!buf) {
    const el = div(cls, '<div class="m-body"></div>');
    flow.appendChild(el);
    buf = state.streaming[key] = { el: el.querySelector('.m-body'), text: '' };
  }
  buf.text += text;
  buf.el.textContent = buf.text;
}

function flushStreaming() {
  state.streaming = {};
}

// ---------- tool_call 卡片 ----------
function toolMeta(u) {
  const title = u.title || u.kind || 'tool';
  let detail = '';
  const raw = u.rawInput || {};
  if (raw.command) detail = raw.command;
  else if (raw.file_path) detail = raw.file_path;
  else if (raw.path) detail = raw.path;
  else if (raw.pattern) detail = raw.pattern;
  return { title, detail };
}

function renderToolCard(u) {
  const { title, detail } = toolMeta(u);
  const card = div('tool-card', '');
  card.dataset.tool = u.toolCallId || '';
  card.innerHTML = `
    <div class="t-head">
      <span class="t-kind ${esc(u.kind || '')}">${esc(u.kind || 'tool')}</span>
      <span>${esc(title)}</span>
      <span class="t-status">${esc(u.status || '')}</span>
    </div>
    <div class="t-body">${detail ? `<pre>${esc(detail)}</pre>` : ''}<div class="t-output"></div></div>`;
  card.querySelector('.t-head').onclick = () => card.classList.toggle('open');
  fillToolOutput(card, u);
  return card;
}

function updateToolCard(card, u) {
  const st = card.querySelector('.t-status');
  if (st && u.status) st.textContent = u.status;
  fillToolOutput(card, u);
}

function fillToolOutput(card, u) {
  const out = card.querySelector('.t-output');
  if (!out || !u.content?.length) return;
  for (const c of u.content) {
    if (c.type === 'content' && c.content?.type === 'text' && c.content.text) {
      const pre = document.createElement('pre');
      pre.textContent = c.content.text.slice(0, 3000);
      out.innerHTML = '';
      out.appendChild(pre);
    }
  }
}

// ---------- 权限审批 ----------
function renderPerms() {
  const area = $('permArea');
  area.innerHTML = '';
  for (const [rid, p] of state.pendingPerms) {
    if (p.sessionId !== state.currentSession) continue;
    const { detail } = toolMeta(p.toolCall || {});
    const banner = div('perm-banner', '');
    banner.innerHTML = `
      <div class="p-title">⚠ 等待审批 — ${esc(p.toolCall?.title || p.toolCall?.kind || '操作')}</div>
      ${detail ? `<div class="p-cmd">${esc(detail)}</div>` : ''}
      <div class="p-opts"></div>`;
    const opts = banner.querySelector('.p-opts');
    for (const o of p.options ?? []) {
      const btn = document.createElement('button');
      btn.className = 'btn small' + (o.kind === 'reject_once' || o.kind?.startsWith('reject') ? ' danger' : o.kind === 'allow_once' ? ' primary' : '');
      btn.textContent = o.name || o.optionId;
      btn.onclick = () => {
        send({ type: 'permission.respond', sessionId: p.sessionId, requestId: rid, optionId: o.optionId });
      };
      opts.appendChild(btn);
    }
    const rej = document.createElement('button');
    rej.className = 'btn small danger';
    rej.textContent = '拒绝';
    rej.onclick = () => send({ type: 'permission.respond', sessionId: p.sessionId, requestId: rid, cancelled: true });
    if (!(p.options ?? []).some((o) => o.kind?.startsWith('reject'))) opts.appendChild(rej);
    area.appendChild(banner);
  }
}

// ---------- 交互绑定 ----------
$('btnPair').onclick = () => {
  const code = $('pairCode').value.trim();
  const name = $('pairName').value.trim() || (/Mobi|Android/i.test(navigator.userAgent) ? '手机浏览器' : '桌面浏览器');
  if (code.replace(/[-\s]/g, '').length !== 8) {
    showError('请输入完整 8 位配对码');
    return;
  }
  connect();
  const tryPair = () => {
    if (state.ws.readyState === 1) {
      send({ type: 'pair', code, deviceName: name, platform: 'pwa' });
    } else setTimeout(tryPair, 300);
  };
  tryPair();
};
$('pairCode').addEventListener('input', (e) => {
  let v = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8);
  e.target.value = v.length > 4 ? v.slice(0, 4) + '-' + v.slice(4) : v;
});
$('pairCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnPair').click(); });

$('btnNewSession').onclick = () => $('newSessionForm').classList.toggle('open');
$('btnRefresh').onclick = () => { send({ type: 'session.list' }); send({ type: 'workdir.list' }); };
$('btnCreateSession').onclick = () => {
  const cwd = $('newSessionCwd').value;
  if (!cwd) return showError('没有可用工作目录 — 请在电脑端配置');
  send({ type: 'session.create', cwd });
  $('newSessionForm').classList.remove('open');
};

$('btnBack').onclick = () => {
  if (state.currentSession) send({ type: 'session.unsubscribe', sessionId: state.currentSession });
  state.currentSession = null;
  setView('list');
  send({ type: 'session.list' });
};

$('btnSend').onclick = sendPrompt;
$('inputBox').addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendPrompt();
  }
});
function sendPrompt() {
  const text = $('inputBox').value.trim();
  if (!text || !state.currentSession) return;
  state.msgCounter++;
  send({
    type: 'session.prompt',
    sessionId: state.currentSession,
    text,
    clientMsgId: `${state.device?.deviceId?.slice(0, 8) || 'web'}-${Date.now()}-${state.msgCounter}`,
  });
  $('inputBox').value = '';
}

$('btnCancel').onclick = () => {
  if (state.currentSession) send({ type: 'session.cancel', sessionId: state.currentSession });
};

$('modeSelect').onchange = (e) => {
  if (state.currentSession) {
    send({ type: 'session.setMode', sessionId: state.currentSession, modeId: e.target.value });
    toast('切换模式: ' + e.target.options[e.target.selectedIndex].text);
  }
};

// ---------- 启动 ----------
loadDevice();
connect();
