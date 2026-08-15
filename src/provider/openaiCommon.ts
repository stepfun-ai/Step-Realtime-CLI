import Anthropic from '@anthropic-ai/sdk';
import { StreamIdleTimeoutError } from './retry.js';
import { mapStepChatFinishReason } from './step/stepCommon.js';

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
  content?: string | OpenAiContentPart[] | null;
  /** assistant 的工具调用列表（tool_use 块翻译而来）。 */
  tool_calls?: OpenAiToolCall[];
  /** tool 消息回指的工具调用 id（tool_result 块的 tool_use_id）。 */
  tool_call_id?: string;
  /** thinking 块回灌字段（reasoning=true 时写入）。 */
  reasoning_content?: string;
}

/** OpenAI Chat 的多模态 content part（user/tool 消息的 content 数组元素）。 */
export interface OpenAiContentPart {
  type: 'text' | 'image_url' | 'video_url';
  text?: string;
  image_url?: { url: string };
  /** 视频扩展形态（非 OpenAI 官方）：两个 openai 兼容端点 2026-08-13 实测接受。 */
  video_url?: { url: string };
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

/**
 * tool_result 块的 content 折成 OpenAI 格式：
 * - string 原样返回
 * - 数组：text 块保留，image 块转成 image_url（data URI），其余丢弃
 *
 * 背景：OpenAI Chat Completions 官方文档只描述 tool role 的 content 为 string，
 * 但 step_plan 通道实测（2026-08-06）接受非标准扩展——content 数组里放 image_url。
 * 这是直接透传策略（不做图片提升到 user 消息）。
 */
function toolResultContent(block: Anthropic.ToolResultBlockParam): string | OpenAiContentPart[] {
  const c = block.content;
  if (c === undefined) return '';
  if (typeof c === 'string') return c;

  // 裸对象防御：MCP 工具可能输出裸 image/text 对象（非数组），cc-switch #6170 实测
  // SenseNova 等严格网关会因此 400。按 type 分发处理，避免 for...of 崩溃。
  if (!Array.isArray(c)) {
    const obj = c as unknown as Record<string, unknown>;
    if (obj.type === 'image' && typeof obj.data === 'string' && typeof obj.mimeType === 'string') {
      return [{ type: 'image_url', image_url: { url: `data:${obj.mimeType};base64,${obj.data}` } }];
    }
    if (obj.type === 'text' && typeof obj.text === 'string') {
      return obj.text;
    }
    return '';  // 无法识别的裸对象，丢弃
  }

  const parts: OpenAiContentPart[] = [];
  for (const part of c) {
    if (part.type === 'text') {
      parts.push({ type: 'text', text: part.text });
    } else if (part.type === 'image' && part.source.type === 'base64') {
      // data URI 格式：data:<media_type>;base64,<data>
      const url = `data:${part.source.media_type};base64,${part.source.data}`;
      parts.push({ type: 'image_url', image_url: { url } });
    } else if ((part as { type: string }).type === 'video') {
      // video 扩展块（官方类型无此块，read_media 视频回灌）→ video_url data URI。
      // 两个 openai 兼容端点实测接受该形态（2026-08-13 探针）。
      const src = (part as unknown as { source: { type: string; media_type: string; data: string } }).source;
      if (src.type === 'base64') {
        parts.push({ type: 'video_url', video_url: { url: `data:${src.media_type};base64,${src.data}` } });
      }
    }
    // document / tool_use / tool_result 等块在 tool_result 里不该出现，丢弃
  }

  // 纯文本场景退化成 string（兼容严格网关）
  if (parts.length === 1 && parts[0]!.type === 'text') {
    return parts[0]!.text!;
  }
  return parts;
}

/**
 * 把 Anthropic 请求（system + messages）翻译成 OpenAI Chat 的 messages 数组：
 * - system 非空 → messages[0] 的 {role:'system'}。
 * - user 消息：string 内容原样；数组内容里 tool_result 块各自展开为一条 {role:'tool'} 消息，
 *   其余文本块合并成一条 {role:'user'}。混合消息（tool_result + 文本）的发出顺序是
 *   **tool 在前、文本 user 在后**——某些严格网关要求 tool 消息紧跟
 *   assistant(tool_calls)，中间插一条 user 文本即 400「tool_calls must be followed by
 *   tool messages」。混合消息真实存在：normalizeHistory 会把合成的 tool_result 前插进
 *   紧随其后的带文本 user 消息；工具执行期间的插话也会被合并成同一条 user。
 *   （这是为不受控外部行为——服务端严格性——存在的容错，不要按「Anthropic 里
 *   tool_result 恒独占 user 消息」的内部假设改回文本在前。）
 * - assistant 消息：text 块合并为 content，tool_use 块展开为 tool_calls；thinking 块
 *   按 capability.reasoning 决定是否保留（reasoning=true 时序列化为 reasoning_content，
 *   false 时剥离）。
 */
export function messagesToOpenAi(
  system: string,
  messages: Anthropic.MessageParam[],
  reasoning: boolean,
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
      // 顺序必须 tool 在前、文本在后：严格网关要求 tool 消息紧跟 assistant(tool_calls)，
      // 文本在前会让整形层（normalizeHistory）修好的配对在 wire 上重新断开（实测严格网关 400）。
      const toolResults = blocks.filter(
        (b): b is Anthropic.ToolResultBlockParam => b.type === 'tool_result',
      );
      const nonTool = blocks.filter((b) => b.type !== 'tool_result');
      const nonToolText = blocksToText(nonTool as Anthropic.ContentBlockParam[]);
      // user 消息里的图片块不能再丢：2026-08-12 实录，Alt+V 贴图经 openai 协议通道
      // 发出时图片被静默吃掉（blocksToText 只拼文本），模型端看不到任何痕迹。
      // 有图片时 content 升级为 parts 数组（OpenAI 视觉标准形态），无图片保持原 string 路径。
      const imageParts: OpenAiContentPart[] = [];
      for (const b of nonTool) {
        if (b.type === 'image' && b.source.type === 'base64') {
          imageParts.push({
            type: 'image_url',
            image_url: { url: `data:${b.source.media_type};base64,${b.source.data}` },
          });
        } else if ((b as { type: string }).type === 'video') {
          // user 消息内嵌视频块（与图片同路升格 parts 数组；read_media 视频经 tool_result
          // 落地，此路径覆盖贴图/重放等 user 侧视频形态）
          const src = (b as unknown as { source: { type: string; media_type: string; data: string } }).source;
          if (src.type === 'base64') {
            imageParts.push({
              type: 'video_url',
              video_url: { url: `data:${src.media_type};base64,${src.data}` },
            });
          }
        }
      }
      for (const tr of toolResults) {
        out.push({ role: 'tool', tool_call_id: tr.tool_use_id, content: toolResultContent(tr) });
      }
      if (imageParts.length > 0) {
        const parts: OpenAiContentPart[] = [];
        if (nonToolText.length > 0) parts.push({ type: 'text', text: nonToolText });
        parts.push(...imageParts);
        out.push({ role: 'user', content: parts });
      } else if (nonToolText.length > 0 || toolResults.length === 0) {
        out.push({ role: 'user', content: nonToolText });
      }
      continue;
    }
    // assistant：文本 + 工具调用 + thinking（按 capability 决定是否回灌）
    const text = blocksToText(blocks as Anthropic.ContentBlockParam[]);
    const thinkingBlocks = blocks.filter((b) => b.type === 'thinking') as Array<{ thinking: string }>;
    const reasoningContent = thinkingBlocks.map((b) => b.thinking).join('');
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
    if (reasoning && thinkingBlocks.length > 0) {
      assistant.reasoning_content = reasoningContent;
    }
    out.push(assistant);
  }
  return out;
}

/**
 * 单条流允许累积的最大字符数（text + thinking + 工具 arguments 合计）。
 * 32M 字符 ≈ 64MB UTF-16 驻留，约为合法最大输出的两个数量级之外，
 * 同时把单条在途流的内存损害限制在堆的 2% 量级（对照 2026-08-04 的 4GB OOM 事故）。
 */
export const MAX_ACCUMULATED_CHARS = 32 * 1024 * 1024;

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
 *
 * 累积量有硬上限（{@link MAX_ACCUMULATED_CHARS}）：在途流持有本实例，text/thinking/
 * arguments 全是强引用，无上限时上游失控（网关/代理层帧洪流）会把老年代线性撑爆——
 * 2026-08-04 实测事故：两个子 agent 的流 15 分钟未结束，堆涨到 4GB 触发 V8 OOM。
 * 合法输出远在限下（max_tokens 有界，思考实测最多百万字符级），超限即视为上游异常，
 * 抛错走既有错误路径，比重试更对（对洪流重试只是再淹一次）。
 */
export class OpenAiChatAccumulator {
  private text = '';
  private thinking = '';
  private readonly toolCalls = new Map<number, ToolCallAccumulator>();
  private finishReason: string | null = null;
  private usage: Anthropic.Usage | undefined;
  /** 已累积的总字符数（text + thinking + 工具 arguments），对照预算熔断。 */
  private accumulatedChars = 0;

  /** 追加文本到 thinking 段（非主 completion 的归痕，debug bundle 需要留痕）。 */
  addThinking(text: string): void {
    if (typeof text === 'string' && text.length > 0) {
      this.thinking += text;
      this.charge(text.length);
    }
  }

  /** 累积一个 choices[0].delta（流式）。 */
  addDelta(delta: OpenAiStreamDelta): void {
    if (typeof delta.content === 'string') {
      this.text += delta.content;
      this.charge(delta.content.length);
    }
    // 思考：reasoning_content 与 reasoning 同值，取任一非空者（避免重复累加）
    const reasoning = delta.reasoning_content ?? delta.reasoning;
    if (typeof reasoning === 'string') {
      this.thinking += reasoning;
      this.charge(reasoning.length);
    }
    if (Array.isArray(delta.tool_calls)) {
      for (const tc of delta.tool_calls) {
        const index = typeof tc.index === 'number' ? tc.index : 0;
        const acc = this.toolCalls.get(index) ?? { id: '', name: '', arguments: '' };
        if (typeof tc.id === 'string' && tc.id.length > 0) acc.id = tc.id;
        if (tc.function !== undefined && tc.function !== null) {
          if (typeof tc.function.name === 'string' && tc.function.name.length > 0) {
            acc.name = tc.function.name;
          }
          if (typeof tc.function.arguments === 'string') {
            acc.arguments += tc.function.arguments;
            this.charge(tc.function.arguments.length);
          }
        }
        this.toolCalls.set(index, acc);
      }
    }
  }

  /** 计入累积量并熔断：超出预算说明上游在灌入远超合法输出的内容，直接抛错中止本条流。 */
  private charge(chars: number): void {
    this.accumulatedChars += chars;
    if (this.accumulatedChars > MAX_ACCUMULATED_CHARS) {
      throw new Error(
        `流式响应累积超过 ${MAX_ACCUMULATED_CHARS} 字符（合法输出远低于此），` +
          `判定上游异常并中止，防止内存被单条流撑爆。`,
      );
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
      stop_reason: mapStepChatFinishReason(this.finishReason, this.toolCalls.size > 0),
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
  id?: string;
  choices?: Array<{ delta?: OpenAiStreamDelta; finish_reason?: string | null }>;
  usage?: OpenAiUsage | null;
}

// ============ SSE 解析 ============

/**
 * 把一个字节流（fetch response.body）按 SSE `data:` 行解析成 JSON 对象序列。
 * 逐行累积，遇到 `data: [DONE]` 结束；忽略空行、注释行与非 data 行。
 * 纯粹按 SSE 文本协议解析，不依赖任何 SDK。
 *
 * 空闲看门狗包在**字节层**而不是解析后的事件层：网关的 SSE 注释心跳（`: keep-alive`）
 * 也算活着的信号，只在「连心跳都没有」时才判死——避免长思考任务被心跳保活期间误杀。
 */
export async function* parseSseStream(
  stream: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array>,
  options?: { idleTimeoutMs?: number; onIdle?: () => void },
): AsyncGenerator<unknown> {
  const decoder = new TextDecoder();
  let buffer = '';
  const iterable = withStreamIdleWatchdog(
    toAsyncIterable(stream),
    options?.idleTimeoutMs ?? STREAM_IDLE_TIMEOUT_MS,
    options?.onIdle,
  );
  for await (const chunk of iterable) {
    buffer += decoder.decode(chunk, { stream: true });
    // 行缓冲护栏：上游若持续灌入无换行的数据，buffer 会绕过 accumulator 的预算无界增长
    // （同 2026-08-04 堆爆事故的外部条件）。正常 SSE 行最大也就单帧 JSON，远低于此限。
    if (buffer.length > MAX_ACCUMULATED_CHARS) {
      throw new Error('SSE 行缓冲超限：上游持续发送无换行数据，判定上游异常并中止。');
    }
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

/**
 * 流式空闲看门狗的超时（毫秒）：超过该时长连一个字节都没收到，判定流已病态并中止。
 * 为什么需要：fetch 层面的 timeout 只覆盖初始响应，管不到 streaming body——上游静默断连
 * 或经代理半死不活时，一条流可以无限挂住（2026-08-04 事故：两条子 agent 的流 15 分钟
 * 未结束，堆被灌到 4GB）。取值放宽到 2 分钟：长思考任务首帧前的静默真实存在（实测
 * router 单请求 111~149s），字节层计时意味着心跳帧会重置计时，只有彻底静默才触发。
 */
export const STREAM_IDLE_TIMEOUT_MS = 120_000;

/**
 * 给任意 AsyncIterable 包一层空闲看门狗：每收到一个元素重置计时，超过 timeoutMs
 * 没有任何元素即抛错中止。onIdle 回调用于让调用方同时 abort 底层 fetch——Response
 * 持有的 socket/TLS 缓冲区在 V8 堆之外，不显式 abort 是堆外内存泄漏。
 */
export async function* withStreamIdleWatchdog<T>(
  iterable: AsyncIterable<T>,
  timeoutMs: number,
  onIdle?: () => void,
): AsyncGenerator<T> {
  const it = iterable[Symbol.asyncIterator]();
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const idle = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          onIdle?.();
          reject(
            new StreamIdleTimeoutError(`流式响应超过 ${Math.round(timeoutMs / 1000)}s 没有任何数据，判定上游异常并中止。`),
          );
        }, timeoutMs);
      });
      try {
        const result = await Promise.race([it.next(), idle]);
        if (result.done === true) return;
        yield result.value;
      } finally {
        if (timer !== undefined) clearTimeout(timer);
      }
    }
  } finally {
    await it.return?.();
  }
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
