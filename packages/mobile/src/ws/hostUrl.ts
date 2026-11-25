/**
 * 主机地址规范化: 用户输入 → ws(s)://host[:port]/ws
 * 规则:
 *  - ws:// / wss:// 原样采用 (补 /ws 路径)
 *  - https:// → wss://, http:// → ws://
 *  - 裸输入: IP / localhost / 带端口号 → ws:// (局域网直连); 域名 → wss:// (Cloudflare Tunnel)
 * 不用 URL 类 — RN/Hermes 的 URL 实现在老版本不完整, 纯字符串解析最可靠
 * 不写死任何默认主机
 */

export interface ParsedHost {
  url: string;      // 规范化 ws url, 路径 /ws
  label: string;    // 展示用主机名 (host 或 host:port)
  secure: boolean;  // 是否 wss
}

export function normalizeHostInput(raw: string): ParsedHost | { error: string } {
  const input = raw.trim();
  if (!input) return { error: '请输入主机地址' };
  if (/\s/.test(input)) return { error: '主机地址不能包含空格' };

  let rest = input;
  let secure: boolean | null = null;

  const lower = rest.toLowerCase();
  if (lower.startsWith('wss://')) {
    secure = true;
    rest = rest.slice(6);
  } else if (lower.startsWith('ws://')) {
    secure = false;
    rest = rest.slice(5);
  } else if (lower.startsWith('https://')) {
    secure = true;
    rest = rest.slice(8);
  } else if (lower.startsWith('http://')) {
    secure = false;
    rest = rest.slice(7);
  }

  if (secure === null) {
    // 裸输入 — 只有明确局域网形态 (IPv4 / localhost) 才默认明文 ws;
    // 域名一律默认 wss (安全优先, 公网主机名即使带自定义端口也应走 TLS)
    // 局域网主机名用户可显式输入 ws:// 前缀
    const bare = rest.split('/')[0] ?? '';
    const isIp = /^\d{1,3}(\.\d{1,3}){3}(:\d+)?$/.test(bare);
    const isLocal = /^localhost(:\d+)?$/i.test(bare) || /^127\./.test(bare);
    secure = !(isIp || isLocal);
  }

  // rest = host[:port][/path...]
  const slashIdx = rest.indexOf('/');
  const hostport = slashIdx >= 0 ? rest.slice(0, slashIdx) : rest;
  let path = slashIdx >= 0 ? rest.slice(slashIdx) : '';

  if (!hostport || !/^[A-Za-z0-9._:-]+$/.test(hostport)) {
    return { error: '主机地址格式无效' };
  }
  const hostOnly = hostport.split(':')[0] ?? '';
  if (!hostOnly) return { error: '主机地址缺少 host' };
  if (hostport.includes(':') && !/:\d+$/.test(hostport)) {
    return { error: '端口号无效' };
  }

  if (path === '' || path === '/') path = '/ws';
  // 去掉末尾多余斜杠
  if (path.length > 1 && path.endsWith('/')) path = path.slice(0, -1);

  const proto = secure ? 'wss' : 'ws';
  return {
    url: `${proto}://${hostport}${path}`,
    label: hostport,
    secure,
  };
}
