import { createServer, type Server as HttpServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join, extname, normalize } from 'node:path';
import type { Store } from '../store/db.js';
import type { PairingService } from '../auth/pairing.js';
import type { ServerConfig } from '../config.js';
import type { SessionManager } from '../acp/runtime.js';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webmanifest': 'application/manifest+json',
  '.woff2': 'font/woff2',
};

export interface HttpApiOptions {
  config: ServerConfig;
  store: Store;
  pairing: PairingService;
  mgr: SessionManager;
  startedAt: number;
  webRoot?: string;   // PWA 静态目录 (web/dist)
  version: string;
}

/**
 * HTTP API + PWA 静态托管
 *  /api/health           — 裸 200, 隧道健康检查用, 不泄露信息
 *  /api/pairing/code     — POST 生成配对码 (仅限 loopback 调用: 桌面面板/本机)
 *  /api/pairing/codes    — GET 活跃配对码 (仅 loopback)
 *  /api/status           — GET 服务状态 (仅 loopback, 面板用)
 *  / 、/assets/*         — PWA 静态文件
 */
export function createHttpServer(opts: HttpApiOptions): HttpServer {
  const { config, pairing, mgr, startedAt, webRoot, version } = opts;

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);
    const path = url.pathname;
    const remote = req.socket.remoteAddress ?? '';
    const isLoopback = remote === '127.0.0.1' || remote === '::1' || remote === '::ffff:127.0.0.1';

    // CORS: PWA 与 API 同源, 不需开放; 仅健康检查公开
    if (path === '/api/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    if (path === '/api/pairing/code' && req.method === 'POST') {
      if (!isLoopback) return deny(res, 403, 'pairing code 只能在本机生成');
      const { code, expiresAt } = pairing.createCode();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code, expiresAt, hostname: config.publicHostname ?? null, port: config.port }));
      return;
    }

    if (path === '/api/pairing/codes' && req.method === 'GET') {
      if (!isLoopback) return deny(res, 403, 'forbidden');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ codes: pairing.listActiveCodes() }));
      return;
    }

    if (path === '/api/status' && req.method === 'GET') {
      if (!isLoopback) return deny(res, 403, 'forbidden');
      const sessions = mgr.list().map((rt) => rt.meta);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        ok: true,
        version,
        uptimeSec: Math.floor((Date.now() - startedAt) / 1000),
        port: config.port,
        host: config.host,
        publicHostname: config.publicHostname ?? null,
        lanEnabled: config.lanEnabled,
        sessions: sessions.length,
        activeSessions: sessions.filter((s) => s.status === 'running' || s.status === 'waiting_permission').length,
        agentAlive: mgr.agent.isAlive(),
        agentPid: mgr.agent.pid,
        workdirs: config.workdirs,
      }));
      return;
    }

    if (path === '/api/agent/log' && req.method === 'GET') {
      if (!isLoopback) return deny(res, 403, 'forbidden');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ lines: mgr.agent.getStderrTail().slice(-40) }));
      return;
    }

    if (path === '/api/devices' && req.method === 'GET') {
      if (!isLoopback) return deny(res, 403, 'forbidden');
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({
        devices: opts.store.listDevices().map((d) => ({
          deviceId: d.deviceId,
          deviceName: d.deviceName,
          platform: d.platform,
          pairedAt: d.pairedAt,
          lastActiveAt: d.lastActiveAt,
          revoked: !!d.revokedAt,
        })),
      }));
      return;
    }

    if (path === '/api/devices/revoke' && req.method === 'POST') {
      if (!isLoopback) return deny(res, 403, 'forbidden');
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        try {
          const { deviceId } = JSON.parse(body);
          const ok = opts.store.revokeDevice(deviceId);
          res.writeHead(ok ? 200 : 404, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ ok }));
        } catch {
          deny(res, 400, 'bad json');
        }
      });
      return;
    }

    // ---------- PWA 静态 ----------
    if (webRoot && req.method === 'GET') {
      return serveStatic(webRoot, path, res);
    }

    deny(res, 404, 'not found');
  });
}

function deny(res: ServerResponse, code: number, message: string): void {
  res.writeHead(code, { 'content-type': 'application/json' });
  res.end(JSON.stringify({ error: message }));
}

function serveStatic(root: string, urlPath: string, res: ServerResponse): void {
  let rel = decodeURIComponent(urlPath);
  if (rel === '/' || rel === '') rel = '/index.html';
  const filePath = normalize(join(root, rel));
  if (!filePath.startsWith(normalize(root))) {
    return deny(res, 403, 'forbidden');
  }
  let target = filePath;
  if (!existsSync(target) || !statSync(target).isFile()) {
    // SPA fallback: 非资源路径回 index.html
    if (!extname(target)) {
      target = join(root, 'index.html');
    }
  }
  if (!existsSync(target)) {
    return deny(res, 404, 'not found');
  }
  const ext = extname(target).toLowerCase();
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'cache-control': ['.html', '.js', '.webmanifest'].includes(ext) ? 'no-cache' : 'public, max-age=86400',
  });
  res.end(readFileSync(target));
}
