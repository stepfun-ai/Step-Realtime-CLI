import { describe, expect, it } from 'vitest';
import { GoalMode } from '../../src/agent/goal/mode.js';
import { createGoalTool, getGoalTool, setGoalBudgetTool, updateGoalTool } from '../../src/tools/goal.js';

describe('GoalMode', () => {
  it('创建 goal，默认 active', () => {
    const g = new GoalMode();
    g.create('实现登录');
    expect(g.get()?.status).toBe('active');
    expect(g.get()?.objective).toBe('实现登录');
  });

  it('已有 goal 时不 replace 报错，replace 覆盖', () => {
    const g = new GoalMode();
    g.create('A');
    expect(() => g.create('B')).toThrow();
    g.create('B', undefined, true);
    expect(g.get()?.objective).toBe('B');
  });

  it('complete 瞬态清除 goal', () => {
    const g = new GoalMode();
    g.create('A');
    g.update('complete');
    expect(g.get()).toBeNull();
  });

  it('预算：超支判定', () => {
    const g = new GoalMode();
    g.create('A');
    g.setTurnBudget(2);
    expect(g.overBudget()).toBe(false);
    g.incrementTurn();
    g.incrementTurn();
    expect(g.overBudget()).toBe(true);
  });

  it('创建时带 createdAt 时间戳', () => {
    const before = Date.now();
    const g = new GoalMode();
    g.create('A');
    const createdAt = g.get()?.createdAt;
    expect(createdAt).toBeGreaterThanOrEqual(before);
    expect(createdAt).toBeLessThanOrEqual(Date.now());
  });

  it('onChange：created / updated / completed 事件依次上抛', () => {
    const g = new GoalMode();
    const events: string[] = [];
    g.setOnChange((ev) => events.push(ev.type));
    g.create('A');
    g.update('paused', '歇一下');
    g.update('active');
    g.update('blocked', '缺凭证');
    g.update('complete', '手动收尾');
    expect(events).toEqual(['created', 'updated', 'updated', 'updated', 'completed']);
  });

  it('onChange：completed 携带清除前快照与原因', () => {
    const g = new GoalMode();
    let snapshot: unknown = null;
    g.setOnChange((ev) => {
      if (ev.type === 'completed') snapshot = ev.goal;
    });
    g.create('A');
    g.incrementTurn();
    g.update('complete', '做完了');
    expect(snapshot).toMatchObject({ objective: 'A', turnsUsed: 1, terminalReason: '做完了' });
    expect(g.get()).toBeNull();
  });

  it('onChange：传 null 解除监听', () => {
    const g = new GoalMode();
    const events: string[] = [];
    g.setOnChange((ev) => events.push(ev.type));
    g.setOnChange(null);
    g.create('A');
    expect(events).toEqual([]);
  });

  it('token 计量：计费口径（input + output；input_tokens 本身已排除缓存命中部分），active 才累计', () => {
    const g = new GoalMode();
    g.create('A');
    g.addTokens({ input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 600 } as never);
    expect(g.get()?.tokensUsed).toBe(1200); // 1000 + 200（cache_read 不计入）
    g.addTokens({ input_tokens: 500, output_tokens: 100 } as never); // cache_read 缺省按 0
    expect(g.get()?.tokensUsed).toBe(1800);
  });

  it('token 计量：paused / blocked 不累计，resume 后继续累计', () => {
    const g = new GoalMode();
    g.create('A');
    g.addTokens({ input_tokens: 100, output_tokens: 10 } as never);
    g.update('paused');
    g.addTokens({ input_tokens: 100, output_tokens: 10 } as never);
    expect(g.get()?.tokensUsed).toBe(110);
    g.update('active');
    g.addTokens({ input_tokens: 100, output_tokens: 10 } as never);
    expect(g.get()?.tokensUsed).toBe(220);
    g.update('blocked');
    g.addTokens({ input_tokens: 100, output_tokens: 10 } as never);
    expect(g.get()?.tokensUsed).toBe(220);
  });

  it('token 预算：超支判定与轮次预算并列', () => {
    const g = new GoalMode();
    g.create('A');
    g.setTokenBudget(100);
    expect(g.overBudget()).toBe(false);
    g.addTokens({ input_tokens: 80, output_tokens: 30 } as never);
    expect(g.exceededBudget()).toBe('tokens');
    expect(g.overBudget()).toBe(true);
    // 轮次预算未设时不误报 turns
    const g2 = new GoalMode();
    g2.create('B');
    g2.setTurnBudget(1);
    g2.incrementTurn();
    expect(g2.exceededBudget()).toBe('turns');
  });

  it('reminder：展示已用轮次/token/剩余；任一预算 ≥75% 追加收敛提示', () => {
    const g = new GoalMode();
    g.create('A');
    g.setTurnBudget(10);
    g.setTokenBudget(1000);
    g.incrementTurn();
    g.addTokens({ input_tokens: 200, output_tokens: 50 } as never);
    const r = g.reminder();
    expect(r).toContain('已用轮次：1 / 预算 10（剩余 9）');
    expect(r).toContain('已用 token：250 / 预算 1000（剩余 750）');
    expect(r).not.toContain('预算将尽');
    // token 用到 75% 触发收敛提示
    g.addTokens({ input_tokens: 500, output_tokens: 0 } as never); // tokensUsed = 750
    expect(g.reminder()).toContain('预算将尽');
    // 仅轮次到 75% 也触发
    const g2 = new GoalMode();
    g2.create('B');
    g2.setTurnBudget(4);
    g2.incrementTurn();
    g2.incrementTurn();
    g2.incrementTurn();
    expect(g2.reminder()).toContain('预算将尽');
  });

  it('restore：active 降级 paused，paused / blocked 原样保留', () => {
    const g = new GoalMode();
    g.create('A');
    g.setTokenBudget(100);
    g.addTokens({ input_tokens: 40, output_tokens: 5 } as never);
    const snap = g.snapshot();
    expect(snap).not.toBeNull();

    const restored = new GoalMode();
    restored.restore(snap);
    expect(restored.get()?.status).toBe('paused'); // active → paused
    expect(restored.get()?.tokensUsed).toBe(45);
    expect(restored.get()?.tokenBudget).toBe(100);

    restored.restore({ ...snap!, status: 'blocked' });
    expect(restored.get()?.status).toBe('blocked');
    restored.restore({ ...snap!, status: 'paused' });
    expect(restored.get()?.status).toBe('paused');
  });

  it('restore(null) 清空 goal；snapshot 无 goal 返回 null', () => {
    const g = new GoalMode();
    expect(g.snapshot()).toBeNull();
    g.create('A');
    g.restore(null);
    expect(g.get()).toBeNull();
  });
});

describe('goal 工具', () => {
  it('create_goal 创建，get_goal 查询', async () => {
    const goal = new GoalMode();
    const ctx = { cwd: process.cwd(), goal };
    await createGoalTool.execute({ objective: '写报告' }, ctx);
    const r = await getGoalTool.execute({}, ctx);
    expect(r.content).toContain('写报告');
    expect(r.content).toContain('active');
  });

  it('update_goal 标 blocked 带原因', async () => {
    const goal = new GoalMode();
    const ctx = { cwd: process.cwd(), goal };
    await createGoalTool.execute({ objective: 'X' }, ctx);
    await updateGoalTool.execute({ status: 'blocked', reason: '缺少凭证' }, ctx);
    expect(goal.get()?.status).toBe('blocked');
    expect(goal.get()?.terminalReason).toBe('缺少凭证');
  });

  it('ctx 无 goal 报不支持', async () => {
    const r = await createGoalTool.execute({ objective: 'X' }, { cwd: process.cwd() });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('不支持');
  });

  it('set_goal_budget：tokens 参数生效，get_goal 展示 token 用量与预算', async () => {
    const goal = new GoalMode();
    const ctx = { cwd: process.cwd(), goal };
    await createGoalTool.execute({ objective: 'X' }, ctx);
    const r = await setGoalBudgetTool.execute({ tokens: 5000 }, ctx);
    expect(r.isError).toBe(false);
    expect(goal.get()?.tokenBudget).toBe(5000);
    goal.addTokens({ input_tokens: 120, output_tokens: 30 } as never);
    const q = await getGoalTool.execute({}, ctx);
    expect(q.content).toContain('已用 token：150 / 预算 5000');
  });

  it('set_goal_budget：turns 与 tokens 都不给 → 拒绝', async () => {
    const goal = new GoalMode();
    const ctx = { cwd: process.cwd(), goal };
    await createGoalTool.execute({ objective: 'X' }, ctx);
    const r = await setGoalBudgetTool.execute({}, ctx);
    expect(r.isError).toBe(true);
  });

  it('set_goal_budget：非法 tokens（负数/小数/非整数）被 schema 拒绝', () => {
    expect(() => setGoalBudgetTool.schema.parse({ tokens: -5 })).toThrow();
    expect(() => setGoalBudgetTool.schema.parse({ tokens: 1.5 })).toThrow();
    expect(() => setGoalBudgetTool.schema.parse({ tokens: 0 })).toThrow();
    expect(setGoalBudgetTool.schema.parse({ tokens: 5000 })).toEqual({ tokens: 5000 });
  });
});
