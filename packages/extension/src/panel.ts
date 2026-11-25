import * as vscode from 'vscode';

/** 控制面板 webview — 极简白纸 Mono 风格 */
export class ControlPanel {
  private panel: vscode.WebviewPanel | null = null;
  private onMessage: (msg: { command: string; [k: string]: unknown }) => void = () => {};

  constructor(private context: vscode.ExtensionContext) {}

  onCommand(cb: (msg: { command: string; [k: string]: unknown }) => void): void {
    this.onMessage = cb;
  }

  show(): void {
    if (this.panel) {
      this.panel.reveal();
      return;
    }
    this.panel = vscode.window.createWebviewPanel(
      'devin-remote-panel',
      'Devin Remote 控制面板',
      vscode.ViewColumn.One,
      { enableScripts: true, retainContextWhenHidden: true },
    );
    this.panel.webview.html = this.html();
    this.panel.webview.onDidReceiveMessage((m) => this.onMessage(m));
    this.panel.onDidDispose(() => { this.panel = null; });
  }

  postState(state: unknown): void {
    this.panel?.webview.postMessage({ type: 'state', state });
  }

  get visible(): boolean {
    return !!this.panel;
  }

  private html(): string {
    return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<style>
:root { --paper:#fdfdfb; --ink:#111110; --soft:#57544e; --faint:#a8a49b; --line:#111110; --linesoft:#e4e1d8; --accent:#e8360f; --ok:#1a7f37; --warn:#b25e09; }
* { margin:0; padding:0; box-sizing:border-box; }
body { background:var(--paper); color:var(--ink); font-family:"Helvetica Neue",Helvetica,"PingFang SC","Microsoft YaHei",sans-serif; padding:28px 32px; line-height:1.5; }
h1 { font-size:26px; letter-spacing:-0.02em; margin-bottom:4px; }
h1 em { color:var(--accent); font-style:normal; }
.sub { color:var(--soft); font-size:13px; margin-bottom:22px; }
.grid { display:grid; grid-template-columns:1fr 1fr; gap:16px; }
@media (max-width:760px){ .grid{ grid-template-columns:1fr; } }
.card { border:2px solid var(--line); background:#fff; padding:16px; box-shadow:4px 4px 0 var(--ink); }
.card h2 { font-size:12px; text-transform:uppercase; letter-spacing:.1em; color:var(--soft); margin-bottom:10px; display:flex; align-items:center; gap:8px; }
.card h2::after{ content:""; flex:1; height:1px; background:var(--linesoft); }
.status-row { display:flex; align-items:center; gap:10px; padding:6px 0; font-size:13.5px; }
.dot { width:10px; height:10px; flex:none; }
.dot.on{ background:var(--ok); } .dot.off{ background:var(--faint); } .dot.warn{ background:var(--warn); } .dot.err{ background:var(--accent); }
.mono { font-family:Consolas,"SF Mono",monospace; }
.btn { display:inline-flex; padding:7px 14px; border:2px solid var(--line); background:var(--paper); font-weight:600; font-size:12.5px; cursor:pointer; box-shadow:2px 2px 0 var(--ink); font-family:inherit; color:var(--ink); border-radius:0; }
.btn:hover { transform:translate(-1px,-1px); box-shadow:3px 3px 0 var(--ink); }
.btn.primary { background:var(--ink); color:var(--paper); }
.btn.danger { border-color:var(--accent); color:var(--accent); }
.btn.small { padding:4px 9px; font-size:11px; box-shadow:none; border-width:1.5px; }
.paircode { font-family:Consolas,monospace; font-size:34px; letter-spacing:.25em; font-weight:700; text-align:center; padding:14px 0 6px; }
.qr-wrap { display:flex; gap:16px; align-items:center; }
.qr-wrap svg, .qr-wrap img { border:2px solid var(--line); }
.url-line { font-size:12px; padding:3px 0; color:var(--soft); word-break:break-all; }
.url-line b { color:var(--ink); }
.dev-row { display:flex; align-items:center; gap:8px; padding:7px 0; border-bottom:1px solid var(--linesoft); font-size:13px; }
.dev-row:last-child { border-bottom:none; }
.dev-row .name { font-weight:600; }
.dev-row .meta { font-size:11px; color:var(--faint); }
.dev-row .sp{ flex:1; }
textarea, input[type=text] { width:100%; border:2px solid var(--line); padding:8px 10px; font-family:Consolas,monospace; font-size:12.5px; border-radius:0; outline:none; background:#fff; color:var(--ink); }
.log-box { font-family:Consolas,monospace; font-size:11px; background:var(--ink); color:#e8e6df; padding:10px; height:180px; overflow-y:auto; white-space:pre-wrap; word-break:break-all; }
.empty { color:var(--faint); font-size:12.5px; padding:10px 0; }
.badge { font-size:10px; border:1.5px solid var(--line); padding:1px 6px; text-transform:uppercase; font-weight:700; letter-spacing:.05em; }
.guide { font-size:12.5px; color:var(--soft); }
.guide li { margin:4px 0 4px 18px; }
.guide code { background:var(--paper); border:1px solid var(--linesoft); padding:1px 4px; font-size:11px; }
</style></head><body>
<h1>devin<em>/</em>remote 控制台</h1>
<div class="sub">手机远程接入你的 devin 会话 — 服务托管 · 隧道 · 配对 · 设备</div>
<div class="grid">
  <div class="card">
    <h2>服务状态</h2>
    <div class="status-row"><span class="dot" id="dotServer"></span><span>本地服务</span><span class="mono" id="serverInfo" style="color:var(--faint);font-size:12px"></span><span style="flex:1"></span>
      <button class="btn small" onclick="cmd('restartServer')">重启</button>
      <button class="btn small" id="btnToggle" onclick="cmd('toggleServer')">停/启</button></div>
    <div class="status-row"><span class="dot" id="dotTunnel"></span><span>Cloudflare 隧道</span><span class="mono" id="tunnelInfo" style="color:var(--faint);font-size:12px"></span><span style="flex:1"></span>
      <button class="btn small" onclick="cmd('reconnectTunnel')">重连</button></div>
    <div class="status-row"><span class="dot" id="dotAgent"></span><span>devin acp</span><span class="mono" id="agentInfo" style="color:var(--faint);font-size:12px"></span></div>
    <div style="margin-top:10px">
      <div class="url-line"><b>局域网:</b> <span class="mono" id="lanUrl">—</span></div>
      <div class="url-line"><b>公网:</b> <span class="mono" id="wanUrl">—</span></div>
    </div>
  </div>

  <div class="card">
    <h2>手机配对</h2>
    <div id="pairArea">
      <div class="empty">点击生成一次性配对码 (5 分钟有效)</div>
      <button class="btn primary" data-cmd="newPairingCode" style="width:100%">生成配对码</button>
    </div>
  </div>

  <div class="card">
    <h2>已配对设备</h2>
    <div id="deviceList"><div class="empty">载入中…</div></div>
  </div>

  <div class="card">
    <h2>工作目录清单</h2>
    <div class="guide" style="margin-bottom:8px">手机端只能在这些目录中创建会话 (一行一个绝对路径) — 保存在设置 <code>devin-remote.workdirs</code></div>
    <textarea id="workdirsInput" rows="4" placeholder="C:\\\\Users\\\\you\\\\projects\\\\foo"></textarea>
    <div style="margin-top:8px; text-align:right"><button class="btn small" onclick="saveWorkdirs()">保存并同步</button></div>
  </div>

  <div class="card" style="grid-column:1/-1">
    <h2>隧道首次配置指引</h2>
    <ol class="guide">
      <li>登录 Cloudflare Zero Trust → Networks → Tunnels → Create tunnel (cloudflared)</li>
      <li>复制隧道 Token 填入设置 <code>devin-remote.tunnelToken</code></li>
      <li>隧道加 Public Hostname: 子域如 <code>devin.example.com</code>, Service 填 <code>http://localhost:8787</code></li>
      <li>把该域名填入设置 <code>devin-remote.publicHostname</code> — 插件自动守护隧道并做公网回环健康检查</li>
    </ol>
    <div style="margin-top:6px"><button class="btn small" onclick="cmd('openSettings')">打开插件设置</button></div>
  </div>

  <div class="card" style="grid-column:1/-1">
    <h2>服务日志</h2>
    <div class="log-box" id="logBox">—</div>
  </div>
</div>
<script>
const vscode = acquireVsCodeApi();
function cmd(command, extra){ vscode.postMessage(Object.assign({command}, extra||{})); }
document.addEventListener('click', (ev) => { const t = ev.target.closest('[data-cmd]'); if (t) cmd(t.dataset.cmd, t.dataset.deviceid ? { deviceId: t.dataset.deviceid } : {}); });
function saveWorkdirs(){
  const lines = document.getElementById('workdirsInput').value.split('\\n').map(s=>s.trim()).filter(Boolean);
  cmd('saveWorkdirs', { workdirs: lines });
}
// ---- 差异化渲染: 指纹对比, 只在变化时重建 DOM, 杜绝闪烁 ----
const fp = { devices: '', pair: '', log: '', workdirs: '' };
let pairExpiresAt = 0;
setInterval(() => {
  const el = document.getElementById('pairCountdown');
  if (el && pairExpiresAt) {
    const left = Math.max(0, Math.round((pairExpiresAt - Date.now()) / 1000));
    el.textContent = left + 's 后过期 · 仅能用一次';
  }
}, 1000);

window.addEventListener('message', (e) => {
  const { type, state } = e.data;
  if (type !== 'state' || !state) return;
  const s = state;
  setDot('dotServer', s.serverRunning ? 'on' : 'off');
  setText('serverInfo', s.serverRunning ? ('运行中 :' + s.port) : '未运行');
  const td = { connected:'on', connecting:'warn', degraded:'warn', downloading:'warn', error:'err', off:'off' }[s.tunnelState] || 'off';
  setDot('dotTunnel', td);
  setText('tunnelInfo', s.tunnelDetail || s.tunnelState);
  setDot('dotAgent', s.agentAlive ? 'on' : 'off');
  setText('agentInfo', s.agentAlive ? ('就绪 pid=' + (s.agentPid||'')) : '未启动');
  setText('lanUrl', s.lanUrl || '—');
  setText('wanUrl', s.wanUrl || '(未配置域名)');

  const wd = (s.workdirs || []).join('\\n');
  const wdInput = document.getElementById('workdirsInput');
  if (wd !== fp.workdirs && document.activeElement !== wdInput) {
    wdInput.value = wd;
    fp.workdirs = wd;
  }

  const logText = (s.log || []).slice(-80).join('\\n');
  if (logText !== fp.log) {
    fp.log = logText;
    const box = document.getElementById('logBox');
    const stick = box.scrollTop + box.clientHeight >= box.scrollHeight - 30;
    box.textContent = logText;
    if (stick) box.scrollTop = box.scrollHeight;
  }

  const pairKey = (s.pairingCode || '') + '|' + (s.pairingExpires || 0);
  if (pairKey !== fp.pair) {
    fp.pair = pairKey;
    pairExpiresAt = s.pairingExpires || 0;
    const area = document.getElementById('pairArea');
    if (s.pairingCode) {
      const left = Math.max(0, Math.round((s.pairingExpires - Date.now())/1000));
      area.innerHTML =
        '<div class="qr-wrap">' + (s.qrSvg || '') +
        '<div><div class="paircode">' + escHtml(s.pairingCode) + '</div>' +
        '<div class="url-line" style="text-align:center" id="pairCountdown">' + left + 's 后过期 · 仅能用一次</div></div></div>' +
        '<div style="margin-top:10px"><button class="btn small" data-cmd="newPairingCode">重新生成</button></div>';
    } else {
      area.innerHTML = '<div class="empty">点击生成一次性配对码 (5 分钟有效)</div>' +
        '<button class="btn primary" data-cmd="newPairingCode" style="width:100%">生成配对码</button>';
    }
  }

  const devJson = JSON.stringify(s.devices || []);
  if (devJson !== fp.devices) {
    fp.devices = devJson;
    const dl = document.getElementById('deviceList');
    if (!s.devices || !s.devices.length) { dl.innerHTML = '<div class="empty">还没有配对设备</div>'; }
    else {
      dl.innerHTML = s.devices.map(d =>
        '<div class="dev-row"><div><div class="name">' + escHtml(d.deviceName) + (d.revoked?' <span class="badge" style="border-color:var(--accent);color:var(--accent)">已撤销</span>':'') + '</div>' +
        '<div class="meta">' + escHtml(d.platform||'') + ' · 配对 ' + fmtTime(d.pairedAt) + ' · 活跃 ' + fmtTime(d.lastActiveAt) + '</div></div>' +
        '<span class="sp"></span>' + (d.revoked ? '' : '<button class="btn small danger" data-cmd="revokeDevice" data-deviceid="' + d.deviceId + '">撤销</button>') + '</div>'
      ).join('');
    }
  }
});
function setText(id, t){ const el = document.getElementById(id); if (el && el.textContent !== t) el.textContent = t; }
function setDot(id, cls){ document.getElementById(id).className = 'dot ' + cls; }
function escHtml(s){ return String(s??'').replace(/[&<>"]/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c])); }
function fmtTime(t){ if(!t) return '—'; const d=new Date(t); return (d.getMonth()+1)+'/'+d.getDate()+' '+String(d.getHours()).padStart(2,'0')+':'+String(d.getMinutes()).padStart(2,'0'); }
cmd('refresh');
</script>
</body></html>`;
  }
}
