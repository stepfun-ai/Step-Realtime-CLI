import { describe, expect, it } from 'vitest';
import { assembleGoalInject, decideGoalTurn } from '../../src/agent/goal/drive.js';
import { GoalMode } from '../../src/agent/goal/mode.js';

describe('assembleGoalInject', () => {
  it('goal 为 null 时返回 null', () => {
    const goal = new GoalMode();
    expect(assembleGoalInject(goal, '继续', [])).toBeNull();
  });

  it('goal complete 瞬态清除后返回 null', () => {
    const goal = new GoalMode();
    goal.create('写报告');
    goal.update('complete');
    expect(assembleGoalInject(goal, '继续', [])).toBeNull();
  });

  it('无 steer：reminder + 续接提示拼接', () => {
    const goal = new GoalMode();
    goal.create('写报告');
    const text = assembleGoalInject(goal, '继续推进', []);
    expect(text).not.toBeNull();
    expect(text).toContain('<goal status="active">');
    expect(text).toContain('写报告');
    expect(text).toContain('继续推进');
    expect(text).not.toContain('留言');
    // reminder 在前，续接提示在后，中间空行分隔
    expect(text!.indexOf('<goal')).toBeLessThan(text!.indexOf('继续推进'));
  });

  it('有 steer：追加留言块且顺序保持', () => {
    const goal = new GoalMode();
    goal.create('写报告');
    const text = assembleGoalInject(goal, '继续推进', ['先改 A 章', '再补 B 章']);
    expect(text).not.toBeNull();
    expect(text).toContain('用户在你运行期间留言');
    expect(text).toContain('先改 A 章\n再补 B 章');
    // 续接提示在留言块之前，steer 按时间顺序排列
    expect(text!.indexOf('继续推进')).toBeLessThan(text!.indexOf('先改 A 章'));
    expect(text!.indexOf('先改 A 章')).toBeLessThan(text!.indexOf('再补 B 章'));
  });
});

describe('decideGoalTurn', () => {
  it('无 goal → stop', () => {
    const goal = new GoalMode();
    expect(decideGoalTurn(goal)).toEqual({ kind: 'stop' });
  });

  it('active 未超预算 → continue 带 continuationPrompt，且无副作用', () => {
    const goal = new GoalMode();
    goal.create('写报告');
    const d = decideGoalTurn(goal);
    expect(d.kind).toBe('continue');
    if (d.kind === 'continue') expect(d.inject).toBe(goal.continuationPrompt());
    // 纯函数：不计轮、不改状态
    expect(goal.get()?.turnsUsed).toBe(0);
    expect(goal.get()?.status).toBe('active');
  });

  it('轮次预算超 → blocked turns', () => {
    const goal = new GoalMode();
    goal.create('写报告');
    goal.setTurnBudget(2);
    goal.incrementTurn();
    goal.incrementTurn();
    expect(decideGoalTurn(goal)).toEqual({ kind: 'blocked', budget: 'turns' });
  });

  it('token 预算超 → blocked tokens', () => {
    const goal = new GoalMode();
    goal.create('写报告');
    goal.setTokenBudget(100);
    goal.addTokens({ input_tokens: 80, output_tokens: 30 } as never);
    expect(decideGoalTurn(goal)).toEqual({ kind: 'blocked', budget: 'tokens' });
  });

  it('paused → stop', () => {
    const goal = new GoalMode();
    goal.create('写报告');
    goal.update('paused');
    expect(decideGoalTurn(goal)).toEqual({ kind: 'stop' });
  });

  it('complete 瞬态清除 → stop', () => {
    const goal = new GoalMode();
    goal.create('写报告');
    goal.update('complete', '做完了');
    expect(decideGoalTurn(goal)).toEqual({ kind: 'stop' });
  });
});
