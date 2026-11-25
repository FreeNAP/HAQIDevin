import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import type { JsonRpcId, JsonRpcMessage } from '@devin-remote/acp-types';

/**
 * NDJSON JSON-RPC 传输层 — 每个子进程 stdin/stdout 一条line一个JSON对象。
 *  - client→agent 请求: 数字 id, pending 表管理超时/应答
 *  - agent→client 请求: id 可能是字符串 UUID, 经 onRequest 回调上层处理
 *  - 通知: onNotification
 */
export class AcpConnection extends EventEmitter {
  private buffer = '';
  private nextId = 1;
  private pending = new Map<JsonRpcId, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; method: string }>();
  private closed = false;

  constructor(private proc: ChildProcess) {
    super();
    proc.stdout!.setEncoding('utf8');
    proc.stdout!.on('data', (d: string) => this.onData(d));
    proc.on('exit', (code) => this.onExit(code));
    proc.on('error', (err) => this.onExit(-1, err));
  }

  private onData(data: string) {
    this.buffer += data;
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, idx).trim();
      this.buffer = this.buffer.slice(idx + 1);
      if (!line) continue;
      let msg: JsonRpcMessage;
      try {
        msg = JSON.parse(line);
      } catch {
        this.emit('parseError', line);
        continue;
      }
      this.dispatch(msg);
    }
  }

  private dispatch(msg: JsonRpcMessage) {
    const m = msg as unknown as Record<string, unknown>;
    if (typeof m.method === 'string' && m.id !== undefined) {
      // agent→client request
      this.emit('request', msg);
    } else if (typeof m.method === 'string') {
      // notification
      this.emit('notification', msg);
    } else if (m.id !== undefined && this.pending.has(m.id as JsonRpcId)) {
      const p = this.pending.get(m.id as JsonRpcId)!;
      this.pending.delete(m.id as JsonRpcId);
      clearTimeout(p.timer);
      if (m.error) {
        const errObj = m.error as { code?: number; message?: string };
        const err = new Error(`${errObj.code}: ${errObj.message}`) as Error & { code?: number };
        err.code = errObj.code;
        p.reject(err);
      } else {
        p.resolve(m.result);
      }
    }
  }

  /** 发送请求并等待 result */
  request<T = unknown>(method: string, params?: unknown, timeoutMs = 120000): Promise<T> {
    if (this.closed) return Promise.reject(new Error('connection closed'));
    const id = this.nextId++;
    const msg = { jsonrpc: '2.0', id, method, params };
    this.proc.stdin!.write(JSON.stringify(msg) + '\n');
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`acp timeout: ${method}`));
        }
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer, method });
    });
  }

  /** 发送通知（无响应） */
  notify(method: string, params?: unknown): void {
    if (this.closed) return;
    this.proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  /** 回应 agent→client 请求 */
  respond(id: JsonRpcId, result: unknown): void {
    if (this.closed) return;
    this.proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  }

  respondError(id: JsonRpcId, code: number, message: string): void {
    if (this.closed) return;
    this.proc.stdin!.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
  }

  private onExit(code: number | null, err?: Error) {
    if (this.closed) return;
    this.closed = true;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(new Error(`agent process exited (code=${code})${err ? ': ' + err.message : ''}`));
    }
    this.pending.clear();
    this.emit('exit', code);
  }

  isClosed(): boolean {
    return this.closed;
  }

  destroy(): void {
    this.closed = true;
    try { this.proc.kill(); } catch { /* already dead */ }
  }
}
