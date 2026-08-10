import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { runAgent } from '../../src/agent/loop.js';
import { stored, type StoredMessage } from '../../src/agent/message.js';
import { collect, makeFakeProvider, textBlock, toolUseBlock } from '../helpers/fakeProvider.js';

/**
 * 跨天提醒的接线测试。
 *
 * nowContext.test.ts 覆盖的是 crossedLocalMidnight 这个纯函数，本文件覆盖它在 loop 里
 * 真的被接上：判定为跨天时确实往 messages 里 push 了一条 injection，且只 push 一次。
 * 少了这层，判定函数写对但接线接错（位置不对、条件取反、忘记 push）测不出来。
 */

/** 构造一条指定 ts 的 storage 消息——stored() 内部固定取当前时刻，测试需要覆盖它。 */
function smAt(message: Anthropic.MessageParam, ts: string): StoredMessage {
  return { ...stored(message, { kind: 'user' }), ts };
}

/**
 * 26 小时前。任意时刻往前推 26 小时都必然落在不同的本地日期上（一天只有 24 小时），
 * 所以这个构造与运行时刻无关，不会出现「在某个钟点跑测试就失效」。
 */
function hoursAgo(h: number): string {
  return new Date(Date.now() - h * 3600 * 1000).toISOString();
}

/** 今天正午。只用于比对日期，取正午避免贴着午夜边界。 */
function todayNoon(): string {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), 12, 0).toISOString();
}

/** 单轮纯文本响应，跑一轮就收尾。 */
function makeSingleTurnProvider() {
  return makeFakeProvider([
    { textChunks: ['好'], finalContent: [textBlock('好')], stopReason: 'end_turn' },
  ]);
}

/** N 轮 tool_use，每轮 pattern 不同以避开 roundLoop 的零进展终止。 */
function makeMultiTurnProvider(count: number) {
  return makeFakeProvider(
    Array.from({ length: count }, (_, i) => ({
      textChunks: [] as string[],
      finalContent: [toolUseBlock('c1', 'grep', { pattern: `q-${i}` })],
      stopReason: 'tool_use' as Anthropic.Message['stop_reason'],
    })),
  );
}

/** 取出跨天提醒（按文案识别；turnWarning 也是 role=user + kind=injection，只看 kind 区分不开）。 */
function dateChangeInjections(messages: StoredMessage[]): StoredMessage[] {
  return messages.filter(
    (m) =>
      m.message.role === 'user' &&
      m.origin.kind === 'injection' &&
      typeof m.message.content === 'string' &&
      m.message.content.includes('日期已变更'),
  );
}

describe('runAgent：跨天提醒接线', () => {
  it('上一条消息在昨天：注入一条跨天提醒', async () => {
    const { provider } = makeSingleTurnProvider();
    const messages: StoredMessage[] = [smAt({ role: 'user', content: '继续' }, hoursAgo(26))];
    await collect(
      runAgent({
        provider,
        system: 'sys',
        ctx: { cwd: process.cwd(), signal: undefined },
        messages,
        maxIterations: 4,
      }),
    );

    const injected = dateChangeInjections(messages);
    expect(injected).toHaveLength(1);
    // 提醒里要带上当前时刻，模型才知道「现在」是几号几点
    expect(injected[0]!.message.content as string).toMatch(/\d{4}-\d{2}-\d{2}/);
    // 同时要说明 system prompt 里那份快照已过时，否则模型不知道该信哪个
    expect(injected[0]!.message.content as string).toContain('快照');
  });

  it('上一条消息就在今天：不注入', async () => {
    const { provider } = makeSingleTurnProvider();
    const messages: StoredMessage[] = [smAt({ role: 'user', content: '继续' }, todayNoon())];
    await collect(
      runAgent({
        provider,
        system: 'sys',
        ctx: { cwd: process.cwd(), signal: undefined },
        messages,
        maxIterations: 4,
      }),
    );

    expect(dateChangeInjections(messages)).toHaveLength(0);
  });

  it('多轮迭代只注入一次：注入的提醒自身把 baseline 推到今天', async () => {
    // 这条是幂等性的核心验证。跨天判定读的是「最后一条消息的 ts」，注入的提醒自己
    // 成为最后一条、ts 即今天，所以后续 iter 的判定必然为假——因此不需要 warned 标记。
    // 若把 baseline 换成别的来源（如会话首条消息），这里就会每轮注入一次。
    const { provider } = makeMultiTurnProvider(4);
    const messages: StoredMessage[] = [smAt({ role: 'user', content: '继续' }, hoursAgo(26))];
    await collect(
      runAgent({
        provider,
        system: 'sys',
        ctx: { cwd: process.cwd(), signal: undefined },
        messages,
        maxIterations: 4,
      }),
    );

    expect(dateChangeInjections(messages)).toHaveLength(1);
  });

  it('坏时间戳不触发注入（否则每轮都会注入一条恒定内容的假提醒）', async () => {
    const { provider } = makeMultiTurnProvider(3);
    const messages: StoredMessage[] = [smAt({ role: 'user', content: '继续' }, '乱码')];
    await collect(
      runAgent({
        provider,
        system: 'sys',
        ctx: { cwd: process.cwd(), signal: undefined },
        messages,
        maxIterations: 3,
      }),
    );

    expect(dateChangeInjections(messages)).toHaveLength(0);
  });

  it('注入的提醒是系统自撰的 user 消息（origin=injection，不会渲染成用户气泡）', async () => {
    const { provider } = makeSingleTurnProvider();
    const messages: StoredMessage[] = [smAt({ role: 'user', content: '继续' }, hoursAgo(26))];
    await collect(
      runAgent({
        provider,
        system: 'sys',
        ctx: { cwd: process.cwd(), signal: undefined },
        messages,
        maxIterations: 4,
      }),
    );

    const injected = dateChangeInjections(messages)[0]!;
    expect(injected.origin.kind).toBe('injection');
    expect(injected.message.role).toBe('user');
    // 未标 startsPromptTurn：这是回合中途注入，不该占用 prompt 回合槽位
    expect(injected.origin.startsPromptTurn).toBeUndefined();
  });
});
