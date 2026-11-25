// Devin Remote 风格样稿组装器：content.html + skin-N.css → style-N-*.html
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = dirname(fileURLToPath(import.meta.url));
const content = readFileSync(join(root, 'src/content.html'), 'utf8');

const styles = [
  {
    n: 1, slug: 'workbench', name: '深空工作台 · Workbench',
    philosophy: 'IDE 原生暗色。等宽字体驱动、信息密度优先、青色信号点缀——为每天对着编辑器十小时的人造。',
  },
  {
    n: 2, slug: 'mono', name: '极简白纸 · Mono',
    philosophy: '瑞士排版。黑墨白纸、一个朱红accent、网格与留白说话——少即是多，没有一寸多余装饰。',
  },
  {
    n: 3, slug: 'pulse', name: '霓虹脉冲 · Pulse',
    philosophy: '赛博暗夜。深紫底、电紫与青色辉光、玻璃拟态——agent 的每次心跳都看得见。',
  },
  {
    n: 4, slug: 'field', name: '暖阳纸面 · Field',
    philosophy: '编辑式暖纸。奶油底色、衬线标题、墨绿与赭橙——像一本做得极好的手工杂志，安静而温暖。',
  },
  {
    n: 5, slug: 'slate', name: '雾蓝专业 · Slate',
    philosophy: '企业级冷灰蓝。条纹面板、精密边框、高密度数据——Stripe 控制台式的可靠与克制。',
  },
];

const js = `
// 配对码倒计时
document.querySelectorAll('.countdown').forEach(el => {
  let s = 4 * 60 + 32;
  setInterval(() => {
    s = s > 0 ? s - 1 : 4 * 60 + 32;
    el.textContent = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  }, 1000);
});
// 流式打字循环
document.querySelectorAll('.type-target').forEach(el => {
  const full = el.textContent;
  let i = full.length;
  setInterval(() => {
    i = i >= full.length + 24 ? 1 : i + 1;
    el.textContent = full.slice(0, Math.min(i, full.length));
  }, 55);
});
// 进入动画
requestAnimationFrame(() => document.querySelectorAll('[data-enter]').forEach((el, i) => {
  setTimeout(() => el.classList.add('entered'), 60 * i);
}));
`;

for (const s of styles) {
  const css = readFileSync(join(root, `src/skin-${s.n}-${s.slug}.css`), 'utf8');
  const html = content
    .replaceAll('STYLE-INDEX', `0${s.n} / 05`)
    .replaceAll('STYLE-NAME', s.name)
    .replaceAll('STYLE-PHILOSOPHY', s.philosophy);
  const page = `<!DOCTYPE html>
<html lang="zh-CN" data-style="${s.slug}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${s.name} — Devin Remote 风格样稿</title>
<style>
${css}
</style>
</head>
<body>
${html}
<script>${js}</script>
</body>
</html>`;
  const out = join(root, `style-${s.n}-${s.slug}.html`);
  writeFileSync(out, page);
  console.log(`built style-${s.n}-${s.slug}.html`);
}
