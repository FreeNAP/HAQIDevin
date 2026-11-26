/**
 * 服务端文件路径工具 — 资源管理器侧边栏专用
 * 兼容 Windows (C:\x\y, 分隔符 \, 大小写不敏感) 与 POSIX (/x/y) 两种风格,
 * 以路径自身特征推断分隔符, 不依赖运行端平台 (手机端无法 path 模块)
 */

/** 推断路径分隔符 — 盘符/UNC 开头或含反斜杠视为 Windows 风格 */
export function detectSep(path: string): '/' | '\\' {
  if (/^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\')) return '\\';
  return path.includes('\\') ? '\\' : '/';
}

function isDriveRoot(p: string): boolean {
  return /^[A-Za-z]:[\\/]$/.test(p);
}

/** 去掉尾部多余分隔符 — 裸根 (/, C:\) 保留原样 */
export function trimTrailingSep(path: string): string {
  let p = path;
  while (p.length > 1 && (p.endsWith('/') || p.endsWith('\\'))) {
    if (p === '/' || p === '\\' || isDriveRoot(p)) break;
    p = p.slice(0, -1);
  }
  return p;
}

/** 拼接单段文件名 — name 为 fs.list 条目的 name (不含分隔符) */
export function joinPath(base: string, name: string): string {
  const sep = detectSep(base);
  const b = trimTrailingSep(base);
  // 裸根后不再补分隔符: '/' + 'etc' → '/etc'; 'C:\' + 'a' → 'C:\a'
  if (b === '/' || b === '\\' || isDriveRoot(b)) return `${b}${name}`;
  return `${b}${sep}${name}`;
}

/** 最后一段名 (文件/目录名) */
export function baseName(path: string): string {
  const p = trimTrailingSep(path);
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  return idx >= 0 ? p.slice(idx + 1) : p;
}

/** 父目录 — 已到根 (/ 或 C:\) 或无分隔符时返回 null */
export function parentPath(path: string): string | null {
  const p = trimTrailingSep(path);
  if (p === '/' || p === '\\' || isDriveRoot(p)) return null;
  const idx = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
  if (idx < 0) return null;
  if (idx === 0) return p.slice(0, 1); // '/x' → '/'
  const parent = p.slice(0, idx);
  // 'C:\x' → 盘符根保留下来的分隔符: 'C:' + '\' → 'C:\'
  if (/^[A-Za-z]:$/.test(parent)) return parent + (p[idx] ?? '\\');
  return parent;
}

function isWindowsish(path: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(path) || path.startsWith('\\\\');
}

/**
 * path 相对 root 的相对路径 — 不在 root 内返回 null
 * root 内等于 root 本身返回 '' (调用方按需显示为 '.')
 * 返回串保留原路径分隔符风格; Windows 根按大小写不敏感比较
 * 比较前统一分隔符 — cwd 配置可能是正斜杠 (C:/x) 而 server 拼接条目是反斜杠 (C:\x\y), 混合场景不断链
 */
export function relativePath(root: string, path: string): string | null {
  const r = trimTrailingSep(root);
  const p = trimTrailingSep(path);
  const insensitive = isWindowsish(r);
  // 归一仅用于比较; 索引截取在原串 p 上进行 ('\\'→'/' 一对一替换不改变长度)
  let rCmp = r.replace(/\\/g, '/');
  let pCmp = p.replace(/\\/g, '/');
  if (insensitive) {
    rCmp = rCmp.toLowerCase();
    pCmp = pCmp.toLowerCase();
  }
  if (pCmp === rCmp) return '';
  if (pCmp.startsWith(rCmp + '/')) {
    return p.slice(r.length + 1);
  }
  return null;
}

/** path 是否等于 root 或位于 root 之内 */
export function withinRoot(root: string, path: string): boolean {
  return relativePath(root, path) !== null;
}

/** @-引用格式: 相对路径统一转正斜杠 (agent/聊天文本里跨平台可读) */
export function toReferencePath(root: string, path: string): string {
  const rel = relativePath(root, path);
  if (rel === null) return baseName(path);
  if (rel === '') return baseName(root);
  return rel.replace(/\\/g, '/');
}

/** 字节数人类可读 — 紧凑小写后缀, 匹配 mono 风格 */
export function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '';
  if (n < 1024) return `${n}B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10 * 1024 ? 1 : 0)}K`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)}M`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(1)}G`;
}

/**
 * fs 请求-响应匹配键宽松归一 — server 回显 path 经 path.resolve 归一 (分隔符/尾斜杠/盘符大小写
 * 与原始输入可能不一致), 而 error 的 ref 是输入原样串; 统一成 小写+反斜杠+去尾斜杠 后比较, 兼容两种来源
 */
export function normalizeFsKey(p: string): string {
  let s = p.replace(/\//g, '\\');
  while (s.length > 1 && s.endsWith('\\')) {
    if (s === '\\\\' || /^[A-Za-z]:\\$/.test(s)) break;
    s = s.slice(0, -1);
  }
  return s.toLowerCase();
}
