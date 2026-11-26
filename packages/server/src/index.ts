#!/usr/bin/env node
/**
 * devin-remote-server — Devin 远程控制面服务器
 * 用法: node dist/index.ts 或 npm run dev (Node 24 直接跑 ts)
 */
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig, resolveDevinPath, type ServerConfig } from './config.js';
import { loadDevinApiKey } from './creds.js';
import { Store } from './store/db.js';
import { AgentProcess } from './acp/agent.js';
import { SessionManager } from './acp/runtime.js';
import { PairingService } from './auth/pairing.js';
import { createHttpServer } from './gateway/httpApi.js';
import { Gateway } from './gateway/ws.js';

const VERSION = '0.1.0';

async function main() {
  const config = loadConfig();
  // 环境变量覆盖端口 (测试/多实例场景)
  if (process.env.DEVIN_REMOTE_PORT) {
    const p = parseInt(process.env.DEVIN_REMOTE_PORT, 10);
    if (!Number.isNaN(p)) config.port = p;
  }
  const { key, source } = loadDevinApiKey();

  console.log(`[devin-remote] v${VERSION}`);
  console.log(`[devin-remote] data dir 配置: ${config.port} 端口, host=${config.host}, LAN=${config.lanEnabled ? '开' : '关'}`);

  if (!key) {
    console.error('[devin-remote] ✘ 未找到 devin api key — 请先运行 `devin auth login` 完成桌面端登录');
    process.exit(1);
  }
  console.log(`[devin-remote] api key 来源: ${source}`);

  const devinPath = resolveDevinPath(config);
  if (!existsSync(devinPath) && process.platform === 'win32') {
    console.error(`[devin-remote] ✘ 找不到 devin: ${devinPath}`);
    process.exit(1);
  }

  // 持久层
  const store = new Store();
  await store.load();

  // agent 进程 (懒启动: 首个会话创建时拉起)
  const agent = new AgentProcess({
    devinPath,
    apiKey: key,
    cwd: config.workdirs[0]?.path ?? process.cwd(),
    model: config.defaultModel,
  });
  agent.on('stderrWarn', (line: string) => {
    if (!/migration/.test(line)) console.log(`[agent] ${line.slice(0, 200)}`);
  });

  const mgr = new SessionManager(agent, store);
  mgr.restoreSessions();
  console.log(`[devin-remote] 恢复历史会话 ${mgr.list().length} 个`);

  const pairing = new PairingService(store);

  // HTTP + WS
  const startedAt = Date.now();
  const webRoot = resolveWebRoot();
  const httpServer = createHttpServer({ config, store, pairing, mgr, startedAt, webRoot, version: VERSION });
  new Gateway(httpServer, mgr, store, pairing, config, startedAt);

  const bindHost = config.lanEnabled ? '0.0.0.0' : config.host;
  await new Promise<void>((resolveListen, rejectListen) => {
    httpServer.once('error', rejectListen);
    httpServer.listen(config.port, bindHost, () => resolveListen());
  }).catch((err) => {
    console.error(`[devin-remote] ✘ 端口 ${config.port} 监听失败: ${err.message}`);
    process.exit(1);
  });

  console.log(`[devin-remote] ✔ HTTP/WS 已监听 ${bindHost}:${config.port}`);
  console.log(`[devin-remote]   health: http://127.0.0.1:${config.port}/api/health`);
  if (webRoot) console.log(`[devin-remote]   PWA:    http://127.0.0.1:${config.port}/`);
  if (config.publicHostname) console.log(`[devin-remote]   公网:   https://${config.publicHostname}`);

  // agent 进程预热 (后台, 不阻塞启动); 实证探针可显式禁用, 避免测试实例拉起 devin 子进程
  if (process.env.DEVIN_REMOTE_DISABLE_AGENT === '1') {
    console.log('[devin-remote] 测试模式: 跳过 devin acp 预热');
  } else {
    agent.ensureReady().then(() => {
      console.log(`[devin-remote] ✔ devin acp 就绪 (pid=${agent.pid})`);
    }).catch((err) => {
      console.error(`[devin-remote] ✘ devin acp 启动失败: ${err.message}`);
    });
  }

  // 优雅停机
  const shutdown = (sig: string) => {
    console.log(`\n[devin-remote] ${sig} 收到, 正在停机…`);
    agent.destroy();
    httpServer.close();
    setTimeout(() => process.exit(0), 1500);
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

function resolveWebRoot(): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, '..', 'web'),          // dist/../web (编译后)
    join(here, 'web'),                // src/web (dev 直跑)
    join(here, '..', '..', 'web'),    // 兼容布局
  ];
  for (const c of candidates) {
    if (existsSync(join(c, 'index.html'))) return c;
  }
  return undefined;
}

main().catch((err) => {
  console.error('[devin-remote] 启动失败:', err);
  process.exit(1);
});
