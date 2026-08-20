import { describe, expect, it } from 'vitest';
import { runAgent } from '../../src/agent/loop.js';
import { stored, type StoredMessage } from '../../src/agent/message.js';
import { collect, makeFakeProvider, textBlock, thinkingBlock } from '../helpers/fakeProvider.js';

function sm(text: string): StoredMessage {
  return stored({ role: 'user', content: text }, { kind: 'user' });
}

describe('think-only 自动恢复（降档重试仍耗尽时落盘 thinking + 注入直接回答）', () => {
  it('降档重试耗尽 → 注入恢复成功：thinking_recover 事件 + 正文正常 + 前轮 thinking 落盘', async () => {
    const { provider, streamCalls, streamParams } = makeFakeProvider([
      // 首轮：thinking 吃满预算，正文零输出
      { textChunks: [], finalContent: [thinkingBlock('首轮思考')], stopReason: 'max_tokens' },
      // 降档重试：still thinking 耗尽
      { textChunks: [], finalContent: [thinkingBlock('low档仍烧光')], stopReason: 'max_tokens' },
      // 注入恢复后：正常产出正文
      { textChunks: ['直接回答'], finalContent: [textBlock('直接回答')] },
    ]);
    const messages: StoredMessage[] = [sm('问')];
    const events = await collect(
      runAgent({
        provider,
        system: 'sys',
        ctx: { cwd: process.cwd() },
        messages,
        thinking: { level: 'high', budgetTokens: 8192 },
      }),
    );

    // 共 3 次 stream 调用：原请求 + 降档重试 + 注入恢复
    expect(streamCalls()).toBe(3);
    // 降档事件
    const dg = events.find((e) => e.type === 'thinking_downgrade');
    expect(dg).toBeDefined();
    expect((dg as { fromLevel?: string }).fromLevel).toBe('high');
    expect((dg as { toLevel?: string }).toLevel).toBe('low');
    // 恢复事件
    const recover = events.find((e) => e.type === 'thinking_recover');
    expect(recover).toBeDefined();
    expect((recover as { retried?: boolean }).retried).toBe(false);
    // 第二次请求（降档重试）thinking.level=low
    expect((streamParams()[1] as { thinking?: { level?: string } }).thinking?.level).toBe('low');
    // 第三次请求（注入恢复）保持原 thinking 参数
    expect((streamParams()[2] as { thinking?: { level?: string } }).thinking?.level).toBe('high');
    // 正文正常
    expect(events.filter((e) => e.type === 'text')).toEqual([{ type: 'text', text: '直接回答' }]);
    // 前轮 thinking 落盘为 assistant 消息，恢复轮次结果也落盘
    const assistants = messages.filter((m) => m.origin.kind === 'assistant');
    expect(assistants.length).toBeGreaterThanOrEqual(2);
    const lastAssistant = assistants.at(-1)!;
    expect((lastAssistant.message.content as unknown[]).map((b) => (b as { type: string }).type)).toEqual([
      'text',
    ]);
    expect((lastAssistant.message.content as unknown[])[0]).toEqual({ type: 'text', text: '直接回答' });
    const prevAssistant = assistants.at(-2)!;
    expect((prevAssistant.message.content as unknown[]).map((b) => (b as { type: string }).type)).toEqual([
      'thinking',
    ]);
    expect((prevAssistant.message.content as unknown[])[0]).toEqual(
      expect.objectContaining({ type: 'thinking', thinking: '首轮思考' }),
    );
    expect(events.at(-1)!.type).toBe('turn_done');
  });

  it('注入恢复后仍耗尽 → 不再重试，退到提示路径，且降档 thinking 已落盘', async () => {
    const { provider, streamCalls, streamParams } = makeFakeProvider([
      { textChunks: [], finalContent: [thinkingBlock('首轮思考')], stopReason: 'max_tokens' },
      { textChunks: [], finalContent: [thinkingBlock('low档仍烧光')], stopReason: 'max_tokens' },
      { textChunks: [], finalContent: [thinkingBlock('注入仍烧光')], stopReason: 'max_tokens' },
    ]);
    const messages: StoredMessage[] = [sm('问')];
    const events = await collect(
      runAgent({
        provider,
        system: 'sys',
        ctx: { cwd: process.cwd() },
        messages,
        thinking: { level: 'high', budgetTokens: 8192 },
      }),
    );

    // 共 3 次 stream 调用：原请求 + 降档重试 + 注入恢复（不再继续）
    expect(streamCalls()).toBe(3);
    // thinking_recover 事件只发 1 次
    expect(events.filter((e) => e.type === 'thinking_recover')).toHaveLength(1);
    // 降档耗尽轮次的 thinking 已落盘
    const assistant = messages.find((m) => m.origin.kind === 'assistant');
    expect(assistant).toBeDefined();
    expect((assistant!.message.content as unknown[]).map((b) => (b as { type: string }).type)).toEqual([
      'thinking',
    ]);
    expect((assistant!.message.content as unknown[])[0]).toEqual(
      expect.objectContaining({ type: 'thinking', thinking: '首轮思考' }),
    );
    // 恢复轮次的内容未落盘（recoverMsg 未成功，不落盘）
    const allAssistants = messages.filter((m) => m.origin.kind === 'assistant');
    expect(allAssistants).toHaveLength(1);
    // 最终走提示路径
    const notice = events.find((e) => e.type === 'notice');
    expect(notice).toBeDefined();
    expect((notice as { message: string }).message).toContain('思考消耗');
    expect(events.at(-1)!.type).toBe('turn_done');
  });

  it('thinking 为 null（off）→ 不触发 think-only 恢复', async () => {
    const { provider, streamCalls } = makeFakeProvider([
      { textChunks: [], finalContent: [thinkingBlock('烧光')], stopReason: 'max_tokens' },
      { textChunks: [], finalContent: [thinkingBlock('仍烧光')], stopReason: 'max_tokens' },
      { textChunks: [], finalContent: [thinkingBlock('注入')], stopReason: 'max_tokens' },
    ]);
    const messages: StoredMessage[] = [sm('问')];
    const events = await collect(
      runAgent({
        provider,
        system: 'sys',
        ctx: { cwd: process.cwd() },
        messages,
        thinking: null,
      }),
    );

    // off 时只有首轮请求，降档与恢复都不触发
    expect(streamCalls()).toBe(1);
    expect(events.some((e) => e.type === 'thinking_downgrade')).toBe(false);
    expect(events.some((e) => e.type === 'thinking_recover')).toBe(false);
  });

  it('注入消息包含「停止继续推理，基于已有的分析直接给出」', async () => {
    const { provider, streamParams } = makeFakeProvider([
      { textChunks: [], finalContent: [thinkingBlock('首轮')], stopReason: 'max_tokens' },
      { textChunks: [], finalContent: [thinkingBlock('low')], stopReason: 'max_tokens' },
      { textChunks: ['答案'], finalContent: [textBlock('答案')] },
    ]);
    await collect(
      runAgent({
        provider,
        system: 'sys',
        ctx: { cwd: process.cwd() },
        messages: [sm('问')],
        thinking: { level: 'high', budgetTokens: 8192 },
      }),
    );

    // 第三次请求的消息序列
    const third = streamParams()[2] as { messages?: Array<{ role: string; content: unknown }> };
    const lastMsg = third.messages?.at(-1);
    expect(lastMsg?.role).toBe('user');
    const content = lastMsg?.content as Array<{ type: string; text: string }> | undefined;
    expect(content?.at(0)?.type).toBe('text');
    expect(content?.at(0)?.text).toContain('停止继续推理');
    expect(content?.at(0)?.text).toContain('基于已有的分析直接给出');
  });

  it('落盘 thinking：messages 中包含前轮 thinking 块', async () => {
    const { provider } = makeFakeProvider([
      { textChunks: [], finalContent: [thinkingBlock('分析过程')], stopReason: 'max_tokens' },
      { textChunks: [], finalContent: [thinkingBlock('low')], stopReason: 'max_tokens' },
      { textChunks: ['答案'], finalContent: [textBlock('答案')] },
    ]);
    const messages: StoredMessage[] = [sm('问')];
    await collect(
      runAgent({
        provider,
        system: 'sys',
        ctx: { cwd: process.cwd() },
        messages,
        thinking: { level: 'high', budgetTokens: 8192 },
      }),
    );

    // messages 末尾应有：注入的 user 消息 + 降档 thinking assistant + 恢复结果 assistant
    const lastUser = messages.filter((m) => m.origin.kind === 'user').at(-1);
    expect(lastUser).toBeDefined();
    const userContent = lastUser!.message.content as Array<{ type: string; text: string }>;
    expect(userContent.at(0)).toEqual(
      expect.objectContaining({ type: 'text', text: expect.stringContaining('停止继续推理') }),
    );
    const assistants = messages.filter((m) => m.origin.kind === 'assistant');
    expect(assistants.length).toBeGreaterThanOrEqual(2);
    const firstAssistant = assistants.at(0)!;
    expect((firstAssistant.message.content as unknown[])[0]).toEqual(
      expect.objectContaining({ type: 'thinking', thinking: '分析过程' }),
    );
  });

  it('用户中断注入恢复：abort 正常生效', async () => {
    const controller = new AbortController();
    const { provider } = makeFakeProvider([
      { textChunks: [], finalContent: [thinkingBlock('首轮')], stopReason: 'max_tokens' },
      { textChunks: [], finalContent: [thinkingBlock('low')], stopReason: 'max_tokens' },
      // 恢复流：在 text_delta 后中断
      { textChunks: ['部分'], throwAfterChunks: new Error('abort'), finalContent: [] },
    ]);
    const messages: StoredMessage[] = [sm('问')];
    const gen = runAgent({
      provider,
      system: 'sys',
      ctx: { cwd: process.cwd() },
      messages,
      thinking: { level: 'high', budgetTokens: 8192 },
      signal: controller.signal,
    });
    // 等 inject 事件发出后中断
    for await (const ev of gen) {
      if (ev.type === 'thinking_recover') {
        controller.abort();
      }
    }
    // 应正常结束为 aborted，不抛错
    const outcomes = messages.filter((m) => m.origin.kind === 'assistant');
    // abort 发生在恢复流中途，recoverMsg 未成功，thinkingBlocks 仍应落盘
    expect(outcomes.length).toBeGreaterThanOrEqual(1);
  });

  it('不可恢复时（thinking 为 undefined 且 exhausted）→ 退到提示路径', async () => {
    // thinking undefined 时 downgrade 不触发，但 exhausted 仍走提示路径；
    // 这里只验证 undefined + exhausted 不触发 recover（因为 downgrade 没触发，所以不会进 recover）
    const { provider, streamCalls } = makeFakeProvider([
      { textChunks: [], finalContent: [thinkingBlock('烧光')], stopReason: 'max_tokens' },
    ]);
    const events = await collect(
      runAgent({
        provider,
        system: 'sys',
        ctx: { cwd: process.cwd() },
        messages: [sm('问')],
        // thinking 不传 = undefined
      }),
    );

    expect(streamCalls()).toBe(1);
    expect(events.some((e) => e.type === 'thinking_downgrade')).toBe(false);
    expect(events.some((e) => e.type === 'thinking_recover')).toBe(false);
  });
});
