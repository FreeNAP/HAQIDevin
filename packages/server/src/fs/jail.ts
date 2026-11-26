import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { WorkdirEntry } from '../config.js';

export type JailErrorCode =
  | 'invalid_path'
  | 'path_escapes_jail'
  | 'not_found'
  | 'not_directory'
  | 'not_file'
  | 'not_empty'
  | 'exists'
  | 'invalid_operation'
  | 'permission_denied'
  | 'fs_error';

export class JailError extends Error {
  constructor(
    public readonly code: JailErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'JailError';
  }
}

export interface JailResolution {
  /** 用户输入经 path.resolve 后的绝对路径 (保留未创建尾段) */
  inputPath: string;
  /** 最近存在祖先 realpath + 未创建尾段 — symlink 祖先已解析 */
  realPath: string;
  /** 命中的 workdir realpath */
  rootRealPath: string;
}

function caseKey(p: string): string {
  return process.platform === 'win32' ? p.toLowerCase() : p;
}

/** target 是否为 root 本身或其任意深度子路径 (大小写规则随平台) */
export function pathWithin(target: string, root: string): boolean {
  const rel = relative(caseKey(root), caseKey(target));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * realpath 最近存在祖先, 再把不存在尾段拼回。
 * 这是新建文件/目的路径场景的关键: 只 realpath 不存在路径本身会漏掉祖先 symlink 逃逸。
 */
async function realpathNearestExisting(target: string): Promise<string> {
  const missing: string[] = [];
  let cursor = target;
  for (;;) {
    try {
      const real = await realpath(cursor);
      return missing.reduce((acc, seg) => join(acc, seg), real);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw err;
      const parent = dirname(cursor);
      if (parent === cursor) return target;
      const seg = cursor.slice(parent.length).replace(/^[/\\]+/, '');
      missing.unshift(seg);
      cursor = parent;
    }
  }
}

/**
 * workdirs 监狱校验。
 *  - 只接受绝对路径
 *  - root 自身不存在时不放行其下任何路径
 *  - target/最近存在祖先 realpath 后必须落在 root realpath 内
 */
export async function resolveInJail(pathInput: string, roots: WorkdirEntry[]): Promise<JailResolution> {
  if (typeof pathInput !== 'string' || !pathInput.trim()) {
    throw new JailError('invalid_path', '路径不能为空');
  }
  if (!isAbsolute(pathInput)) {
    throw new JailError('invalid_path', `必须是绝对路径: ${pathInput}`);
  }
  const inputPath = resolve(pathInput);
  let realPath: string;
  try {
    realPath = await realpathNearestExisting(inputPath);
  } catch (err) {
    throw new JailError('invalid_path', `路径解析失败: ${(err as Error).message}`);
  }

  for (const root of roots) {
    if (!root?.path) continue;
    let rootReal: string;
    try {
      rootReal = await realpath(resolve(root.path));
    } catch {
      continue;
    }
    if (pathWithin(realPath, rootReal)) {
      return { inputPath, realPath, rootRealPath: rootReal };
    }
  }
  throw new JailError('path_escapes_jail', `路径越出允许的工作目录: ${pathInput}`);
}

/** Node fs 错误 → wire error code */
export function fsErrorCode(err: unknown): JailErrorCode {
  if (err instanceof JailError) return err.code;
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  switch (code) {
    case 'ENOENT': return 'not_found';
    case 'ENOTDIR': return 'not_directory';
    case 'ENOTEMPTY': return 'not_empty';
    case 'EEXIST': return 'exists';
    case 'EPERM':
    case 'EACCES': return 'permission_denied';
    default: return 'fs_error';
  }
}

export function fsErrorMessage(err: unknown): string {
  if (err instanceof JailError) return err.message;
  return String((err as Error | undefined)?.message ?? err);
}
