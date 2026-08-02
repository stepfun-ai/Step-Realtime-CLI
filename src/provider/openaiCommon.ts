import Anthropic from '@anthropic-ai/sdk';

/**
 * OpenAI 协议适配层的共享纯函数：请求侧把 Anthropic 形状翻译成 OpenAI 形状，
 * 响应侧把 OpenAI Chat 的增量（delta）累积并折算成 Anthropic.Message 形状，
 * 以及把 HTTP 错误包成 Anthropic.APIError（让 runTurn 的重试/限流/溢出分类零改动生效）。
 *
 * 设计原则：消费方（runTurn/loop/compaction/TUI）已深度绑定 Anthropic 形状，
 * 因此归一化目标是 Anthropic 形状，翻译全部封闭在 provider 内部。
 */

// ============ 请求侧翻译：Anthropic → OpenAI ============

/** OpenAI Chat 的一条 message（role 决定形状；tool 消息带 tool_call_id）。 */
export interface OpenAiMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  /** 文本内容；assistant 纯工具调用时可为 null。 */
  content?: string | null;
  /** assistant 的工具调用列表（tool_use 块翻译而来）。 */
  tool_calls?: OpenAiToolCall[];
  /** tool 消息回指的工具调用 id（tool_result 块的 tool_use_id）。 */
  tool_call_id?: string;
}

/** OpenAI Chat 的一次工具调用（function 型）。 */
export interface OpenAiToolCall {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

/** OpenAI Chat 的一个工具定义（function 型）。 */
export interface OpenAiTool {
  type: 'function';
  function: { name: string; description?: string; parameters?: Record<string, unknown> };
}

/** Anthropic.Tool[] → OpenAI function 工具定义数组。 */
export function toolsToOpenAi(tools: Anthropic.Tool[]): OpenAiTool[] {
  return tools.map((tool) => {
    const fn: OpenAiTool['function'] = {
      name: tool.name,
      parameters: (tool.input_schema ?? {}) as Record<string, unknown>,
    };
    if (typeof tool.description === 'string' && tool.description.length > 0) {
      fn.description = tool.description;
    }
    return { type: 'function', function: fn };
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
 * 把 Anthropic 请求（system + messages）翻译成 OpenAI Chat 的 messages 数组：
 * - system 非空 → messages[0] 的 {role:'system'}。
 * - user 消息：string 内容原样；数组内容里 tool_result 块各自展开为一条 {role:'tool'} 消息，
 *   其余文本块合并成一条 {role:'user'}（顺序：先文本 user，再各 tool——但 Anthropic 里
 *   tool_result 恒独占 user 消息，故实践中不会混排）。
 * - assistant 消息：text 块合并为 content，tool_use 块展开为 tool_calls；thinking 块忽略
 *   （OpenAI 不接受回传 reasoning）。
 */
export function messagesToOpenAi(
  system: string,
  messages: Anthropic.MessageParam[],
): OpenAiMessage[] {
  const out: OpenAiMessage[] = [];
  if (system.length > 0) out.push({ role: 'system', content: system });

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      out.push({ role: msg.role, content: msg.content });
      continue;
    }
    const blocks = msg.content;
    if (msg.role === 'user') {
      // tool_result 块各自成一条 tool 消息；其余文本另组一条 user 消息。
      const toolResults = blocks.filter(
        (b): b is Anthropic.ToolResultBlockParam => b.type === 'tool_result',
      );
      const nonToolText = blocksToText(
        blocks.filter((b) => b.type !== 'tool_result') as Anthropic.ContentBlockParam[],
      );
      if (nonToolText.length > 0 || toolResults.length === 0) {
        out.push({ role: 'user', content: nonToolText });
      }
      for (const tr of toolResults) {
        out.push({ role: 'tool', tool_call_id: tr.tool_use_id, content: toolResultText(tr) });
      }
      continue;
    }
    // assistant：文本 + 工具调用
    const text = blocksToText(blocks as Anthropic.ContentBlockParam[]);
    const toolUses = blocks.filter(
      (b): b is Anthropic.ToolUseBlockParam => b.type === 'tool_use',
    );
    const assistant: OpenAiMessage = { role: 'assistant' };
    if (toolUses.length > 0) {
      assistant.tool_calls = toolUses.map((tu) => ({
        id: tu.id,
        type: 'function',
        function: { name: tu.name, arguments: JSON.stringify(tu.input ?? {}) },
      }));
      // 纯工具调用轮 content 用 null（OpenAI 约定），有正文则带正文
      assistant.content = text.length > 0 ? text : null;
    } else {
      assistant.content = text;
    }
    out.push(assistant);
  }
  return out;
}

// ============ 响应侧累积：OpenAI delta → Anthropic.Message ============

/** 累积一次工具调用的增量（arguments 分片拼接）。 */
interface ToolCallAccumulator {
  id: string;
  name: string;
  arguments: string;
}

/**
 * 累积 OpenAI Chat 流式响应（或非流式的一次性 message），产出 Anthropic.Message 形状。
 * 消费方只读 content / usage / stop_reason，故只需精确还原这三者。
 */
export class OpenAiChatAccumulator {
  private text = '';
  private thinking = '';
  private readonly toolCalls = new Map<number, ToolCallAccumulator>();
  private finishReason: string | null = null;
  private usage: Anthropic.Usage | undefined;

  /** 累积一个 choices[0].delta（流式）。 */
  addDelta(delta: OpenAiStreamDelta): void {
    if (typeof delta.content === 'string') this.text += delta.content;
    // 思考：reasoning_content 与 reasoning 同值，取任一非空者（避免重复累加）
    const reasoning = delta.reasoning_content ?? delta.reasoning;
    if (typeof reasoning === 'string') this.thinking += reasoning;
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const index = typeof tc.index === 'number' ? tc.index : 0;
        const acc = this.toolCalls.get(index) ?? { id: '', name: '', arguments: '' };
        if (typeof tc.id === 'string' && tc.id.length > 0) acc.id = tc.id;
        if (tc.function !== undefined && tc.function !== null) {
          if (typeof tc.function.name === 'string' && tc.function.name.length > 0) {
            acc.name = tc.function.name;
          }
          if (typeof tc.function.arguments === 'string') acc.arguments += tc.function.arguments;
        }
        this.toolCalls.set(index, acc);
      }
    }
  }

  /** 记录本次 chunk 的 finish_reason（末尾 chunk 才有）。 */
  setFinishReason(reason: string | null | undefined): void {
    if (typeof reason === 'string') this.finishReason = reason;
  }

  /** 记录 usage（stream_options.include_usage 的末尾 chunk 才有）。 */
  setUsage(usage: OpenAiUsage | undefined | null): void {
    if (usage === undefined || usage === null) return;
    this.usage = mapUsage(usage);
  }

  /** 是否已累积到任意文本增量（供流式重试判定用；此处未直接使用，保留给消费方扩展）。 */
  hasText(): boolean {
    return this.text.length > 0;
  }

  /** 组装成 Anthropic.Message 形状（content: [thinking?, text?, tool_use...]）。 */
  build(model: string): Anthropic.Message {
    const content: Anthropic.ContentBlock[] = [];
    if (this.thinking.length > 0) {
      // OpenAI 无 signature，thinking 块只带 thinking 文本；回灌时 prepare 层因文本非空保留
      content.push({ type: 'thinking', thinking: this.thinking, signature: '' } as unknown as Anthropic.ContentBlock);
    }
    if (this.text.length > 0) {
      content.push({ type: 'text', text: this.text, citations: null } as unknown as Anthropic.ContentBlock);
    }
    for (const acc of this.toolCalls.values()) {
      content.push({
        type: 'tool_use',
        id: acc.id.length > 0 ? acc.id : `call_${Math.random().toString(36).slice(2)}`,
        name: acc.name,
        input: parseToolArguments(acc.arguments),
      } as unknown as Anthropic.ContentBlock);
    }
    return {
      id: '',
      type: 'message',
      role: 'assistant',
      model,
      content,
      stop_reason: mapStopReason(this.finishReason, this.toolCalls.size > 0),
      stop_sequence: null,
      usage: this.usage ?? emptyUsage(),
    } as unknown as Anthropic.Message;
  }
}

/** 把 OpenAI 工具调用的 arguments（JSON 字符串）解析成对象；空串或非法 JSON → {}。 */
export function parseToolArguments(raw: string): Record<string, unknown> {
  const trimmed = raw.trim();
  if (trimmed.length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return typeof parsed === 'object' && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/**
 * OpenAI finish_reason → Anthropic stop_reason：
 * tool_calls → tool_use、stop → end_turn、length → max_tokens、其余 → end_turn。
 * 有工具调用时无论 finish_reason 为何都判 tool_use（防个别网关末尾漏 finish_reason）。
 */
export function mapStopReason(
  finishReason: string | null,
  hasToolCalls: boolean,
): Anthropic.Message['stop_reason'] {
  if (hasToolCalls || finishReason === 'tool_calls') return 'tool_use';
  if (finishReason === 'length') return 'max_tokens';
  if (finishReason === 'stop') return 'end_turn';
  return 'end_turn';
}

/** OpenAI usage → Anthropic.Usage（input_tokens 不含 cached，cache_read 单列，对齐 anthropic 语义）。 */
export function mapUsage(usage: OpenAiUsage): Anthropic.Usage {
  const prompt = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0;
  const completion = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0;
  const cached =
    typeof usage.prompt_tokens_details?.cached_tokens === 'number'
      ? usage.prompt_tokens_details.cached_tokens
      : 0;
  return {
    input_tokens: Math.max(0, prompt - cached),
    output_tokens: completion,
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: 0,
  } as unknown as Anthropic.Usage;
}

function emptyUsage(): Anthropic.Usage {
  return {
    input_tokens: 0,
    output_tokens: 0,
    cache_read_input_tokens: 0,
    cache_creation_input_tokens: 0,
  } as unknown as Anthropic.Usage;
}

// ============ OpenAI 响应 wire 类型（宽松：容忍缺字段/网关差异）============

export interface OpenAiStreamToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string } | null;
}

export interface OpenAiStreamDelta {
  content?: string | null;
  reasoning_content?: string | null;
  reasoning?: string | null;
  tool_calls?: OpenAiStreamToolCallDelta[];
}

export interface OpenAiUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

export interface OpenAiStreamChunk {
  choices?: Array<{ delta?: OpenAiStreamDelta; finish_reason?: string | null }>;
  usage?: OpenAiUsage | null;
}

// ============ SSE 解析 ============

/**
 * 把一个字节流（fetch response.body）按 SSE `data:` 行解析成 JSON 对象序列。
 * 逐行累积，遇到 `data: [DONE]` 结束；忽略空行、注释行与非 data 行。
 * 纯粹按 SSE 文本协议解析，不依赖任何 SDK。
 */
export async function* parseSseStream(
  stream: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>,
): AsyncGenerator<unknown> {
  const decoder = new TextDecoder();
  let buffer = '';
  const iterable = toAsyncIterable(stream);
  for await (const chunk of iterable) {
    buffer += decoder.decode(chunk, { stream: true });
    let nlIndex: number;
    // SSE 事件以换行分隔；这里按行解析 data: 前缀（OpenAI 每条 data 独占一行）
    while ((nlIndex = buffer.indexOf('\n')) !== -1) {
      const rawLine = buffer.slice(0, nlIndex);
      buffer = buffer.slice(nlIndex + 1);
      const line = rawLine.replace(/\r$/, '').trim();
      if (line.length === 0 || line.startsWith(':')) continue;
      if (!line.startsWith('data:')) continue;
      const data = line.slice('data:'.length).trim();
      if (data === '[DONE]') return;
      try {
        yield JSON.parse(data);
      } catch {
        // 畸形 data 行跳过（网关偶发心跳/非 JSON），不中断整流
      }
    }
  }
}

/** ReadableStream / AsyncIterable 统一成 AsyncIterable。 */
function toAsyncIterable(
  stream: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>,
): AsyncIterable<Uint8Array> {
  if (Symbol.asyncIterator in (stream as object)) {
    return stream as AsyncIterable<Uint8Array>;
  }
  // web ReadableStream：用 reader 适配（Node18+ 的 fetch body 本身可 async 迭代，此为兜底）
  const reader = (stream as ReadableStream<Uint8Array>).getReader();
  return {
    async *[Symbol.asyncIterator]() {
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) return;
          if (value !== undefined) yield value;
        }
      } finally {
        reader.releaseLock();
      }
    },
  };
}

// ============ 错误包装 ============

/**
 * 把 HTTP 非 2xx 响应包成 Anthropic.APIError（按 status 生成对应子类，携带 headers）。
 * 这样 runTurn 的 isRetryableError / isRateLimitError / isContextOverflowError / retryAfterMs
 * 全部零改动生效——它们都基于 `instanceof Anthropic.APIError` 与 status/headers 判断。
 *
 * SDK makeMessage 的取信顺序是 error.message（顶层）→ JSON.stringify(error)，传入的 message
 * 参数在 error 为对象时被忽略。因此这里把可读摘要归一化到 payload 顶层 message：
 * error.message（OpenAI/Anthropic 标准错误形）→ 顶层 message → 「{type} · {body 截断}」合成摘要。
 * 裸 body（如 {"type":"error"}，线上实测）不再原样当 message，保证任何输出路径都带得上类型信息。
 */
export function httpErrorToApiError(status: number, body: string, headers: Headers): Error {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    parsed = undefined;
  }
  const errObj = parsed as
    | { error?: { message?: string; type?: string }; message?: string; type?: string }
    | undefined;
  const type = errObj?.error?.type ?? errObj?.type;
  const summary =
    errObj?.error?.message ??
    errObj?.message ??
    (body.length > 0 ? `${type !== undefined ? `${type} · ` : ''}${truncateBody(body)}` : '(no body)');
  const errorPayload =
    parsed !== undefined && typeof parsed === 'object'
      ? { ...parsed, message: summary }
      : { message: summary };
  return Anthropic.APIError.generate(status, errorPayload, summary, headers);
}

/** 错误响应体截断：防止网关/HTML 错误页刷屏。 */
function truncateBody(body: string, max = 200): string {
  const flat = body.replace(/\s+/g, ' ').trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
}
