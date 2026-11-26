import {
  cp,
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rm,
  rmdir,
  stat,
  writeFile,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { FsEntry } from '@devin-remote/protocol';
import type { WorkdirEntry } from '../config.js';
import { JailError, pathWithin, resolveInJail } from './jail.js';

const DEFAULT_READ_MAX = 256 * 1024;
const READ_MAX_LIMIT = 1024 * 1024;

function entryTypeFromStats(st: import('node:fs').Stats): FsEntry['type'] {
  if (st.isFile()) return 'file';
  if (st.isDirectory()) return 'directory';
  if (st.isSymbolicLink()) return 'symlink';
  return 'other';
}

/** 目录 listing: 名称/类型/大小/mtime; showHidden=false 时过滤 dotfile */
export async function listDirectory(pathInput: string, roots: WorkdirEntry[], showHidden = false): Promise<{ path: string; entries: FsEntry[] }> {
  const res = await resolveInJail(pathInput, roots);
  const st = await stat(res.realPath);
  if (!st.isDirectory()) throw new JailError('not_directory', `不是目录: ${pathInput}`);
  const dirents = await readdir(res.realPath, { withFileTypes: true });
  const entries: FsEntry[] = [];
  for (const de of dirents) {
    if (!showHidden && de.name.startsWith('.')) continue;
    const childReal = join(res.realPath, de.name);
    const childDisplay = join(res.inputPath, de.name);
    try {
      const lst = await lstat(childReal);
      entries.push({
        name: de.name,
        path: childDisplay,
        type: entryTypeFromStats(lst),
        size: lst.size,
        mtimeMs: Math.round(lst.mtimeMs),
      });
    } catch {
      // 条目在 readdir/stat 间被删除: 跳过, 不让整个 listing 失败
    }
  }
  entries.sort((a, b) => {
    const ad = a.type === 'directory' ? 0 : 1;
    const bd = b.type === 'directory' ? 0 : 1;
    return ad - bd || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
  });
  return { path: res.inputPath, entries };
}

/** 读文件: 默认 utf8; 侦测到 NUL 时返回 base64, 防止二进制破坏 JSON UI */
export async function readFileInJail(pathInput: string, roots: WorkdirEntry[], maxBytes?: number): Promise<{
  path: string;
  content: string;
  encoding: 'utf8' | 'base64';
  size: number;
  mtimeMs: number;
  truncated: boolean;
}> {
  const limit = Math.min(Math.max(maxBytes ?? DEFAULT_READ_MAX, 1), READ_MAX_LIMIT);
  const res = await resolveInJail(pathInput, roots);
  const st = await stat(res.realPath);
  if (!st.isFile()) throw new JailError('not_file', `不是文件: ${pathInput}`);

  const fh = await open(res.realPath, 'r');
  try {
    const buf = Buffer.alloc(Math.min(limit + 1, Math.max(Number(st.size), 1)));
    const { bytesRead } = await fh.read(buf, 0, buf.length, 0);
    const slice = buf.subarray(0, bytesRead);
    const truncated = st.size > limit;
    const contentBuf = truncated ? slice.subarray(0, limit) : slice;
    const binary = contentBuf.subarray(0, Math.min(contentBuf.length, 8192)).includes(0);
    return {
      path: res.inputPath,
      content: binary ? contentBuf.toString('base64') : contentBuf.toString('utf8'),
      encoding: binary ? 'base64' : 'utf8',
      size: Number(st.size),
      mtimeMs: Math.round(st.mtimeMs),
      truncated,
    };
  } finally {
    await fh.close();
  }
}

/** 写文本文件 (utf8) — 不自动创建多级父目录, 避免误拼路径成片落盘 */
export async function writeFileInJail(pathInput: string, roots: WorkdirEntry[], content: string): Promise<{
  path: string;
  bytes: number;
  mtimeMs: number;
}> {
  const res = await resolveInJail(pathInput, roots);
  await writeFile(res.realPath, content, 'utf8');
  const st = await stat(res.realPath);
  return { path: res.inputPath, bytes: Buffer.byteLength(content, 'utf8'), mtimeMs: Math.round(st.mtimeMs) };
}

/** 删除文件/符号链接/目录; 非空目录在 recursive=false 时拒绝 */
export async function deleteInJail(pathInput: string, roots: WorkdirEntry[], recursive = false): Promise<{ path: string }> {
  const res = await resolveInJail(pathInput, roots);
  // 用 inputPath 删最终 symlink 本身; resolveInJail 已拒绝指向狱外的 symlink
  const lst = await lstat(res.inputPath);
  if (lst.isDirectory() && !lst.isSymbolicLink()) {
    if (recursive) {
      await rm(res.inputPath, { recursive: true, force: false });
    } else {
      await rmdir(res.inputPath);
    }
  } else {
    await rm(res.inputPath, { force: false });
  }
  return { path: res.inputPath };
}

async function destinationExists(p: string): Promise<boolean> {
  try {
    await lstat(p);
    return true;
  } catch {
    return false;
  }
}

async function removeExistingDestination(dst: string): Promise<void> {
  const lst = await lstat(dst);
  if (lst.isDirectory() && !lst.isSymbolicLink()) {
    await rm(dst, { recursive: true, force: false });
  } else {
    await rm(dst, { force: false });
  }
}

async function assertCopyMoveShape(srcReal: string, dstReal: string): Promise<void> {
  const sst = await stat(srcReal);
  if (sst.isDirectory() && pathWithin(dstReal, srcReal) && dstReal !== srcReal) {
    throw new JailError('invalid_operation', '不能将目录移动/复制到其自身内部');
  }
  if (dstReal === srcReal) {
    throw new JailError('invalid_operation', '源路径与目标路径相同');
  }
}

/** 移动/重命名; overwrite=true 时先清除已验证的 destination */
export async function moveInJail(srcInput: string, dstInput: string, roots: WorkdirEntry[], overwrite = false): Promise<{ src: string; dst: string }> {
  const src = await resolveInJail(srcInput, roots);
  const dst = await resolveInJail(dstInput, roots);
  await stat(src.realPath); // 源必须存在
  await assertCopyMoveShape(src.realPath, dst.realPath);

  if (await destinationExists(dst.inputPath)) {
    if (!overwrite) throw new JailError('exists', `目标已存在: ${dstInput}`);
    await removeExistingDestination(dst.inputPath);
  }

  try {
    await rename(src.inputPath, dst.inputPath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EXDEV') throw err;
    // 跨盘移动 fallback: copy + delete (Windows workdirs 常见 C: ↔ D:)
    const sst = await lstat(src.inputPath);
    if (sst.isDirectory() && !sst.isSymbolicLink()) {
      await cp(src.inputPath, dst.inputPath, { recursive: true, verbatimSymlinks: true });
      await rm(src.inputPath, { recursive: true, force: false });
    } else {
      await copyFile(src.inputPath, dst.inputPath);
      await rm(src.inputPath, { force: false });
    }
  }
  return { src: src.inputPath, dst: dst.inputPath };
}

/** 复制文件或目录 (目录递归复制); overwrite=false 时目标存在即拒绝 */
export async function copyInJail(srcInput: string, dstInput: string, roots: WorkdirEntry[], overwrite = false): Promise<{ src: string; dst: string }> {
  const src = await resolveInJail(srcInput, roots);
  const dst = await resolveInJail(dstInput, roots);
  const sst = await stat(src.realPath); // 源必须存在
  await assertCopyMoveShape(src.realPath, dst.realPath);

  if (!overwrite && await destinationExists(dst.inputPath)) {
    throw new JailError('exists', `目标已存在: ${dstInput}`);
  }
  if (sst.isDirectory()) {
    await cp(src.inputPath, dst.inputPath, {
      recursive: true,
      force: overwrite,
      errorOnExist: !overwrite,
      verbatimSymlinks: true,
    });
  } else {
    if (!overwrite && await destinationExists(dst.inputPath)) throw new JailError('exists', `目标已存在: ${dstInput}`);
    await copyFile(src.inputPath, dst.inputPath);
  }
  return { src: src.inputPath, dst: dst.inputPath };
}

/** git/config 等其他模块也需要确保 cwd 在监狱内且是存在目录 */
export async function assertDirectoryInJail(pathInput: string, roots: WorkdirEntry[]): Promise<{ inputPath: string; realPath: string }> {
  const res = await resolveInJail(pathInput, roots);
  const st = await stat(res.realPath);
  if (!st.isDirectory()) throw new JailError('not_directory', `不是目录: ${pathInput}`);
  return { inputPath: res.inputPath, realPath: res.realPath };
}

/** 供 workdir.add 使用: 新增 root 本身不要求已经在旧监狱内; 允许 root 是 symlink/junction, 后续 jail 以 realpath 锚定 */
export async function validateNewWorkdir(pathInput: string): Promise<{ inputPath: string; realPath: string }> {
  if (!isAbsolute(pathInput)) throw new JailError('path_escapes_jail', `必须使用绝对路径: ${pathInput}`);
  const inputPath = resolve(pathInput);
  const realPath = await realpath(inputPath);
  const st = await stat(realPath);
  if (!st.isDirectory()) throw new JailError('not_directory', `不是目录: ${pathInput}`);
  return { inputPath, realPath };
}

/** rules/mcp 写文件前确保父目录存在 (仅限配置树内部, 与 fs.write 的用户文件语义不同) */
export async function ensureParentDir(filePath: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
}

export { dirname, join };
