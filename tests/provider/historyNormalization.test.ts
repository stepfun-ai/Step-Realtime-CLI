import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { checkHistoryInvariants, type HistoryViolation } from '../../src/provider/historyInvariants.js';
import { withHistoryNormalization } from '../../src/provider/normalizedProvider.js';
import { normalizeHistory, projectMessages } from '../../src/provider/projector.js';
import { createProvider } from '../../src/provider/factory.js';
import { StepfunAdapter } from '../../src/provider/adapter.js';
import { AnthropicMessagesProvider } from '../../src/provider/anthropicMessages.js';
import { OpenAiChatProvider } from '../../src/provider/openaiChat.js';
import { OpenAiResponsesProvider } from '../../src/provider/openaiResponses.js';

const assistantToolUse = (id: string): Anthropic.MessageParam => ({
  role: 'assistant',
  content: [{ type: 'tool_use', id, name: 't', input: {} }],
});
const userToolResult = (id: string, text = 'r'): Anthropic.MessageParam => ({
  role: 'user',
  content: [{ type: 'tool_result', tool_use_id: id, content: text }],
});

describe('checkHistoryInvariants', () => {
  it('合法历史返回空数组', () => {
    const violations = checkHistoryInvariants([
      { role: 'user', content: '问' },
      assistantToolUse('a'),
      userToolResult('a'),
      { role: 'assistant', content: '答' },
    ]);
    expect(violations).toHaveLength(0);
  });

  it(' dangling-tool-use：有 tool_use 无配对 tool_result', () => {
    const violations = checkHistoryInvariants([
      { role: 'user', content: '问' },
      assistantToolUse('dangling'),
    ]);
    expect(violations).toEqual([
      { code: 'dangling-tool-use', detail: expect.stringContaining('dangling') },
    ]);
  });

  it('orphan-tool-result：有 tool_result 无对应 tool_use', () => {
    const violations = checkHistoryInvariants([
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'ghost', content: 'r' }],
      },
    ]);
    expect(violations).toEqual([
      { code: 'orphan-tool-result', detail: expect.stringContaining('ghost') },
    ]);
  });

  it('pairing-not-adjacent：tool_use 与 tool_result 之间插入其他消息', () => {
    const violations = checkHistoryInvariants([
      { role: 'user', content: '问' },
      assistantToolUse('x'),
      { role: 'assistant', content: '插话' },
      userToolResult('x'),
    ]);
    expect(violations.some((v) => v.code === 'pairing-not-adjacent')).toBe(true);
  });

  it('连续同 role 不算违规：内部历史的正常常态，由 normalizeHistory 合并', () => {
    const violations = checkHistoryInvariants([
      { role: 'user', content: '一' },
      { role: 'user', content: '二' },
    ]);
    expect(violations).toEqual([]);
  });

  it('并行工具结果分成连续几条纯 tool_result user 消息，仍视为同一配对组（不报不相邻）', () => {
    const violations = checkHistoryInvariants([
      { role: 'user', content: '问' },
      {
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'a', name: 't', input: {} },
          { type: 'tool_use', id: 'b', name: 't', input: {} },
        ],
      },
      userToolResult('a'),
      userToolResult('b'),
    ]);
    expect(violations).toEqual([]);
  });

  it('配对组中间夹一条带文本的 user 消息 → 报不相邻（投影到 Chat 后即严格网关 400 的形态）', () => {
    const violations = checkHistoryInvariants([
      { role: 'user', content: '问' },
      assistantToolUse('x'),
      { role: 'user', content: '插一句话' },
      userToolResult('x'),
    ]);
    expect(violations.some((v) => v.code === 'pairing-not-adjacent')).toBe(true);
  });
});

describe('normalizeHistory 协议无关不变量的行为', () => {
  it('孤儿 tool_result 丢弃 + 悬空 tool_use 合成闭合 + 合并连续同 role', () => {
    const input: Anthropic.MessageParam[] = [
      { role: 'user', content: '问' },
      assistantToolUse('keep'),
      userToolResult('keep'),
      assistantToolUse('dangling'),
      { role: 'user', content: '答' },
      { role: 'user', content: '再答' },
    ];
    const out = normalizeHistory(input);
    // dangling 已闭合
    expect(out.some((m) => (m.content as Anthropic.ContentBlockParam[]).some((b) => b.type === 'tool_result' && (b as Anthropic.ToolResultBlockParam).tool_use_id === 'dangling'))).toBe(true);
    // 连续同 role 合并：中间仍有 tool_result 的 user 消息独立存在，末两条 user 合并
    expect(out.filter((m) => m.role === 'user')).toHaveLength(3);
  });

  it('不插入空 user 开场（那是 ensureLeadingUser 的职责）', () => {
    const out = normalizeHistory([{ role: 'assistant', content: '答' }]);
    expect(out[0]!.role).toBe('assistant');
  });

  it('不改动入参数组', () => {
    const input: Anthropic.MessageParam[] = [
      { role: 'user', content: '问' },
      assistantToolUse('x'),
      userToolResult('x'),
    ];
    const before = JSON.stringify(input);
    normalizeHistory(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe('withHistoryNormalization 装饰器', () => {
  it('孤立 tool_result 不进 inner、悬空 tool_use 被合成闭合、连续同 role 合并、不插入空 user 开场', async () => {
    const captured: Anthropic.MessageParam[][] = [];
    const fakeInner = {
      maxTokens: 1024,
      stream(p: { messages: Anthropic.MessageParam[] }) {
        captured.push(p.messages);
        async function* gen() {}
        const g = gen();
        return {
          [Symbol.asyncIterator]: () => g,
          async finalMessage() {
            return { content: [], stop_reason: 'end_turn', usage: {} } as unknown as Anthropic.Message;
          },
        };
      },
    };
    const provider = withHistoryNormalization(fakeInner as unknown as Parameters<typeof withHistoryNormalization>[0]);
    const messages: Anthropic.MessageParam[] = [
      { role: 'assistant', content: '开场' },
      assistantToolUse('dangling'),
      { role: 'user', content: '一' },
      { role: 'user', content: '二' },
    ];
    const stream = provider.stream({ system: '', tools: [], messages });
    await stream.finalMessage();
    const sent = captured[0]!;
    // 不插入空 user
    expect(sent[0]!.role).toBe('assistant');
    // dangling 已闭合
    expect(sent.some((m) => (m.content as Anthropic.ContentBlockParam[]).some((b) => b.type === 'tool_result' && (b as Anthropic.ToolResultBlockParam).tool_use_id === 'dangling'))).toBe(true);
    // 连续同 role 合并
    expect(sent.filter((m) => m.role === 'user')).toHaveLength(1);
  });

  it('STEP_CODE_STRICT_HISTORY=1 时抛错；未设时只 warn 不抛', async () => {
    const fakeInner = {
      maxTokens: 1024,
      stream() {
        async function* gen() {}
        const g = gen();
        return {
          [Symbol.asyncIterator]: () => g,
          async finalMessage() {
            return { content: [], stop_reason: 'end_turn', usage: {} } as unknown as Anthropic.Message;
          },
        };
      },
    };
    const provider = withHistoryNormalization(fakeInner as unknown as Parameters<typeof withHistoryNormalization>[0]);
    // 用孤儿 tool_result 当违规样本：连续同 role 是内部历史的正常常态，不算违规
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: '问' },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'ghost', content: 'r' }] },
    ];
    // 未设环境变量：不抛
    const prev = process.env['STEP_CODE_STRICT_HISTORY'];
    process.env['STEP_CODE_STRICT_HISTORY'] = '';
    try {
      await provider.stream({ system: '', tools: [], messages }).finalMessage();
    } finally {
      process.env['STEP_CODE_STRICT_HISTORY'] = prev ?? '';
    }
    // 设环境变量：抛错
    process.env['STEP_CODE_STRICT_HISTORY'] = '1';
    try {
      expect(() => provider.stream({ system: '', tools: [], messages })).toThrow('历史不变量被破坏');
    } finally {
      process.env['STEP_CODE_STRICT_HISTORY'] = prev ?? '';
    }
  });
});

describe('factory 装配', () => {
  const base = {
    apiKey: 'k',
    baseUrl: 'https://api.stepfun.com',
    model: 'step-3.7-flash',
    maxContextSize: 1_000_000,
    maxTokens: 8192,
    subagent: { maxDepth: 1, maxSteps: 100, maxConcurrent: 4 } as const,
    compaction: { triggerRatio: 0.85, reservedTokens: 32_000 } as const,
  };

  it('stepfun 路径不重复包装（保持 StepfunAdapter）', () => {
    const p = createProvider({ ...base, provider: 'stepfun' });
    expect(p).toBeInstanceOf(StepfunAdapter);
  });

  it('openai 路径由装饰器包装', () => {
    const p = createProvider({ ...base, provider: 'openai', baseUrl: 'https://api.stepfun.com/v1' });
    // 用 withHistoryNormalization 包装后不再是原始 OpenAiChatProvider
    expect(p).not.toBeInstanceOf(OpenAiChatProvider);
    // 但仍可调用 stream
    expect(typeof p.stream).toBe('function');
  });

  it('openai_responses 路径由装饰器包装', () => {
    const p = createProvider({ ...base, provider: 'openai_responses', baseUrl: 'https://api.stepfun.com/v1' });
    expect(p).not.toBeInstanceOf(OpenAiResponsesProvider);
    expect(typeof p.stream).toBe('function');
  });

  it('anthropic 路径由装饰器包装', () => {
    const p = createProvider({ ...base, provider: 'anthropic', baseUrl: 'https://api.anthropic.com', model: 'claude-x' });
    expect(p).not.toBeInstanceOf(AnthropicMessagesProvider);
    expect(typeof p.stream).toBe('function');
  });
});
