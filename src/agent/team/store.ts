/**
 * TeamStore：`.teams/` 档案目录的读写与团队机制的全部规则。
 *
 * 规则集中在这里（工具层只做参数校验与转发）：
 * - init 的拒绝条件（非 git 仓 / 空仓）
 * - plan 的 scope 互斥检查（build 类两两不重叠）
 * - spawn 的依赖硬化门控（deps 未全 merged 直接拒绝）
 * - merge 的门禁（reviewedCommit 声明 + tip 未动 + deps 全并 + 无越界文件 + typecheck + --no-ff）
 * - teardown 的 dirty 保留
 */
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, join, resolve, sep } from 'node:path';

import {
  addWorktree,
  branchTip,
  currentBranch,
  diffNameOnly,
  ensureGitExclude,
  hasAnyCommit,
  isInsideRepo,
  isWorktreeDirty,
  mergeAbort,
  mergeNoFf,
  refExists,
  removeWorktree,
  resolveRepoRoot,
  typecheck,
} from './git.js';
import { TeamError, type TeamMessage, type TeamMission, type TeamMissionStatus, type TeamState } from './types.js';

const STATE_FILE = 'state.json';
const INBOX_DIR = 'comms/inbox';
const LOG_DIR = 'log';
const WORKTREES_DIR = 'worktrees';
const ACTIVITY_LOG = 'log/activity.log';

/** scope 归一为路径前缀：`src/data/**` / `src/data/*` → `src/data`。 */
export function normalizeScope(raw: string): string {
  return raw.replace(/\\/g, '/').replace(/\/\*\*?$/, '');
}

/** 目录语义的前缀：`src/data` → `src/data/`（已是文件或带尾斜线则原样）。 */
function withSlash(s: string): string {
  return s.endsWith('/') ? s : `${s}/`;
}

/** scope 是否覆盖文件：`src/data` 覆盖 `src/data/x.ts`，不覆盖 `src/database/x.ts`。 */
export function scopeMatches(scope: string, file: string): boolean {
  const f = file.replace(/\\/g, '/');
  return f === scope || f.startsWith(withSlash(scope));
}

/** 两个 scope 是否冲突（目录语义下互为前缀即重叠；`src/data` 与 `src/database` 不算）。 */
function scopesOverlap(a: string, b: string): boolean {
  return a === b || a.startsWith(withSlash(b)) || b.startsWith(withSlash(a));
}

export class TeamStore {
  /**
   * @param dir 团队档案目录（`.teams/` 或 `--dir` 指定的独立位置）
   * @param repoRoot 基准仓绝对路径
   */
  constructor(
    readonly dir: string,
    readonly repoRoot: string,
  ) {}

  private abs(rel: string): string {
    return join(this.dir, rel);
  }

  /** 任务工作间的绝对路径。单仓时在档案目录下；跨仓时放到各仓的 `.teams/worktrees/`。 */
  worktreePath(mission: TeamMission): string {
    const root = mission.repo === this.repoRoot ? this.dir : join(mission.repo, '.teams');
    return join(root, WORKTREES_DIR, mission.worktree);
  }

  async isInitialized(): Promise<boolean> {
    try {
      await readFile(this.abs(STATE_FILE), 'utf8');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * 初始化档案目录。幂等：已初始化则保留全部状态（重进已关闭团队时清关闭标记）。
   * baseBranch 显式给出时以它为基准分支（开发不一定在当前分支上）；缺省取当前分支。
   */
  async init(baseBranch?: string): Promise<{ created: boolean; base: string }> {
    if (!(await isInsideRepo(this.repoRoot))) {
      throw new TeamError('team 需要 git 仓库（当前目录不在任何仓库内）。');
    }
    if (!(await hasAnyCommit(this.repoRoot))) {
      throw new TeamError('仓库还没有任何提交——先创建初始提交再初始化 team。');
    }
    if (await this.isInitialized()) {
      const state = await this.load();
      // 重进已关闭的团队：清掉关闭标记，状态全部保留
      if (state.closedAt !== undefined) {
        delete state.closedAt;
        await this.save(state);
        await this.appendLog('team', 'reopen', '重新激活');
      }
      return { created: false, base: state.base };
    }
    // 防污染：目录已存在且非空、但不是 team 档案（无 state.json）——拒绝写入。
    // 场景：dir 参数误指到另一个仓根或任何有内容的目录，不能把档案结构铺进去。
    // 意图识别：如果 dir 本身是个 git 仓库，极可能是用户把仓路径误填进 dir（正确参数是 repo）。
    let entries: string[] = [];
    try {
      entries = await readdir(this.dir);
    } catch {
      // 目录不存在——正常，下面 mkdir 会建
    }
    if (entries.length > 0) {
      const dirIsRepo = await isInsideRepo(this.dir);
      if (dirIsRepo) {
        throw new TeamError(
          `目录 ${this.dir} 是一个 git 仓库，不是 team 档案目录。\n` +
            '如果你的意图是把它设为基准仓（最常见），应该传 repo=' + this.dir + '、dir 留空（档案会缺省建在 ' + this.dir + '/.teams/）。\n' +
            '如果你确实想自定义档案目录，换一个空目录或不存在的路径。',
        );
      }
      throw new TeamError(`档案目录 ${this.dir} 已存在且非空，但不是 team 档案（缺 ${STATE_FILE}）——拒绝写入以防污染。换空目录或先清空它。`);
    }
    for (const dir of [INBOX_DIR, LOG_DIR, WORKTREES_DIR]) {
      await mkdir(this.abs(dir), { recursive: true });
    }
    // 档案目录在基准仓内时才需要排除；--dir 放到仓外则无需动 exclude
    if (resolve(this.dir).startsWith(resolve(this.repoRoot) + sep)) {
      await ensureGitExclude(this.repoRoot, `${basename(this.dir)}/`);
    }
    let base: string;
    if (baseBranch !== undefined) {
      // 显式指定的基准分支必须存在，否则 worktree 开不出来、合并也没目标
      if (!(await refExists(this.repoRoot, baseBranch))) {
        throw new TeamError(`基准分支 ${baseBranch} 在 ${this.repoRoot} 不存在。`);
      }
      base = baseBranch;
    } else {
      base = await currentBranch(this.repoRoot);
    }
    const state: TeamState = {
      version: 1,
      base,
      repoRoot: this.repoRoot,
      createdAt: new Date().toISOString(),
      missions: [],
    };
    await this.save(state);
    await writeFile(this.abs(ACTIVITY_LOG), '', 'utf8');
    return { created: true, base };
  }

  async load(): Promise<TeamState> {
    let raw: string;
    try {
      raw = await readFile(this.abs(STATE_FILE), 'utf8');
    } catch {
      throw new TeamError('team 尚未初始化——先运行 team_init。');
    }
    return JSON.parse(raw) as TeamState;
  }

  private async save(state: TeamState): Promise<void> {
    await writeFile(this.abs(STATE_FILE), JSON.stringify(state, null, 2), 'utf8');
  }

  async appendLog(actor: string, action: string, detail: string): Promise<void> {
    await appendFile(this.abs(ACTIVITY_LOG), `${new Date().toISOString()} ${actor} ${action} ${detail}\n`, 'utf8');
  }

  /**
   * 拆活：登记任务清单。build 类 scope 两两互斥（survey 只读不占位）；
   * deps 必须引用已存在的任务；merged 任务的 scope 不再占位。
   */
  async plan(input: Array<Omit<TeamMission, 'id' | 'status' | 'branch' | 'worktree' | 'repo'> & { repo?: string }>): Promise<TeamMission[]> {
    const state = await this.load();
    const occupied: Array<{ id: string; scope: string[] }> = state.missions
      .filter((m) => m.kind === 'build' && m.status !== 'merged')
      .map((m) => ({ id: m.id, scope: m.scope }));
    const missions: TeamMission[] = [];
    const ids = new Set(state.missions.map((m) => m.id));

    input.forEach((raw, i) => {
      const id = `M${state.missions.length + i + 1}`;
      const scope = raw.scope.map(normalizeScope);
      if (raw.kind === 'build') {
        for (const other of [...occupied, ...missions.filter((m) => m.kind === 'build').map((m) => ({ id: m.id, scope: m.scope }))]) {
          for (const a of scope) {
            for (const b of other.scope) {
              if (scopesOverlap(a, b)) {
                throw new TeamError(`任务 ${id} 的范围「${a}」与 ${other.id} 的「${b}」重叠——写类任务的范围必须互斥，请重新划分。`);
              }
            }
          }
        }
      }
      for (const dep of raw.deps) {
        if (!ids.has(dep) && !input.some((_, j) => j < i && `M${state.missions.length + j + 1}` === dep)) {
          throw new TeamError(`任务 ${id} 依赖了不存在的任务「${dep}」。`);
        }
      }
      const slug = raw.title.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').slice(0, 24).replace(/^-|-$/g, '') || id.toLowerCase();
      missions.push({
        ...raw,
        id,
        scope,
        repo: raw.repo ?? this.repoRoot,
        branch: `team/${id.toLowerCase()}-${slug}`,
        worktree: `wt-${state.missions.length + i + 1}`,
        status: 'planned',
      });
    });

    state.missions.push(...missions);
    await this.save(state);
    await this.appendLog('team', 'plan', missions.map((m) => m.id).join(','));
    return missions;
  }

  /**
   * 派 worker 前的门控：deps 未全 merged 直接拒绝（硬化，不靠主 agent 自觉）。
   * 通过后开 worktree、置 active。
   * completed 允许重派（rework：审阅打回后的返工——worktree 幂等重挂，任务分支上已有提交不丢）。
   * blocked 也允许重派（respawn：worker 执行失败后重试）。
   */
  async spawn(missionId: string, owner: string): Promise<TeamMission> {
    const state = await this.load();
    const m = state.missions.find((x) => x.id === missionId);
    if (m === undefined) throw new TeamError(`任务 ${missionId} 不存在。`);
    const rework = m.status === 'completed';
    const respawn = m.status === 'blocked';
    if (m.status !== 'planned' && m.status !== 'paused' && !rework && !respawn) {
      throw new TeamError(`任务 ${missionId} 当前状态是 ${m.status}，不能启动。`);
    }
    const unmerged = m.deps.filter((d) => state.missions.find((x) => x.id === d)?.status !== 'merged');
    if (unmerged.length > 0) {
      throw new TeamError(`任务 ${missionId} 的依赖 ${unmerged.join('、')} 尚未合并——依赖未满足前不能启动。`);
    }
    const base = m.repo === this.repoRoot ? state.base : await currentBranch(m.repo);
    m.baseBranch = base;
    await addWorktree(m.repo, this.worktreePath(m), m.branch, base);
    m.status = 'active';
    m.owner = owner;
    await this.save(state);
    await this.appendLog('team', rework ? 'rework' : respawn ? 'respawn' : 'spawn', `${m.id} → ${owner}`);
    return m;
  }

  async setStatus(missionId: string, status: TeamMissionStatus): Promise<TeamMission> {
    const state = await this.load();
    const m = state.missions.find((x) => x.id === missionId);
    if (m === undefined) throw new TeamError(`任务 ${missionId} 不存在。`);
    m.status = status;
    await this.save(state);
    await this.appendLog(m.owner ?? 'team', 'status', `${m.id} → ${status}`);
    return m;
  }

  /**
   * 合并六道门：
   * 门〇（前置检查）build 任务 diffNameOnly 为空：任务分支无新提交，worker 可能忘提交或提交到了错误的地方；
   * ①② 主 agent 已审阅（传入 reviewedCommit 即声明已审且干净）；
   * ③ 分支 tip 自审阅后未移动；
   * ④ 依赖全部已 merged；
   * ⑤ diff 无 scope 外文件（按归一前缀逐文件比对）。
   * 全过才 git merge --no-ff。
   * survey 任务不受门〇限制（本来就不产生提交）。
   */
  async merge(missionId: string, reviewedCommit: string, force = false): Promise<{ conflictsWith: string[]; worktreeKept?: string; typecheckSkipped?: boolean }> {
    const state = await this.load();
    const m = state.missions.find((x) => x.id === missionId);
    if (m === undefined) throw new TeamError(`任务 ${missionId} 不存在。`);
    if (m.status !== 'completed') throw new TeamError(`任务 ${missionId} 状态是 ${m.status}，只有 completed 才能合并。`);

    const unmerged = m.deps.filter((d) => state.missions.find((x) => x.id === d)?.status !== 'merged');
    if (unmerged.length > 0) throw new TeamError(`门④：依赖 ${unmerged.join('、')} 尚未合并。`);

    const tip = await branchTip(m.repo, m.branch);
    if (tip !== reviewedCommit) {
      throw new TeamError(`门③：分支 tip 已移动（审阅时 ${reviewedCommit.slice(0, 8)}，现在 ${tip.slice(0, 8)}）——请重新审阅。`);
    }

    const base = m.baseBranch ?? state.base;
    if (m.kind === 'build') {
      const files = await diffNameOnly(m.repo, base, m.branch);
      // 门〇（前置检查）：任务分支相对基准没有任何新提交
      if (files.length === 0) {
        throw new TeamError(
          `门〇：任务分支 ${m.branch} 相对基准分支 ${base} 没有任何新提交。` +
            '两种可能：① worker 忘了提交（spawn 后执行完毕但没 git add/commit）；' +
            '② worker 提交到了错误的地方（比如直接提交到了基准分支，绕过任务分支）。' +
            '请核实工作间状态后再操作。',
        );
      }
      const outside = files.filter((f) => !m.scope.some((s) => scopeMatches(s, f)));
      if (outside.length > 0) {
        throw new TeamError(`门⑤：以下文件超出任务范围 ${m.scope.join('、')}：${outside.slice(0, 10).join('、')}——先收编或还原这些改动。`);
      }
    }

    // 合并目标分支必须是基准分支本身——用户中途切了分支时拒绝，防止合错地方
    const cur = await currentBranch(m.repo);
    if (cur !== base) {
      throw new TeamError(`合并目标是基准分支 ${base}，但 ${m.repo} 当前 checkout 的是 ${cur}——先切回 ${base} 再收编。`);
    }

    // typecheck 门：build 任务在 worktree 跑 tsc --noEmit（非 TS 仓自动跳过）。
    // 与 worktree.mjs 四道门对齐，提前把类型错误挡在合并之前，而非留到 merge 后手动抓。
    // survey 无提交，跳过；force 可绕过（确认是环境差异等误报时）。
    let typecheckSkipped = false;
    if (m.kind === 'build') {
      const wtDir = this.worktreePath(m);
      const tc = await typecheck(wtDir);
      if (tc.skipped) {
        typecheckSkipped = true;
      } else if (!tc.ok && !force) {
        throw new TeamError(
          `typecheck 未通过：\n${tc.detail}\n` +
            '修复后重新提交并收编；确认是环境差异等误报时加 --force 跳过本门（仅本门，其余硬门不可绕过）。',
        );
      }
    }

    try {
      await mergeNoFf(m.repo, m.branch);
    } catch (e) {
      // 真冲突会把仓库卡在 MERGING 状态——自动 abort 救回，再报指引
      await mergeAbort(m.repo).catch(() => undefined);
      throw new TeamError(
        `合并 ${m.branch} 时发生冲突，已自动中止合并（仓库恢复原状）。` +
          `请先在任务工作间里把基准分支 rebase/合并进任务分支、解完冲突再重新收编。原始错误：${(e as Error).message}`,
      );
    }
    m.status = 'merged';
    m.reviewedCommit = reviewedCommit;
    await this.save(state);
    await this.appendLog('team', 'merge', `${m.id} 已并入 ${state.base}`);

    // Merge 成功后自动清理 worktree：干净则删，dirty 则保留并记日志
    const wtDir = this.worktreePath(m);
    let worktreeKept: string | undefined;
    try {
      if (await isWorktreeDirty(wtDir)) {
        worktreeKept = `${m.worktree}（有未提交改动，保留）`;
        await this.appendLog('team', 'merge-worktree-keep', worktreeKept);
      } else {
        await removeWorktree(m.repo, wtDir, false);
        await this.appendLog('team', 'merge-worktree-remove', m.worktree);
      }
    } catch {
      // 删除失败不阻塞 merge 成功
      worktreeKept = `${m.worktree}（清理失败，保留）`;
      await this.appendLog('team', 'merge-worktree-keep', worktreeKept).catch(() => undefined);
    }

    // 波及检测：其他未 merged 的 build 任务，scope 与本次改动文件重叠的列出来
    const changed = await diffNameOnly(m.repo, base, m.branch).catch(() => [] as string[]);
    const conflictsWith = state.missions
      .filter((x) => x.kind === 'build' && x.status !== 'merged' && x.id !== m.id)
      .filter((x) => x.scope.some((s) => changed.some((f) => scopeMatches(s, f))))
      .map((x) => x.id);
    const result: { conflictsWith: string[]; worktreeKept?: string; typecheckSkipped?: boolean } = { conflictsWith, worktreeKept };
    if (typecheckSkipped) result.typecheckSkipped = true;
    return result;
  }

  /** 发信：往信箱目录写一个 md 文件（frontmatter + 正文）。 */
  async send(from: string, to: string, subject: string, body: string): Promise<string> {
    const date = new Date().toISOString().slice(0, 10).replace(/-/g, '');
    const safe = (s: string) => s.replace(/[^\w\u4e00-\u9fff-]+/g, '-').slice(0, 40);
    const file = `${date}-${safe(from)}-${safe(to)}-${safe(subject)}.md`;
    const content = [
      '---',
      `message_id: ${randomUUID()}`,
      `from: ${from}`,
      `to: ${to}`,
      `subject: ${subject}`,
      `sent_at: ${new Date().toISOString()}`,
      '---',
      '',
      body,
      '',
    ].join('\n');
    await writeFile(this.abs(join(INBOX_DIR, file)), content, 'utf8');
    await this.appendLog(from, 'send', `→ ${to}: ${subject}`);
    return file;
  }

  /** 收信：newest-first；name 为 'team' 时看全部，否则看发给自己的与广播。 */
  async inbox(name: string, limit = 20): Promise<TeamMessage[]> {
    let files: string[];
    try {
      files = await readdir(this.abs(INBOX_DIR));
    } catch {
      return [];
    }
    const out: TeamMessage[] = [];
    for (const file of files.filter((f) => f.endsWith('.md')).sort().reverse()) {
      if (out.length >= limit) break;
      const raw = await readFile(this.abs(join(INBOX_DIR, file)), 'utf8');
      const fm = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(raw);
      if (fm === null) continue;
      const meta: Record<string, string> = {};
      for (const line of fm[1].split('\n')) {
        const kv = /^(\w+):\s*(.*)$/.exec(line);
        if (kv !== null) meta[kv[1]] = kv[2];
      }
      if (name !== 'team' && meta.to !== name && meta.to !== 'all') continue;
      out.push({
        messageId: meta.message_id ?? '',
        from: meta.from ?? '?',
        to: meta.to ?? '?',
        subject: meta.subject ?? '',
        sentAt: meta.sent_at ?? '',
        body: fm[2].trim(),
        file,
      });
    }
    return out;
  }

  /** 全部活跃工作间的绝对路径（write guard 白名单用）。 */
  async activeWorktreeRoots(): Promise<string[]> {
    try {
      const state = await this.load();
      return state.missions
        .filter((m) => m.status === 'active' || m.status === 'completed' || m.status === 'paused')
        .map((m) => resolve(this.worktreePath(m)));
    } catch {
      return [];
    }
  }

  /** 团队是否开着：已初始化且未标记关闭（resume 恢复的依据——档案是事实源，快照只是指针）。 */
  async isOpen(): Promise<boolean> {
    try {
      const state = await this.load();
      return state.closedAt === undefined;
    } catch {
      return false;
    }
  }

  /** 标记团队已关闭（teardown/exit 时调用）。幂等。 */
  async markClosed(): Promise<void> {
    const state = await this.load();
    if (state.closedAt !== undefined) return;
    state.closedAt = new Date().toISOString();
    await this.save(state);
  }

  /** 收尾：先标记关闭（防 resume 复活），再清 worktree（dirty 默认保留），档案目录与日志永久保留。 */
  async teardown(force: boolean): Promise<{ removed: string[]; kept: string[] }> {
    // 关闭标记必须先落盘：后面清工作间即使抛错，团队也已关闭，resume 不会复活
    await this.markClosed();
    const state = await this.load();
    const removed: string[] = [];
    const kept: string[] = [];
    for (const m of state.missions) {
      const dir = this.worktreePath(m);
      try {
        if (!force && (await isWorktreeDirty(dir))) {
          kept.push(`${m.worktree}（有未提交改动，保留）`);
          continue;
        }
        await removeWorktree(m.repo, dir, force);
        removed.push(m.worktree);
      } catch {
        // worktree 不存在或已清理——不算错误
      }
    }
    await this.appendLog('team', 'teardown', `removed=${removed.length} kept=${kept.length}`);
    return { removed, kept };
  }
}

/** 从 cwd 构造 store：档案目录缺省在仓根的 `.teams/`；repo 显式给出时以它为基准仓（跨目录指挥）。 */
export async function newTeamStore(cwd: string, customDir?: string, repo?: string): Promise<TeamStore> {
  const repoRoot = repo !== undefined ? resolve(repo) : await resolveRepoRoot(cwd).catch(() => cwd);
  return new TeamStore(customDir ?? join(repoRoot, '.teams'), repoRoot);
}
