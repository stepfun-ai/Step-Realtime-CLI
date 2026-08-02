import type Anthropic from '@anthropic-ai/sdk';
import { t } from '../../i18n.js';
import { billedTokens } from '../compaction/compact.js';

/** goal（自主目标）状态：active / paused / blocked（complete 瞬态即清）。 */
export type GoalStatus = 'active' | 'paused' | 'blocked';

export interface GoalState {
  objective: string;
  completionCriterion?: string;
  status: GoalStatus;
  turnsUsed: number;
  /** 轮次预算（可选，超支 markBlocked）。 */
  turnBudget?: number;
  /** 已用 token（计费口径累计：input - cache_read + output）。 */
  tokensUsed: number;
  /** token 预算（可选，超支 markBlocked）。 */
  tokenBudget?: number;
  terminalReason?: string;
  /** 创建时间戳（ms），用于状态栏徽标与面板展示墙钟用时。 */
  createdAt: number;
}

/** goal 生命周期事件：created / updated（暂停、恢复、阻塞）/ completed（瞬态完成，携带清除前快照）。 */
export type GoalChangeEvent =
  | { type: 'created'; goal: GoalState }
  | { type: 'updated'; goal: GoalState }
  | { type: 'completed'; goal: GoalState };

/** 预算使用比例达到该值时，reminder 追加收敛提示。 */
const NEAR_BUDGET_RATIO = 0.75;

/** goal 管理器：持有当前 goal，状态机 + 预算判定 + 生命周期事件。 */
export class GoalMode {
  private goal: GoalState | null = null;
  private listener: ((ev: GoalChangeEvent) => void) | null = null;

  /** 注册生命周期监听器（UI 层打 marker、刷状态栏）；传 null 解除。 */
  setOnChange(fn: ((ev: GoalChangeEvent) => void) | null): void {
    this.listener = fn;
  }

  private emit(ev: GoalChangeEvent): void {
    this.listener?.(ev);
  }

  create(objective: string, completionCriterion?: string, replace = false): GoalState {
    if (this.goal !== null && !replace) {
      throw new Error('已有进行中的 goal。先 UpdateGoal 结束，或带 replace 覆盖。');
    }
    this.goal = { objective, completionCriterion, status: 'active', turnsUsed: 0, tokensUsed: 0, createdAt: Date.now() };
    this.emit({ type: 'created', goal: { ...this.goal } });
    return this.goal;
  }

  get(): GoalState | null {
    return this.goal;
  }

  update(status: 'active' | 'paused' | 'blocked' | 'complete', reason?: string): void {
    if (this.goal === null) throw new Error('当前没有 goal。');
    if (status === 'complete') {
      const snapshot: GoalState = { ...this.goal, terminalReason: reason };
      this.goal = null; // 瞬态：完成即清
      this.emit({ type: 'completed', goal: snapshot });
      return;
    }
    this.goal.status = status;
    this.goal.terminalReason = reason;
    this.emit({ type: 'updated', goal: { ...this.goal } });
  }

  setTurnBudget(n: number): void {
    if (this.goal === null) throw new Error('当前没有 goal。');
    this.goal.turnBudget = n;
  }

  setTokenBudget(n: number): void {
    if (this.goal === null) throw new Error('当前没有 goal。');
    this.goal.tokenBudget = n;
  }

  incrementTurn(): void {
    if (this.goal !== null && this.goal.status === 'active') this.goal.turnsUsed += 1;
  }

  /**
   * 按计费口径累计 token（goal active 才累计，paused/blocked 不累计）：
   * 缓存命中不计成本，故 input 扣除 cache_read 后加 output。
   */
  addTokens(usage: Anthropic.Usage): void {
    if (this.goal === null || this.goal.status !== 'active') return;
    this.goal.tokensUsed += billedTokens(usage);
  }

  /** 哪种预算耗尽（turns / tokens），都没超返回 null。 */
  exceededBudget(): 'turns' | 'tokens' | null {
    if (this.goal === null) return null;
    if (this.goal.turnBudget !== undefined && this.goal.turnsUsed >= this.goal.turnBudget) return 'turns';
    if (this.goal.tokenBudget !== undefined && this.goal.tokensUsed >= this.goal.tokenBudget) return 'tokens';
    return null;
  }

  /** 是否超预算（轮次或 token 任一）。 */
  overBudget(): boolean {
    return this.exceededBudget() !== null;
  }

  /** 导出当前 goal 快照（随会话持久化用）；无 goal 返回 null。 */
  snapshot(): GoalState | null {
    return this.goal === null ? null : { ...this.goal };
  }

  /**
   * 从会话快照恢复 goal（挂载 /resume 时调用）。
   * active 一律降级 paused——防进程重启后自动续跑烧钱，用户 /goal resume 显式复活；
   * paused / blocked 原样保留。静默恢复，不发生命周期事件。
   */
  restore(state: GoalState | null | undefined): void {
    if (state === null || state === undefined) {
      this.goal = null;
      return;
    }
    this.goal = { ...state, status: state.status === 'active' ? 'paused' : state.status };
  }

  /** goal 激活时应续跑的提示（模型自报停机的替身）。 */
  continuationPrompt(): string {
    return (
      '继续朝当前目标推进。每轮完成一个连贯的工作切片并自审：' +
      '若目标已达成、或遇到无法自行解决的阻塞，调用 update_goal 标记 complete 或 blocked，不要再空跑。' +
      '不要只产出计划或摘要就标记 complete。'
    );
  }

  /** 注入上下文的 goal 提醒（防注入包裹）：已用轮次/token/剩余，预算将尽时追加收敛提示。 */
  reminder(): string {
    if (this.goal === null) return '';
    const g = this.goal;
    const crit = g.completionCriterion !== undefined ? `\n完成标准：${g.completionCriterion}` : '';
    const turns =
      g.turnBudget !== undefined ? `${g.turnsUsed} / 预算 ${g.turnBudget}（剩余 ${g.turnBudget - g.turnsUsed}）` : `${g.turnsUsed}`;
    const tokens =
      g.tokenBudget !== undefined
        ? `${g.tokensUsed} / 预算 ${g.tokenBudget}（剩余 ${g.tokenBudget - g.tokensUsed}）`
        : `${g.tokensUsed}`;
    const near =
      (g.turnBudget !== undefined && g.turnsUsed >= g.turnBudget * NEAR_BUDGET_RATIO) ||
      (g.tokenBudget !== undefined && g.tokensUsed >= g.tokenBudget * NEAR_BUDGET_RATIO);
    const warning = near ? `\n${t('goal.budgetWarning')}` : '';
    return `<goal status="${g.status}">\n目标：<untrusted_objective>${escapeXml(g.objective)}</untrusted_objective>${crit}\n已用轮次：${turns}\n已用 token：${tokens}${warning}\n</goal>`;
  }
}

function escapeXml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
