/** 相对时间格式化 (中文, 对照 mockup: "2 分钟前 / 昨天") */

export function relativeTime(ts: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - ts);
  const sec = Math.floor(diff / 1000);
  if (sec < 45) return '刚刚';
  const min = Math.floor(sec / 60);
  if (min < 1) return `${sec} 秒前`;
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day === 1) return '昨天';
  if (day < 30) return `${day} 天前`;
  const month = Math.floor(day / 30);
  if (month < 12) return `${month} 个月前`;
  return `${Math.floor(month / 12)} 年前`;
}

/** 时长格式化: 65 -> "1m 5s", 3722 -> "1h 2m" */
export function durationText(sec: number): string {
  if (sec < 60) return `${Math.floor(sec)}s`;
  const m = Math.floor(sec / 60);
  if (m < 60) return `${m}m ${Math.floor(sec % 60)}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** 目录路径取最后一段作为显示名: C:\a\b\HAQIDevin -> HAQIDevin */
export function dirName(cwd: string): string {
  const parts = cwd.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] ?? cwd;
}

/** 本地时刻 "HH:mm" (24 小时制, 补零) */
export function clockTime(ts: number): string {
  const d = new Date(ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  return `${hh}:${mm}`;
}

/** 本地日期时刻 "M月D日 HH:mm" — 额度重置时间等绝对时间展示用 */
export function dateTimeText(ts: number): string {
  const d = new Date(ts);
  return `${d.getMonth() + 1}月${d.getDate()}日 ${clockTime(ts)}`;
}

/**
 * 未来时间相对文案 — 额度重置倒计时用:
 *   < 1h  "45 分钟后" | < 24h "5 小时后" | < 2d "明天 HH:mm" | 其余 "x 天后"
 * 已过期返回 null (调用方决定兜底显示)
 */
export function futureText(ts: number, now: number = Date.now()): string | null {
  const diff = ts - now;
  if (diff <= 0) return null;
  const min = Math.floor(diff / 60000);
  if (min < 1) return '即将';
  if (min < 60) return `${min} 分钟后`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时后`;
  const day = Math.floor(hour / 24);
  if (day < 2) return `明天 ${clockTime(ts)}`;
  return `${day} 天后`;
}
