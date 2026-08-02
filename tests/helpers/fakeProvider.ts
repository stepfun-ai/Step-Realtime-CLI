import type Anthropic from '@anthropic-ai/sdk';
import type { AgentEvent } from '../../src/agent/events.js';
import type { ChatProvider } from '../../src/provider/types.js';

/** 一次 stream() 调用的脚本：要么抛错，要么产出若干文本增量并以给定 content 收尾。 */
export type Behavior =
  | { throw: unknown }
  | {
      textChunks: string[];
      /** 思考增量（在 textChunks 之前按序吐出，模拟 thinking 块先于正文）。 */
      thinkingChunks?: string[];
      finalContent: Anthropic.ContentBlock[];
      stopReason?: Anthropic.Message['stop_reason'];
      /** 本回合真实 usage（缺省即无 usage，模拟 provider 未返回）。 */
      usage?: Anthropic.Usage;
    };

/** 构造满足 runTurn/runAgent 所需最小契约的假 provider（async 迭代 + finalMessage）。 */
export function makeFakeProvider(behaviors: Behavior[]): {
  provider: ChatProvider;
  streamCalls: () => number;
  /** 历次 stream() 调用的入参快照（用于断言 model 等覆盖字段）。 */
  streamParams: () => Record<string, unknown>[];
} {
  let call = 0;
  const params: Record<string, unknown>[] = [];
  const provider = {
    stream(p: Record<string, unknown>) {
      params.push(p);
      const behavior = behaviors[call++];
      if (behavior === undefined) throw new Error('fake provider: no more behaviors');
      if ('throw' in behavior) {
        throw behavior.throw;
      }
      const b = behavior;
      async function* iter(): AsyncGenerator<Anthropic.MessageStreamEvent> {
        for (const thinking of b.thinkingChunks ?? []) {
          yield {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'thinking_delta', thinking },
          } as unknown as Anthropic.MessageStreamEvent;
        }
        for (const text of b.textChunks) {
          yield {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text },
          } as unknown as Anthropic.MessageStreamEvent;
        }
      }
      const gen = iter();
      return {
        [Symbol.asyncIterator]: () => gen,
        finalMessage: async () =>
          ({ content: b.finalContent, stop_reason: b.stopReason ?? 'end_turn', usage: b.usage }) as unknown as Anthropic.Message,
      };
    },
  };
  return { provider: provider as unknown as ChatProvider, streamCalls: () => call, streamParams: () => params };
}

export async function collect(gen: AsyncGenerator<AgentEvent>): Promise<AgentEvent[]> {
  const out: AgentEvent[] = [];
  for await (const ev of gen) out.push(ev);
  return out;
}

export function textBlock(text: string): Anthropic.ContentBlock {
  return { type: 'text', text } as Anthropic.ContentBlock;
}

export function toolUseBlock(id: string, name: string, input: unknown): Anthropic.ContentBlock {
  return { type: 'tool_use', id, name, input } as unknown as Anthropic.ContentBlock;
}

export function thinkingBlock(thinking: string, signature = 'sig-1'): Anthropic.ContentBlock {
  return { type: 'thinking', thinking, signature } as unknown as Anthropic.ContentBlock;
}
