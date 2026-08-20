import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import {
  buildSystemBlocks,
  isToolResultOnly,
  prepareMessages,
  stripInvalidThinkingBlocks,
  withToolCacheControl,
} from '../../src/provider/prepare.js';

const CC = { type: 'ephemeral' };

describe('buildSystemBlocks', () => {
  it('把 system 字符串包成带 cache_control 的单个 text block', () => {
    const blocks = buildSystemBlocks('hello');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ type: 'text', text: 'hello', cache_control: CC });
  });
});

describe('withToolCacheControl', () => {
  it('只给最后一个 tool 打 cache_control', () => {
    const tools = [
      { name: 'a', description: '', input_schema: { type: 'object' } },
      { name: 'b', description: '', input_schema: { type: 'object' } },
    ] as Anthropic.Tool[];
    const out = withToolCacheControl(tools);
    expect((out[0] as { cache_control?: unknown }).cache_control).toBeUndefined();
    expect((out[1] as { cache_control?: unknown }).cache_control).toEqual(CC);
  });

  it('空数组原样返回', () => {
    expect(withToolCacheControl([])).toEqual([]);
  });
});

describe('isToolResultOnly', () => {
  it('全是 tool_result 的 user 消息 → true', () => {
    const msg: Anthropic.MessageParam = {
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'x', content: 'r' }],
    };
    expect(isToolResultOnly(msg)).toBe(true);
  });

  it('含文本或非 user → false', () => {
    expect(isToolResultOnly({ role: 'user', content: 'hi' })).toBe(false);
    expect(
      isToolResultOnly({ role: 'assistant', content: [{ type: 'text', text: 'x' }] }),
    ).toBe(false);
  });
});

describe('prepareMessages', () => {
  it('合并相邻的纯 tool_result user 消息', () => {
    const input: Anthropic.MessageParam[] = [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'a', content: '1' }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'b', content: '2' }] },
    ];
    const out = prepareMessages(input);
    expect(out).toHaveLength(1);
    expect((out[0]!.content as unknown[]).length).toBe(2);
  });

  it('在最后一条消息的最后一个 block 注入 cache_control', () => {
    const input: Anthropic.MessageParam[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ];
    const out = prepareMessages(input);
    const content = out[0]!.content as Array<{ cache_control?: unknown }>;
    expect(content[content.length - 1]!.cache_control).toEqual(CC);
  });

  it('不改动传入的原数组', () => {
    const input: Anthropic.MessageParam[] = [
      { role: 'user', content: [{ type: 'text', text: 'hi' }] },
    ];
    const before = JSON.stringify(input);
    prepareMessages(input);
    expect(JSON.stringify(input)).toBe(before);
  });

  it('字符串 content 的消息不崩（跳过注入）', () => {
    const input: Anthropic.MessageParam[] = [{ role: 'user', content: 'plain' }];
    const out = prepareMessages(input);
    expect(out[0]).toEqual({ role: 'user', content: 'plain' });
  });
});

describe('stripInvalidThinkingBlocks / thinking 回灌防御', () => {
  const thinkingMsg = (blocks: unknown[]): Anthropic.MessageParam =>
    ({ role: 'assistant', content: blocks }) as unknown as Anthropic.MessageParam;

  it('空且无 signature 的 thinking 块被剔除，其余块保留', () => {
    const msg = thinkingMsg([
      { type: 'thinking', thinking: '', signature: '' },
      { type: 'text', text: '正文' },
    ]);
    const out = stripInvalidThinkingBlocks(msg);
    expect(out.content).toEqual([{ type: 'text', text: '正文' }]);
  });

  it('带 signature 的空 thinking 块原样保留', () => {
    const blocks = [{ type: 'thinking', thinking: '', signature: 'sig-1' }, { type: 'text', text: 'x' }];
    const out = stripInvalidThinkingBlocks(thinkingMsg(blocks));
    expect(out.content).toEqual(blocks);
  });

  it('非空 thinking 块即使无 signature 也保留（「空且无签名」才剔除）', () => {
    const blocks = [{ type: 'thinking', thinking: '有内容', signature: '' }];
    const out = stripInvalidThinkingBlocks(thinkingMsg(blocks));
    expect(out.content).toEqual(blocks);
  });

  it('user 消息与非数组 content 不处理（原引用返回）', () => {
    const userMsg: Anthropic.MessageParam = { role: 'user', content: 'hi' };
    expect(stripInvalidThinkingBlocks(userMsg)).toBe(userMsg);
  });

  it('无需剔除时返回原消息对象（浅拷贝承诺）', () => {
    const msg = thinkingMsg([{ type: 'thinking', thinking: '想', signature: 'sig' }]);
    expect(stripInvalidThinkingBlocks(msg)).toBe(msg);
  });

  it('prepareMessages 集成：历史中的空 thinking 块在回灌前被剔除', () => {
    const input: Anthropic.MessageParam[] = [
      thinkingMsg([
        { type: 'thinking', thinking: '', signature: '' },
        { type: 'thinking', thinking: '保留', signature: 'sig-9' },
        { type: 'text', text: '正文' },
      ]),
      { role: 'user', content: [{ type: 'text', text: '下一条' }] },
    ];
    const out = prepareMessages(input);
    expect(out[0]!.content).toEqual([
      { type: 'thinking', thinking: '保留', signature: 'sig-9' },
      { type: 'text', text: '正文' },
    ]);
    // 末条消息的末块仍正常注入 cache_control
    const last = out[1]!.content as Array<{ cache_control?: unknown }>;
    expect(last[last.length - 1]!.cache_control).toEqual(CC);
  });
});
