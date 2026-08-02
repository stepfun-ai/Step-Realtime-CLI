import type Anthropic from '@anthropic-ai/sdk';
import { VERSION } from '../version.js';
import {
  httpErrorToApiError,
  messagesToOpenAi,
  OpenAiChatAccumulator,
  type OpenAiStreamChunk,
  parseSseStream,
  toolsToOpenAi,
} from './openaiCommon.js';
import type { ChatProvider } from './types.js';

/** {@link OpenAiChatProvider} 构造参数。 */
export interface OpenAiChatProviderOptions {
  apiKey: string;
  /** 带 /v1 的 base_url（拼 /chat/completions）。 */
  baseUrl: string;
  model: string;
  maxTokens: number;
  /** 注入的 fetch 实现（测试用 mock）；缺省用全局 fetch。 */
  fetchImpl?: typeof fetch;
}

/**
 * OpenAI Chat Completions 协议 provider（/v1/chat/completions）。
 *
 * 协议适配器：请求侧把 Anthropic 形状的 system/tools/messages 翻译成 OpenAI 形状，
 * 响应侧 fetch 流式 + 手写 SSE 解析，把 delta.content→text_delta 事件、
 * delta.reasoning_content→thinking_delta 事件吐出，finalMessage() 返回 Anthropic.Message 形状。
 * 消费方（runTurn/loop/compaction/TUI）零改动。
 *
 * 不引入 openai SDK：用 fetch + parseSseStream 实现更轻，鉴权走 Authorization: Bearer。
 * thinking：阶跃恒思考，请求不发 thinking 字段（非标准 OpenAI 字段）；[thinking] 的 budget 语义
 * 只对 anthropic 有效，openai 下由工厂忽略。
 */
export class OpenAiChatProvider implements ChatProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  readonly maxTokens: number;
  private readonly fetchImpl: typeof fetch;

  constructor(options: OpenAiChatProviderOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.model = options.model;
    this.maxTokens = options.maxTokens;
    this.fetchImpl = options.fetchImpl ?? fetch;
  }

  stream(params: {
    system: string;
    tools: Anthropic.Tool[];
    messages: Anthropic.MessageParam[];
    signal?: AbortSignal;
    model?: string;
    /** thinking 覆盖：openai 协议无 thinking 请求字段，忽略此参数（仅为对齐 ChatProvider 签名）。 */
    thinking?: { budgetTokens?: number } | null;
  }): ReturnType<Anthropic['messages']['stream']> {
    const model = params.model ?? this.model;
    const body: Record<string, unknown> = {
      model,
      max_tokens: this.maxTokens,
      messages: messagesToOpenAi(params.system, params.messages),
      stream: true,
      stream_options: { include_usage: true },
    };
    const tools = toolsToOpenAi(params.tools);
    if (tools.length > 0) body.tools = tools;

    const accumulator = new OpenAiChatAccumulator();
    const fetchImpl = this.fetchImpl;
    const url = `${this.baseUrl}/chat/completions`;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      authorization: `Bearer ${this.apiKey}`,
      // 自报家门：诚实标识客户端与版本（不伪装任何官方客户端），便于上游识别与归因。
      'user-agent': `step-code/${VERSION}`,
    };

    // Anthropic 风格的事件流：for await 吐 content_block_delta（text_delta/thinking_delta）。
    async function* iterate(): AsyncGenerator<Anthropic.MessageStreamEvent> {
      const res = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        ...(params.signal !== undefined ? { signal: params.signal } : {}),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw httpErrorToApiError(res.status, text, res.headers);
      }
      if (res.body === null) {
        throw httpErrorToApiError(502, 'empty response body', res.headers);
      }
      for await (const raw of parseSseStream(res.body)) {
        const chunk = raw as OpenAiStreamChunk;
        const choice = chunk.choices?.[0];
        if (choice?.delta !== undefined) {
          const delta = choice.delta;
          accumulator.addDelta(delta);
          const reasoning = delta.reasoning_content ?? delta.reasoning;
          if (typeof reasoning === 'string' && reasoning.length > 0) {
            yield {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'thinking_delta', thinking: reasoning },
            } as unknown as Anthropic.MessageStreamEvent;
          }
          if (typeof delta.content === 'string' && delta.content.length > 0) {
            yield {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: delta.content },
            } as unknown as Anthropic.MessageStreamEvent;
          }
        }
        if (choice?.finish_reason !== undefined && choice.finish_reason !== null) {
          accumulator.setFinishReason(choice.finish_reason);
        }
        if (chunk.usage !== undefined && chunk.usage !== null) {
          accumulator.setUsage(chunk.usage);
        }
      }
    }

    // 共享一个 generator 实例：for await 与 finalMessage() 都消费它；
    // finalMessage() 若被单独 await（流未迭代），先把剩余事件 drain 完再 build。
    const gen = iterate();
    let drained = false;
    const drain = async (): Promise<void> => {
      if (drained) return;
      // eslint-disable-next-line no-empty
      for await (const _ of gen) {
        /* 消费剩余事件以完成累积 */
      }
      drained = true;
    };

    const streamLike = {
      [Symbol.asyncIterator](): AsyncGenerator<Anthropic.MessageStreamEvent> {
        // 迭代结束即视为已 drain（runTurn 恒先 for await 再 finalMessage）
        const inner = gen;
        return {
          async next(...args: [] | [undefined]) {
            const r = await inner.next(...args);
            if (r.done === true) drained = true;
            return r;
          },
          async return(value?: unknown) {
            drained = true;
            return inner.return(value as never);
          },
          async throw(e?: unknown) {
            return inner.throw(e);
          },
          [Symbol.asyncIterator]() {
            return this;
          },
        } as AsyncGenerator<Anthropic.MessageStreamEvent>;
      },
      async finalMessage(): Promise<Anthropic.Message> {
        await drain();
        return accumulator.build(model);
      },
    };
    return streamLike as unknown as ReturnType<Anthropic['messages']['stream']>;
  }
}
