import { describe, expect, it } from 'vitest';
import { planTurnEnd } from '../../src/chat/turnEnd.js';

describe('planTurnEnd 回合收尾决策', () => {
  it('队列优先于 goal 续接：queue 非空时先 submit-queue', () => {
    const plan = planTurnEnd({
      continuation: '继续推进目标',
      goalActive: true,
      queue: ['第一条', '第二条'],
      hasPendingPrompt: false,
    });
    expect(plan.action).toBe('submit-queue');
    expect(plan.text).toBe('第一条');
    expect(plan.queueRemainder).toEqual(['第二条']);
  });

  it('队列优先于 Stop hook 续行（无 active goal 同样让位）', () => {
    const plan = planTurnEnd({
      continuation: 'hook 要求继续',
      goalActive: false,
      queue: ['排队消息'],
      hasPendingPrompt: false,
    });
    expect(plan.action).toBe('submit-queue');
    expect(plan.text).toBe('排队消息');
    expect(plan.queueRemainder).toEqual([]);
  });

  it('queue 空时 goal 续接正常派发（submit-continuation）', () => {
    const plan = planTurnEnd({
      continuation: '继续推进目标',
      goalActive: true,
      queue: [],
      hasPendingPrompt: false,
    });
    expect(plan.action).toBe('submit-continuation');
    expect(plan.text).toBe('继续推进目标');
    expect(plan.queueRemainder).toEqual([]);
  });

  it('queue 空时 Stop hook 兜底续行正常派发', () => {
    const plan = planTurnEnd({
      continuation: 'hook 要求继续',
      goalActive: false,
      queue: [],
      hasPendingPrompt: false,
    });
    expect(plan.action).toBe('submit-continuation');
    expect(plan.text).toBe('hook 要求继续');
  });

  it('pending 弹层时不 shift 不丢弃：队列原样留队，action 为 idle', () => {
    const queue = ['消息A', '消息B'];
    const plan = planTurnEnd({
      continuation: null,
      goalActive: false,
      queue,
      hasPendingPrompt: true,
    });
    expect(plan.action).toBe('idle');
    expect(plan.text).toBeUndefined();
    expect(plan.queueRemainder).toEqual(['消息A', '消息B']);
  });

  it('pending 弹层时 continuation 也不派发（等弹层关闭后的下一收尾点）', () => {
    const plan = planTurnEnd({
      continuation: '继续推进目标',
      goalActive: true,
      queue: ['消息A'],
      hasPendingPrompt: true,
    });
    expect(plan.action).toBe('idle');
    expect(plan.queueRemainder).toEqual(['消息A']);
  });

  it('queue 与 continuation 同存时分两轮：先 queue 后 continuation', () => {
    // 第一轮：queue 优先
    const round1 = planTurnEnd({
      continuation: '继续推进目标',
      goalActive: true,
      queue: ['排队消息'],
      hasPendingPrompt: false,
    });
    expect(round1.action).toBe('submit-queue');
    expect(round1.text).toBe('排队消息');
    // 第二轮：队列消息回合收尾，queue 已空，续接（由调用方保留）再派发
    const round2 = planTurnEnd({
      continuation: '继续推进目标',
      goalActive: true,
      queue: round1.queueRemainder,
      hasPendingPrompt: false,
    });
    expect(round2.action).toBe('submit-continuation');
    expect(round2.text).toBe('继续推进目标');
  });

  it('多条队列逐条排空：每轮只发队首，余量正确', () => {
    const r1 = planTurnEnd({ continuation: null, goalActive: false, queue: ['a', 'b', 'c'], hasPendingPrompt: false });
    expect(r1).toMatchObject({ action: 'submit-queue', text: 'a', queueRemainder: ['b', 'c'] });
    const r2 = planTurnEnd({ continuation: null, goalActive: false, queue: r1.queueRemainder, hasPendingPrompt: false });
    expect(r2).toMatchObject({ action: 'submit-queue', text: 'b', queueRemainder: ['c'] });
    const r3 = planTurnEnd({ continuation: null, goalActive: false, queue: r2.queueRemainder, hasPendingPrompt: false });
    expect(r3).toMatchObject({ action: 'submit-queue', text: 'c', queueRemainder: [] });
    const r4 = planTurnEnd({ continuation: null, goalActive: false, queue: r3.queueRemainder, hasPendingPrompt: false });
    expect(r4.action).toBe('idle');
  });

  it('/compact 收尾排空：无 continuation 时队列非空照样发下一条', () => {
    const plan = planTurnEnd({
      continuation: null,
      goalActive: false,
      queue: ['压缩后排队的消息'],
      hasPendingPrompt: false,
    });
    expect(plan.action).toBe('submit-queue');
    expect(plan.text).toBe('压缩后排队的消息');
    expect(plan.queueRemainder).toEqual([]);
  });

  it('全空（无队列无续接无弹层）为 idle', () => {
    const plan = planTurnEnd({ continuation: null, goalActive: false, queue: [], hasPendingPrompt: false });
    expect(plan.action).toBe('idle');
    expect(plan.text).toBeUndefined();
    expect(plan.queueRemainder).toEqual([]);
  });

  it('不修改输入 queue（纯函数）', () => {
    const queue = ['x', 'y'];
    planTurnEnd({ continuation: 'c', goalActive: true, queue, hasPendingPrompt: false });
    expect(queue).toEqual(['x', 'y']);
  });

  // ─────────────────────────────────────────────────────────────────
  // submit() 的 fromQueue 语义契约（ behavioural contract ）：
  //
  // planTurnEnd 返回 submit-queue 后，调用方通过 submit(text, { fromQueue: true })
  // 告知 submit：这是队列自动发送，不得 setInput('')——用户可能正在输入框里编辑草稿。
  //
  // 对应修复：submit 非 busy 分支的 setInput('')  guarded by !opts?.fromQueue。
  // settleHandler 空闲路径同样传 fromQueue: true（系统合成注入，不清草稿）。
  //
  // 用户主动提交（Enter / busy 时入队）不走 fromQueue，setInput('') 正常执行。
  // cronFire / skillInject 走 silent 路径在 busy 分支 return，不进入非 busy 分支，
  // 因此不受 fromQueue 影响，行为不变。
  // ─────────────────────────────────────────────────────────────────
});
