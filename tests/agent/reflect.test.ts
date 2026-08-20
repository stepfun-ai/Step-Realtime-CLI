import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { stored, type StoredMessage } from '../../src/agent/message.js';
import type { MessageOriginKind } from '../../src/agent/message.js';
import type { ChatProvider } from '../../src/provider/types.js';
import { REFLECT_EMPTY_HISTORY, REFLECT_NO_FINDINGS, runReflect, segmentMessages } from '../../src/agent/reflect.js';
import { makeFakeProvider, textBlock } from '../helpers/fakeProvider.js';

/** 造一条指定角色/文本的 StoredMessage。 */
function msg(role: 'user' | 'assistant', text: string): StoredMessage {
  const origin: MessageOriginKind = role === 'user' ? 'user' : 'assistant';
  return stored({ role, content: text }, origin);
}

/** 捕获每次 stream 调用参数（system + 首条 user 文本）的 fake provider。 */
function capturingProvider(texts: string[]): {
  provider: ChatProvider;
  calls: { system: string; content: string }[];
} {
  const calls: { system: string; content: string }[] = [];
  let i = 0;
  const provider = {
    stream(params: {
      system: string;
      tools: Anthropic.Tool[];
      messages: Anthropic.MessageParam[];
    }) {
      const c = params.messages[0]!.content;
      calls.push({ system: params.system, content: typeof c === 'string' ? c : JSON.stringify(c) });
      const text = texts[i++] ?? '';
      async function* iter(): AsyncGenerator<Anthropic.MessageStreamEvent> {
        // 无增量事件
      }
      const gen = iter();
      return {
        [Symbol.asyncIterator]: () => gen,
        finalMessage: async () => ({ content: [{ type: 'text', text }] }) as unknown as Anthropic.Message,
      };
    },
  };
  return { provider: provider as unknown as ChatProvider, calls };
}

describe('segmentMessages', () => {
  it('按 token 预算切段：每条约 8 token', () => {
    const msgs = [msg('user', 'x'.repeat(30)), msg('assistant', 'y'.repeat(30)), msg('user', 'z'.repeat(30))];
    // 分桶估算下每条 30 个 ASCII 字符 = ceil(30/4) = 8 token
    // 预算 25：8+8+8=24 <= 25，三条同段
    expect(segmentMessages(msgs, 25)).toHaveLength(1);
    // 预算 10：8 装得下，+8=16 超预算 → 每条自成一段
    expect(segmentMessages(msgs, 10)).toHaveLength(3);
  });

  it('单条超预算仍自成一段，不拆消息', () => {
    const big = msg('user', 'x'.repeat(300)); // 75 token（300 ASCII / 4）
    expect(segmentMessages([big], 10)).toHaveLength(1);
    expect(segmentMessages([big], 10)[0]).toHaveLength(1);
  });

  it('空输入 → 空段数组', () => {
    expect(segmentMessages([], 100)).toEqual([]);
  });
});

describe('runReflect', () => {
  it('空历史 → 提示文案，不调用 provider', async () => {
    const { provider, streamCalls } = makeFakeProvider([]);
    const out = await runReflect(provider, []);
    expect(out).toContain('没有可回顾');
    expect(streamCalls()).toBe(0);
  });

  it('单段：只 map 一次、不 reduce，直接返回该段经验', async () => {
    const { provider, streamCalls } = makeFakeProvider([
      { textChunks: [], finalContent: [textBlock('经验A')] },
    ]);
    const out = await runReflect(provider, [msg('user', 'hi')], { maxTokensPerSegment: 1000 });
    expect(out).toBe('经验A');
    expect(streamCalls()).toBe(1); // 仅 map，无 reduce
  });

  it('多段：N 次 map + 1 次 reduce', async () => {
    const { provider, streamCalls } = makeFakeProvider([
      { textChunks: [], finalContent: [textBlock('经验1')] }, // map seg1
      { textChunks: [], finalContent: [textBlock('经验2')] }, // map seg2
      { textChunks: [], finalContent: [textBlock('汇总清单')] }, // reduce
    ]);
    const msgs = [msg('user', 'x'.repeat(30)), msg('assistant', 'y'.repeat(30))];
    const out = await runReflect(provider, msgs, { maxTokensPerSegment: 10 });
    expect(out).toBe('汇总清单');
    expect(streamCalls()).toBe(3);
  });

  it('map 携带滚动摘要：后一段 prompt 含前一段经验，reduce 汇总所有段', async () => {
    const { provider, calls } = capturingProvider(['经验1', '经验2', '汇总清单']);
    const msgs = [msg('user', 'x'.repeat(30)), msg('assistant', 'y'.repeat(30))];
    const out = await runReflect(provider, msgs, { maxTokensPerSegment: 10 });
    expect(out).toBe('汇总清单');
    // 第一段无先验
    expect(calls[0]!.content).not.toContain('已发现的经验');
    // 第二段携带第一段产出
    expect(calls[1]!.content).toContain('已发现的经验');
    expect(calls[1]!.content).toContain('经验1');
    // reduce 输入含分段标记
    expect(calls[2]!.content).toContain('【第 1 段】');
    expect(calls[2]!.content).toContain('【第 2 段】');
  });

  it('「本段无」空产出被过滤，不喂进 reduce', async () => {
    const { provider, streamCalls } = makeFakeProvider([
      { textChunks: [], finalContent: [textBlock('经验1')] }, // map seg1
      { textChunks: [], finalContent: [textBlock('（本段无）')] }, // map seg2 空
    ]);
    const msgs = [msg('user', 'x'.repeat(30)), msg('assistant', 'y'.repeat(30))];
    const out = await runReflect(provider, msgs, { maxTokensPerSegment: 10 });
    // 只剩 1 条有效经验 → 不 reduce，直接返回
    expect(out).toBe('经验1');
    expect(streamCalls()).toBe(2); // 2 次 map，无 reduce
  });

  it('全部段无产出 → 返回未提炼提示', async () => {
    const { provider } = makeFakeProvider([
      { textChunks: [], finalContent: [textBlock('（本段无）')] },
    ]);
    const out = await runReflect(provider, [msg('user', 'hi')], { maxTokensPerSegment: 1000 });
    expect(out).toContain('未从历史中提炼');
  });

  it('段数护栏：超过 maxSegments 截断并给出提示', async () => {
    const { provider, streamCalls } = makeFakeProvider([
      { textChunks: [], finalContent: [textBlock('经验1')] }, // map seg1
      { textChunks: [], finalContent: [textBlock('经验2')] }, // map seg2
      { textChunks: [], finalContent: [textBlock('汇总清单')] }, // reduce（仅前 2 段）
    ]);
    // 3 条各自成段（预算 10），但 maxSegments=2 → 只处理前 2 段
    const msgs = [
      msg('user', 'a'.repeat(30)),
      msg('assistant', 'b'.repeat(30)),
      msg('user', 'c'.repeat(30)),
    ];
    const out = await runReflect(provider, msgs, { maxTokensPerSegment: 10, maxSegments: 2 });
    expect(out).toContain('汇总清单');
    expect(out).toContain('共 3 段');
    expect(out).toContain('仅回顾了前 2 段');
    expect(streamCalls()).toBe(3); // 2 map + 1 reduce，第 3 段未处理
  });
});
describe('占位文案常量（App 侧 === 判断的依赖）', () => {
  it('空历史返回 REFLECT_EMPTY_HISTORY 常量本身（引用相等）', async () => {
    // App 用 === 判断要不要把产出注入会话流；若有人把返回改成同内容的新字面量，
    // 注入判断会静默失效，占位文本就被写进会话流。这里锁引用相等。
    const { provider } = makeFakeProvider([]);
    expect(await runReflect(provider, [], {})).toBe(REFLECT_EMPTY_HISTORY);
  });

  it('常量的文案保持占位形态（以（开头），UI 直出不变', () => {
    expect(REFLECT_EMPTY_HISTORY.startsWith('（')).toBe(true);
    expect(REFLECT_NO_FINDINGS.startsWith('（')).toBe(true);
  });
});
