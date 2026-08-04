import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { runAgent } from '../../src/agent/loop.js';
import { stored, type StoredMessage } from '../../src/agent/message.js';
import { collect, makeFakeProvider, textBlock } from '../helpers/fakeProvider.js';

/** 包一条 storage 消息（测试用）。 */
function sm(message: Anthropic.MessageParam): StoredMessage {
  return stored(message, { kind: 'user' });
}

const baseOpts = (
  provider: ReturnType<typeof makeFakeProvider>['provider'],
  messages: StoredMessage[],
) => ({ provider, system: 'sys', ctx: { cwd: process.cwd() }, messages });

describe('runAgent thinking 透传', () => {
  it('thinking 对象覆盖 → 透传到每次 provider.stream', async () => {
    const { provider, streamCalls, streamParams } = makeFakeProvider([
      { textChunks: ['好'], finalContent: [textBlock('好')] },
    ]);
    const events = await collect(
      runAgent({ ...baseOpts(provider, [sm({ role: 'user', content: 'hi' })]), thinking: { budgetTokens: 4096 } }),
    );
    expect(events.at(-1)!.type).toBe('turn_done');
    expect(streamCalls()).toBe(1);
    expect(streamParams()[0]!['thinking']).toEqual({ budgetTokens: 4096 });
  });

  it('thinking null（/think off）→ 原样透传 null（provider 层负责抑制）', async () => {
    const { provider, streamParams } = makeFakeProvider([
      { textChunks: ['好'], finalContent: [textBlock('好')] },
    ]);
    await collect(
      runAgent({ ...baseOpts(provider, [sm({ role: 'user', content: 'hi' })]), thinking: null }),
    );
    expect(streamParams()[0]!['thinking']).toBeNull();
  });

  it('不传 thinking → stream 入参 thinking 为 undefined（provider 用构造默认）', async () => {
    const { provider, streamParams } = makeFakeProvider([
      { textChunks: ['好'], finalContent: [textBlock('好')] },
    ]);
    await collect(runAgent(baseOpts(provider, [sm({ role: 'user', content: 'hi' })])));
    expect(streamParams()[0]!['thinking']).toBeUndefined();
  });

  it('多回合（工具调用续轮）：每回合 stream 都带同一 thinking 覆盖', async () => {
    const { provider, streamCalls, streamParams } = makeFakeProvider([
      {
        textChunks: [],
        finalContent: [
          { type: 'tool_use', id: 'c1', name: 'nonexistent_tool', input: {} } as unknown as Anthropic.ContentBlock,
        ],
      },
      { textChunks: ['完成'], finalContent: [textBlock('完成')] },
    ]);
    const events = await collect(
      runAgent({ ...baseOpts(provider, [sm({ role: 'user', content: 'go' })]), thinking: { budgetTokens: 1024 } }),
    );
    expect(events.at(-1)!.type).toBe('turn_done');
    expect(streamCalls()).toBe(2);
    expect(streamParams()[0]!['thinking']).toEqual({ budgetTokens: 1024 });
    expect(streamParams()[1]!['thinking']).toEqual({ budgetTokens: 1024 });
  });
});
