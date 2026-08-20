/**
 * usage 落盘（`model.usage` wire 事件）。
 *
 * 背景：会话快照只存消息内容、不存 usage，导致「上下文占用异常」类问题事后无法复算。
 * 2026-08-02 那次排查（状态栏 479.4k 超上限两成）就卡在这上面——手里只有压缩后的快照，
 * 拿它去解释压缩前的占用，得出「差 48 倍」的伪结论，实际是复算对象错配。
 * 本文件钉住：每轮真实 API 往返都留下一条可审计记录，且同时含真实值与估算值两套口径。
 */
import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { runAgent } from '../../src/agent/loop.js';
import { stored, type StoredMessage } from '../../src/agent/message.js';
import type { WireEvent } from '../../src/agent/wirelog.js';
import { collect, makeFakeProvider, textBlock, toolUseBlock } from '../helpers/fakeProvider.js';

function sm(message: Anthropic.MessageParam, origin: 'user' | 'assistant' | 'tool' = 'user'): StoredMessage {
  return stored(message, { kind: origin });
}

/** 取出所有 model.usage 事件（收窄类型便于断言字段）。 */
function usageEvents(events: WireEvent[]): Extract<WireEvent, { type: 'model.usage' }>[] {
  return events.filter(
    (e): e is Extract<WireEvent, { type: 'model.usage' }> => e.type === 'model.usage',
  );
}

describe('model.usage 事件落盘', () => {
  it('单回合有真实 usage → 落一条，四项明细与两套口径都在', async () => {
    const usage = {
      input_tokens: 1000,
      output_tokens: 200,
      cache_read_input_tokens: 600,
      cache_creation_input_tokens: 50,
    } as Anthropic.Usage;
    const { provider } = makeFakeProvider([
      { textChunks: ['好'], finalContent: [textBlock('好')], usage },
    ]);
    const wire: WireEvent[] = [];
    const messages: StoredMessage[] = [sm({ role: 'user', content: 'hi' })];
    await collect(
      runAgent({
        provider,
        system: 'sys',
        ctx: { cwd: process.cwd() },
        messages,
        onWireEvent: (e) => wire.push(e),
      }),
    );

    const us = usageEvents(wire);
    expect(us).toHaveLength(1);
    const u = us[0]!;
    // 服务端明细逐项落盘（缺一项就无法区分「缓存命中」与「真在烧输入」）
    expect(u.inputTokens).toBe(1000);
    expect(u.outputTokens).toBe(200);
    expect(u.cacheReadTokens).toBe(600);
    expect(u.cacheCreationTokens).toBe(50);
    // 两套聚合口径：totalTokens 是状态栏显示的事实源，billedTokens 是计费增量
    // billedTokens = input + output（input_tokens 本身已排除缓存命中部分）
    expect(u.totalTokens).toBe(1000 + 200 + 600 + 50);
    expect(u.billedTokens).toBe(1000 + 200);
    // 估算口径同时记：与 totalTokens 的比值就是预检可信度
    expect(u.estimatedTokens).toBeGreaterThan(0);
    expect(u.stopReason).toBe('end_turn');
    expect(typeof u.ts).toBe('string');
  });

  it('measuredLength 是发请求那一刻的历史长度，不是回合结束后的长度', async () => {
    // 关键区分：回合结束时历史已追加 assistant（可能还有 tool_result），
    // 若记成结束后的长度，事后复算会把本轮新增的消息也算进「已被真实 usage 覆盖」的范围，
    // 导致下一轮预检重复计数。
    const usage = { input_tokens: 100, output_tokens: 10 } as Anthropic.Usage;
    const { provider } = makeFakeProvider([
      { textChunks: ['答'], finalContent: [textBlock('答')], usage },
    ]);
    const wire: WireEvent[] = [];
    const messages: StoredMessage[] = [sm({ role: 'user', content: 'q' })];
    await collect(
      runAgent({
        provider,
        system: 'sys',
        ctx: { cwd: process.cwd() },
        messages,
        onWireEvent: (e) => wire.push(e),
      }),
    );

    // 发请求时 1 条，结束后 2 条（追加了 assistant）
    expect(messages).toHaveLength(2);
    expect(usageEvents(wire)[0]!.measuredLength).toBe(1);
  });

  it('多回合逐轮各落一条，且 stopReason 能把工具轮与收尾轮分开', async () => {
    const u1 = { input_tokens: 500, output_tokens: 30 } as Anthropic.Usage;
    const u2 = { input_tokens: 800, output_tokens: 40 } as Anthropic.Usage;
    const { provider } = makeFakeProvider([
      { textChunks: [], finalContent: [toolUseBlock('c1', 'nonexistent_tool', {})], usage: u1 },
      { textChunks: ['完成'], finalContent: [textBlock('完成')], usage: u2 },
    ]);
    const wire: WireEvent[] = [];
    await collect(
      runAgent({
        provider,
        system: 'sys',
        ctx: { cwd: process.cwd() },
        messages: [sm({ role: 'user', content: 'go' })],
        onWireEvent: (e) => wire.push(e),
      }),
    );

    const us = usageEvents(wire);
    expect(us).toHaveLength(2);
    expect(us.map((x) => x.stopReason)).toEqual(['tool_use', 'end_turn']);
    expect(us.map((x) => x.totalTokens)).toEqual([530, 840]);
    // 第二轮发请求时历史更长（含第一轮的 assistant + tool_result）
    expect(us[1]!.measuredLength).toBeGreaterThan(us[0]!.measuredLength);
  });

  it('model 覆盖时记的是本轮实际请求的模型（子 agent / /model 切换后不可混淆）', async () => {
    const usage = { input_tokens: 10, output_tokens: 2 } as Anthropic.Usage;
    const { provider } = makeFakeProvider([
      { textChunks: ['x'], finalContent: [textBlock('x')], usage },
    ]);
    const wire: WireEvent[] = [];
    await collect(
      runAgent({
        provider,
        system: 'sys',
        ctx: { cwd: process.cwd() },
        messages: [sm({ role: 'user', content: 'hi' })],
        model: 'step-flash-lite',
        onWireEvent: (e) => wire.push(e),
      }),
    );
    expect(usageEvents(wire)[0]!.model).toBe('step-flash-lite');
  });

  it('provider 未返回 usage → 不落假数据（宁可没有记录，也不能有编造的 0）', async () => {
    // 一条 0 tokens 的记录会被后续分析当成真实观测，比没有记录更糟。
    const { provider } = makeFakeProvider([
      { textChunks: ['无 usage'], finalContent: [textBlock('无 usage')] },
    ]);
    const wire: WireEvent[] = [];
    await collect(
      runAgent({
        provider,
        system: 'sys',
        ctx: { cwd: process.cwd() },
        messages: [sm({ role: 'user', content: 'hi' })],
        onWireEvent: (e) => wire.push(e),
      }),
    );
    expect(usageEvents(wire)).toHaveLength(0);
  });

  it('截断回合（max_tokens）同样落盘：异常轮才是最需要事后审计的', async () => {
    const usage = { input_tokens: 300, output_tokens: 65536 } as Anthropic.Usage;
    const { provider } = makeFakeProvider([
      {
        textChunks: ['半截'],
        finalContent: [textBlock('半截')],
        stopReason: 'max_tokens',
        usage,
      },
    ]);
    const wire: WireEvent[] = [];
    await collect(
      runAgent({
        provider,
        system: 'sys',
        ctx: { cwd: process.cwd() },
        messages: [sm({ role: 'user', content: '写长文' })],
        onWireEvent: (e) => wire.push(e),
      }),
    );
    const us = usageEvents(wire);
    expect(us).toHaveLength(1);
    expect(us[0]!.stopReason).toBe('max_tokens');
    expect(us[0]!.outputTokens).toBe(65536);
  });
});
