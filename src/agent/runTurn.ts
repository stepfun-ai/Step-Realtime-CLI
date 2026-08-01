import type Anthropic from '@anthropic-ai/sdk';
import {
  abortableSleep,
  computeRetryDelay,
  EmptyResponseError,
  errorAdvice,
  isContextOverflowError,
  isEmptyStreamError,
  isRateLimitError,
  isRetryableError,
  retryAfterMs,
  summarizeError,
  RETRY_MAX_ATTEMPTS,
} from '../provider/retry.js';
import type { ChatProvider } from '../provider/types.js';
import { t } from '../i18n.js';
import { executeTool, toolAccessOf } from '../tools/index.js';
import type { ToolAccess } from '../tools/access.js';
import type { ToolContext, ToolResult } from '../tools/types.js';
import type { AgentEvent } from './events.js';
import { type LoopHooks, resolveAuthorization, resolveFinalizeResult } from './hooks.js';
import { stored, type StoredMessage } from './message.js';
import { ToolScheduler } from './toolScheduler.js';
import { toWire } from './wire.js';

/** 单回合结束原因。overflow = 上下文溢出，交外层循环压缩后重试。max_tokens = 输出达上限被截断。 */
export type StopReason = 'end_turn' | 'tool_use' | 'aborted' | 'error' | 'overflow' | 'max_tokens';

/** 单回合执行结果。 */
export interface TurnOutcome {
  stopReason: StopReason;
  /** 本回合模型返回的真实 token usage（成功拿到 finalMessage 时带上，供压缩判断）。 */
  usage?: Anthropic.Usage;
  /**
   * 思考预算耗尽标记：stop_reason==='max_tokens' 且响应无正文/工具调用（仅 thinking 块）。
   * 语义是「思考吃满了 max_tokens，正文没有空间生成」——与「正文写到一半被截断」不同，
   * loop 据此给出「调大 max_tokens / 降 thinking 档位」的确定性提示，而非「回复继续」。
   */
  thinkingExhausted?: boolean;
}

export interface RunTurnOptions {
  provider: ChatProvider;
  system: string;
  tools: Anthropic.Tool[];
  ctx: ToolContext;
  /** 会话历史（storage 层信封）。就地追加 assistant / tool_result 消息；发 provider 前过 toWire。 */
  messages: StoredMessage[];
  hooks: LoopHooks;
  signal?: AbortSignal;
  /** 工具白名单集合。存在时，白名单外的工具调用被拒（子 agent 收窄）。 */
  allowedTools?: Set<string>;
  /** 模型覆盖，透传给 provider.stream。 */
  model?: string;
  /** thinking 覆盖（三态：undefined 构造默认 / 对象覆盖 / null 抑制），透传给 provider.stream。 */
  thinking?: { budgetTokens?: number } | null;
}

/** 用户主动取消时回灌给模型的 tool_result 文案（区别于系统错误，避免模型自动重试）。 */
const USER_ABORT_TOOL_MSG =
  '用户主动中断了本次操作。这不是系统错误，不要自动重试，等待用户的下一步指示。';

/** 并行子 agent 429 重排队：延迟阶梯（封顶 12s）与重排上限。子 agent 内部重试循环是第一道防线，这是第二道。 */
export const SUBAGENT_REQUEUE_DELAYS = [3000, 6000, 12000] as const;
export const SUBAGENT_REQUEUE_MAX = 2;

/**
 * spawn_agent 任务的重排延迟决策：仅当结果是 provider 429 限流失败且未达重排上限时返回延迟 ms
 * （错误带合法 Retry-After 头时优先用其值），否则 undefined（不占槽重排，直接收敛）。
 */
export function subagentRequeueDelay(
  result: Pick<ToolResult, 'isError' | 'cause'> | undefined,
  requeued: number,
): number | undefined {
  if (result === undefined || !result.isError || !isRateLimitError(result.cause)) return undefined;
  if (requeued >= SUBAGENT_REQUEUE_MAX) return undefined;
  return retryAfterMs(result.cause) ?? SUBAGENT_REQUEUE_DELAYS[Math.min(requeued, SUBAGENT_REQUEUE_DELAYS.length - 1)]!;
}

/** 错误事件文案：可读摘要（HTTP 状态码 + 服务端错误类型/消息）+ 按错误码附加的建议用户动作。 */
function errorMessageWithAdvice(err: unknown): string {
  const advice = errorAdvice(err);
  // 空流/空响应给确定的中文文案：SDK 原文是英文且不附恢复线索
  const message =
    err instanceof EmptyResponseError || isEmptyStreamError(err)
      ? t('error.emptyStream')
      : summarizeError(err);
  return advice === undefined ? message : `${message}\n${advice}`;
}

/** 空响应判定：content 里既没有 text 块也没有 tool_use 块（thinking-only 视为空——思考不构成正文）。 */
function isEmptyResponse(msg: Anthropic.Message): boolean {
  return !msg.content.some((b) => b.type === 'text' || b.type === 'tool_use');
}

/** 准备阶段产出的一个待执行工具调用。 */
interface PreparedToolCall {
  tu: Anthropic.ToolUseBlock;
  /** 资源访问声明（冲突判定依据）。 */
  access: ToolAccess;
  /** 是否占用子 agent 并发槽位（spawn_agent）。 */
  needsSubagentSlot?: boolean;
  /** 准备阶段即定的结果（白名单 / 授权拒绝 / 中断），不再真正执行。 */
  preset?: ToolResult;
  /** 执行产出的结果。 */
  result?: ToolResult;
}

/**
 * 执行一个回合：一次模型调用（含流式与可重试错误退避）→ 解析 tool_use →
 * 三段式执行工具（准备串行授权 → 冲突调度并行执行 → 按 provider 顺序回收）→
 * 把 tool_result 就地追加进 messages（包成 storage 信封）。
 * 发给 provider 的消息一律经 toWire 投影成干净 wire。通过 yield 发事件，通过 return 返回停止原因（含真实 usage）。
 * 上下文溢出返回 stopReason='overflow'（不报错，交外层压缩重试）。
 */
export async function* runTurn(
  opts: RunTurnOptions,
): AsyncGenerator<AgentEvent, TurnOutcome> {
  const { provider, system, tools, ctx, messages, hooks, signal, allowedTools, model, thinking } = opts;

  if (signal?.aborted) return { stopReason: 'aborted' };

  // --- 流式请求（边流边 yield 的手动重试：仅在尚未吐字时才重试） ---
  let final: Anthropic.Message | undefined;
  for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
    let emittedText = false;
    try {
      const wireOpts = ctx.attachments !== undefined ? { attachments: ctx.attachments, cwd: ctx.cwd } : undefined;
      const stream = provider.stream({ system, tools, messages: toWire(messages, wireOpts), signal, model, thinking });
      for await (const event of stream) {
        if (signal?.aborted) break;
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          emittedText = true;
          yield { type: 'text', text: event.delta.text };
        } else if (event.type === 'content_block_delta' && event.delta.type === 'thinking_delta') {
          // 思考增量上抛给 UI（流式预览）；同样标记已吐字——已流出的思考重试会重复展示
          emittedText = true;
          yield { type: 'thinking_delta', text: event.delta.thinking };
        }
        // signature_delta 不上抛：signature 由 SDK 聚合进 finalMessage 的 thinking 块，
        // 随 assistant 消息进历史并原样回灌（Anthropic 协议要求 tool-use 轮带 signature）。
      }
      if (signal?.aborted) return { stopReason: 'aborted' };
      const msg = await stream.finalMessage();
      // 空响应契约：流正常结束但无正文也无工具调用。先按 stop_reason 分型：
      // - stop_reason==='max_tokens'：思考吃满了输出预算，正文没空间生成（配置性问题，
      //   重试无意义——预算组合不变必然复现）。不抛错，落 final 走下方 max_tokens 分支，
      //   携带 thinkingExhausted 标记让 loop 给「调 max_tokens / 降档」的确定性提示。
      // - 其余（end_turn 等）：真正的服务端瞬时空响应，抛 EmptyResponseError 走重试。
      //   emittedText 守卫仍优先：已流出思考时不重试，避免重复展示。
      if (isEmptyResponse(msg)) {
        if (msg.stop_reason === 'max_tokens') {
          final = msg;
          break;
        }
        throw new EmptyResponseError('empty response (no text, no tool_use)');
      }
      final = msg;
      break;
    } catch (e) {
      if (signal?.aborted) return { stopReason: 'aborted' };
      // 上下文溢出：不报错，交给外层循环压缩历史后重试本回合（仅在尚未吐字时才有意义）
      if (!emittedText && isContextOverflowError(e)) {
        return { stopReason: 'overflow' };
      }
      if (emittedText || !isRetryableError(e) || attempt >= RETRY_MAX_ATTEMPTS) {
        yield { type: 'error', message: errorMessageWithAdvice(e), cause: e };
        return { stopReason: 'error' };
      }
      const delay = computeRetryDelay(attempt, e);
      yield {
        type: 'retry',
        attempt,
        delayMs: delay,
        message: t('turn.retry', { delay: Math.round(delay), attempt, max: RETRY_MAX_ATTEMPTS - 1 }),
      };
      try {
        await abortableSleep(delay, signal);
      } catch {
        return { stopReason: 'aborted' };
      }
    }
  }
  if (final === undefined) {
    yield { type: 'error', message: t('turn.incomplete') };
    return { stopReason: 'error' };
  }
  const usage = final.usage;

  messages.push(stored({ role: 'assistant', content: final.content }, 'assistant'));

  // 输出达 max_tokens 上限被截断：截断响应里的 tool_use 不执行——
  // 半截 JSON 参数可能解析出错误输入，执行有副作用风险。assistant 消息保留进历史，
  // 交外层 loop 发明确提示后结束回合（不自动续写）。
  // thinkingExhausted：响应仅 thinking 块、无正文/工具调用——思考吃满预算，正文零输出，
  // 与「正文写到一半被截断」区分开，loop 据此给「调 max_tokens / 降档」提示。
  if (final.stop_reason === 'max_tokens') {
    const thinkingExhausted = isEmptyResponse(final);
    return thinkingExhausted
      ? { stopReason: 'max_tokens', usage, thinkingExhausted: true }
      : { stopReason: 'max_tokens', usage };
  }

  const toolUses = final.content.filter(
    (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
  );
  if (toolUses.length === 0) {
    return { stopReason: 'end_turn', usage };
  }

  // --- 执行工具：三段式。准备与回收都按 provider 顺序，执行交给冲突调度器乱序完成，
  //     tool_result 按 tool_use 顺序拼装（Anthropic 配对自动满足）。冲突模型见 tools/access.ts；
  //     spawn_agent 额外受 ctx.subagentMaxConcurrent 信号量约束（worker pool 语义）。
  //     每个 tool_use 必配 tool_result，绝不出现孤立 tool_use。 ---

  // 准备（串行）：白名单检查 + 授权逐个做——审批是对话式交互，并行化会让多个审批弹窗交错。
  // 拒绝的结果直接占槽（preset），不再真正执行。拒绝任务声明 all：它们的 tool_start/tool_end
  // 随调度串行吐出，保持与旧串行实现一致的事件交替。
  const prepared: PreparedToolCall[] = [];
  let userAborted = false;
  for (const tu of toolUses) {
    if (userAborted || signal?.aborted) {
      userAborted = true;
      prepared.push({ tu, access: { kind: 'none' }, preset: { content: USER_ABORT_TOOL_MSG, isError: true } });
      continue;
    }
    const req = { id: tu.id, name: tu.name, input: tu.input };
    // 工具白名单收窄（子 agent）：不在白名单内的工具直接拒，不执行
    if (allowedTools !== undefined && !allowedTools.has(tu.name)) {
      prepared.push({ tu, access: { kind: 'all' }, preset: { content: `工具 ${tu.name} 在当前 agent 不可用。`, isError: true } });
      continue;
    }
    // 授权（Phase 3 权限系统挂在这里）
    const auth = await resolveAuthorization(hooks, req);
    if (auth.decision === 'deny') {
      prepared.push({ tu, access: { kind: 'all' }, preset: { content: `工具调用被拒绝：${auth.reason}`, isError: true } });
      continue;
    }
    prepared.push({
      tu,
      access: toolAccessOf(tu.name, tu.input, ctx),
      needsSubagentSlot: tu.name === 'spawn_agent',
    });
  }

  // 执行 + 回收：tool_start 在任务实际启动时发出（onStart），tool_end 按数组顺序随回收发出；
  // 串行场景（单工具或全部冲突）下事件仍是 start→end 逐个交替，与旧串行实现字节级一致。
  const toolResults: Anthropic.ToolResultBlockParam[] = [];
  const pendingStarts: AgentEvent[] = [];
  const scheduler = new ToolScheduler(
    prepared.map((p) => ({
      access: p.access,
      needsSubagentSlot: p.needsSubagentSlot,
      run: async () => {
        if (p.preset !== undefined) {
          p.result = p.preset;
          return;
        }
        // 每任务独立 try/catch 转 is_error：单个工具异常不影响兄弟工具
        try {
          let result = await executeTool(p.tu.name, p.tu.input, ctx);
          result = await resolveFinalizeResult(hooks, { id: p.tu.id, name: p.tu.name, input: p.tu.input }, result);
          p.result = result;
        } catch (e) {
          p.result = { content: `工具 ${p.tu.name} 执行异常：${(e as Error).message}`, isError: true };
        }
      },
      // 429 重排队（第二道防线）：spawn_agent 因限流失败时不直接占槽，重排队尾让出槽位后重试
      shouldRequeue:
        p.tu.name === 'spawn_agent' ? (requeued) => subagentRequeueDelay(p.result, requeued) : undefined,
    })),
    {
      // 与 workflow 工具一致的缺省 4（config.subagent.maxConcurrent 首次在 runTurn 路径生效）
      maxSubagentConcurrent: ctx.subagentMaxConcurrent ?? 4,
      signal,
      onStart: (i) => {
        const p = prepared[i]!;
        pendingStarts.push({ type: 'tool_start', id: p.tu.id, name: p.tu.name, input: p.tu.input });
      },
      onRequeue: (_i, delayMs, requeued) => {
        pendingStarts.push({
          type: 'notice',
          message: t('turn.subagentRequeue', {
            delay: Math.round(delayMs),
            attempt: requeued,
            max: SUBAGENT_REQUEUE_MAX,
          }),
        });
      },
    },
  );

  scheduler.start();
  while (pendingStarts.length > 0) yield pendingStarts.shift()!;
  for (let i = 0; i < prepared.length; i++) {
    const p = prepared[i]!;
    const state = await scheduler.waitSettled(i);
    if (state === 'skipped') {
      // 中断时未启动的任务：合成中断结果占槽，不发事件（沿用旧串行实现语义）
      userAborted = true;
      const aborted = p.preset ?? { content: USER_ABORT_TOOL_MSG, isError: true };
      toolResults.push(makeToolResult(p.tu.id, aborted));
      continue;
    }
    const result = p.result!;
    yield { type: 'tool_end', id: p.tu.id, name: p.tu.name, result: result.content, isError: result.isError };
    toolResults.push(makeToolResult(p.tu.id, result));
    // 完成放行：被本任务卡住的后续任务现在启动，其 tool_start 排在本 tool_end 之后
    scheduler.drain();
    while (pendingStarts.length > 0) yield pendingStarts.shift()!;
  }
  messages.push(stored({ role: 'user', content: toolResults }, 'tool'));

  return { stopReason: userAborted ? 'aborted' : 'tool_use', usage };
}

/**
 * 组装 tool_result 块。result.images 非空时 content 从纯文本升格为块数组
 * [{type:'text',text}, ...imageBlocks]（Anthropic 官方支持 tool_result 内嵌 image，
 * 这是 read_media 等工具把图片回灌给模型的通道）。无图片时维持纯文本形态不变。
 */
function makeToolResult(
  toolUseId: string,
  result: ToolResult,
): Anthropic.ToolResultBlockParam {
  const base = { type: 'tool_result' as const, tool_use_id: toolUseId, is_error: result.isError };
  if (result.images === undefined || result.images.length === 0) {
    return { ...base, content: result.content };
  }
  const content: Exclude<Anthropic.ToolResultBlockParam['content'], string> = [
    { type: 'text', text: result.content },
    ...result.images.map((img) => ({
      type: 'image' as const,
      source: {
        type: 'base64' as const,
        media_type: img.mediaType as Anthropic.Base64ImageSource['media_type'],
        data: img.base64,
      },
    })),
  ];
  return { ...base, content };
}
