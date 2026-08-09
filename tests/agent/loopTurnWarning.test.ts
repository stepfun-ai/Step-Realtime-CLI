import { describe, expect, it } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import { runAgent } from '../../src/agent/loop.js';
import { stored, type StoredMessage } from '../../src/agent/message.js';
import { collect, makeFakeProvider, textBlock, toolUseBlock } from '../helpers/fakeProvider.js';

/* ------------------------------------------------------------------ */
/* 测试辅助                                                           */
/* ------------------------------------------------------------------ */

/** 包一条 storage 消息（测试用）。 */
function sm(message: Anthropic.MessageParam, origin: 'user' | 'assistant' | 'tool' = 'user'): StoredMessage {
  return stored(message, { kind: origin });
}

/**
 * 构造一个能连续供给 N 次 tool_use 响应的 fake provider。
 *
 * `makeFakeProvider` 的行为数组越界会抛错；本函数把同一条行为重复 N 次。
 * 使用 `grep` 工具（正确入参 `{ pattern: string }`），通过工具校验正常执行。
 */
function makeRepeatedToolProvider(count: number) {
  const behavior = {
    textChunks: [] as string[],
    finalContent: [toolUseBlock('c1', 'grep', { pattern: 'foo' })],
    stopReason: 'tool_use' as Anthropic.Message['stop_reason'],
  };
  return makeFakeProvider(Array.from({ length: count }, () => behavior));
}

/** 渲染后的 mid 文案（用于 notice 断言比对）。 */
function midNotice(n: number, max: number): string {
  return `本轮已连续 ${n} 次工具调用（单轮上限 ${max}），请自查是否在原地重复；若已得到答案请直接作答。`;
}

/** 渲染后的 late 文案（用于 notice 断言比对）。 */
function lateNotice(n: number, max: number): string {
  return `本轮已达 ${n} 次工具调用，接近上限 {max}，请立即收敛并给出结论。`.replace('{max}', String(max));
}

/* ------------------------------------------------------------------ */
/* 阈值命中：注入 injection + yield notice                            */
/* ------------------------------------------------------------------ */

describe('runAgent：单轮步数分级提醒接线', () => {
  const baseMessages = (): StoredMessage[] => [
    sm({ role: 'user', content: '请搜索文件。' }, 'user'),
  ];

  /* ---- mid 档：maxIterations=4，mid=2，在 turn 2 触发 ---- */

  it('mid：达到 50% 阈值时注入 injection 并 yield notice', async () => {
    // maxIterations=4 → midThreshold = floor(4*0.5) = 2
    // 循环顶部检查：iter=0 turnCount=1 < 2 → 无；iter=1 turnCount=2 >= 2 → mid fires
    // 之后 roundLoop.stop 在 turn 4 终止循环
    const { provider } = makeRepeatedToolProvider(4);
    const messages = baseMessages();
    const events = await collect(
      runAgent({
        provider,
        system: 'sys',
        ctx: { cwd: process.cwd(), signal: undefined },
        messages,
        maxIterations: 4,
      }),
    );

    // 应有 mid notice，at turnCount=2
    const midNotices = events.filter(
      (e) =>
        e.type === 'notice' &&
        typeof (e as { message?: string }).message === 'string' &&
        (e as { message: string }).message === midNotice(2, 4),
    );
    expect(midNotices).toHaveLength(1);

    // messages 中应多一条 injection（role=user, kind=injection）
    const injections = messages.filter(
      (m) => m.message.role === 'user' && m.origin.kind === 'injection',
    );
    expect(injections.length).toBeGreaterThanOrEqual(1);
    // injection 内容应含 mid 文案关键词
    const injectionTexts = injections.map((i) => (i.message.content as string)).join('');
    expect(injectionTexts).toContain('请自查是否在原地重复');
  });

  /* ---- late 档：maxIterations=4，late=3，在 turn 3 触发 ---- */

  it('late：达到 80% 阈值时注入 injection 并 yield notice', async () => {
    // maxIterations=4 → lateThreshold = floor(4*0.8) = 3
    // iter=0 turnCount=1 < 3 → 无；iter=1 turnCount=2 < 3 → 无
    // iter=2 turnCount=3 >= 3 → late fires
    const { provider } = makeRepeatedToolProvider(4);
    const messages = baseMessages();
    const events = await collect(
      runAgent({
        provider,
        system: 'sys',
        ctx: { cwd: process.cwd(), signal: undefined },
        messages,
        maxIterations: 4,
      }),
    );

    // 应有 late notice，at turnCount=3
    const lateNotices = events.filter(
      (e) =>
        e.type === 'notice' &&
        typeof (e as { message?: string }).message === 'string' &&
        (e as { message: string }).message === lateNotice(3, 4),
    );
    expect(lateNotices).toHaveLength(1);

    const injections = messages.filter(
      (m) => m.message.role === 'user' && m.origin.kind === 'injection',
    );
    expect(injections.length).toBeGreaterThanOrEqual(1);
    const injectionTexts = injections.map((i) => (i.message.content as string)).join('');
    expect(injectionTexts).toContain('请立即收敛');
  });

  /* ---- 每档只触发一次 ---- */

  it('每档只触发一次：远超阈值后 notice 不重复出现', async () => {
    // maxIterations=4，4 轮 tool_use
    // turnCount 序列：1, 2(mid fires), 3(late fires), 4(>=max → loop ends)
    // mid 在 turn 2 触发一次，late 在 turn 3 触发一次
    const { provider } = makeRepeatedToolProvider(4);
    const messages = baseMessages();
    const events = await collect(
      runAgent({
        provider,
        system: 'sys',
        ctx: { cwd: process.cwd(), signal: undefined },
        messages,
        maxIterations: 4,
      }),
    );

    // mid 只出现 1 次
    const midNotices = events.filter(
      (e) =>
        e.type === 'notice' &&
        typeof (e as { message?: string }).message === 'string' &&
        (e as { message: string }).message.includes('请自查是否在原地重复'),
    );
    expect(midNotices).toHaveLength(1);

    // late 只出现 1 次
    const lateNotices = events.filter(
      (e) =>
        e.type === 'notice' &&
        typeof (e as { message?: string }).message === 'string' &&
        (e as { message: string }).message.includes('请立即收敛'),
    );
    expect(lateNotices).toHaveLength(1);
  });

  /* ---- mid + late 两档都触发 ---- */

  it('两档都触发：mid 先、late 后，各只一次', async () => {
    // maxIterations=4，4 轮 tool_use
    // turnCount=2 → mid; turnCount=3 → late; turnCount=4 → loop ends (error)
    const { provider } = makeRepeatedToolProvider(4);
    const messages = baseMessages();
    const events = await collect(
      runAgent({
        provider,
        system: 'sys',
        ctx: { cwd: process.cwd(), signal: undefined },
        messages,
        maxIterations: 4,
      }),
    );

    // mid：1 次，at turnCount=2
    const midNotices = events.filter(
      (e) =>
        e.type === 'notice' &&
        typeof (e as { message?: string }).message === 'string' &&
        (e as { message: string }).message === midNotice(2, 4),
    );
    expect(midNotices).toHaveLength(1);

    // late：1 次，at turnCount=3
    const lateNotices = events.filter(
      (e) =>
        e.type === 'notice' &&
        typeof (e as { message?: string }).message === 'string' &&
        (e as { message: string }).message === lateNotice(3, 4),
    );
    expect(lateNotices).toHaveLength(1);

    // 无其他 turnWarning 相关 notice
    const allWarnings = events.filter(
      (e) =>
        e.type === 'notice' &&
        typeof (e as { message?: string }).message === 'string' &&
        ((e as { message: string }).message.includes('请自查') ||
          (e as { message: string }).message.includes('请立即收敛')),
    );
    expect(allWarnings).toHaveLength(2);
  });

  /* ---- 小 maxIterations=10：两档不重叠，mid=5 late=8 ---- */

  it('小 maxIterations=10：mid=5、late=8，不重复注入', async () => {
    // 使用不同 pattern 避免 roundLoop 提前终止
    // 每轮 pattern 不同 → 指纹不同 → roundLoop 不触发
    // turnCount=5 → mid; turnCount=8 → late
    const behaviors = Array.from({ length: 9 }, (_, i) => ({
      textChunks: [] as string[],
      finalContent: [toolUseBlock('c1', 'grep', { pattern: `query-${i}` })],
      stopReason: 'tool_use' as Anthropic.Message['stop_reason'],
    }));
    const { provider } = makeFakeProvider(behaviors);
    const messages = baseMessages();
    const events = await collect(
      runAgent({
        provider,
        system: 'sys',
        ctx: { cwd: process.cwd(), signal: undefined },
        messages,
        maxIterations: 10,
      }),
    );

    // mid：1 次，at turnCount=5
    const midNotices = events.filter(
      (e) =>
        e.type === 'notice' &&
        typeof (e as { message?: string }).message === 'string' &&
        (e as { message: string }).message === midNotice(5, 10),
    );
    expect(midNotices).toHaveLength(1);

    // late：1 次，at turnCount=8
    const lateNotices = events.filter(
      (e) =>
        e.type === 'notice' &&
        typeof (e as { message?: string }).message === 'string' &&
        (e as { message: string }).message === lateNotice(8, 10),
    );
    expect(lateNotices).toHaveLength(1);
  });

  /* ---- 小 maxIterations=1：两档撞在同一轮（阈值均为 0），只触发 mid ---- */

  it('小 maxIterations=1：两档撞同一轮（阈值均为 0），只触发 mid', async () => {
    // mid=0, late=0
    // iter=0 turnCount=1: !midWarned && 1>=0 → mid fires; else-if skipped
    const { provider } = makeRepeatedToolProvider(1);
    const messages = baseMessages();
    const events = await collect(
      runAgent({
        provider,
        system: 'sys',
        ctx: { cwd: process.cwd(), signal: undefined },
        messages,
        maxIterations: 1,
      }),
    );

    const midNotices = events.filter(
      (e) =>
        e.type === 'notice' &&
        typeof (e as { message?: string }).message === 'string' &&
        (e as { message: string }).message.includes('请自查是否在原地重复'),
    );
    expect(midNotices).toHaveLength(1);

    // late 不应出现
    const lateNotices = events.filter(
      (e) =>
        e.type === 'notice' &&
        typeof (e as { message?: string }).message === 'string' &&
        (e as { message: string }).message.includes('请立即收敛'),
    );
    expect(lateNotices).toHaveLength(0);
  });

  /* ---- 小 maxIterations=2：两档撞在同一轮（阈值均为 1） ---- */

  it('小 maxIterations=2：两档撞同一轮（阈值均为 1），只触发 mid（同一 iter 内 late 被 else-if 拦下）', async () => {
    // mid=1, late=1
    // iter=0 turnCount=1: mid fires, late skipped (else-if, same iter) ✓
    // iter=1 turnCount=2: midWarned=true → else-if: !lateWarned && 2>=1 → late fires
    const { provider } = makeRepeatedToolProvider(2);
    const messages = baseMessages();
    const events = await collect(
      runAgent({
        provider,
        system: 'sys',
        ctx: { cwd: process.cwd(), signal: undefined },
        messages,
        maxIterations: 2,
      }),
    );

    // mid 在 turn 1 触发
    const midNotices = events.filter(
      (e) =>
        e.type === 'notice' &&
        typeof (e as { message?: string }).message === 'string' &&
        (e as { message: string }).message === midNotice(1, 2),
    );
    expect(midNotices).toHaveLength(1);

    // late 在 turn 2 触发（不同 iter，不是同一轮重复）
    const lateNotices = events.filter(
      (e) =>
        e.type === 'notice' &&
        typeof (e as { message?: string }).message === 'string' &&
        (e as { message: string }).message === lateNotice(2, 2),
    );
    expect(lateNotices).toHaveLength(1);
  });

  /* ---- 未达阈值：正常短交互不受影响 ---- */

  it('未达阈值：正常短交互不产生任何 turnWarning notice', async () => {
    // 1 轮纯文本 → end_turn，turnCount=1 < midThreshold=2（maxIterations=4）
    const { provider } = makeFakeProvider([
      { textChunks: ['完成'], finalContent: [textBlock('完成')], stopReason: 'end_turn' },
    ]);
    const messages: StoredMessage[] = baseMessages();
    const events = await collect(
      runAgent({
        provider,
        system: 'sys',
        ctx: { cwd: process.cwd(), signal: undefined },
        messages,
        maxIterations: 4,
      }),
    );

    // 不应有任何 turnWarning 相关 notice
    const warningNotices = events.filter(
      (e) =>
        e.type === 'notice' &&
        typeof (e as { message?: string }).message === 'string' &&
        ((e as { message: string }).message.includes('请自查') ||
          (e as { message: string }).message.includes('请立即收敛')),
    );
    expect(warningNotices).toHaveLength(0);

    // 正常以 turn_done 收尾
    expect(events.at(-1)!.type).toBe('turn_done');
  });

  /* ---- maxIterations=4：撞线时照旧 error（无 hook 场景回归） ---- */

  it('maxIterations=4：identical rounds 仍由 roundLoop.stop 正常收尾（不杀死 goal 场景回归）', async () => {
    // 4 轮 tool_use（全部相同）→ roundLoop.stop 在 turn 4 触发 → turn_done
    // 这验证了 roundLoop 的接线行为不变；turnCount 的注入不影响既有 stop 路径
    const { provider } = makeRepeatedToolProvider(4);
    const messages = baseMessages();
    const events = await collect(
      runAgent({
        provider,
        system: 'sys',
        ctx: { cwd: process.cwd(), signal: undefined },
        messages,
        maxIterations: 4,
      }),
    );

    // roundLoop.stop 以 turn_done 收尾，不是 error
    expect(events.at(-1)!.type).toBe('turn_done');
    // 不应有 error 事件
    expect(events.some((e) => e.type === 'error')).toBe(false);
  });
});
