import type { GoalMode } from './mode.js';

/**
 * 组装下一个自主轮的注入文本：goal reminder + 续接提示 + 运行期间的用户留言（steer）。
 * goal 已结束（get() 为 null）时返回 null——调用方放弃续接。
 */
export function assembleGoalInject(
  goal: GoalMode,
  continuation: string,
  steers: readonly string[],
): string | null {
  if (goal.get() === null) return null;
  let text = `${goal.reminder()}\n\n${continuation}`;
  if (steers.length > 0) {
    text += `\n\n用户在你运行期间留言（按时间顺序，请优先响应）：\n${steers.join('\n')}`;
  }
  return text;
}

/** 自主轮裁决：继续（带注入文本）/ 预算撞线（哪种预算）/ 结束。 */
export type GoalTurnDecision =
  | { kind: 'continue'; inject: string }
  | { kind: 'blocked'; budget: 'turns' | 'tokens' }
  | { kind: 'stop' };

/**
 * 判定 goal 是否还能推进下一个自主轮。纯函数，不做副作用——
 * incrementTurn / update('blocked') 等副作用留给调用方（App 的薄壳）。
 */
export function decideGoalTurn(goal: GoalMode): GoalTurnDecision {
  const g = goal.get();
  if (g === null || g.status !== 'active') return { kind: 'stop' };
  const hit = goal.exceededBudget();
  if (hit !== null) return { kind: 'blocked', budget: hit };
  return { kind: 'continue', inject: goal.continuationPrompt() };
}
