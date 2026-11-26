/**
 * 行级文本 diff — 简化 Myers O((N+M)D) 实现
 * 不引第三方依赖; 输入由调用方先截断, 大文件退化为粗粒度删除+新增以避免移动端卡顿
 */

export type DiffLineType = 'add' | 'del' | 'context';

export interface DiffLine {
  type: DiffLineType;
  text: string;
}

/** 统一换行并去掉末尾换行造成的幻影空行; 中间空行保留 */
export function splitLines(text: string): string[] {
  if (!text) return [];
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop();
  return lines;
}

function contextLines(lines: string[]): DiffLine[] {
  return lines.map((text) => ({ type: 'context' as const, text }));
}

/** Myers 中段 diff; 调用方已剥离公共头尾, 这里不要求输入非空 */
function myersMiddle(a: string[], b: string[]): DiffLine[] {
  if (a.length === 0) return b.map((text) => ({ type: 'add' as const, text }));
  if (b.length === 0) return a.map((text) => ({ type: 'del' as const, text }));

  const max = a.length + b.length;
  const offset = max;
  const width = max * 2 + 1;
  const v = new Int32Array(width);
  const trace: Int32Array[] = [];
  let endD = -1;

  for (let d = 0; d <= max; d += 1) {
    let reached = false;
    for (let k = -d; k <= d; k += 2) {
      const idx = k + offset;
      const down = k === -d || (k !== d && v[idx - 1] < v[idx + 1]);
      let x = down ? v[idx + 1] : v[idx - 1] + 1;
      let y = x - k;
      while (x < a.length && y < b.length && a[x] === b[y]) {
        x += 1;
        y += 1;
      }
      v[idx] = x;
      if (x >= a.length && y >= b.length) {
        reached = true;
        break;
      }
    }
    trace.push(v.slice());
    if (reached) {
      endD = d;
      break;
    }
  }

  if (endD < 0) {
    // 理论上不可达; 防御性降级仍保证输出包含全部输入行
    return [...a.map((text) => ({ type: 'del' as const, text })), ...b.map((text) => ({ type: 'add' as const, text }))];
  }

  const reversed: DiffLine[] = [];
  let x = a.length;
  let y = b.length;
  for (let d = endD; d > 0; d -= 1) {
    const prev = trace[d - 1]!;
    const k = x - y;
    const idx = k + offset;
    const down = k === -d || (k !== d && prev[idx - 1] < prev[idx + 1]);
    const prevK = down ? k + 1 : k - 1;
    const prevX = prev[prevK + offset]!;
    const prevY = prevX - prevK;

    while (x > prevX && y > prevY) {
      x -= 1;
      y -= 1;
      reversed.push({ type: 'context', text: a[x]! });
    }
    if (x === prevX && y > prevY) {
      y -= 1;
      reversed.push({ type: 'add', text: b[y]! });
    } else if (y === prevY && x > prevX) {
      x -= 1;
      reversed.push({ type: 'del', text: a[x]! });
    }
  }
  while (x > 0 && y > 0) {
    x -= 1;
    y -= 1;
    reversed.push({ type: 'context', text: a[x]! });
  }
  return reversed.reverse();
}

/**
 * 计算行级 diff。先剥公共头尾, 典型小改动只需对很小的中段跑 Myers;
 * 超大中段直接 del+add 粗排 — 展示层本来会折叠, 不值得为最优最小编辑序列掉帧。
 */
export function diffLines(oldText: string, newText: string): DiffLine[] {
  const a = splitLines(oldText);
  const b = splitLines(newText);
  if (a.length === 0 && b.length === 0) return [];

  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start += 1;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA -= 1;
    endB -= 1;
  }

  const prefix = contextLines(a.slice(0, start));
  const suffix = contextLines(a.slice(endA));
  const midA = a.slice(start, endA);
  const midB = b.slice(start, endB);
  const middle = midA.length + midB.length > 1400
    ? [...midA.map((text) => ({ type: 'del' as const, text })), ...midB.map((text) => ({ type: 'add' as const, text }))]
    : myersMiddle(midA, midB);
  return [...prefix, ...middle, ...suffix];
}
