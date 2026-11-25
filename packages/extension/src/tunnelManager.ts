import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, createWriteStream, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import * as vscode from 'vscode';

export type TunnelState = 'off' | 'downloading' | 'connecting' | 'connected' | 'degraded' | 'error';

/**
 * cloudflared 命名隧道守护
 *  - 首次使用自动下载官方二进制 (按平台), 存 globalStorage
 *  - token 模式: cloudflared tunnel --no-autoupdate run --token <t>
 *  - 公网回环健康检查: https://<hostname>/api/health 探活, 连续失败标记 degraded
 */
export class TunnelManager {
  private child: ChildProcess | null = null;
  private healthTimer: NodeJS.Timeout | null = null;
  private onStateChange: (s: TunnelState, detail?: string) => void = () => {};
  private failStreak = 0;
  private stoppedByUser = false;
  public state: TunnelState = 'off';
  public lastError = '';

  constructor(private context: vscode.ExtensionContext) {}

  onState(cb: (s: TunnelState, detail?: string) => void): void {
    this.onStateChange = cb;
  }

  private setState(s: TunnelState, detail?: string) {
    this.state = s;
    this.onStateChange(s, detail);
  }

  private binPath(): string {
    const name = process.platform === 'win32' ? 'cloudflared.exe' : 'cloudflared';
    return join(this.context.globalStorageUri.fsPath, name);
  }

  private downloadUrl(): string {
    const plat = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'darwin' : 'linux';
    const arch = process.arch === 'arm64' ? 'arm64' : 'amd64';
    const file = process.platform === 'win32' ? `cloudflared-windows-${arch}.exe` : `cloudflared-${plat}-${arch}`;
    return `https://github.com/cloudflare/cloudflared/releases/latest/download/${file}`;
  }

  async ensureBinary(progress?: (msg: string) => void): Promise<string> {
    const bin = this.binPath();
    if (existsSync(bin)) return bin;

    this.setState('downloading');
    progress?.('下载 cloudflared…');
    const url = this.downloadUrl();
    const tmp = bin + '.download';
    const fs = await import('node:fs');
    fs.mkdirSync(this.context.globalStorageUri.fsPath, { recursive: true });

    const res = await fetch(url, { redirect: 'follow' });
    if (!res.ok || !res.body) throw new Error(`cloudflared 下载失败: HTTP ${res.status}`);
    await pipeline(res.body as unknown as NodeJS.ReadableStream, createWriteStream(tmp));
    fs.renameSync(tmp, bin);
    if (process.platform !== 'win32') chmodSync(bin, 0o755);
    return bin;
  }

  async start(): Promise<void> {
    const cfg = vscode.workspace.getConfiguration('devin-remote');
    const token = cfg.get<string>('tunnelToken') ?? '';
    const hostname = cfg.get<string>('publicHostname') ?? '';
    // 本地 config 文件模式优先 (ingress 在文件里, 适配国内网络 protocol: http2)
    const { homedir } = await import('node:os');
    const localConfig = join(homedir(), '.cloudflared', 'config-devin.yml');
    const useConfigFile = existsSync(localConfig);

    // 公网已在线 (外部启动的隧道, 如 start-tunnel.pyw)? 直接接管状态, 不再 spawn 冲突进程
    if (hostname && await this.probePublic(hostname)) {
      this.setState('connected');
      this.startHealthLoop();
      return;
    }

    if (!useConfigFile && (!token || !hostname)) {
      // 无自管能力但有域名: 仍启动探测循环, 外部隧道上线时面板能及时反映
      if (hostname) this.startHealthLoop();
      this.setState('off', '未配置隧道 token 或域名');
      return;
    }

    this.stoppedByUser = false;
    try {
      const bin = await this.ensureBinary();
      const args = useConfigFile
        ? ['tunnel', '--config', localConfig, '--no-autoupdate', 'run']
        : ['tunnel', '--no-autoupdate', 'run', '--token', token];
      this.spawn(bin, args);
    } catch (e) {
      this.lastError = String((e as Error).message);
      this.setState('error', this.lastError);
    }
  }

  private spawn(bin: string, args: string[]): void {
    this.setState('connecting');
    const child = spawn(bin, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    this.child = child;

    let sawConnected = false;
    const onLog = (d: Buffer | string) => {
      const text = String(d);
      if (/Registered tunnel connection|Connection .+ registered/i.test(text) && !sawConnected) {
        sawConnected = true;
        this.failStreak = 0;
        this.setState('connected');
      }
      const errMatch = text.match(/ERR\s+(.+)/);
      if (errMatch) this.lastError = errMatch[1].slice(0, 200);
    };
    child.stdout?.on('data', onLog);
    child.stderr?.on('data', onLog);

    child.on('exit', (code) => {
      this.child = null;
      if (!this.stoppedByUser) {
        this.setState('connecting', `cloudflared 退出 code=${code}, 3s 后重连`);
        setTimeout(() => { if (!this.stoppedByUser) this.spawn(bin, args); }, 3000);
      } else {
        this.setState('off');
      }
    });

    this.startHealthLoop();
  }

  /** 单次公网回环探测 */
  private async probePublic(hostname: string): Promise<boolean> {
    try {
      const ctl = new AbortController();
      const t = setTimeout(() => ctl.abort(), 8000);
      const r = await fetch(`https://${hostname}/api/health`, { signal: ctl.signal });
      clearTimeout(t);
      return r.ok;
    } catch {
      return false;
    }
  }

  /** 公网回环健康检查: 走 Cloudflare 打自己, 验证端到端 — 独立于自管进程, 外部启动的隧道同样识别 */
  private startHealthLoop(): void {
    if (this.healthTimer) clearInterval(this.healthTimer);
    this.healthTimer = setInterval(async () => {
      const cfg = vscode.workspace.getConfiguration('devin-remote');
      const hostname = cfg.get<string>('publicHostname') ?? '';
      if (!hostname) return;
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 8000);
        const r = await fetch(`https://${hostname}/api/health`, { signal: ctl.signal });
        clearTimeout(t);
        if (r.ok) {
          this.failStreak = 0;
          if (this.state !== 'connected') this.setState('connected');
        } else {
          this.failStreak++;
        }
      } catch {
        this.failStreak++;
      }
      // 仅在自管进程或曾在线的情况下才降级; 外部从未在线时保持 off
      if (this.failStreak >= 3 && this.state === 'connected') {
        this.setState('degraded', '公网回环连续失败');
      }
    }, 20000);
  }

  /** 外部探测模式: 插件未自管隧道时, 仅依据公网回环反映真实可达性 (识别 start-tunnel.pyw 等外部启动) */
  startExternalProbe(): void {
    if (this.child) return; // 自管模式已由 start() 启动探测
    const cfg = vscode.workspace.getConfiguration('devin-remote');
    if (!cfg.get<string>('publicHostname')) return;
    this.startHealthLoop();
  }

  async stop(): Promise<void> {
    this.stoppedByUser = true;
    if (this.healthTimer) { clearInterval(this.healthTimer); this.healthTimer = null; }
    try { this.child?.kill(); } catch { /* ignore */ }
    this.child = null;
    this.setState('off');
  }

  async reconnect(): Promise<void> {
    await this.stop();
    await new Promise((r) => setTimeout(r, 800));
    this.stoppedByUser = false;
    await this.start();
  }

  async sha256OfBin(): Promise<string | null> {
    const bin = this.binPath();
    if (!existsSync(bin)) return null;
    return new Promise((resolveHash) => {
      const h = createHash('sha256');
      createReadStream(bin)
        .on('data', (d) => h.update(d))
        .on('end', () => resolveHash(h.digest('hex')))
        .on('error', () => resolveHash(null));
    });
  }
}
