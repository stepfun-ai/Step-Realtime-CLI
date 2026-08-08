/**
 * team 的 git 操作封装：全部走子进程 execFile，不引第三方依赖。
 * 只覆盖 team 需要的最小集：仓内判定 / 有提交判定 / 当前分支 / worktree 增删 / diff 文件清单 / merge。
 */
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { TeamError } from './types.js';

const run = promisify(execFile);

/** 执行 git 命令，失败抛 TeamError（带 stderr 摘要）。 */
async function git(repoRoot: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run('git', ['-C', repoRoot, ...args], { maxBuffer: 8 * 1024 * 1024 });
    return stdout.trim();
  } catch (e) {
    const err = e as { stderr?: string; message?: string };
    const detail = (err.stderr ?? err.message ?? '').trim().split('\n').slice(0, 3).join(' ');
    throw new TeamError(`git ${args[0]} 失败：${detail}`);
  }
}

/** cwd 是否在某个 git 仓库内部（子目录也算）。 */
export async function isInsideRepo(cwd: string): Promise<boolean> {
  try {
    await git(cwd, ['rev-parse', '--is-inside-work-tree']);
    return true;
  } catch {
    return false;
  }
}

/** 从 cwd 反查仓库根（子目录启动时以整仓为基准）。 */
export async function resolveRepoRoot(cwd: string): Promise<string> {
  return git(cwd, ['rev-parse', '--show-toplevel']);
}

/** 仓库是否已有至少一次提交（无提交则开不出 worktree）。 */
export async function hasAnyCommit(repoRoot: string): Promise<boolean> {
  try {
    await git(repoRoot, ['rev-parse', 'HEAD']);
    return true;
  } catch {
    return false;
  }
}

export async function currentBranch(repoRoot: string): Promise<string> {
  const b = await git(repoRoot, ['branch', '--show-current']);
  if (b === '') throw new TeamError('当前处于 detached HEAD，无法确定基准分支。先切到一个分支。');
  return b;
}

/** 分支（或任意 ref）是否存在。 */
export async function refExists(repoRoot: string, ref: string): Promise<boolean> {
  try {
    await git(repoRoot, ['rev-parse', '--verify', ref]);
    return true;
  } catch {
    return false;
  }
}

/** 开出 worktree：`<dir>` 处挂 `<branch>`（不存在则从 base 新建）。幂等：dir 已是挂着 branch 的 worktree 时直接复用（rework 重派场景）。 */
export async function addWorktree(repoRoot: string, dir: string, branch: string, base: string): Promise<void> {
  if (!(await refExists(repoRoot, branch))) {
    await git(repoRoot, ['worktree', 'add', dir, '-b', branch, base]);
    return;
  }
  // 分支已存在：dir 已经挂在该分支上 → 复用；否则挂载既有分支
  try {
    const cur = await git(dir, ['branch', '--show-current']);
    if (cur === branch) return;
  } catch {
    // dir 不存在或不是 worktree——继续挂载
  }
  await git(repoRoot, ['worktree', 'add', dir, branch]);
}

/** 移除 worktree；force 处理 dirty 与含 submodule 的残留。 */
export async function removeWorktree(repoRoot: string, dir: string, force: boolean): Promise<void> {
  await git(repoRoot, ['worktree', 'remove', ...(force ? ['--force'] : []), dir]);
}

/** worktree 是否有未提交改动。 */
export async function isWorktreeDirty(dir: string): Promise<boolean> {
  const out = await git(dir, ['status', '--porcelain']);
  return out !== '';
}

/** 分支相对 base 的改动文件清单（相对 repo 根路径）。 */
export async function diffNameOnly(repoRoot: string, base: string, branch: string): Promise<string[]> {
  const out = await git(repoRoot, ['diff', '--name-only', `${base}...${branch}`]);
  return out === '' ? [] : out.split('\n').map((s) => s.trim()).filter(Boolean);
}

/** 分支当前 tip commit。 */
export async function branchTip(repoRoot: string, branch: string): Promise<string> {
  return git(repoRoot, ['rev-parse', branch]);
}

/** 合回基准分支（--no-ff 保留 merge commit）。 */
export async function mergeNoFf(repoRoot: string, branch: string): Promise<void> {
  await git(repoRoot, ['merge', '--no-ff', branch]);
}

/** 合并撞冲突后中止，把仓库从 MERGING 状态救回来。 */
export async function mergeAbort(repoRoot: string): Promise<void> {
  await git(repoRoot, ['merge', '--abort']);
}

/** 把团队目录写进 `.git/info/exclude`（仓本地排除，不动可追踪的 .gitignore）。 */
export async function ensureGitExclude(repoRoot: string, entry: string): Promise<void> {
  const { mkdir, readFile, appendFile } = await import('node:fs/promises');
  const { join, dirname, resolve } = await import('node:path');
  let gitDir: string;
  try {
    // rev-parse --git-dir 在仓根返回相对路径「.git」，必须相对仓根 resolve 再用
    gitDir = resolve(repoRoot, await git(repoRoot, ['rev-parse', '--git-dir']));
  } catch {
    gitDir = join(repoRoot, '.git');
  }
  const excludePath = join(gitDir, 'info', 'exclude');
  await mkdir(dirname(excludePath), { recursive: true });
  let existing = '';
  try {
    existing = await readFile(excludePath, 'utf8');
  } catch {
    // 尚无 exclude 文件
  }
  if (existing.split(/\r?\n/).some((line) => line.trim() === entry)) return;
  await appendFile(excludePath, `${existing.endsWith('\n') || existing.length === 0 ? '' : '\n'}${entry}\n`, 'utf8');
}
