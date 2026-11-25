import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import * as vscode from 'vscode';

/**
 * devin-remote-server 进程托管
 *  - spawn 方式: ELECTRON_RUN_AS_NODE=1 + process.execPath (Electron 即 Node 运行时)
 *  - 崩溃自动重启 (指数退避, 上限 5min)
 *  - 配置从 vscode settings 同步到 ~/.devin-remote/config.json
 */
export class ServerManager {
  private child: ChildProcess | null = null;
  private restartDelay = 2000;
  private stoppedByUser = false;
  private logLines: string[] = [];
  private adopted = false; // 端口上已有健康 server (非本插件 spawn), 接管其状态展示
  private consecutiveSpawnFails = 0;
  private onStateChange: (running: boolean) => void = () => {};

  constructor(private context: vscode.ExtensionContext) {}

  get running(): boolean {
    return this.adopted || (this.child !== null && !this.child.killed);
  }

  getLog(): string[] {
    return [...this.logLines];
  }

  onState(cb: (running: boolean) => void): void {
    this.onStateChange = cb;
  }

  /** 把 vscode 设置同步为 server 配置文件 */
  syncConfig(): void {
    const cfg = vscode.workspace.getConfiguration('devin-remote');
    const dir = join(homedir(), '.devin-remote');
    mkdirSync(dir, { recursive: true });
    const port = cfg.get<number>('port') ?? 8787;
    const workdirs = (cfg.get<string[]>('workdirs') ?? []).filter(Boolean).map((p) => ({ path: p }));
    const merged = {
      port,
      host: '127.0.0.1',
      lanEnabled: cfg.get<boolean>('lanEnabled') ?? true,
      publicHostname: cfg.get<string>('publicHostname') || undefined,
      workdirs,
    };
    writeFileSync(join(dir, 'config.json'), JSON.stringify(merged, null, 2));
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.stoppedByUser = false;
    this.syncConfig();

    const port = vscode.workspace.getConfiguration('devin-remote').get<number>('port') ?? 8787;
    // 端口已有健康 server (如外部启动或上次残留)? 直接接管, 避免重启风暴
    if (await this.waitHealth(port, 1500)) {
      this.adopted = true;
      this.pushLog('[host] 端口 ' + port + ' 已有健康 server, 接管状态展示');
      this.onStateChange(true);
      return;
    }

    const bundle = join(this.context.extensionPath, 'server', 'server-bundle.mjs');
    if (!existsSync(bundle)) {
      vscode.window.showErrorMessage('Devin Remote: server bundle 缺失, 插件安装不完整');
      return;
    }

    const child = spawn(process.execPath, [bundle], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;

    const pushLog = (d: Buffer | string) => {
      for (const line of String(d).split('\n')) {
        if (!line.trim()) continue;
        this.logLines.push(line);
        if (this.logLines.length > 300) this.logLines.shift();
      }
    };
    child.stdout?.on('data', pushLog);
    child.stderr?.on('data', pushLog);

    child.on('exit', (code) => {
      pushLog(`[host] server 退出 code=${code}`);
      this.child = null;
      this.onStateChange(false);
      if (!this.stoppedByUser && this.consecutiveSpawnFails < 3) {
        setTimeout(() => { if (!this.stoppedByUser) void this.start(); }, this.restartDelay);
        this.restartDelay = Math.min(this.restartDelay * 2, 300000);
      } else if (this.consecutiveSpawnFails >= 3) {
        pushLog('[host] 连续启动失败, 停止自动重试 — 请检查端口占用或查看日志后手动重启');
      }
    });

    // 健康确认: 轮询 /api/health 最多 15s
    const ok = await this.waitHealth(port, 15000);
    if (ok) {
      this.restartDelay = 2000;
      this.consecutiveSpawnFails = 0;
      this.onStateChange(true);
    } else {
      this.consecutiveSpawnFails++;
    }
  }

  private pushLog(line: string): void {
    this.logLines.push(line);
    if (this.logLines.length > 300) this.logLines.shift();
  }

  private async waitHealth(port: number, timeoutMs: number): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/api/health`);
        if (r.ok) return true;
      } catch { /* retry */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    return false;
  }

  async stop(): Promise<void> {
    this.stoppedByUser = true;
    this.adopted = false;
    try { this.child?.kill(); } catch { /* ignore */ }
    this.child = null;
    this.onStateChange(false);
  }

  async restart(): Promise<void> {
    await this.stop();
    await new Promise((r) => setTimeout(r, 800));
    this.stoppedByUser = false;
    await this.start();
  }

  async healthPort(): Promise<number> {
    return vscode.workspace.getConfiguration('devin-remote').get<number>('port') ?? 8787;
  }
}
