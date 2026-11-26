import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AccountQuotaMsg, AccountUsageAggregate } from '@devin-remote/protocol';
import type { Store } from './store/db.js';
import { loadDevinApiKey } from './creds.js';

const CONNECT_PATH = '/exa.seat_management_pb.SeatManagementService/GetUserStatus';
const CONNECT_TIMEOUT_MS = 10_000;

interface CredentialInfo {
  key: string | null;
  apiServerUrl: string;
  devinApiUrl?: string;
}

/** 读取 devin credentials.toml; 不把 key 写入任何日志/响应 */
function loadCredentialInfo(): CredentialInfo {
  const { key } = loadDevinApiKey();
  let apiServerUrl = 'https://server.codeium.com';
  let devinApiUrl: string | undefined;
  const candidates: string[] = [];
  if (process.platform === 'win32' && process.env.APPDATA) {
    candidates.push(join(process.env.APPDATA, 'devin', 'credentials.toml'));
  }
  candidates.push(join(process.env.HOME || '', '.config', 'devin', 'credentials.toml'));
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const text = readFileSync(p, 'utf8');
      apiServerUrl = text.match(/api_server_url\s*=\s*"([^"]+)"/)?.[1] ?? apiServerUrl;
      devinApiUrl = text.match(/devin_api_url\s*=\s*"([^"]+)"/)?.[1];
      break;
    } catch { /* try next */ }
  }
  return { key, apiServerUrl, devinApiUrl };
}

function asObject(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;
}

function numberOrNull(v: unknown): number | null {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() && Number.isFinite(Number(v))) return Number(v);
  return null;
}

function findNumericDeep(root: unknown, names: string[], depth = 0): number | null {
  if (depth > 8) return null;
  const obj = asObject(root);
  if (!obj) return null;
  for (const name of names) {
    const hit = numberOrNull(obj[name]);
    if (hit !== null) return hit;
  }
  for (const value of Object.values(obj)) {
    if (value && typeof value === 'object') {
      const hit = findNumericDeep(value, names, depth + 1);
      if (hit !== null) return hit;
    }
  }
  return null;
}

function unixSecondsToMs(v: number | null): number | null {
  if (v === null) return null;
  // 兼容少数实现直接返回 ms 的情况
  return v > 10_000_000_000 ? v : v * 1000;
}

function pick(obj: unknown, keys: string[]): Record<string, unknown> {
  const src = asObject(obj);
  const out: Record<string, unknown> = {};
  if (!src) return out;
  for (const k of keys) {
    if (k in src) out[k] = src[k];
  }
  return out;
}

/** connect 响应的安全投影: 保留额度/plan 字段, 剔除 email/team/org/account id 等账户隐私 */
function quotaRawProjection(raw: unknown): unknown {
  const root = asObject(raw);
  if (!root) return null;
  const us = asObject(root.userStatus ?? root.user_status);
  const ps = asObject(us?.planStatus ?? us?.plan_status);
  const pi = asObject(ps?.planInfo ?? ps?.plan_info);
  const rootPi = asObject(root.planInfo ?? root.plan_info);
  return {
    userStatus: {
      pro: us?.pro ?? null,
      teamsTier: us?.teamsTier ?? us?.teams_tier ?? null,
      planStatus: {
        ...pick(ps, [
          'availablePromptCredits', 'availableFlowCredits', 'usedPromptCredits', 'usedFlowCredits',
          'availableFlexCredits', 'usedFlexCredits', 'dailyQuotaRemainingPercent', 'weeklyQuotaRemainingPercent',
          'overageBalanceMicros', 'dailyQuotaResetAtUnix', 'weeklyQuotaResetAtUnix', 'acuConsumed', 'acuLimit',
          'planStart', 'planEnd',
          'available_prompt_credits', 'available_flow_credits', 'used_prompt_credits', 'used_flow_credits',
          'available_flex_credits', 'used_flex_credits', 'daily_quota_remaining_percent', 'weekly_quota_remaining_percent',
          'overage_balance_micros', 'daily_quota_reset_at_unix', 'weekly_quota_reset_at_unix', 'acu_consumed', 'acu_limit',
          'plan_start', 'plan_end',
        ]),
        planInfo: pick(pi, ['planName', 'teamsTier', 'hideDailyQuota', 'isDevin', 'billingStrategy', 'plan_name', 'teams_tier', 'hide_daily_quota', 'is_devin', 'billing_strategy']),
      },
    },
    planInfo: pick(rootPi, ['planName', 'teamsTier', 'hideDailyQuota', 'isDevin', 'billingStrategy', 'plan_name', 'teams_tier', 'hide_daily_quota', 'is_devin', 'billing_strategy']),
  };
}

async function probeConnectQuota(): Promise<{ raw: unknown | null; error: string | null; host: string | null }> {
  const creds = loadCredentialInfo();
  if (!creds.key) return { raw: null, error: 'credentials.toml 无 windsurf_api_key', host: null };
  const hosts = [...new Set([creds.apiServerUrl, 'https://server.codeium.com', creds.devinApiUrl].filter((x): x is string => !!x))];
  const errors: string[] = [];

  for (const host of hosts) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);
    try {
      const body = {
        metadata: {
          apiKey: creds.key,
          ideName: 'devin-cli',
          ideVersion: '3000.11.3',
          extensionName: 'devin',
          extensionVersion: '3000.11.3',
          locale: 'en-US',
        },
      };
      const res = await fetch(host.replace(/\/$/, '') + CONNECT_PATH, {
        method: 'POST',
        headers: {
          'accept': 'application/json',
          'content-type': 'application/json',
          'connect-protocol-version': '1',
          'authorization': `Bearer ${creds.key}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const text = await res.text();
      if (!res.ok) {
        errors.push(`${host}: HTTP ${res.status} ${text.slice(0, 160)}`);
        continue;
      }
      return { raw: JSON.parse(text), error: null, host };
    } catch (e) {
      errors.push(`${host}: ${String((e as Error).message).slice(0, 160)}`);
    } finally {
      clearTimeout(timer);
    }
  }
  return { raw: null, error: errors.join(' | ') || 'connect 探针失败', host: null };
}

function usageNumber(meta: Record<string, unknown>, name: string): number {
  return numberOrNull(meta[`cognition.ai/${name}`]) ?? numberOrNull(meta[name]) ?? 0;
}

/**
 * events fallback 的保守统计:
 * usage_update 在 session/load 重放时会产生重复事件, 且 inputTokens/ACU 常为累计值;
 * 因此每会话取各指标最大值作为“至少消耗”, 再跨会话求和。docs/quota-research.md 明确该限制。
 */
export function aggregateUsageFromEvents(store: Store): AccountUsageAggregate {
  let totalCreditCost = 0;
  let totalAcuCost = 0;
  let inputTokens = 0;
  let eventCount = 0;
  let sessionsWithUsage = 0;

  for (const session of store.listSessions()) {
    const per = { credit: 0, acu: 0, input: 0 };
    const seen = new Set<string>();
    for (const ev of store.eventsSince(session.sessionId, 0)) {
      if (ev.kind !== 'acp-update') continue;
      const p = asObject(ev.payload);
      if (!p || p.sessionUpdate !== 'usage_update') continue;
      const meta = asObject(p._meta) ?? {};
      const signature = JSON.stringify([p.used, p.size, meta]);
      if (!seen.has(signature)) {
        seen.add(signature);
        eventCount++;
      }
      per.credit = Math.max(per.credit, usageNumber(meta, 'totalCreditCost'));
      per.acu = Math.max(per.acu, usageNumber(meta, 'totalAcuCost'));
      per.input = Math.max(per.input, usageNumber(meta, 'inputTokens'));
    }
    if (seen.size) sessionsWithUsage++;
    totalCreditCost += per.credit;
    totalAcuCost += per.acu;
    inputTokens += per.input;
  }

  return { totalCreditCost, totalAcuCost, inputTokens, eventCount, sessions: sessionsWithUsage };
}

/** account.quota 主入口: connect-RPC 优先, events 统计始终附带作 fallback/对照 */
export async function getAccountQuota(store: Store): Promise<AccountQuotaMsg> {
  const sessionUsage = aggregateUsageFromEvents(store);
  const probe = await probeConnectQuota();
  const raw = probe.raw;
  const weekly = findNumericDeep(raw, ['weeklyQuotaRemainingPercent', 'weekly_quota_remaining_percent']);
  const daily = findNumericDeep(raw, ['dailyQuotaRemainingPercent', 'daily_quota_remaining_percent']);
  const overage = findNumericDeep(raw, ['overageBalanceMicros', 'overage_balance_micros']);
  const dailyReset = unixSecondsToMs(findNumericDeep(raw, ['dailyQuotaResetAtUnix', 'daily_quota_reset_at_unix']));
  const weeklyReset = unixSecondsToMs(findNumericDeep(raw, ['weeklyQuotaResetAtUnix', 'weekly_quota_reset_at_unix']));
  const acuConsumed = findNumericDeep(raw, ['acuConsumed', 'acu_consumed']);
  const acuLimit = findNumericDeep(raw, ['acuLimit', 'acu_limit']);

  const us = asObject(asObject(raw)?.userStatus ?? asObject(raw)?.user_status);
  const ps = asObject(us?.planStatus ?? us?.plan_status);
  const pi = asObject(ps?.planInfo ?? ps?.plan_info) ?? asObject(asObject(raw)?.planInfo ?? asObject(raw)?.plan_info);
  const planName = typeof pi?.planName === 'string' ? pi.planName : typeof pi?.plan_name === 'string' ? pi.plan_name : null;

  return {
    type: 'account.quota',
    source: raw ? 'connect-rpc' : sessionUsage.eventCount ? 'events-fallback' : 'none',
    weeklyRemainingPercent: weekly,
    dailyRemainingPercent: daily,
    dailyResetAt: dailyReset,
    weeklyResetAt: weeklyReset,
    overageBalance: overage,
    overageBalanceMicros: overage,
    acuConsumed,
    acuLimit,
    planName,
    sessionUsage,
    raw: raw ? quotaRawProjection(raw) : { connectError: probe.error },
  };
}
