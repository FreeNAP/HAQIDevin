/**
 * 配对二维码内容解析 — 约定格式 + 宽容降级:
 *  1. devinremote://pair?host=<host>&code=<8位码>   (标准)
 *  2. <host>|<code>                                 (纯文本管道形)
 *  3. 任意含 host=/code= 查询参数的 URL 形式          (宽容)
 * host 可能是 URL 编码; code 容忍无横线/小写/含空格, 统一规范化为 XXXX-XXXX
 */

export interface PairQrResult {
  host?: string;
  code?: string;      // 已规范化为 XXXX-XXXX
}

/** 规范化配对码: 去非字母数字 → 大写 → 8 位补横线; 不合法返回 undefined */
export function normalizePairCode(raw: string): string | undefined {
  const clean = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (clean.length !== 8) return undefined;
  return `${clean.slice(0, 4)}-${clean.slice(4)}`;
}

function decodeHost(raw: string): string | undefined {
  const trimmed = raw.trim();
  if (!trimmed) return undefined;
  try {
    return decodeURIComponent(trimmed);
  } catch {
    return trimmed; // 含非法 % 序列时按原文使用
  }
}

function extractParams(input: string): { host?: string; code?: string } {
  // 手工解析查询参数 — RN/Hermes 的 URL/URLSearchParams 实现不完整, 且 scheme 自定义时行为不一
  const qIdx = input.indexOf('?');
  if (qIdx < 0) return {};
  const query = input.slice(qIdx + 1).split('#')[0] ?? '';
  const out: { host?: string; code?: string } = {};
  for (const pair of query.split('&')) {
    const eq = pair.indexOf('=');
    if (eq < 0) continue;
    const key = pair.slice(0, eq).trim().toLowerCase();
    const value = pair.slice(eq + 1);
    if (key === 'host' && !out.host) out.host = decodeHost(value);
    if ((key === 'code' || key === 'paircode' || key === 'pair') && !out.code) {
      const normalized = normalizePairCode(value);
      if (normalized) out.code = normalized;
    }
  }
  return out;
}

/** 解析扫码内容 — 无法识别返回 null; 仅识别出一种信息也返回 (调用方自行补全) */
export function parsePairQr(raw: string): PairQrResult | null {
  const input = raw.trim();
  if (!input) return null;

  // 形式 2: <host>|<code> 纯文本
  if (!input.includes('://') && input.includes('|')) {
    const [hostPart, codePart] = input.split('|').map((s) => s.trim());
    const code = codePart ? normalizePairCode(codePart) : undefined;
    const host = hostPart ? decodeHost(hostPart) : undefined;
    if (host || code) return { host, code };
    return null;
  }

  // 形式 1/3: URL 形 — 提取查询参数
  const params = extractParams(input);
  if (params.host || params.code) return params;

  // 兜底: 整体就是一个配对码
  const codeOnly = normalizePairCode(input);
  if (codeOnly) return { code: codeOnly };

  return null;
}
