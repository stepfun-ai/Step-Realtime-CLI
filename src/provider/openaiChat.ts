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
import { stepEffortParam } from './step/stepCommon.js';
import type { ChatProvider, ThinkingParam } from './types.js';

/** {@link OpenAiChatProvider} 构造参数。 */
export interface OpenAiChatProviderOptions {
  apiKey: string;
  /** 带 /v1 的 base_url（拼 /chat/completions）。 */
  baseUrl: string;
  model: string;
  maxTokens: number;
  /** 注入的 fetch 实现（测试用 mock）；缺省用全局 fetch。 */
  fetchImpl?: typeof fetch;
  /**
   * 是否允许下发思考控制字段（`reasoning_effort`）。默认 false。
   * 为 true 时也仅是开关打开：实际发不发还看 thinking 是否给出具体预算。
   */
  sendThinking?: boolean;
  /** 思考强度，由工厂从 [thinking] 配置注入；本类只用其中的 level（作 reasoning_effort 值）。 */
  thinking?: ThinkingParam;
  /** 模型能力：thinking 块是否回灌。默认 true（与 DEFAULT_CAPABILITY 对齐）。 */
  reasoning?: boolean;
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
  private readonly sendThinking: boolean;
  private readonly thinking?: ThinkingParam;
  private readonly reasoning: boolean;

  constructor(options: OpenAiChatProviderOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.model = options.model;
    this.maxTokens = options.maxTokens;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sendThinking = options.sendThinking ?? false;
    this.thinking = options.thinking;
    this.reasoning = options.reasoning ?? true;
  }

  stream(params: {
    system: string;
    tools: Anthropic.Tool[];
    messages: Anthropic.MessageParam[];
    signal?: AbortSignal;
    model?: string;
    /**
     * thinking 覆盖（三态）：undefined 用构造默认；对象本次覆盖；null 本次强制不发。
     *
     * Step 的 Chat Completions **有**思考控制字段：顶层 `reasoning_effort`。
     * 此前这里的注释写着「openai 协议无 thinking 请求字段，忽略此参数」并真的忽略了。
     * 2026-08-02 实测（step-3.7-flash，重任务）：不发 effort 时思考 15975 字符，
     * low 档 3248 字符——不下发等于放任思考跑到服务端默认深度。
     */
    thinking?: ThinkingParam | null;
  }): ReturnType<Anthropic['messages']['stream']> {
    const model = params.model ?? this.model;
    const body: Record<string, unknown> = {
      model,
      max_tokens: this.maxTokens,
      messages: messagesToOpenAi(params.system, params.messages, this.reasoning),
      stream: true,
      stream_options: { include_usage: true },
    };
    const tools = toolsToOpenAi(params.tools);
    if (tools.length > 0) body.tools = tools;

    // reasoning_effort：档位名直接作值；level 缺失时不发字段（不替用户猜档位）。
    const thinking = params.thinking === undefined ? this.thinking : params.thinking;
    if (this.sendThinking && thinking !== null && thinking !== undefined) {
      Object.assign(body, stepEffortParam('chat', thinking.level));
    }

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
      // 本地 AbortController 汇流两个中止源：用户 Esc（params.signal）与流空闲看门狗。
      // 看门狗触发时必须 abort fetch——Response 持有的 socket/TLS 缓冲在 V8 堆外，不取消是堆外泄漏。
      const controller = new AbortController();
      const parentSignal = params.signal;
      if (parentSignal !== undefined) {
        if (parentSignal.aborted) controller.abort(parentSignal.reason);
        else parentSignal.addEventListener('abort', () => controller.abort(parentSignal.reason), { once: true });
      }
      const res = await fetchImpl(url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        throw httpErrorToApiError(res.status, text, res.headers);
      }
      if (res.body === null) {
        throw httpErrorToApiError(502, 'empty response body', res.headers);
      }

      // 多 completion 分段（部分上游模型的行为）：一条流里可能出现多个 chunk.id，
      // 且互为前缀关系 `inner === outer + "." + <后缀>`。外层段装的是模型内部工作痕迹
      // （评审对话等），内层段才是真正的回答。判据是纯结构的，不依赖内容措辞。
      //
      // 实测形态（8/8 样本）：外层恒为流的第 1 帧且只有 1 帧，finish_reason=null，
      // 内容为纯文本、不含 tool_calls。因此无需缓冲整条流：只把第一帧暂存，
      // 等下一个不同 id 到来时判定前缀关系，即可决定第一帧的归属。这样流式输出不受影响。
      //
      // 若上游未来出现「外层多帧」或「外层带 tool_calls」的形态，需重新评估本策略。
      let pendingFirst: OpenAiStreamChunk | undefined;
      let outerId: string | undefined;
      let decided = false;

      /** 把一个 chunk 计入正文并产出流式事件（主 completion 路径）。 */
      // 工具调用块的合成流事件状态：OpenAI 协议没有 content_block 概念，tool_calls 按
      // index 增量到达。这里合成 Anthropic 同形的 content_block_start[tool_use] 与
      // input_json_delta，让上层（runTurn → UI）在参数流式期间就能挂「成形中」工具卡。
      // index 偏移 1000 避让正文/思考块（它们恒为 0）。
      const startedToolBlocks = new Set<number>();
      function* emitAsMain(chunk: OpenAiStreamChunk): Generator<Anthropic.MessageStreamEvent> {
        const choice = chunk.choices?.[0];
        if (choice?.delta !== undefined) {
          const delta = choice.delta;
          accumulator.addDelta(delta);
          if (Array.isArray(delta.tool_calls)) {
            for (const tc of delta.tool_calls) {
              const blockIndex = 1000 + (typeof tc.index === 'number' ? tc.index : 0);
              const toolId = typeof tc.id === 'string' && tc.id.length > 0 ? tc.id : `synthetic-${blockIndex}`;
              const name = tc.function?.name;
              if (typeof name === 'string' && name.length > 0 && !startedToolBlocks.has(blockIndex)) {
                startedToolBlocks.add(blockIndex);
                yield {
                  type: 'content_block_start',
                  index: blockIndex,
                  content_block: { type: 'tool_use', id: toolId, name, input: {} },
                } as unknown as Anthropic.MessageStreamEvent;
              }
              const argsFragment = tc.function?.arguments;
              if (typeof argsFragment === 'string' && argsFragment.length > 0) {
                yield {
                  type: 'content_block_delta',
                  index: blockIndex,
                  delta: { type: 'input_json_delta', partial_json: argsFragment },
                } as unknown as Anthropic.MessageStreamEvent;
              }
            }
          }
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

      /** 把一个 chunk 的内容归入 thinking（外层段路径）：不进正文、不产出 text_delta。 */
      function absorbAsOuter(chunk: OpenAiStreamChunk): void {
        const delta = chunk.choices?.[0]?.delta;
        if (delta === undefined) return;
        if (typeof delta.content === 'string') accumulator.addThinking(delta.content);
        const reasoning = delta.reasoning_content ?? delta.reasoning;
        if (typeof reasoning === 'string') accumulator.addThinking(reasoning);
        // 外层段的 finish_reason 刻意不采信：实测恒为 null，采信会覆盖主段的真实结束标志。
        if (chunk.usage !== undefined && chunk.usage !== null) accumulator.setUsage(chunk.usage);
      }

      for await (const raw of parseSseStream(res.body, { onIdle: () => controller.abort() })) {
        const chunk = raw as OpenAiStreamChunk;

        if (!decided) {
          const id = chunk.id;
          if (pendingFirst === undefined) {
            // 第一帧：暂不处理，等下一帧的 id 才能判断它是外层还是主段。
            pendingFirst = chunk;
            outerId = id;
            continue;
          }
          // 第二帧：判定前缀关系。
          decided = true;
          const isOuter =
            typeof id === 'string' &&
            typeof outerId === 'string' &&
            id.length > outerId.length &&
            id.startsWith(`${outerId}.`);
          if (isOuter) {
            absorbAsOuter(pendingFirst);
          } else {
            // 单 completion 流（绝大多数情况）：第一帧照常进正文，行为与分段前完全一致。
            yield* emitAsMain(pendingFirst);
          }
          pendingFirst = undefined;
          yield* emitAsMain(chunk);
          continue;
        }

        yield* emitAsMain(chunk);
      }

      // 只有一帧的流：没有第二帧可比对，按主段处理（不可能是外层——外层必有内层跟随）。
      if (pendingFirst !== undefined) {
        yield* emitAsMain(pendingFirst);
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
