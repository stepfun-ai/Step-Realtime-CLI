/**
 * team 团队模式测试：TeamStore 规则（init 拒绝条件 / plan 互斥 / spawn 依赖门控 /
 * merge 五道门 / 信箱可见性 / teardown dirty 保留）+ TeamMode 生命周期。
 * 全部用真实临时 git 仓（worktree/merge 必须真跑 git 才算数）。
 */
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile, access } from 'node:fs/promises';
import { existsSync, lstatSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it, vi } from 'vitest';

// Windows CI runner 上 git 进程创建慢，建仓+worktree+merge 的真实 git 操作会顶破全局 20s 超时
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

import { TeamMode } from '../../src/agent/team/mode.js';
import { normalizeScope, scopeMatches, TeamStore } from '../../src/agent/team/store.js';
import { addWorktree, branchTip, linkSharedNodeModules } from '../../src/agent/team/git.js';
import { workerBriefing } from '../../src/tools/team.js';
import { wrapWriteGuard } from '../../src/agent/subagent/runner.js';

const run = promisify(execFile);
const tmpDirs: string[] = [];

async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await run('git', ['-C', cwd, ...args]);
  return stdout.trim();
}

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'team-test-'));
  tmpDirs.push(dir);
  return dir;
}

/** 建一个有一次提交的 git 仓（worktree 的前提）。 */
async function makeRepo(): Promise<string> {
  const dir = await makeDir();
  await git(dir, ['init']);
  await git(dir, ['config', 'user.email', 'test@example.com']);
  await git(dir, ['config', 'user.name', 'test']);
  // Windows CI 默认 autocrlf=true，worktree checkout 会把 LF 转 CRLF 弄挂内容断言——测试仓统一关掉
  await git(dir, ['config', 'core.autocrlf', 'false']);
  await writeFile(join(dir, 'README.md'), 'hello\n');
  await git(dir, ['add', '.']);
  await git(dir, ['commit', '-m', 'init']);
  return dir;
}

/** 在 worktree 里写文件并提交到任务分支。 */
async function commitInWorktree(wtDir: string, rel: string, content: string): Promise<void> {
  await mkdir(join(wtDir, dirname(rel)), { recursive: true });
  await writeFile(join(wtDir, rel), content);
  await git(wtDir, ['add', '.']);
  await git(wtDir, ['commit', '-m', `add ${rel}`]);
}

/** 路径是否存在（fs.access 静默吞错）。 */
async function exists(p: string): Promise<boolean> {
  try { await access(p); return true; } catch { return false; }
}

afterAll(async () => {
  for (const d of tmpDirs) await rm(d, { recursive: true, force: true }).catch(() => undefined);
});

describe('normalizeScope / scopeMatches', () => {
  it('归一化尾部通配', () => {
    expect(normalizeScope('src/data/**')).toBe('src/data');
    expect(normalizeScope('src/data/*')).toBe('src/data');
    expect(normalizeScope('README.md')).toBe('README.md');
  });

  it('目录边界：`src/data` 覆盖 `src/data/x`，不覆盖 `src/database/x`', () => {
    expect(scopeMatches('src/data', 'src/data/a.ts')).toBe(true);
    expect(scopeMatches('src/data', 'src/database/a.ts')).toBe(false);
    expect(scopeMatches('README.md', 'README.md')).toBe(true);
  });
});

describe('TeamStore.init', () => {
  it('非 git 仓拒绝', async () => {
    const dir = await makeDir();
    const store = new TeamStore(join(dir, '.teams'), dir);
    await expect(store.init()).rejects.toThrow('git 仓库');
  });

  it('空仓（无提交）拒绝', async () => {
    const dir = await makeDir();
    await git(dir, ['init']);
    const store = new TeamStore(join(dir, '.teams'), dir);
    await expect(store.init()).rejects.toThrow('初始提交');
  });

  it('正常初始化：目录树 + state.json + exclude，幂等保留状态', async () => {
    const repo = await makeRepo();
    const store = new TeamStore(join(repo, '.teams'), repo);
    const r1 = await store.init();
    expect(r1.created).toBe(true);
    expect(r1.base).toMatch(/^(main|master)$/);
    const state = JSON.parse(await readFile(join(repo, '.teams', 'state.json'), 'utf8'));
    expect(state.missions).toEqual([]);
    const exclude = await readFile(join(repo, '.git', 'info', 'exclude'), 'utf8');
    expect(exclude).toContain('.teams/');
    const r2 = await store.init();
    expect(r2.created).toBe(false);
  });
});

describe('TeamStore.plan', () => {
  it('分配 id/分支/槽位；build 范围重叠拒绝；survey 可重叠；deps 不存在拒绝', async () => {
    const repo = await makeRepo();
    const store = new TeamStore(join(repo, '.teams'), repo);
    await store.init();
    const ms = await store.plan([
      { title: '改数据层', kind: 'build', scope: ['src/data/**'], deps: [] },
      { title: '查文档', kind: 'survey', scope: ['src/data/**'], deps: [] },
    ]);
    expect(ms.map((m) => m.id)).toEqual(['M1', 'M2']);
    expect(ms[0].branch).toContain('team/m1-');
    expect(ms[0].worktree).toBe('wt-1');

    await expect(
      store.plan([{ title: '也改数据层', kind: 'build', scope: ['src/data/core/**'], deps: [] }]),
    ).rejects.toThrow('互斥');

    await expect(store.plan([{ title: 'x', kind: 'survey', scope: [], deps: ['M99'] }])).rejects.toThrow('不存在');
  });

  it('互斥判定不误伤近似前缀（src/data vs src/database）', async () => {
    const repo = await makeRepo();
    const store = new TeamStore(join(repo, '.teams'), repo);
    await store.init();
    const ms = await store.plan([
      { title: 'a', kind: 'build', scope: ['src/data/**'], deps: [] },
      { title: 'b', kind: 'build', scope: ['src/database/**'], deps: [] },
    ]);
    expect(ms).toHaveLength(2);
  });
});

describe('TeamStore.spawn 依赖门控', () => {
  it('deps 未 merged 拒绝启动；无依赖任务开 worktree 置 active', async () => {
    const repo = await makeRepo();
    const store = new TeamStore(join(repo, '.teams'), repo);
    await store.init();
    await store.plan([
      { title: '先做的', kind: 'build', scope: ['src/a/**'], deps: [] },
      { title: '后做的', kind: 'build', scope: ['src/b/**'], deps: ['M1'] },
    ]);
    await expect(store.spawn('M2', 'worker-M2')).rejects.toThrow('依赖');

    const m1 = await store.spawn('M1', 'worker-M1');
    expect(m1.status).toBe('active');
    const state = await store.load();
    expect(state.missions[0].owner).toBe('worker-M1');
    // worktree 真实开出
    const wtReadme = await readFile(join(repo, '.teams', 'worktrees', 'wt-1', 'README.md'), 'utf8');
    expect(wtReadme).toBe('hello\n');
  });

  it('completed 任务可重派（rework）：worktree 重挂、分支提交保留、状态回 active', async () => {
    const repo = await makeRepo();
    const store = new TeamStore(join(repo, '.teams'), repo);
    await store.init();
    await store.plan([{ title: 'a', kind: 'build', scope: ['src/**'], deps: [] }]);
    const m = await store.spawn('M1', 'worker-M1');
    const wt = store.worktreePath(m);
    await commitInWorktree(wt, 'src/a.ts', 'export const a = 1;\n');
    await store.setStatus('M1', 'completed');

    // 审阅打回 → 重派
    const m2 = await store.spawn('M1', 'worker-M1-r2');
    expect(m2.status).toBe('active');
    expect(m2.owner).toBe('worker-M1-r2');
    // 分支上已有提交不丢
    const content = await readFile(join(store.worktreePath(m2), 'src', 'a.ts'), 'utf8');
    expect(content).toBe('export const a = 1;\n');
    // merged 任务仍不可重派
    await store.setStatus('M1', 'merged');
    await expect(store.spawn('M1', 'worker-M1-r3')).rejects.toThrow('不能启动');
  });

  it('blocked 任务可重派（respawn）：状态回 active；merged 仍拒绝', async () => {
    const repo = await makeRepo();
    const store = new TeamStore(join(repo, '.teams'), repo);
    await store.init();
    await store.plan([{ title: 'a', kind: 'build', scope: ['src/**'], deps: [] }]);
    await store.spawn('M1', 'worker-M1');
    await store.setStatus('M1', 'blocked');

    // blocked → respawn → active
    const m2 = await store.spawn('M1', 'worker-M1-r2');
    expect(m2.status).toBe('active');
    expect(m2.owner).toBe('worker-M1-r2');
    // merged 仍拒绝
    await store.setStatus('M1', 'merged');
    await expect(store.spawn('M1', 'worker-M1-r3')).rejects.toThrow('不能启动');
  });
});

describe('跨仓任务', () => {
  it('跨仓 spawn 以任务仓当前分支为 base，不套用基准仓分支名', async () => {
    const repo = await makeRepo();
    const other = await makeRepo();
    // 任务仓切到一个与基准仓不同名的分支，并留下独有内容
    await git(other, ['checkout', '-b', 'feature-x']);
    await writeFile(join(other, 'OTHER.md'), 'from feature-x\n');
    await git(other, ['add', '.']);
    await git(other, ['commit', '-m', 'feature work']);

    const store = new TeamStore(join(repo, '.teams'), repo);
    await store.init();
    await store.plan([{ title: '跨仓任务', kind: 'build', scope: ['src/**'], deps: [], repo: other }]);
    const m = await store.spawn('M1', 'worker-M1');
    expect(m.baseBranch).toBe('feature-x');
    // worktree 开在任务仓的 .teams/worktrees/，内容来自任务仓当前分支
    const marker = await readFile(join(other, '.teams', 'worktrees', m.worktree, 'OTHER.md'), 'utf8');
    expect(marker).toBe('from feature-x\n');
  });

  it('newTeamStore：显式 repo 覆盖 cwd 推断（跨目录指挥）', async () => {
    const { newTeamStore } = await import('../../src/agent/team/store.js');
    const repo = await makeRepo();
    const elsewhere = await makeDir();
    const store = await newTeamStore(elsewhere, undefined, repo);
    expect(store.repoRoot).toBe(resolve(repo));
    expect(store.dir).toBe(join(resolve(repo), '.teams'));
  });
});

describe('TeamStore.merge 五道门', () => {
  async function setupMission() {
    const repo = await makeRepo();
    const store = new TeamStore(join(repo, '.teams'), repo);
    await store.init();
    await store.plan([{ title: '改数据层', kind: 'build', scope: ['src/data/**'], deps: [] }]);
    await store.spawn('M1', 'worker-M1');
    return { repo, store, wt: join(repo, '.teams', 'worktrees', 'wt-1') };
  }

  it('非 completed 拒绝合并', async () => {
    const { store } = await setupMission();
    // 状态检查在 tip 比对之前，随便传个 commit 即撞「非 completed」
    await expect(store.merge('M1', '0'.repeat(40))).rejects.toThrow('completed');
  });

  it('tip 移动（门③）拒绝', async () => {
    const { repo, store, wt } = await setupMission();
    await commitInWorktree(wt, join('src', 'data', 'a.ts'), 'export {};\n');
    await store.setStatus('M1', 'completed');
    await expect(store.merge('M1', '0'.repeat(40))).rejects.toThrow('tip');
  });

  it('越界文件（门⑤）拒绝', async () => {
    const { repo, store, wt } = await setupMission();
    await commitInWorktree(wt, 'other.txt', 'out of scope\n');
    await store.setStatus('M1', 'completed');
    const tip = await branchTip(repo, (await store.load()).missions[0].branch);
    await expect(store.merge('M1', tip)).rejects.toThrow('门⑤');
  });

  it('正常合并：文件落回基准分支，任务置 merged', async () => {
    const { repo, store, wt } = await setupMission();
    await commitInWorktree(wt, join('src', 'data', 'a.ts'), 'export const x = 1;\n');
    await store.setStatus('M1', 'completed');
    const branch = (await store.load()).missions[0].branch;
    const tip = await branchTip(repo, branch);
    const { conflictsWith } = await store.merge('M1', tip);
    expect(conflictsWith).toEqual([]);
    expect((await store.load()).missions[0].status).toBe('merged');
    const merged = await readFile(join(repo, 'src', 'data', 'a.ts'), 'utf8');
    expect(merged).toContain('export const x');
  });

  it('依赖未并（门④）拒绝：M2 deps M1 未 merged 时 M2 不能合', async () => {
    const repo = await makeRepo();
    const store = new TeamStore(join(repo, '.teams'), repo);
    await store.init();
    await store.plan([
      { title: 'a', kind: 'build', scope: ['src/a/**'], deps: [] },
      { title: 'b', kind: 'build', scope: ['src/b/**'], deps: ['M1'] },
    ]);
    await store.spawn('M1', 'worker-M1');
    await store.setStatus('M1', 'completed'); // completed 但不是 merged
    await store.setStatus('M2', 'completed'); // setStatus 不做转换校验，直接置位
    await expect(store.merge('M2', '0'.repeat(40))).rejects.toThrow('门④');
  });
  it('merge 真冲突：自动 abort 救回仓库 + 报恢复指引', async () => {
    const repo = await makeRepo();
    const store = new TeamStore(join(repo, '.teams'), repo);
    await store.init();
    await store.plan([{ title: '改 README', kind: 'build', scope: ['README.md'], deps: [] }]);
    await store.spawn('M1', 'worker-M1');
    const wt = join(repo, '.teams', 'worktrees', 'wt-1');
    // worktree 里改 README 第一行并提交
    await commitInWorktree(wt, 'README.md', 'worker 改的\n');
    // 基准分支同时改同一行（主仓在团队跑期间前进了）
    await writeFile(join(repo, 'README.md'), '主仓改的\n');
    await git(repo, ['add', '.']);
    await git(repo, ['commit', '-m', 'main moved']);
    await store.setStatus('M1', 'completed');
    const tip = await branchTip(repo, (await store.load()).missions[0].branch);
    await expect(store.merge('M1', tip)).rejects.toThrow('已自动中止');
    // 仓库不在 MERGING 状态（abort 生效）
    await expect(git(repo, ['rev-parse', 'MERGING_HEAD'])).rejects.toThrow();
  });

  it('merge 成功后干净 worktree 自动清理：目录消失 + worktree list 不含它', async () => {
    const repo = await makeRepo();
    const store = new TeamStore(join(repo, '.teams'), repo);
    await store.init();
    await store.plan([{ title: '改数据层', kind: 'build', scope: ['src/data/**'], deps: [] }]);
    await store.spawn('M1', 'worker-M1');
    const wt = join(repo, '.teams', 'worktrees', 'wt-1');
    await commitInWorktree(wt, join('src', 'data', 'a.ts'), 'export const x = 1;\n');
    await store.setStatus('M1', 'completed');
    const branch = (await store.load()).missions[0].branch;
    const tip = await branchTip(repo, branch);

    // 确认 worktree 在合并前存在
    const wtsBefore = await git(repo, ['worktree', 'list']);
    expect(wtsBefore).toContain('wt-1');
    expect(await exists(wt)).toBe(true);

    const { worktreeKept } = await store.merge('M1', tip);
    expect(worktreeKept).toBeUndefined();
    // 目录已删除
    expect(await exists(wt)).toBe(false);
    // git worktree list 不含该 worktree
    const wtsAfter = await git(repo, ['worktree', 'list']);
    expect(wtsAfter).not.toContain('wt-1');
  });

  it('merge 成功后 dirty worktree 保留：目录还在 + worktreeKept 返回', async () => {
    const repo = await makeRepo();
    const store = new TeamStore(join(repo, '.teams'), repo);
    await store.init();
    await store.plan([{ title: '改数据层', kind: 'build', scope: ['src/data/**'], deps: [] }]);
    await store.spawn('M1', 'worker-M1');
    const wt = join(repo, '.teams', 'worktrees', 'wt-1');
    await commitInWorktree(wt, join('src', 'data', 'a.ts'), 'export const x = 1;\n');
    // 在 worktree 里写一个未提交文件使其 dirty
    await writeFile(join(wt, 'dirty-note.txt'), 'not committed yet\n');
    await store.setStatus('M1', 'completed');
    const branch = (await store.load()).missions[0].branch;
    const tip = await branchTip(repo, branch);

    const { worktreeKept } = await store.merge('M1', tip);
    expect(worktreeKept).toBeDefined();
    expect(worktreeKept).toContain('wt-1');
    expect(worktreeKept).toContain('保留');
    // 目录还在
    expect(await exists(wt)).toBe(true);
  });

  it('门〇：build 任务分支无新提交 → merge 拒绝（worker 可能忘提交或提交到错误地方）', async () => {
    const { store, wt } = await setupMission();
    // spawn 后不提交直接标 completed → merge 时应被门〇拦住
    await store.setStatus('M1', 'completed');
    const branch = (await store.load()).missions[0].branch;
    const tip = await branchTip(await store.load().then((s) => s.repoRoot), branch);
    await expect(store.merge('M1', tip)).rejects.toThrow('门〇');
    await expect(store.merge('M1', tip)).rejects.toThrow('任何新提交');
    await expect(store.merge('M1', tip)).rejects.toThrow('提交到了错误的地方');
  });

  it('门〇豁免：survey 任务无提交 → merge 正常通过', async () => {
    const repo = await makeRepo();
    const store = new TeamStore(join(repo, '.teams'), repo);
    await store.init();
    await store.plan([{ title: '查文档', kind: 'survey', scope: [], deps: [] }]);
    await store.spawn('M1', 'worker-M1');
    // survey 不提交也正常 completed
    await store.setStatus('M1', 'completed');
    const branch = (await store.load()).missions[0].branch;
    const tip = await branchTip(repo, branch);
    // merge 不应报门〇错误
    const r = await store.merge('M1', tip);
    expect(r.conflictsWith).toEqual([]);
  });

  it('门〇：worker 直接提交到基准分支（而非任务分支）→ merge 拒绝', async () => {
    const repo = await makeRepo();
    const store = new TeamStore(join(repo, '.teams'), repo);
    await store.init();
    await store.plan([{ title: '改数据层', kind: 'build', scope: ['src/data/**'], deps: [] }]);
    await store.spawn('M1', 'worker-M1');
    // 模拟事故：在基准仓（repo）里提交，不在工作间（wt）里提交
    await commitInWorktree(repo, 'src/data/leaked.ts', '// leaked to base\n');
    await store.setStatus('M1', 'completed');
    const branch = (await store.load()).missions[0].branch;
    const tip = await branchTip(repo, branch);
    // 任务分支没新提交 → 门〇拦截
    await expect(store.merge('M1', tip)).rejects.toThrow('门〇');
    await expect(store.merge('M1', tip)).rejects.toThrow('提交到了错误的地方');
  });

  describe('typecheck 门', () => {
    /** 在工作间里造一个假 tsc（node 脚本）：pass=true 退出 0，否则退出 1 并输出错误。 */
    async function plantFakeTsc(wt: string, pass: boolean): Promise<void> {
      const bin = join(wt, 'node_modules', 'typescript', 'bin');
      await mkdir(bin, { recursive: true });
      await writeFile(join(wt, 'tsconfig.json'), '{ "include": ["src"] }\n');
      const body = pass ? 'process.exit(0);\n' : 'process.stderr.write("src/x.ts(1,5): error TS2322: fake type error\\n"); process.exit(1);\n';
      await writeFile(join(bin, 'tsc'), body);
    }

    it('build 任务 typecheck 失败 → merge 拒绝', async () => {
      const { repo, store, wt } = await setupMission();
      await commitInWorktree(wt, join('src', 'data', 'a.ts'), 'export const x = 1;\n'); // 过门〇/门⑤
      await plantFakeTsc(wt, false);
      await store.setStatus('M1', 'completed');
      const tip = await branchTip(repo, (await store.load()).missions[0].branch);
      await expect(store.merge('M1', tip)).rejects.toThrow('typecheck');
    });

    it('build 任务 typecheck 失败 + force → 绕过本门正常合并', async () => {
      const { repo, store, wt } = await setupMission();
      await commitInWorktree(wt, join('src', 'data', 'a.ts'), 'export const x = 1;\n');
      await plantFakeTsc(wt, false);
      await store.setStatus('M1', 'completed');
      const branch = (await store.load()).missions[0].branch;
      const tip = await branchTip(repo, branch);
      const { conflictsWith } = await store.merge('M1', tip, true);
      expect(conflictsWith).toEqual([]);
      expect((await store.load()).missions[0].status).toBe('merged');
    });

    it('survey 任务跳过 typecheck（即使假 tsc 会失败）', async () => {
      const repo = await makeRepo();
      const store = new TeamStore(join(repo, '.teams'), repo);
      await store.init();
      await store.plan([{ title: '查文档', kind: 'survey', scope: [], deps: [] }]);
      await store.spawn('M1', 'worker-M1');
      const wt = join(repo, '.teams', 'worktrees', 'wt-1');
      await plantFakeTsc(wt, false);
      await store.setStatus('M1', 'completed');
      const tip = await branchTip(repo, (await store.load()).missions[0].branch);
      const { conflictsWith } = await store.merge('M1', tip);
      expect(conflictsWith).toEqual([]);
    });

    it('无 tsconfig → typecheck 跳过（不误拦），merge 正常', async () => {
      const { repo, store, wt } = await setupMission();
      await commitInWorktree(wt, join('src', 'data', 'a.ts'), 'export const x = 1;\n');
      await store.setStatus('M1', 'completed');
      const branch = (await store.load()).missions[0].branch;
      const tip = await branchTip(repo, branch);
      const { conflictsWith, typecheckSkipped } = await store.merge('M1', tip);
      expect(conflictsWith).toEqual([]);
      expect(typecheckSkipped).toBe(true);
    });

    it('假 tsc 通过 → merge 正常，不标记 skipped', async () => {
      const { repo, store, wt } = await setupMission();
      await commitInWorktree(wt, join('src', 'data', 'a.ts'), 'export const x = 1;\n');
      await plantFakeTsc(wt, true);
      await store.setStatus('M1', 'completed');
      const branch = (await store.load()).missions[0].branch;
      const tip = await branchTip(repo, branch);
      const { conflictsWith, typecheckSkipped } = await store.merge('M1', tip);
      expect(conflictsWith).toEqual([]);
      expect(typecheckSkipped).toBeUndefined();
    });
  });
});

describe('wrapWriteGuard（per-worker 写隔离）', () => {
  const allowBase = async () => ({ decision: 'allow' as const });
  const cwd = join(tmpdir(), 'fake-wt');

  it('工作间内的写放行，越界写拦截，非写工具透传', async () => {
    const guard = wrapWriteGuard(allowBase, cwd, cwd);
    const inside = await guard({ id: '1', name: 'write_file', input: { path: join(cwd, 'a.ts') } });
    expect(inside.decision).toBe('allow');
    const rel = await guard({ id: '2', name: 'write_file', input: { path: 'src/a.ts' } });
    expect(rel.decision).toBe('allow'); // 相对路径解析在 cwd（工作间）内
    const outside = await guard({ id: '3', name: 'write_file', input: { path: join(tmpdir(), 'other', 'a.ts') } });
    expect(outside.decision).toBe('deny');
    const bash = await guard({ id: '4', name: 'bash', input: { command: 'echo hi' } });
    expect(bash.decision).toBe('allow'); // 无写入迹象 → 放行
  });

  /**
   * bash 分支：之前 bash 完全透传，worker 一句重定向就能写到工作间外，范围互斥只剩
   * team_merge 的事后 diff 检查兜着。这组用例锁住两端——越界写要拦住，而 worker
   * 日常命令（git 提交、跑测试、丢弃输出）不能被误拦。
   */
  describe('bash 分支', () => {
    /** 用正斜杠形式，贴近模型实际写法，也避开命令字符串里的反斜杠转义。 */
    const fwd = (p: string): string => p.replace(/\\/g, '/');
    const guard = wrapWriteGuard(allowBase, cwd, cwd);

    it('放行：git 提交与跑测试（命令行无显式写入语法）', async () => {
      for (const command of ['git add -A && git commit -m x', 'git push origin br', 'npm test', 'npx tsc --noEmit']) {
        const r = await guard({ id: 'b', name: 'bash', input: { command } });
        expect(r.decision, command).toBe('allow');
      }
    });

    it('放行：工作间内的重定向与子目录写入', async () => {
      for (const command of ['echo hi > notes.txt', 'echo hi > sub/a.txt', 'echo hi >> CHANGELOG.md']) {
        const r = await guard({ id: 'b', name: 'bash', input: { command } });
        expect(r.decision, command).toBe('allow');
      }
    });

    it('放行：丢弃输出到 /dev/null（最常见的写法，误报会卡死正常命令）', async () => {
      for (const command of ['ls -la > /dev/null', 'npm test 2>/dev/null', 'ls &> /dev/null']) {
        const r = await guard({ id: 'b', name: 'bash', input: { command } });
        expect(r.decision, command).toBe('allow');
      }
    });

    it('拦截：越界重定向、拷贝与删除', async () => {
      const out = fwd(join(tmpdir(), 'other', 'a.txt'));
      for (const command of [`echo hi > ${out}`, `cp a.txt ${out}`, `rm -rf ${fwd(join(tmpdir(), 'other'))}`]) {
        const r = await guard({ id: 'b', name: 'bash', input: { command } });
        expect(r.decision, command).toBe('deny');
        expect(r.reason ?? '').toContain('本任务工作间内');
      }
    });

    it('拦截：动态路径无法静态校验（B 档），提示改写成显式路径', async () => {
      const r = await guard({ id: 'b', name: 'bash', input: { command: 'echo hi > $OUT_DIR/a.txt' } });
      expect(r.decision).toBe('deny');
      expect(r.reason ?? '').toContain('显式路径');
    });
  });
});

describe('信箱', () => {
  it('定向与广播可见性；协调者看全部', async () => {
    const repo = await makeRepo();
    const store = new TeamStore(join(repo, '.teams'), repo);
    await store.init();
    await store.send('worker-M1', 'worker-M2', '接口变了', 'findUser 改签名了');
    await store.send('worker-M1', 'all', '广播', '大家都看下');

    const m2 = await store.inbox('worker-M2');
    expect(m2).toHaveLength(2);
    const m3 = await store.inbox('worker-M3');
    expect(m3).toHaveLength(1);
    expect(m3[0].subject).toBe('广播');
    const all = await store.inbox('team');
    expect(all).toHaveLength(2);
  });
});

describe('teardown', () => {
  it('dirty 工作间默认保留，force 删除；模式退出后档案保留', async () => {
    const repo = await makeRepo();
    const store = new TeamStore(join(repo, '.teams'), repo);
    await store.init();
    await store.plan([{ title: 'a', kind: 'build', scope: ['src/a/**'], deps: [] }]);
    await store.spawn('M1', 'worker-M1');
    const wt = join(repo, '.teams', 'worktrees', 'wt-1');
    await writeFile(join(wt, 'uncommitted.txt'), 'not committed\n');

    const r1 = await store.teardown(false);
    expect(r1.kept).toHaveLength(1);
    expect(r1.removed).toHaveLength(0);

    const r2 = await store.teardown(true);
    expect(r2.removed).toHaveLength(1);
    // 档案目录还在
    const state = await readFile(join(repo, '.teams', 'state.json'), 'utf8');
    expect(state).toContain('"missions"');
  });

  it('退出即标记关闭：resume 不复活，init 重进清标记且状态保留', async () => {
    const repo = await makeRepo();
    const store = new TeamStore(join(repo, '.teams'), repo);
    await store.init();
    await store.plan([{ title: 'a', kind: 'build', scope: ['src/a/**'], deps: [] }]);
    expect(await store.isOpen()).toBe(true);

    await store.teardown(false);
    // 关闭后 isOpen = false（restore 的依据：档案是事实源，快照只是指针）
    expect(await store.isOpen()).toBe(false);
    const mode = new TeamMode();
    await mode.restore({ dir: store.dir, repoRoot: repo });
    expect(mode.active).toBe(false);

    // init 重进：清关闭标记、任务清单保留
    const r = await store.init();
    expect(r.created).toBe(false);
    expect(await store.isOpen()).toBe(true);
    const state = await store.load();
    expect(state.missions).toHaveLength(1);
    expect(state.closedAt).toBeUndefined();
    const mode2 = new TeamMode();
    await mode2.restore({ dir: store.dir, repoRoot: repo });
    expect(mode2.active).toBe(true);
  });

  it('markClosed 幂等；teardown 先落关闭标记（清工作间失败也不复活）', async () => {
    const repo = await makeRepo();
    const store = new TeamStore(join(repo, '.teams'), repo);
    await store.init();
    await store.markClosed();
    await store.markClosed();
    const state = await store.load();
    expect(state.closedAt).toBeDefined();
  });
});

describe('init 防污染', () => {
  it('dir 指向 git 仓（非空、缺 state.json）→ 意图识别：报 repo= 引导', async () => {
    const repo = await makeRepo();
    const gitDir = await makeRepo(); // dir 误填了一个 git 仓
    const store = new TeamStore(gitDir, repo);
    const msg = await store.init().catch((e: Error) => e.message);
    expect(msg).toContain('基准仓');
    expect(msg).toContain('repo=');
    // 确认没往里铺档案结构
    await expect(readFile(join(gitDir, 'state.json'), 'utf8')).rejects.toThrow();
  });

  it('dir 指向普通非空非仓目录 → 仍是「拒绝写入以防污染」文案', async () => {
    const repo = await makeRepo();
    const noisy = await makeDir();
    await writeFile(join(noisy, 'some-file.txt'), 'noise');
    const store = new TeamStore(noisy, repo);
    const msg = await store.init().catch((e: Error) => e.message);
    expect(msg).toContain('拒绝写入以防污染');
  });

  it('档案目录已存在但为空 → 正常初始化', async () => {
    const repo = await makeRepo();
    const empty = await makeDir();
    const store = new TeamStore(empty, repo);
    const r = await store.init();
    expect(r.created).toBe(true);
  });
});

describe('基准分支控制', () => {
  it('显式 --base：以指定分支为基准（开发不在当前分支上）；不存在的分支拒绝', async () => {
    const repo = await makeRepo();
    await git(repo, ['checkout', '-b', 'dev']);
    const store = new TeamStore(join(repo, '.teams'), repo);
    const r = await store.init('dev');
    expect(r.base).toBe('dev');

    const gone = new TeamStore(join(await makeRepo(), '.teams'), repo);
    // 换一个还没初始化的档案目录，指定不存在的分支
    await expect(gone.init('no-such-branch')).rejects.toThrow('不存在');
  });

  it('收编时当前 checkout 不是基准分支 → 拒绝（防合错分支）', async () => {
    const repo = await makeRepo();
    const store = new TeamStore(join(repo, '.teams'), repo);
    await store.init();
    const state = await store.load();
    await store.plan([{ title: 'a', kind: 'build', scope: ['src/**'], deps: [] }]);
    const m = await store.spawn('M1', 'worker-M1');
    await commitInWorktree(store.worktreePath(m), 'src/a.ts', 'export const a = 1;\n');
    await store.setStatus('M1', 'completed');
    const tip = await branchTip(repo, m.branch);

    // 用户中途切走分支
    await git(repo, ['checkout', '-b', 'other']);
    await expect(store.merge('M1', tip)).rejects.toThrow('切回');
    // 切回基准分支后正常收编
    await git(repo, ['checkout', state.base]);
    const r = await store.merge('M1', tip);
    expect(r.conflictsWith).toEqual([]);
  });
});

describe('workerBriefing', () => {
  it('briefing 包含「禁止」与「任务分支」关键词', () => {
    const m: any = {
      id: 'M1',
      title: '改数据层',
      kind: 'build',
      scope: ['src/data/**'],
      branch: 'team/m1-改数据层',
      deps: [],
    };
    const wtAbs = '/tmp/wt-1';
    const text = workerBriefing(m, wtAbs);
    expect(text).toContain('禁止');
    expect(text).toContain('任务分支');
    // 硬纪律四条也应在场
    expect(text).toContain('不可绕过');
    expect(text).toContain('违规即终止');
    expect(text).toContain('基准仓');
    expect(text).toContain('git -C');
  });
});

describe('TeamMode', () => {
  it('snapshot/restore；未激活时 allowRoots 返回 null', async () => {
    const repo = await makeRepo();
    const store = new TeamStore(join(repo, '.teams'), repo);
    await store.init();
    const mode = new TeamMode();
    expect(mode.active).toBe(false);
    expect(await mode.allowRoots()).toBeNull();

    mode.activate(store);
    expect(mode.active).toBe(true);
    const snap = mode.snapshot();
    expect(snap?.dir).toBe(store.dir);

    const mode2 = new TeamMode();
    await mode2.restore(snap);
    expect(mode2.active).toBe(true);

    // 档案目录被删 → 静默降级
    const gone = new TeamMode();
    await gone.restore({ dir: join(repo, '.teams-gone'), repoRoot: repo });
    expect(gone.active).toBe(false);
  });

  it('onChange：activate/deactivate/restore 都广播（状态栏徽标数据源）', async () => {
    const repo = await makeRepo();
    const store = new TeamStore(join(repo, '.teams'), repo);
    await store.init();
    const events: boolean[] = [];
    const mode = new TeamMode();
    mode.setOnChange((active) => events.push(active));
    mode.activate(store);
    mode.deactivate();
    const mode2 = new TeamMode();
    mode2.setOnChange((active) => events.push(active));
    await mode2.restore({ dir: store.dir, repoRoot: repo });
    expect(events).toEqual([true, false, true]);
  });
});
