/**
 * 极简白纸 · Mono 色板 — 逐字取自 mockups/style-2-mono.html 的 CSS 变量
 */
export const colors = {
  paper: '#fafaf7',      // 纸白底
  paper2: '#f1f1ec',     // 次纸底
  card: '#ffffff',       // 卡片白
  ink: '#111311',        // 黑墨
  ink2: '#575b55',       // 次级墨
  ink3: '#9a9e96',       // 弱化墨
  line: '#111311',       // 硬边框线
  hairline: '#e2e2da',   // 细分隔线
  acc: '#e8442e',        // 朱红 accent
  accSoft: 'rgba(232, 68, 46, 0.07)',
  ok: '#1d7a3e',
  warn: '#b07800',
  danger: '#c22f1e',
  shadowInk: 'rgba(17, 19, 17, 0.12)',
  shadowAcc: 'rgba(232, 68, 46, 0.16)',
} as const;

export type ColorKey = keyof typeof colors;
