/**
 * TeamMode：session 级团队模式状态（范本：GoalMode）。
 * 持有「模式是否活跃 + 档案目录位置」，快照随会话落盘，resume 时恢复。
 * 规则逻辑全在 TeamStore；这里只管生命周期与向 write guard 提供白名单。
 */
import { newTeamStore, TeamStore } from './store.js';

export interface TeamSnapshot {
  /** 档案目录绝对路径。 */
  dir: string;
  /** 基准仓绝对路径。 */
  repoRoot: string;
}

export class TeamMode {
  private store: TeamStore | null = null;
  private listener: ((active: boolean) => void) | null = null;

  /** 活跃状态变化监听（组合根注册，驱动状态栏徽标重渲）。 */
  setOnChange(fn: ((active: boolean) => void) | null): void {
    this.listener = fn;
  }

  /** 模式是否活跃（init 成功后为 true，teardown 后为 false）。 */
  get active(): boolean {
    return this.store !== null;
  }

  getStore(): TeamStore {
    if (this.store === null) throw new Error('team 模式未激活——先运行 team_init。');
    return this.store;
  }

  /** 进入模式（init 成功后调用）。 */
  activate(store: TeamStore): void {
    this.store = store;
    this.listener?.(true);
  }

  /** 退出模式（teardown 后调用）；档案目录保留。 */
  deactivate(): void {
    this.store = null;
    this.listener?.(false);
  }

  /** write guard 白名单：活跃工作间的绝对路径列表。模式未激活返回 null（不拦截）。 */
  async allowRoots(): Promise<string[] | null> {
    if (this.store === null) return null;
    return this.store.activeWorktreeRoots();
  }

  snapshot(): TeamSnapshot | null {
    if (this.store === null) return null;
    return { dir: this.store.dir, repoRoot: this.store.repoRoot };
  }

  /** 从快照恢复（resume）。目录被删或团队已关闭（teardown/exit 落过 closedAt）时静默降级为未激活。 */
  async restore(snap: TeamSnapshot | null | undefined): Promise<void> {
    if (snap === null || snap === undefined) return;
    const store = new TeamStore(snap.dir, snap.repoRoot);
    if (await store.isOpen()) {
      this.store = store;
      // restore 可能在 listener 注册后才完成（异步），激活要广播，否则状态栏徽标不亮
      this.listener?.(true);
    }
  }
}

/** 供组合根/命令直接使用：按 cwd 与可选 --dir/--repo/--base 建 store 并初始化。 */
export async function initTeam(cwd: string, customDir?: string, repo?: string, base?: string): Promise<{ store: TeamStore; created: boolean; base: string }> {
  const store = await newTeamStore(cwd, customDir, repo);
  const { created, base: b } = await store.init(base);
  return { store, created, base: b };
}
