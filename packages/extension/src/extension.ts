import * as vscode from 'vscode';
import { networkInterfaces } from 'node:os';
import { ServerManager } from './serverManager';
import { TunnelManager } from './tunnelManager';
import { ControlPanel } from './panel';

let serverMgr: ServerManager;
let tunnelMgr: TunnelManager;
let panel: ControlPanel;
let statusBar: vscode.StatusBarItem;
let stateTimer: NodeJS.Timeout | null = null;

export function activate(context: vscode.ExtensionContext): void {
  serverMgr = new ServerManager(context);
  tunnelMgr = new TunnelManager(context);
  panel = new ControlPanel(context);

  // 状态栏
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 90);
  statusBar.command = 'devin-remote.openPanel';
  context.subscriptions.push(statusBar);
  statusBar.show();
  updateStatusBar();

  serverMgr.onState(() => { updateStatusBar(); void pushState(); });
  tunnelMgr.onState(() => { updateStatusBar(); void pushState(); });

  // 命令
  context.subscriptions.push(
    vscode.commands.registerCommand('devin-remote.openPanel', () => { panel.show(); void pushState(); }),
    vscode.commands.registerCommand('devin-remote.newPairingCode', () => void genPairingCode()),
    vscode.commands.registerCommand('devin-remote.restartServer', () => void serverMgr.restart().then(pushState)),
    vscode.commands.registerCommand('devin-remote.reconnectTunnel', () => void tunnelMgr.reconnect().then(pushState)),
    vscode.commands.registerCommand('devin-remote.toggleServer', async () => {
      if (serverMgr.running) await serverMgr.stop(); else await serverMgr.start();
      void pushState();
    }),
  );

  // 面板消息
  panel.onCommand(async (msg) => {
    switch (msg.command) {
      case 'refresh': await pushState(); break;
      case 'newPairingCode': await genPairingCode(); break;
      case 'restartServer': await serverMgr.restart(); await pushState(); break;
      case 'reconnectTunnel': await tunnelMgr.reconnect(); await pushState(); break;
      case 'toggleServer':
        if (serverMgr.running) await serverMgr.stop(); else await serverMgr.start();
        await pushState();
        break;
      case 'revokeDevice': await revokeDevice(msg.deviceId as string); break;
      case 'saveWorkdirs': await saveWorkdirs(msg.workdirs as string[]); break;
      case 'openSettings': void vscode.commands.executeCommand('workbench.action.openSettings', 'devin-remote'); break;
    }
  });

  // 侧栏
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider('devin-remote.sidebar', new SidebarProvider()),
  );

  // 自动启动
  const cfg = vscode.workspace.getConfiguration('devin-remote');
  if (cfg.get<boolean>('autoStart') ?? true) {
    void serverMgr.start().then(() => {
      void tunnelMgr.start();
      void pushState();
    });
  }

  // 周期状态推送
  stateTimer = setInterval(() => void pushState(), 5000);
  context.subscriptions.push({ dispose: () => { if (stateTimer) clearInterval(stateTimer); } });
}

export function deactivate(): void {
  void serverMgr?.stop();
  void tunnelMgr?.stop();
}

function updateStatusBar(): void {
  const s = serverMgr?.running;
  const t = tunnelMgr?.state ?? 'off';
  if (!s) {
    statusBar.text = '$(circle-slash) Devin Remote';
    statusBar.tooltip = '远程服务未运行 — 点击打开控制面板';
  } else if (t === 'connected') {
    statusBar.text = '$(radio-tower) Devin Remote';
    statusBar.tooltip = '远程服务在线 · 隧道已连接';
  } else if (t === 'connecting' || t === 'downloading') {
    statusBar.text = '$(sync~spin) Devin Remote';
    statusBar.tooltip = '隧道连接中…';
  } else {
    statusBar.text = '$(home) Devin Remote';
    statusBar.tooltip = '仅局域网可用 (隧道未连接)';
  }
}

function lanAddress(port: number): string {
  for (const ifaces of Object.values(networkInterfaces())) {
    for (const i of ifaces ?? []) {
      if (i.family === 'IPv4' && !i.internal) return `http://${i.address}:${port}`;
    }
  }
  return `http://127.0.0.1:${port}`;
}

async function fetchJson(url: string, init?: RequestInit): Promise<Record<string, unknown> | null> {
  try {
    const r = await fetch(url, init);
    if (!r.ok) return null;
    return await r.json() as Record<string, unknown>;
  } catch { return null; }
}

let lastPairing: { code: string; expiresAt: number; qrSvg: string } | null = null;

async function genPairingCode(): Promise<void> {
  const port = await serverMgr.healthPort();
  const r = await fetchJson(`http://127.0.0.1:${port}/api/pairing/code`, { method: 'POST' });
  if (!r?.code) {
    vscode.window.showErrorMessage('Devin Remote: 生成配对码失败 — 服务未运行?');
    return;
  }
  const cfg = vscode.workspace.getConfiguration('devin-remote');
  const hostname = cfg.get<string>('publicHostname') || '';
  const deepLinkHost = hostname ? `https://${hostname}` : lanAddress(port);
  // QR 内容: 服务地址 + 配对码, 手机端扫码即得两者
  const qrPayload = JSON.stringify({ url: deepLinkHost, code: r.code });
  let qrSvg = '';
  try {
    const qrcode = await import('qrcode');
    qrSvg = await qrcode.toString(qrPayload, { type: 'svg', margin: 1, width: 140 });
  } catch { qrSvg = ''; }
  lastPairing = { code: r.code as string, expiresAt: r.expiresAt as number, qrSvg };
  panel.show();
  await pushState();
}

async function revokeDevice(deviceId: string): Promise<void> {
  const port = await serverMgr.healthPort();
  await fetchJson(`http://127.0.0.1:${port}/api/devices/revoke`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ deviceId }),
  });
  await pushState();
}

async function saveWorkdirs(dirs: string[]): Promise<void> {
  const cfg = vscode.workspace.getConfiguration('devin-remote');
  await cfg.update('workdirs', dirs, vscode.ConfigurationTarget.Global);
  serverMgr.syncConfig();
  vscode.window.showInformationMessage('Devin Remote: 工作目录已保存 — 重启服务后生效', '重启服务').then((c) => {
    if (c) void serverMgr.restart();
  });
}

async function pushState(): Promise<void> {
  if (!panel.visible) { updateStatusBar(); return; }
  const cfg = vscode.workspace.getConfiguration('devin-remote');
  const port = cfg.get<number>('port') ?? 8787;
  const hostname = cfg.get<string>('publicHostname') || '';
  const status = await fetchJson(`http://127.0.0.1:${port}/api/status`);
  const devices = await fetchJson(`http://127.0.0.1:${port}/api/devices`);
  if (lastPairing && lastPairing.expiresAt < Date.now()) lastPairing = null;
  panel.postState({
    serverRunning: serverMgr.running,
    port,
    tunnelState: tunnelMgr.state,
    tunnelDetail: tunnelMgr.state === 'error' ? tunnelMgr.lastError : undefined,
    agentAlive: !!status?.agentAlive,
    agentPid: status?.agentPid,
    lanUrl: lanAddress(port),
    wanUrl: hostname ? `https://${hostname}` : null,
    workdirs: cfg.get<string[]>('workdirs') ?? [],
    devices: devices?.devices ?? [],
    pairingCode: lastPairing?.code ?? null,
    pairingExpires: lastPairing?.expiresAt ?? 0,
    qrSvg: lastPairing?.qrSvg ?? '',
    log: serverMgr.getLog().slice(-60),
  });
  updateStatusBar();
}

class SidebarProvider implements vscode.WebviewViewProvider {
  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = { enableScripts: true };
    view.webview.html = `<!DOCTYPE html><html><body style="font-family:var(--vscode-font-family);padding:12px">
      <div style="font-size:13px;margin-bottom:10px"><b>Devin Remote</b></div>
      <div id="st" style="font-size:12px;color:var(--vscode-descriptionForeground);margin-bottom:12px">—</div>
      <button onclick="vscode.postMessage({c:'open'})" style="width:100%;padding:6px;background:var(--vscode-button-background);color:var(--vscode-button-foreground);border:none;cursor:pointer">打开控制面板</button>
      <script>
        const vscode = acquireVsCodeApi();
        window.addEventListener('message', e => {
          if (e.data.type === 'status') document.getElementById('st').textContent = e.data.text;
        });
        vscode.postMessage({c:'ready'});
      </script></body></html>`;
    view.webview.onDidReceiveMessage((m) => {
      if (m.c === 'open') void vscode.commands.executeCommand('devin-remote.openPanel');
    });
    const tick = () => {
      const s = serverMgr?.running ? '服务运行中' : '服务未运行';
      const t = { connected: ' · 隧道在线', connecting: ' · 隧道连接中', degraded: ' · 隧道抖动' }[tunnelMgr?.state as string] ?? '';
      view.webview.postMessage({ type: 'status', text: s + t });
    };
    const iv = setInterval(tick, 4000);
    view.onDidDispose(() => clearInterval(iv));
  }
}
