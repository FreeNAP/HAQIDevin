import { execFile } from 'node:child_process';
import type { GitChangedFile, GitStatusMsg } from '@devin-remote/protocol';
import type { WorkdirEntry } from './config.js';
import { assertDirectoryInJail } from './fs/fsOps.js';

const GIT_TIMEOUT_MS = 90_000;
const GIT_MAX_BUFFER = 16 * 1024 * 1024;
const DIFF_LIMIT = 100 * 1024;

export class GitError extends Error {
  constructor(
    public readonly code: 'git_unavailable' | 'git_timeout' | 'git_failed' | 'not_git_repo',
    message: string,
    public readonly stdout = '',
    public readonly stderr = '',
  ) {
    super(message);
    this.name = 'GitError';
  }
}

interface GitRunResult {
  stdout: string;
  stderr: string;
}

/** execFile 直跑 git, 不走 shell; 90s timeout + 禁用交互凭据弹窗 */
async function runGit(cwd: string, args: string[], timeoutMs = GIT_TIMEOUT_MS): Promise<GitRunResult> {
  const options = {
    timeout: timeoutMs,
    maxBuffer: GIT_MAX_BUFFER,
    windowsHide: true,
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: '0',
      GCM_INTERACTIVE: 'never',
      GIT_EDITOR: 'true',
    },
  };
  return await new Promise((resolveRun, rejectRun) => {
    execFile('git', ['-C', cwd, ...args], options, (err, stdout, stderr) => {
      if (!err) {
        resolveRun({ stdout: String(stdout), stderr: String(stderr) });
        return;
      }
      const e = err as NodeJS.ErrnoException & { killed?: boolean; signal?: string };
      const out = String(stdout ?? '');
      const serr = String(stderr ?? '');
      if (e.code === 'ENOENT') {
        rejectRun(new GitError('git_unavailable', 'git 不在 PATH 或不可执行', out, serr));
      } else if (e.killed || e.signal === 'SIGTERM') {
        rejectRun(new GitError('git_timeout', `git ${args[0] ?? ''} 超过 ${Math.round(timeoutMs / 1000)}s 超时`, out, serr));
      } else {
        rejectRun(new GitError('git_failed', (serr || e.message || `git ${args[0] ?? ''} 失败`).trim(), out, serr));
      }
    });
  });
}

async function gitRepoRoot(cwdReal: string): Promise<string> {
  try {
    const r = await runGit(cwdReal, ['rev-parse', '--show-toplevel']);
    return r.stdout.trim();
  } catch (e) {
    if (e instanceof GitError && /not a git repository/i.test(e.stderr + e.message)) {
      throw new GitError('not_git_repo', '该目录不在 git 仓库内', e.stdout, e.stderr);
    }
    throw e;
  }
}

function parseStatusXY(xy: string): GitChangedFile['status'] {
  if (xy === '??') return 'untracked';
  if (xy === '!!') return 'ignored';
  if (xy.includes('U') || xy === 'AA' || xy === 'DD') return 'unmerged';
  if (xy.includes('R')) return 'renamed';
  if (xy.includes('C')) return 'copied';
  if (xy.includes('A')) return 'added';
  if (xy.includes('D')) return 'deleted';
  if (xy.includes('M') || xy.includes('T')) return 'modified';
  return 'unknown';
}

/** porcelain v1 -z 解析; rename/copy 的第二个 NUL 字段放入 oldPath */
function parsePorcelainV1Z(text: string): GitChangedFile[] {
  const parts = text.split('\0');
  const out: GitChangedFile[] = [];
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (!rec) continue;
    if (rec.length < 4) continue;
    const xy = rec.slice(0, 2);
    const p = rec.slice(3);
    let oldPath: string | undefined;
    if ((xy.includes('R') || xy.includes('C')) && i + 1 < parts.length) {
      oldPath = parts[++i] || undefined;
    }
    const staged = xy[0] !== ' ' && xy[0] !== '?' && xy[0] !== '!';
    const unstaged = xy[1] !== ' ' || xy === '??' || xy === '!!';
    out.push({
      path: p,
      oldPath,
      xy,
      status: parseStatusXY(xy),
      staged,
      unstaged,
    });
  }
  return out;
}

async function optionalGit(cwd: string, args: string[]): Promise<string | null> {
  try {
    return (await runGit(cwd, args)).stdout.trim();
  } catch {
    return null;
  }
}

export async function gitStatus(cwdInput: string, roots: WorkdirEntry[]): Promise<GitStatusMsg> {
  const dir = await assertDirectoryInJail(cwdInput, roots);
  const repoRoot = await gitRepoRoot(dir.realPath);
  const branchRaw = (await runGit(dir.realPath, ['branch', '--show-current'])).stdout.trim();
  const upstream = await optionalGit(dir.realPath, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  let ahead: number | null = null;
  let behind: number | null = null;
  if (upstream) {
    const counts = await optionalGit(dir.realPath, ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}']);
    const m = counts?.match(/^(\d+)\s+(\d+)/);
    if (m) {
      ahead = Number(m[1]);
      behind = Number(m[2]);
    }
  }
  const porcelain = await runGit(dir.realPath, ['status', '--porcelain=v1', '-z', '--untracked-files=normal']);
  const files = parsePorcelainV1Z(porcelain.stdout);
  return {
    type: 'git.status',
    cwd: dir.inputPath,
    repoRoot,
    branch: branchRaw || null,
    upstream,
    ahead,
    behind,
    files,
    clean: files.length === 0,
  };
}

function truncateDiff(diff: string): { diff: string; truncated: boolean } {
  const buf = Buffer.from(diff, 'utf8');
  if (buf.length <= DIFF_LIMIT) return { diff, truncated: false };
  return {
    diff: buf.subarray(0, DIFF_LIMIT).toString('utf8') + '\n…[diff truncated at 100KB]',
    truncated: true,
  };
}

export async function gitDiff(cwdInput: string, roots: WorkdirEntry[], file?: string, staged = false): Promise<{
  cwd: string;
  file?: string;
  diff: string;
  truncated: boolean;
}> {
  const dir = await assertDirectoryInJail(cwdInput, roots);
  await gitRepoRoot(dir.realPath);
  const args = ['diff', '--no-color'];
  if (staged) args.push('--cached');
  if (file) args.push('--', file);
  const r = await runGit(dir.realPath, args);
  const cut = truncateDiff(r.stdout);
  return { cwd: dir.inputPath, file, diff: cut.diff, truncated: cut.truncated };
}

export async function gitCommit(cwdInput: string, roots: WorkdirEntry[], message: string, files?: string[]): Promise<{
  cwd: string;
  stdout: string;
  stderr: string;
  commitHash?: string;
}> {
  const dir = await assertDirectoryInJail(cwdInput, roots);
  await gitRepoRoot(dir.realPath);
  if (!message.trim()) throw new GitError('git_failed', 'commit message 不能为空');
  let commitArgs = ['commit', '-m', message];
  if (files?.length) {
    // 先 add 覆盖 untracked; commit 显式带 pathspec, 避免把用户此前暂存的无关文件一起提交
    await runGit(dir.realPath, ['add', '--', ...files]);
    commitArgs = ['commit', '-m', message, '--', ...files];
  }
  const r = await runGit(dir.realPath, commitArgs);
  const hash = (await optionalGit(dir.realPath, ['rev-parse', 'HEAD'])) ?? undefined;
  return { cwd: dir.inputPath, stdout: r.stdout, stderr: r.stderr, commitHash: hash };
}

export async function gitPush(cwdInput: string, roots: WorkdirEntry[], remote?: string, branch?: string): Promise<{
  cwd: string;
  stdout: string;
  stderr: string;
}> {
  const dir = await assertDirectoryInJail(cwdInput, roots);
  await gitRepoRoot(dir.realPath);
  const args = ['push'];
  if (remote) args.push(remote);
  if (branch) args.push(branch);
  const r = await runGit(dir.realPath, args);
  return { cwd: dir.inputPath, stdout: r.stdout, stderr: r.stderr };
}

export async function gitPull(cwdInput: string, roots: WorkdirEntry[], remote?: string, branch?: string): Promise<{
  cwd: string;
  stdout: string;
  stderr: string;
}> {
  const dir = await assertDirectoryInJail(cwdInput, roots);
  await gitRepoRoot(dir.realPath);
  const args = ['pull'];
  if (remote) args.push(remote);
  if (branch) args.push(branch);
  const r = await runGit(dir.realPath, args);
  return { cwd: dir.inputPath, stdout: r.stdout, stderr: r.stderr };
}
