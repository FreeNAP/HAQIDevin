import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { AcpConnection } from './connection.js';
import type { InitializeResult, JsonRpcRequest } from '@devin-remote/acp-types';

export interface AgentOptions {
  devinPath: string;
  apiKey: string;
  cwd: string;
  model?: string;
}

/**
 * devin acp 进程管理器 — 单进程多会话复用:
 *  spawn → initialize → authenticate(_meta.api_key) → 就绪
 *  agent→client 的请求 (session/request_permission, fs/*) 经 onAgentRequest 派发给上层,
 *  按 params.sessionId 路由到对应 SessionRuntime。
 */
export class AgentProcess extends EventEmitter {
  private conn: AcpConnection | null = null;
  private readyPromise: Promise<InitializeResult> | null = null;
  public initResult: InitializeResult | null = null;
  public pid: number | null = null;
  private stderrTail: string[] = [];
  private restartCount = 0;

  constructor(private opts: AgentOptions) {
    super();
  }

  /** 启动并完成握手 (幂等: 重复调用复用同一 promise) */
  ensureReady(): Promise<InitializeResult> {
    if (this.readyPromise) return this.readyPromise;
    this.readyPromise = this.boot();
    return this.readyPromise;
  }

  private async boot(): Promise<InitializeResult> {
    const args = ['acp'];
    if (this.opts.model) args.push('--model', this.opts.model);

    const child = spawn(this.opts.devinPath, args, {
      cwd: this.opts.cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, WINDSURF_API_KEY: this.opts.apiKey },
    });
    this.pid = child.pid ?? null;

    child.stderr!.setEncoding('utf8');
    child.stderr!.on('data', (d: string) => {
      for (const line of d.split('\n')) {
        if (!line.trim()) continue;
        this.stderrTail.push(line);
        if (this.stderrTail.length > 80) this.stderrTail.shift();
        if (/ERROR|WARN/.test(line)) this.emit('stderrWarn', line);
      }
    });

    this.conn = new AcpConnection(child);
    this.conn.on('request', (msg: JsonRpcRequest) => this.emit('agentRequest', msg));
    this.conn.on('notification', (msg: { method: string; params?: unknown }) => this.emit('agentNotification', msg));
    this.conn.on('exit', (code: number) => {
      this.emit('exit', code);
      this.conn = null;
      this.readyPromise = null;
    });

    const init = await this.conn.request<InitializeResult>('initialize', {
      protocolVersion: 1,
      clientCapabilities: {
        fs: { readTextFile: true, writeTextFile: true },
      },
      clientInfo: { name: 'devin-remote-server', title: 'Devin Remote Server', version: '0.1.0' },
    }, 30000);

    await this.conn.request('authenticate', {
      methodId: 'devin-browser',
      _meta: { api_key: this.opts.apiKey },
    }, 30000);

    this.initResult = init;
    this.emit('ready', init);
    return init;
  }

  /** 已崩溃/退出后重启 (调用方负责 session/load 恢复) */
  async restart(): Promise<InitializeResult> {
    this.destroy();
    this.restartCount++;
    this.readyPromise = null;
    return this.ensureReady();
  }

  get connection(): AcpConnection | null {
    return this.conn;
  }

  isAlive(): boolean {
    return this.conn !== null && !this.conn.isClosed();
  }

  getStderrTail(): string[] {
    return [...this.stderrTail];
  }

  getRestartCount(): number {
    return this.restartCount;
  }

  destroy(): void {
    try { this.conn?.destroy(); } catch { /* ignore */ }
    this.conn = null;
    this.readyPromise = null;
  }
}
