import type Anthropic from '@anthropic-ai/sdk';
import type { AgentEvent } from '../../src/agent/events.js';
import type { ChatProvider } from '../../src/provider/types.js';

/** 一次 stream() 调用的脚本：要么抛错，要么产出若干文本增量并以给定 content 收尾。 */
export type Behavior =
  | { throw: unknown }
  | {
      textChunks: string[];
      /**
       * 思考增量（在 textChunks 之前按序吐出，模拟 thinking 块先于正文）。
       * 给出（含空数组）即按协议包一层 content_block_start[thinking] → …deltas… →
       * signature_delta → content_block_stop；空数组即「无痕思考」（只吐 signature 的模型）。
       */
      thinkingChunks?: string[];
      /**
       * 模拟工具调用的参数流式：先吐 content_block_start[tool_use]，再逐段吐
       * input_json_delta（半截 JSON）。配 finalContent 里的 tool_use 块组成完整回合。
       */
      toolCallStream?: { id: string; name: string; argChunks: string[] };
      /**
       * 吐完上述增量后在 finalMessage 阶段抛错——模拟「流式正文中途连接中断」
       * （ECONNRESET / terminated）：正文已进 UI，但流未正常收尾。与 `{ throw }` 不同，
       * 后者在 stream() 调用时同步抛（连第一个增量都没产出），覆盖不了「吐字后断连」。
       */
      throwAfterChunks?: unknown;
      finalContent: Anthropic.ContentBlock[];
      stopReason?: Anthropic.Message['stop_reason'];
      /** 本回合真实 usage（缺省即无 usage，模拟 provider 未返回）。 */
      usage?: Anthropic.Usage;
    };

/** 构造满足 runTurn/runAgent 所需最小契约的假 provider（async 迭代 + finalMessage）。 */
export function makeFakeProvider(
  behaviors: Behavior[],
  /**
   * 单次响应输出上限。真实 provider 恒有此值（config 的 max_tokens 有默认值 65536），
   * 空响应诊断要靠「outputTokens / maxTokens」的比值区分「预算烧光」与「正常结束无正文」，
   * 需要覆盖该判据的测试必须显式给这个值。
   */
  maxTokens?: number,
): {
  provider: ChatProvider;
  streamCalls: () => number;
  /** 历次 stream() 调用的入参快照（用于断言 model 等覆盖字段）。 */
  streamParams: () => Record<string, unknown>[];
} {
  let call = 0;
  const params: Record<string, unknown>[] = [];
  const provider = {
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    stream(p: Record<string, unknown>) {
      params.push(p);
      const behavior = behaviors[call++];
      if (behavior === undefined) throw new Error('fake provider: no more behaviors');
      if ('throw' in behavior) {
        throw behavior.throw;
      }
      const b = behavior;
      async function* iter(): AsyncGenerator<Anthropic.MessageStreamEvent> {
        if (b.thinkingChunks !== undefined) {
          yield {
            type: 'content_block_start',
            index: 0,
            content_block: { type: 'thinking', thinking: '', signature: '' },
          } as unknown as Anthropic.MessageStreamEvent;
          for (const thinking of b.thinkingChunks) {
            yield {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'thinking_delta', thinking },
            } as unknown as Anthropic.MessageStreamEvent;
          }
          yield {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'signature_delta', signature: 'sig-1' },
          } as unknown as Anthropic.MessageStreamEvent;
          yield { type: 'content_block_stop', index: 0 } as unknown as Anthropic.MessageStreamEvent;
        }
        for (const text of b.textChunks) {
          yield {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text },
          } as unknown as Anthropic.MessageStreamEvent;
        }
        if (b.toolCallStream !== undefined) {
          const ts = b.toolCallStream;
          yield {
            type: 'content_block_start',
            index: 1,
            content_block: { type: 'tool_use', id: ts.id, name: ts.name, input: {} },
          } as unknown as Anthropic.MessageStreamEvent;
          for (const partial of ts.argChunks) {
            yield {
              type: 'content_block_delta',
              index: 1,
              delta: { type: 'input_json_delta', partial_json: partial },
            } as unknown as Anthropic.MessageStreamEvent;
          }
          yield { type: 'content_block_stop', index: 1 } as unknown as Anthropic.MessageStreamEvent;
        }
      }
      const gen = iter();
      return {
        [Symbol.asyncIterator]: () => gen,
        finalMessage: async () => {
          if (b.throwAfterChunks !== undefined) throw b.throwAfterChunks;
          return { content: b.finalContent, stop_reason: b.stopReason ?? 'end_turn', usage: b.usage } as unknown as Anthropic.Message;
        },
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
