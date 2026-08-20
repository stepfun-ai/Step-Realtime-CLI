import type Anthropic from '@anthropic-ai/sdk';
import {
  httpErrorToApiError,
  mapUsage,
  type OpenAiUsage,
  parseSseStream,
  parseToolArguments,
} from './openaiCommon.js';
import { mapStepResponsesStatus, stepEffortParam } from './step/stepCommon.js';
import type { ChatProvider, ThinkingParam } from './types.js';

/** {@link OpenAiResponsesProvider} 构造参数。 */
export interface OpenAiResponsesProviderOptions {
  apiKey: string;
  /** 带 /v1 的 base_url（拼 /responses）。 */
  baseUrl: string;
  model: string;
  maxTokens: number;
  /** 注入的 fetch 实现（测试用 mock）；缺省用全局 fetch。 */
  fetchImpl?: typeof fetch;
  /**
   * 是否允许下发思考控制字段（`reasoning.effort`）。默认 false。
   * 为 true 时也仅是开关打开：实际发不发还看 thinking 是否给出具体预算。
   */
  sendThinking?: boolean;
  /** 思考强度，由工厂从 [thinking] 配置注入；本类只用其中的 level（作 reasoning.effort 值）。 */
  thinking?: ThinkingParam;
}

/** Responses API 的多模态 content part（user 消息含图片时升级为数组形态）。 */
interface ResponsesContentPart {
  type: 'input_text' | 'input_image';
  text?: string;
  /** input_image 用 data URI；Responses 的字段名是 image_url 的字符串直挂，不是对象。 */
  image_url?: string;
}

/** Responses API 的一条对话 input 项（role + 内容；含图片时为 parts 数组）。 */
interface ResponsesMessageItem {
  role: 'system' | 'user' | 'assistant';
  content: string | ResponsesContentPart[];
}

/** Responses API 的一次工具调用 input 项（回灌 assistant 的 tool_use 用）。 */
interface ResponsesFunctionCallItem {
  type: 'function_call';
  name: string;
  call_id: string;
  /** 入参 JSON 字符串（协议要求字符串，不是对象）。 */
  arguments: string;
}

/** Responses API 的一条工具结果 input 项（回灌 user 的 tool_result 用）。 */
interface ResponsesFunctionCallOutputItem {
  type: 'function_call_output';
  call_id: string;
  output: string;
}

type ResponsesInputItem =
  | ResponsesMessageItem
  | ResponsesFunctionCallItem
  | ResponsesFunctionCallOutputItem;

/** Responses API 的一个工具定义：字段平铺在 item 上，不像 Chat 那样嵌在 function 里。 */
interface ResponsesTool {
  type: 'function';
  name: string;
  description?: string;
  parameters?: Record<string, unknown>;
}

/** Anthropic.Tool[] → Responses 平铺工具定义数组（input_schema → parameters）。 */
export function toolsToResponses(tools: Anthropic.Tool[]): ResponsesTool[] {
  return tools.map((tool) => {
    const out: ResponsesTool = {
      type: 'function',
      name: tool.name,
      parameters: (tool.input_schema ?? {}) as Record<string, unknown>,
    };
    if (typeof tool.description === 'string' && tool.description.length > 0) {
      out.description = tool.description;
    }
    return out;
  });
}

/** 把 Anthropic content block 数组里的纯文本拼接成一个字符串（忽略非文本块）。 */
function blocksToText(content: Anthropic.ContentBlockParam[]): string {
  const parts: string[] = [];
  for (const block of content) {
    if (block.type === 'text') parts.push(block.text);
  }
  return parts.join('');
}

/** tool_result 块的 content 折成纯文本（string 原样；数组取其中 text 块拼接）。 */
function toolResultText(block: Anthropic.ToolResultBlockParam): string {
  const c = block.content;
  if (c === undefined) return '';
  if (typeof c === 'string') return c;
  const parts: string[] = [];
  for (const part of c) {
    if (part.type === 'text') parts.push(part.text);
  }
  return parts.join('');
}

/**
 * 把 Anthropic 请求（system + messages）翻译成 Responses 的 input 数组。
 *
 * 工具往返在 Responses 里不用 Chat 那种 role:'tool' 消息，而是两种独立 item 靠 call_id 关联：
 * assistant 的 tool_use → {type:'function_call'}、user 的 tool_result → {type:'function_call_output'}。
 * tool_use.id 即 call_id，因此回灌链路只要 build 侧取的是权威 call_id 就自然对得上。
 * thinking 块不回传（服务端不接受回灌 reasoning）。
 */
export function messagesToResponsesInput(
  system: string,
  messages: Anthropic.MessageParam[],
): ResponsesInputItem[] {
  const out: ResponsesInputItem[] = [];
  if (system.length > 0) out.push({ role: 'system', content: system });

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      out.push({ role: msg.role, content: msg.content });
      continue;
    }
    const blocks = msg.content;
    if (msg.role === 'user') {
      const toolResults = blocks.filter(
        (b): b is Anthropic.ToolResultBlockParam => b.type === 'tool_result',
      );
      const nonTool = blocks.filter((b) => b.type !== 'tool_result');
      const nonToolText = blocksToText(nonTool);
      // user 图片块不能丢（与 messagesToOpenAi 同修，2026-08-12 实录：openai 系通道
      // user 消息图片被静默吃掉）。有图片时 content 升级为 input_text/input_image 数组。
      const imageParts: ResponsesContentPart[] = [];
      for (const b of nonTool) {
        if (b.type === 'image' && b.source.type === 'base64') {
          imageParts.push({
            type: 'input_image',
            image_url: `data:${b.source.media_type};base64,${b.source.data}`,
          });
        }
      }
      // function_call_output 在前、文本 user 在后：与 messagesToOpenAi 同一顺序约定——
      // 整形层会把合成/迟到的 tool_result 与插话文本合进同一条 user 消息，
      // 输出项先发出能保证工具配对在 input 序列上保持「调用紧邻结果」的形态。
      for (const tr of toolResults) {
        out.push({
          type: 'function_call_output',
          call_id: tr.tool_use_id,
          output: toolResultText(tr),
        });
      }
      if (imageParts.length > 0) {
        const parts: ResponsesContentPart[] = [];
        if (nonToolText.length > 0) parts.push({ type: 'input_text', text: nonToolText });
        parts.push(...imageParts);
        out.push({ role: 'user', content: parts });
      } else if (nonToolText.length > 0 || toolResults.length === 0) {
        // 无工具结果时即使正文为空也要留一条 user 项，保持对话轮次完整
        out.push({ role: 'user', content: nonToolText });
      }
      continue;
    }
    // assistant：正文与工具调用各自成项，正文在前
    const text = blocksToText(blocks);
    if (text.length > 0) out.push({ role: 'assistant', content: text });
    for (const block of blocks) {
      if (block.type !== 'tool_use') continue;
      out.push({
        type: 'function_call',
        name: block.name,
        call_id: block.id,
        arguments: JSON.stringify(block.input ?? {}),
      });
    }
  }
  return out;
}

/**
 * OpenAI Responses 协议 provider（/v1/responses），流式，支持工具调用。
 *
 * 请求侧把 Anthropic 形状的 system/tools/messages 翻译成 Responses 形状（tools 平铺、
 * 工具往返用 function_call / function_call_output 两类 input 项）；响应侧 fetch 流式 +
 * 手写 SSE 解析，把 reasoning_text.delta→thinking_delta、output_text.delta→text_delta 吐出。
 *
 * finalMessage() 一律从 `response.completed` 事件带回的完整 response 对象重建，不用流式中间
 * 事件累积：实测流式 output_item.added 给的 call_id 与 response.completed 里同一调用的 call_id
 * 不是同一个值，只有后者能用于工具结果回灌，取错则下一轮 call_id 对不上。中间事件因此只负责
 * 产出增量、不参与最终形状。
 */
export class OpenAiResponsesProvider implements ChatProvider {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  readonly maxTokens: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sendThinking: boolean;
  private readonly thinking?: ThinkingParam;

  constructor(options: OpenAiResponsesProviderOptions) {
    this.apiKey = options.apiKey;
    this.baseUrl = options.baseUrl.replace(/\/$/, '');
    this.model = options.model;
    this.maxTokens = options.maxTokens;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.sendThinking = options.sendThinking ?? false;
    this.thinking = options.thinking;
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
     * Responses 协议**有**思考控制字段：`reasoning: { effort }`。此前这里的注释写着
     * 「协议无 thinking 请求字段，忽略此参数」并真的忽略了，导致用户配的档位在本通道
     * 完全不生效、思考深度只由服务端默认值决定。2026-08-02 实测 effort 单调生效
     * （low/medium/high 思考量递增），故改为按档位下发。
     */
    thinking?: ThinkingParam | null;
  }): ReturnType<Anthropic['messages']['stream']> {
    const model = params.model ?? this.model;
    const body: Record<string, unknown> = {
      model,
      input: messagesToResponsesInput(params.system, params.messages),
      max_output_tokens: this.maxTokens,
      stream: true,
    };
    const tools = toolsToResponses(params.tools);
    if (tools.length > 0) body['tools'] = tools;

    // reasoning.effort：档位名直接作值；level 缺失时不发字段（不替用户猜档位）。
    const thinking = params.thinking === undefined ? this.thinking : params.thinking;
    if (this.sendThinking && thinking !== null && thinking !== undefined) {
      Object.assign(body, stepEffortParam('responses', thinking.level));
    }

    const fetchImpl = this.fetchImpl;
    const url = `${this.baseUrl}/responses`;
    const headers: Record<string, string> = {
      'content-type': 'application/json',
      authorization: `Bearer ${this.apiKey}`,
    };
    const maxTokens = this.maxTokens;

    // 最终 response 对象（response.completed 的权威值）；未收到时用 undefined 兜底为空消息。
    let completed: ResponsesResponse | undefined;

    async function* iterate(): AsyncGenerator<Anthropic.MessageStreamEvent> {
      // 本地 AbortController 汇流用户 Esc 与流空闲看门狗两个中止源（同 openaiChat）。
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
        const errText = await res.text().catch(() => '');
        throw httpErrorToApiError(res.status, errText, res.headers);
      }
      if (res.body === null) {
        throw httpErrorToApiError(502, 'empty response body', res.headers);
      }
      for await (const raw of parseSseStream(res.body, { onIdle: () => controller.abort() })) {
        const event = raw as ResponsesStreamEvent;
        if (event.type === 'response.reasoning_text.delta') {
          if (typeof event.delta === 'string' && event.delta.length > 0) {
            yield {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'thinking_delta', thinking: event.delta },
            } as unknown as Anthropic.MessageStreamEvent;
          }
        } else if (event.type === 'response.output_text.delta') {
          if (typeof event.delta === 'string' && event.delta.length > 0) {
            yield {
              type: 'content_block_delta',
              index: 0,
              delta: { type: 'text_delta', text: event.delta },
            } as unknown as Anthropic.MessageStreamEvent;
          }
        } else if (event.type === 'response.completed' || event.type === 'response.incomplete') {
          if (event.response !== undefined && event.response !== null) completed = event.response;
        }
      }
    }

    // 共享一个 generator 实例：for await 与 finalMessage() 都消费它；
    // finalMessage() 若被单独 await（流未迭代），先把剩余事件 drain 完再 build。
    const gen = iterate();
    let drained = false;
    const drain = async (): Promise<void> => {
      if (drained) return;
      for await (const _ of gen) {
        /* 消费剩余事件以拿到 response.completed */
      }
      drained = true;
    };

    const streamLike = {
      [Symbol.asyncIterator](): AsyncGenerator<Anthropic.MessageStreamEvent> {
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
        return buildResponsesMessage(completed ?? {}, model, maxTokens);
      },
    };
    return streamLike as unknown as ReturnType<Anthropic['messages']['stream']>;
  }
}

/** Responses API 响应形状（宽松：容忍缺字段）。 */
interface ResponsesResponse {
  output?: ResponsesOutputItem[];
  usage?: OpenAiResponsesUsage | null;
  /**
   * 响应级状态：`completed` / `incomplete` / `failed`（另有 in_progress 等中间态）。
   * 此前本接口未声明该字段，因此代码读不到、`incomplete` 被当成正常结束。
   */
  status?: string;
  /**
   * 未完成详情，仅在 `status=incomplete` 时非空。Step 文档称常见
   * `{ reason: 'max_output_tokens' }`，官方另有 `content_filter`。
   */
  incomplete_details?: { reason?: string } | null;
  /** 错误信息，仅在 `status=failed` 时非空。 */
  error?: { message?: string; type?: string; code?: string } | null;
}

/** output 数组里的一项：reasoning / message / function_call 三类共用宽松形状。 */
interface ResponsesOutputItem {
  type?: string;
  content?: Array<{ type?: string; text?: string }>;
  /** function_call 项：工具名。 */
  name?: string;
  /** function_call 项：入参 JSON 字符串。 */
  arguments?: string;
  /** function_call 项：回灌用的关联 id（与 item 自身的 id 不同，不能混用）。 */
  call_id?: string;
  id?: string;
}

/** Responses 流式事件形状（宽松：只取本适配器用到的字段）。 */
interface ResponsesStreamEvent {
  type?: string;
  delta?: string;
  response?: ResponsesResponse | null;
}

interface OpenAiResponsesUsage {
  input_tokens?: number;
  output_tokens?: number;
  input_tokens_details?: { cached_tokens?: number };
}

/**
 * 把 Responses 的 output 数组组装成 Anthropic.Message
 * （reasoning→thinking、message→text、function_call→tool_use）。
 * tool_use.id 取 call_id 而非 item 的 id：只有 call_id 能在下一轮 function_call_output 里关联上。
 */
export function buildResponsesMessage(
  json: ResponsesResponse,
  model: string,
  _maxTokens: number,
): Anthropic.Message {
  let thinking = '';
  let text = '';
  const toolUses: Anthropic.ContentBlock[] = [];
  for (const item of json.output ?? []) {
    if (item.type === 'reasoning') {
      for (const c of item.content ?? []) {
        if (c.type === 'reasoning_text' && typeof c.text === 'string') thinking += c.text;
      }
    } else if (item.type === 'message') {
      for (const c of item.content ?? []) {
        if (c.type === 'output_text' && typeof c.text === 'string') text += c.text;
      }
    } else if (item.type === 'function_call') {
      toolUses.push({
        type: 'tool_use',
        id: item.call_id ?? item.id ?? '',
        name: item.name ?? '',
        input: parseToolArguments(item.arguments ?? ''),
      } as unknown as Anthropic.ContentBlock);
    }
  }
  const content: Anthropic.ContentBlock[] = [];
  if (thinking.length > 0) {
    content.push({ type: 'thinking', thinking, signature: '' } as unknown as Anthropic.ContentBlock);
  }
  if (text.length > 0) {
    content.push({ type: 'text', text, citations: null } as unknown as Anthropic.ContentBlock);
  }
  content.push(...toolUses);
  return {
    id: '',
    type: 'message',
    role: 'assistant',
    model,
    content,
    // status + incomplete_details.reason → stop_reason。此前写死 tool_use / end_turn 二选一，
    // 完全不读 status：`incomplete`（预算耗尽被切断，output 常为空）被当成正常收尾，
    // 空响应就此被无声吞掉。Responses 的 status 是响应级状态，真正对应停止原因的是
    // incomplete_details.reason。
    stop_reason: mapStepResponsesStatus(json.status, json.incomplete_details?.reason, toolUses.length > 0),
    stop_sequence: null,
    usage: json.usage != null ? mapResponsesUsage(json.usage) : emptyUsage(),
  } as unknown as Anthropic.Message;
}

/** Responses usage（input_tokens/output_tokens）→ Anthropic.Usage，复用 Chat 的 mapUsage 语义。 */
function mapResponsesUsage(usage: OpenAiResponsesUsage): Anthropic.Usage {
  const shim: OpenAiUsage = {
    prompt_tokens: usage.input_tokens ?? 0,
    completion_tokens: usage.output_tokens ?? 0,
  };
  const cached = usage.input_tokens_details?.cached_tokens;
  if (typeof cached === 'number') shim.prompt_tokens_details = { cached_tokens: cached };
  return mapUsage(shim);
}

function emptyUsage(): Anthropic.Usage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  } as unknown as Anthropic.Usage;
}
