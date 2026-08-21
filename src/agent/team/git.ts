/**
 * team 的 git 操作封装：全部走子进程 execFile，不引第三方依赖。
 * 只覆盖 team 需要的最小集：仓内判定 / 有提交判定 / 当前分支 / worktree 增删 / diff 文件清单 / merge。
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { symlink } from 'node:fs/promises';
import { join } from 'node:path';
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

/**
 * 把主仓的 node_modules 以目录联接的形式挂进工作间。返回是否挂上（或已存在）。
 *
 * 为什么需要：worktree 只 checkout 版本控制里的文件，而 node_modules 被 gitignore，
 * 所以工作间是「有源码、没依赖」的状态。worker 一跑 vitest / tsc 就会因为找不到依赖
 * 卡到超时被杀——它于是无法在自己的改动上自验，只能提交未验证的代码，把验证责任
 * 全压到收编后的主仓复跑上。这是实际发生过两次的失败模式。
 *
 * 为什么用联接而不是复制：node_modules 动辄数百 MB，且内部本身就是符号链接农场
 * （pnpm 指向 .pnpm store），复制既慢又可能破坏链接结构。
 *
 * 副作用需要知情：依赖是**共享**的。worker 若在工作间里跑 npm install / pnpm add，
 * 会写到主仓的 node_modules，影响主仓与其他并行 worker。worker 本不该装依赖
 * （依赖已齐备），但这条约束得靠任务提示传达，联接本身拦不住。
 *
 * 失败不阻塞：Windows 上建目录联接通常不需要管理员权限，但真失败了也只是 worker
 * 跑不了测试，不该让任务启动不起来——静默跳过，由调用方决定是否提示。
 */
export async function linkSharedNodeModules(repoRoot: string, worktreeDir: string): Promise<boolean> {
  const src = join(repoRoot, 'node_modules');
  const dest = join(worktreeDir, 'node_modules');
  try {
    if (!existsSync(src)) return false; // 主仓自己都没装依赖，无事可做
    if (existsSync(dest)) return true; // 复用工作间时已经挂过
    // 'junction' 在非 Windows 平台被 Node 视作 'dir'，故无需分平台
    await symlink(src, dest, 'junction');
    return true;
  } catch {
    return false;
  }
}

/** 开出 worktree：`<dir>` 处挂 `<branch>`（不存在则从 base 新建）。幂等：dir 已是挂着 branch 的 worktree 时直接复用（rework 重派场景）。 */
export async function addWorktree(repoRoot: string, dir: string, branch: string, base: string): Promise<void> {
  await mountWorktree(repoRoot, dir, branch, base);
  // 挂载成功后补依赖联接（三条挂载路径都要，故放在外层统一做）
  await linkSharedNodeModules(repoRoot, dir);
}

async function mountWorktree(repoRoot: string, dir: string, branch: string, base: string): Promise<void> {
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

/**
 * 把团队目录写进 `.git/info/exclude`（仓本地排除，不动可追踪的 .gitignore）。
 */
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

/** typecheck 结果：ok 是否通过、skipped 是否跳过、detail 细节。 */
export interface TypecheckResult {
  ok: boolean;
  skipped: boolean;
  detail: string;
}

/**
 * 在指定目录跑 tsc --noEmit（team 收编的 typecheck 门）。
 *
 * 跨仓通用性的取舍：只在「有 tsconfig.json 且本地装了 typescript」时真跑，否则跳过
 * （不误拦非 TS 仓、或未装 typescript 的仓）。worktree 通过 junction 共享主仓 node_modules，
 * 故本地 typescript 通常可达。用 node 直跑 typescript/bin/tsc，避开 npx / shell 的跨平台问题。
 *
 * @param dir 待检查目录（通常是 team worktree）
 */
export async function typecheck(dir: string): Promise<TypecheckResult> {
  if (!existsSync(join(dir, 'tsconfig.json'))) {
    return { ok: true, skipped: true, detail: '无 tsconfig.json，跳过 typecheck' };
  }
  // 优先用本地 node_modules/typescript（junction 共享主仓依赖），避免依赖全局 npx
  const tscBin = join(dir, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!existsSync(tscBin)) {
    return { ok: true, skipped: true, detail: '未找到 typescript，跳过 typecheck' };
  }
  try {
    await run(process.execPath, [tscBin, '--noEmit'], { cwd: dir, maxBuffer: 8 * 1024 * 1024 });
    return { ok: true, skipped: false, detail: 'typecheck 通过' };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string };
    const out = ((err.stdout ?? '') + (err.stderr ?? '')).trim().split('\n').slice(-15).join('\n');
    return { ok: false, skipped: false, detail: out || 'typecheck 失败（无输出）' };
  }
}
