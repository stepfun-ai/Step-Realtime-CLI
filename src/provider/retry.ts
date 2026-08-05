import Anthropic from '@anthropic-ai/sdk';
import { t } from '../i18n.js';

/**
 * 识别 Anthropic SDK 的空流错误：MessageStream 在没收到任何 message_start 的情况下被
 * drain 完，finalMessage() 抛出不带 HTTP status 的 AnthropicError，是网关/服务端瞬时故障
 * 的典型表现。无 status 的 provider 错误默认可重试：流在收到终止事件前就断开，
 * 属于可安全重放的瞬时故障。
 */
export function isEmptyStreamError(err: unknown): boolean {
  return (
    err instanceof Anthropic.AnthropicError &&
    !(err instanceof Anthropic.APIError) &&
    /stream ended without producing/i.test(err.message)
  );
}

/**
 * 空响应错误：流「正常」结束，但终态消息既没有正文也没有工具调用（含 thinking-only
 * 变体——思考不构成正文，可能是流中断或 reasoning 烧光了输出预算）。由 runTurn 拿到
 * finalMessage 后抛出，与 SDK 空流错误走同一条重试路径。
 */

/**
 * 空响应的诊断上下文。
 *
 * 空响应有多种成因，可重试性完全不同：服务端瞬时故障重发就好，思考吃满预算重发一万次
 * 也一样。此前的文案写死「通常是网关或服务端的瞬时故障」——这个归因没有证据支撑，
 * 且 2026-08-02 的排查证明它把方向带偏了整整一个阶段（真实成因是输出预算不足）。
 *
 * 因此这里改为**只报事实、不猜原因**，把判断依据交给用户：有没有产出思考、
 * 结束原因是什么、烧了多少 token——这四项合起来足以让用户自己区分「没生成」与
 * 「全烧在思考上」，而不必依赖我们猜一个可能错的成因。
 */
export interface EmptyResponseContext {
  /** 是否产出过思考内容。为 true 时「模型什么都没做」不成立，更可能是预算问题。 */
  hadReasoning?: boolean;
  /** 服务端给出的结束原因（已归一到 Anthropic 词汇表）；null 表示服务端没给信号。 */
  stopReason?: string | null;
  /** 本次输出消耗的 token 数。与 hadReasoning 一起看即可区分「没生成」与「全烧在思考上」。 */
  outputTokens?: number;
  /**
   * 本次请求发出的输出上限。**必须与 outputTokens 一起看**——只有二者的比值能回答
   * 「预算是否真的被烧光」。单看 outputTokens 的绝对值不行：155 tok 在 64K 预算下是 0.24%，
   * 与「预算耗尽」相差三个数量级，但若只判 `outputTokens > 0` 就会把它误诊成耗尽。
   */
  maxTokens?: number;
  /** 模型名，多渠道场景下用于定位是哪个模型的行为。 */
  model?: string;
  /** 渠道名，多渠道场景下用于定位是哪条通道的行为。 */
  provider?: string;
}

export class EmptyResponseError extends Error {
  /** 诊断上下文；缺省表示调用方没有提供（旧调用点仍可只传 message）。 */
  readonly context?: EmptyResponseContext;

  constructor(message: string, context?: EmptyResponseContext) {
    super(message);
    this.name = 'EmptyResponseError';
    if (context !== undefined) this.context = context;
  }
}

/**
 * 流式空闲看门狗超时：超过 STREAM_IDLE_TIMEOUT_MS 连一个字节都没收到，判定上游病态并中止。
 * 归可重试——假死多为网关/代理半开连接或上游静默断连，重发换一个连接往往能恢复；
 * 与 ECONNRESET 同属「传输层瞬断」家族，只是触发方式从「对端 RST」变成「对端彻底静默」。
 * 独立成类型（而非裸 Error）：裸 Error 无 code、非 APIError、非 TypeError，
 * isRetryableError 接不住，会把这类瞬时假死也推成用户必须手动重发的硬错误（实测确认）。
 */
export class StreamIdleTimeoutError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StreamIdleTimeoutError';
  }
}

/**
 * 沿 err.cause 链收集所有字符串 code（含顶层）。
 * undici（Node 内置 fetch）传输层失败时抛 TypeError('fetch failed')，真实的
 * socket/DNS code 嵌在 err.cause（可能多级）；OpenAI 兼容通道用裸 fetch，这类
 * 错误不经 SDK 包装，必须下钻 cause 链才能识别，否则会被误判为不可重试。
 * 带循环保护，容错任意畸形对象。
 */
function causeChainCodes(err: unknown): string[] {
  const codes: string[] = [];
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur !== null && typeof cur === 'object' && !seen.has(cur)) {
    seen.add(cur);
    const code = (cur as { code?: unknown }).code;
    if (typeof code === 'string') codes.push(code);
    cur = (cur as { cause?: unknown }).cause;
  }
  return codes;
}

/** 可重试的网络错误 code 集合：连接/超时类瞬时故障（含 undici 自定义 code 与瞬态 DNS）。 */
const RETRYABLE_NET_CODES = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'ECONNREFUSED',
  'EPIPE',
  'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
  'UND_ERR_SOCKET',
]);

/**
 * 判断一个错误是否值得重试。
 * 可重试：网络连接错误、超时、429（限流）、5xx（服务端）、空流/空响应。
 * 不可重试：4xx（除 429，通常是请求本身有问题，重试无益）。
 */
export function isRetryableError(err: unknown): boolean {
  if (err instanceof Anthropic.APIConnectionError || err instanceof Anthropic.APIConnectionTimeoutError) {
    return true;
  }
  // 空流/空响应：对端在产出任何内容前结束了生成，多为瞬时故障；
  // 配合 runTurn「未吐字才重试」守卫，归可重试是安全的。
  if (err instanceof EmptyResponseError || isEmptyStreamError(err)) {
    return true;
  }
  // 流式假死看门狗：与空响应同属「传输/上游异常」家族，重发换连接可恢复
  if (err instanceof StreamIdleTimeoutError) {
    return true;
  }
  if (err instanceof Anthropic.APIError && typeof err.status === 'number') {
    return err.status === 429 || err.status >= 500;
  }
  // 兜底：带 code 的网络错误（下钻 cause 链，覆盖 undici fetch 失败的嵌套形态）
  if (causeChainCodes(err).some((c) => RETRYABLE_NET_CODES.has(c))) {
    return true;
  }
  // undici 裸传输错误：fetch 只在网络层失败时抛这两种 TypeError，
  // 即使 cause 链缺 code 也按可安全重放的瞬时故障处理
  if (err instanceof TypeError && (err.message === 'fetch failed' || err.message === 'terminated')) {
    return true;
  }
  return false;
}

/**
 * 判断错误是否为 provider 限流（429）。供并行子 agent 的重排队判定使用——
 * 这是调度层唯一能拿到 status 的地方（子 agent 内部的 runTurn 重试循环已先扛过一轮）。
 */
export function isRateLimitError(err: unknown): boolean {
  return err instanceof Anthropic.APIError && err.status === 429;
}

/**
 * 判断错误是否为「用户中断」而非真实故障。
 *
 * 中断在链路上有多种形态：SDK 的 `APIUserAbortError`、DOM 风格的 `AbortError`
 * （fetch 在 signal abort 时抛出）、以及本文件 abortableSleep / withRetry 抛的 `已取消`。
 * 调用方据此把中断与故障区分开：故障可以重试或降级，中断必须立刻停手——
 * 对中断做重试等于让用户按了取消还要再等几轮请求。
 */
export function isAbortError(err: unknown): boolean {
  if (err instanceof Anthropic.APIUserAbortError) return true;
  if (err instanceof Error) {
    if (err.name === 'AbortError') return true;
    if (err.message === '已取消') return true;
  }
  return false;
}

/**
 * 错误码 → 建议用户动作（最小目录，对齐 error.advice.* 文案）：
 * 401/403 → 检查 key 配置；429（重试耗尽后）→ 稍后重试或查配额。其他错误无建议（undefined）。
 */
export function errorAdvice(err: unknown): string | undefined {
  if (err instanceof Anthropic.APIError && typeof err.status === 'number') {
    if (err.status === 401 || err.status === 403) return t('error.advice.auth');
    if (err.status === 429) return t('error.advice.rateLimit');
  }
  return undefined;
}

/**
 * 面向用户的错误摘要：HTTP 状态码 + 错误类型 + 服务端消息。
 * SDK APIError 的 message 固定形如「{status} {body}」，body 可能是裸 JSON（网关原文，
 * 线上实测 `{"type":"error"}`）；这里剥掉状态码前缀、提取 JSON 里的可读字段，
 * 非 APIError 原样返回。输出形如 `HTTP 400 · invalid_request_error: prompt is too long`。
 */
export function summarizeError(err: unknown): string {
  const raw = (err as Error | undefined)?.message ?? String(err);
  const status = err instanceof Anthropic.APIError && typeof err.status === 'number' ? err.status : undefined;
  let type = (err as { type?: string | null } | undefined)?.type ?? undefined;
  let body = raw.trim();
  if (status !== undefined && body.startsWith(`${status} `)) {
    body = body.slice(`${status} `.length);
  }
  if (body.startsWith('{')) {
    try {
      const parsed = JSON.parse(body) as {
        error?: { type?: string; message?: string };
        type?: string;
        message?: string;
      };
      type = parsed.error?.type ?? parsed.type ?? type;
      const msg = parsed.error?.message ?? parsed.message;
      if (typeof msg === 'string') {
        body = msg;
      } else if (body.length > 200) {
        body = `${body.slice(0, 200)}…`;
      }
    } catch {
      // 非 JSON，按原文展示
    }
  }
  const typed = type !== undefined && !body.includes(type) ? `${type}: ${body}` : body;
  let summary = status !== undefined ? `HTTP ${status} · ${typed}` : typed;
  // undici 传输错误：把 cause 链上的真实 code 带上——否则一句「fetch failed」
  // 无法区分 DNS 失败、连接重置还是超时，用户无从下手
  if (status === undefined) {
    const codes = causeChainCodes(err);
    if (codes.length > 0 && !summary.includes(codes[0]!)) {
      summary = `${summary} (${codes.join(' < ')})`;
    }
  }
  return summary;
}

/**
 * 判断错误是否为上下文溢出（超出模型窗口）。这类错误重试无益，需先压缩历史再重试。
 * StepFun 走 Anthropic 协议，溢出通常是 400 invalid_request_error，消息含 "prompt is too long" 等。
 * 识别不到只退化为普通错误（现有行为），不会更糟；故用相对具体的关键词，避免把别的 400 误判成溢出。
 */
export function isContextOverflowError(err: unknown): boolean {
  if (err instanceof Anthropic.APIError && err.status === 400) {
    const msg = String(err.message ?? '').toLowerCase();
    return (
      msg.includes('prompt is too long') ||
      msg.includes('too many tokens') ||
      msg.includes('context_length') ||
      msg.includes('context window') ||
      msg.includes('maximum context')
    );
  }
  return false;
}

export interface RetryOptions {
  maxAttempts?: number;
  signal?: AbortSignal;
  /** 每次重试前回调，供上层提示用户。 */
  onRetry?: (attempt: number, delayMs: number, err: unknown) => void;
}

/** 默认退避参数，供流式循环手动重试时复用（保持单一真相）。 */
export const RETRY_MAX_ATTEMPTS = 3;
export const RETRY_BASE_MS = 300;
export const RETRY_MAX_MS = 5000;

/** Retry-After 头给出的等待上限：服务端值优先于本地退避，但不无限信任。 */
export const RETRY_AFTER_MAX_MS = 120_000;

/** 计算第 attempt 次（1 起）重试的退避时长（含 25% 抖动）。 */
export function computeBackoff(attempt: number): number {
  const backoff = Math.min(RETRY_BASE_MS * 2 ** (attempt - 1), RETRY_MAX_MS);
  return backoff + Math.random() * backoff * 0.25;
}

/**
 * 从 Anthropic APIError 的响应头解析 Retry-After（秒数或 HTTP-date），返回等待毫秒。
 * 缺失 / 畸形 / 非 APIError 返回 undefined（调用方回退本地退避）；合法值封顶 RETRY_AFTER_MAX_MS。
 */
export function retryAfterMs(err: unknown): number | undefined {
  if (!(err instanceof Anthropic.APIError)) return undefined;
  const raw = err.headers?.get('retry-after')?.trim();
  if (raw === undefined || raw === '') return undefined;
  let ms: number;
  if (/^[+-]?[\d.]+$/.test(raw)) {
    // delay-seconds 数字形式：负数 / 非有限值视为畸形
    const secs = Number(raw);
    if (!Number.isFinite(secs) || secs < 0) return undefined;
    ms = secs * 1000;
  } else {
    // HTTP-date 形式：换成相对现在的等待时长；过期的日期按 0 处理
    const at = Date.parse(raw);
    if (Number.isNaN(at)) return undefined;
    ms = Math.max(0, at - Date.now());
  }
  if (!Number.isFinite(ms)) return undefined;
  return Math.min(ms, RETRY_AFTER_MAX_MS);
}

/** 重试延迟：Retry-After 头优先，缺失/畸形回退本地指数退避。 */
export function computeRetryDelay(attempt: number, err: unknown): number {
  return retryAfterMs(err) ?? computeBackoff(attempt);
}

/** 可被 AbortSignal 中断的 sleep。 */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error('已取消'));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error('已取消'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

/**
 * 指数退避 + 抖动地重试一个异步操作。
 * 默认 3 次尝试，300ms 起步，封顶 5s，因子 2；仅对 isRetryableError 为真的错误重试。
 * 尊重 AbortSignal：已中止则不再重试，直接抛出。
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const maxAttempts = opts.maxAttempts ?? RETRY_MAX_ATTEMPTS;

  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (opts.signal?.aborted) throw new Error('已取消');
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt >= maxAttempts || !isRetryableError(err) || opts.signal?.aborted) {
        throw err;
      }
      const delay = computeRetryDelay(attempt, err);
      opts.onRetry?.(attempt, delay, err);
      await abortableSleep(delay, opts.signal);
    }
  }
  throw lastErr;
}
