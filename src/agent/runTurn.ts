import type Anthropic from '@anthropic-ai/sdk';
import {
  abortableSleep,
  computeRetryDelay,
  type EmptyResponseContext,
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
import type { ChatProvider, ThinkingParam } from '../provider/types.js';
import { createThinkingLoopDetector } from './thinkingLoop.js';
import { t } from '../i18n.js';
import { executeTool, toolAccessOf } from '../tools/index.js';
import type { ToolAccess } from '../tools/access.js';
import type { ToolContext, ToolResult } from '../tools/types.js';
import type { AgentEvent } from './events.js';
import { type LoopHooks, resolveAuthorization, resolveFinalizeResult } from './hooks.js';
import { stored, type StoredMessage } from './message.js';
import { capToolResult } from './toolResultLimit.js';
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
  /**
   * 工具调用通道退化标记：本回合零 tool_use，但正文里出现了工具调用标签的特征形态。
   * 语义是「模型把工具调用打成了纯文本，工具从未执行」——这是模型侧退化（实证只在长上下文下
   * 间歇发生），若不检测则回合以 end_turn 正常收尾，界面刷出一屏看似正常的 XML 而毫无信号，
   * 且那段文本作为 assistant 消息进历史，下一轮模型可能基于「我已经改了文件」的错误前提继续推进。
   * loop 据此给出用户可见 notice。只提示不修复——不做文本兜底解析，理由见工具调用健壮性设计 P0.5。
   */
  toolCallLeak?: boolean;
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
  thinking?: ThinkingParam | null;
  /** 渠道名（如 stepfun / openai / anthropic），用于空响应诊断上下文。 */
  providerName?: string;
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

/**
 * 错误事件文案：可读摘要（HTTP 状态码 + 服务端错误类型/消息）+ 按错误码附加的建议用户动作。
 *
 * 空响应带诊断上下文时（{@link EmptyResponseError.context}）会附一行事实说明。
 * 不猜成因——旧文案写死「通常是网关或服务端的瞬时故障」，该归因无证据支撑且实测被证伪
 * （真实成因是输出预算被思考吃满），反而误导排查方向。
 */
function errorMessageWithAdvice(err: unknown): string {
  const advice = errorAdvice(err);
  // 空流/空响应给确定的中文文案：SDK 原文是英文且不附恢复线索
  const message =
    err instanceof EmptyResponseError || isEmptyStreamError(err)
      ? t('error.emptyStream')
      : summarizeError(err);
  const diagnostics =
    err instanceof EmptyResponseError && err.context !== undefined
      ? emptyResponseDiagnostics(err.context)
      : undefined;
  return [message, diagnostics, advice].filter((s) => s !== undefined && s !== '').join('\n');
}

/**
 * 把空响应诊断上下文渲染成一行事实陈述，并按**预算是否真被烧光**给出对应建议。
 *
 * 两类空响应的建议是相反的，选错就是把用户推向无效动作：
 * - **预算真耗尽**（服务端报 max_tokens，或输出确实逼近上限）：降档 / 调大预算有效，重发无用。
 * - **正常结束但无正文**（服务端报 end_turn，输出只占预算零头）：预算根本没参与，降档与调大
 *   都不会改变它；这类是模型侧偶发行为，**重试往往有效**——恰好与上一类相反。
 *
 * 判据必须同时看 stopReason 与「outputTokens / maxTokens 的比值」。早期实现只判
 * `hadReasoning && outputTokens > 0`，把 155 tok / 64K 预算（0.24%）+ end_turn 的实例
 * 误诊为耗尽，并明确劝用户「重发无用」，而重发正是那一类唯一可能有效的动作。
 *
 * 注意这里用的是**占用率**，不是「输出少于 N tok 即异常」的绝对阈值——后者会误伤合法短答
 * （问「1+1」答「2」是 2 tok），已在实验记录 1.7.1 判定不做。占用率回答的是另一个问题：
 * 这次输出有没有把预算用完。且此处已在空响应路径上，不存在误伤正常回答的可能。
 */
function emptyResponseDiagnostics(ctx: EmptyResponseContext): string | undefined {
  const parts: string[] = [];
  if (ctx.provider !== undefined && ctx.provider !== '') parts.push(t('error.emptyStream.provider', { provider: ctx.provider }));
  if (ctx.model !== undefined && ctx.model !== '') parts.push(t('error.emptyStream.model', { model: ctx.model }));
  if (ctx.hadReasoning !== undefined) {
    parts.push(ctx.hadReasoning ? t('error.emptyStream.hadReasoning') : t('error.emptyStream.noReasoning'));
  }
  if (ctx.stopReason !== undefined) {
    parts.push(t('error.emptyStream.stopReason', { reason: ctx.stopReason ?? t('error.emptyStream.noSignal') }));
  }
  if (ctx.outputTokens !== undefined) {
    parts.push(
      ctx.maxTokens !== undefined && ctx.maxTokens > 0
        ? t('error.emptyStream.outputTokensOfLimit', {
            tokens: String(ctx.outputTokens),
            limit: String(ctx.maxTokens),
          })
        : t('error.emptyStream.outputTokens', { tokens: String(ctx.outputTokens) }),
    );
  }
  if (parts.length === 0) return undefined;
  const line = t('error.emptyStream.diagnostics', { details: parts.join(' · ') });
  const hint = emptyResponseHint(ctx);
  return hint === undefined ? line : `${line}\n${hint}`;
}

/** 输出占预算的比例达到此值即认定预算被烧光（留余量：思考+正文的计数未必精确等于上限）。 */
const BUDGET_EXHAUSTED_RATIO = 0.9;

/**
 * 选出与实测事实相符的那条建议。返回 undefined 表示信息不足，不给建议——
 * **宁可不给，也不给相反的建议**：拿不到 maxTokens 时无法判断预算是否耗尽，
 * 此时任何一条建议都有一半概率把用户推向无效动作。
 */
function emptyResponseHint(ctx: EmptyResponseContext): string | undefined {
  if (ctx.hadReasoning !== true || (ctx.outputTokens ?? 0) <= 0) return undefined;
  // 服务端明确报截断：预算耗尽已被确认，无需比值。
  if (ctx.stopReason === 'max_tokens') return t('error.emptyStream.budgetHint');
  if (ctx.maxTokens === undefined || ctx.maxTokens <= 0) return undefined;
  const used = ctx.outputTokens ?? 0;
  return used / ctx.maxTokens >= BUDGET_EXHAUSTED_RATIO
    ? t('error.emptyStream.budgetHint')
    : t('error.emptyStream.notBudgetHint', { used: String(used), limit: String(ctx.maxTokens) });
}

/** 空响应判定：content 里既没有 text 块也没有 tool_use 块（thinking-only 视为空——思考不构成正文）。 */
function isEmptyResponse(msg: Anthropic.Message): boolean {
  return !msg.content.some((b) => b.type === 'text' || b.type === 'tool_use');
}

/**
 * 工具调用标签的特征形态。判据刻意要求**尖括号开启的标签**，不匹配裸词。
 *
 * 原因是一个具体的误报场景：本项目自己的文档（设计稿、已知问题清单）里就写着
 * `invoke name=`、`function_calls` 这些裸词字面，在本仓库工作的 agent 复述文档时会必然误触发。
 * 真实泄漏一定以 `<` 开启标签，而文档讨论写的是正则字面或反引号包裹的词——尖括号把两者分开，
 * 收紧成本为零。带 `antml:` 前缀与不带的两种形态都收（不同模型退化时吐出的形态不一）。
 */
const TOOL_CALL_LEAK_PATTERNS: readonly RegExp[] = [
  /<\s*antml:invoke\s+name\s*=/i,
  /<\s*antml:parameter\s+name\s*=/i,
  /<\s*antml:function_calls\s*>/i,
  /<\s*invoke\s+name\s*=/i,
  /<\s*function_calls\s*>/i,
];

/**
 * 工具调用通道退化检测：正文里是否出现了本该走结构化 tool_use 的调用标签。
 *
 * 只在「本回合零 tool_use」时调用（调用点已收窄），因此不会影响正常的工具执行路径。
 * 已知不覆盖：部分泄漏（一部分调用走了结构化通道、另一部分漏成文本）——此时 toolUses 非空，
 * 检测不运行。实证样本均为整回合全泄漏，故先不处理。
 */
export function detectToolCallLeak(msg: Anthropic.Message): boolean {
  return msg.content.some(
    (b) => b.type === 'text' && TOOL_CALL_LEAK_PATTERNS.some((re) => re.test(b.text)),
  );
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
  const { provider, system, tools, ctx, messages, hooks, signal, allowedTools, model, thinking, providerName } = opts;

  if (signal?.aborted) return { stopReason: 'aborted' };

  // --- 流式请求（边流边 yield 的手动重试：仅在尚未吐字时才重试） ---
  let final: Anthropic.Message | undefined;
  // think-only 恢复路径自己管理 messages 落盘（thinking 与正文分成多条 assistant，
  // 注入的 user 消息也落盘），与循环外的统一 messages.push(final) 互斥。
  // 该路径即时落盘后把此标记置 true，跳过循环外的统一 push，避免重复落盘。
  let skipFinalPush = false;
  // thinking 预算耗尽自动降档：首轮 thinkingExhausted 时把 thinking 降到 low 重试 1 次。
  // 成功后恢复原档位；失败退到 loop 的提示路径。最多 1 次，防死循环。
  let retriedDowngrade = false;
  // think-only 自动恢复：降档重试仍耗尽时，把耗尽轮次的 thinking 落盘为 assistant 消息，
  // 注入「直接回答」user 消息，用同一份 messages 发新请求。最多 1 次，防死循环。
  let retriedThinkOnly = false;
  // thinking 流死循环：流式检测命中后，中止当前流、用「诱导跳出」提示重试 1 次。
  // 注入会污染上下文（reasoning leakage 风险），故用「终止+新请求」而非同流续写。
  // loopRetryMessages 非空时表示本次重试要用注入后的消息序列。
  let retriedLoop = false;
  let loopRetryMessages: typeof messages | undefined;
  let loopDetector = createThinkingLoopDetector();
  for (let attempt = 1; attempt <= RETRY_MAX_ATTEMPTS; attempt++) {
    /**
     * 本次尝试是否已流出**正文**（text_delta）。它是重试禁令的唯一判据：
     * 正文已经进了用户屏幕，重试会让同一段话出现两遍。
     *
     * 刻意**不含**思考增量。曾经思考也置这个标记，后果是 step-router-v1 这类
     * 「每轮先吐思考」的模型永远走不进重试分支：服务端返回 thinking-only 空响应时，
     * 诊断文案说「重试往往有效」，代码却直接报错退出，把动作推回给用户（实测复现）。
     * 思考重复展示的代价远小于让用户手动重发，故两个口径分开。
     */
    let emittedText = false;
    // thinking 流死循环：命中后中止当前流走注入重试（见循环尾部处理）。
    let loopAborted = false;
    try {
      const wireOpts = ctx.attachments !== undefined ? { attachments: ctx.attachments, cwd: ctx.cwd } : undefined;
      const wireMessages = loopRetryMessages ?? messages;
      const stream = provider.stream({ system, tools, messages: toWire(wireMessages, wireOpts), signal, model, thinking });
      // 在途 thinking 块的 index：content_block_start[thinking] 记下，同 index 的 content_block_stop 清掉。
      // 边界事件独立上抛，使「只吐 signature、不吐可见思考」的模型也能被 UI 显示为思考中。
      let thinkingIndex: number | undefined;
      // 在途 tool_use 块的 index → id：Anthropic 通道原生有 content_block_start[tool_use] 与
      // input_json_delta，OpenAI 通道由 provider 合成同形事件（index 偏移 1000 避让正文块）。
      // 两者在这里统一映射成 tool_forming / tool_args_delta，UI 提前挂「成形中」工具卡。
      const toolBlockIds = new Map<number, string>();
      for await (const event of stream) {
        if (signal?.aborted) break;
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          emittedText = true;
          yield { type: 'text', text: event.delta.text };
        } else if (event.type === 'content_block_delta' && event.delta.type === 'input_json_delta') {
          const toolId = toolBlockIds.get(event.index);
          if (toolId !== undefined) yield { type: 'tool_args_delta', id: toolId, partialJson: event.delta.partial_json };
        } else if (
          event.type === 'content_block_start' &&
          event.content_block.type === 'tool_use'
        ) {
          const block = event.content_block;
          toolBlockIds.set(event.index, block.id);
          yield { type: 'tool_forming', id: block.id, name: block.name };
        } else if (event.type === 'content_block_delta' && event.delta.type === 'thinking_delta') {
          // 思考增量上抛给 UI（流式预览）。**不置 emittedText**：思考不是正文，
          // 重试只会让思考重复展示一次，而阻断重试会把偶发空响应变成用户必须手动重发的硬错误。
          yield { type: 'thinking_delta', text: event.delta.thinking };
          // thinking 流死循环检测：命中即中止当前流（下方走注入诱导重试）。
          // 已吐正文时不中止：撤回正文违背「正文不进重试」的铁律。
          if (!emittedText && !retriedLoop) {
            const verdict = loopDetector.ingest(event.delta.thinking);
            if (verdict.looping) {
              loopAborted = true;
              break;
            }
          }
        } else if (
          event.type === 'content_block_start' &&
          // redacted_thinking（加密思考）同样一个字都不吐，是「无痕思考」的另一种来源
          (event.content_block.type === 'thinking' || event.content_block.type === 'redacted_thinking')
        ) {
          thinkingIndex = event.index;
          // 不标记 emittedText：边界事件不含内容，重试不会重复展示任何东西，无痕思考仍应可重试
          yield { type: 'thinking_start' };
        } else if (event.type === 'content_block_stop' && event.index === thinkingIndex) {
          thinkingIndex = undefined;
          yield { type: 'thinking_end' };
        }
        // signature_delta 不上抛：signature 由 SDK 聚合进 finalMessage 的 thinking 块，
        // 随 assistant 消息进历史并原样回灌（Anthropic 协议要求 tool-use 轮带 signature）。
      }
      if (signal?.aborted) return { stopReason: 'aborted' };
      // thinking 流死循环命中：中止当前流，构造「诱导跳出」注入消息，重试 1 次。
      // 注入放在新请求的 user 消息尾部（客户端可控的最后位置），明确要求直接给答案。
      // 用「终止+新请求」而非同流续写：注入会污染上下文，原流已陷入循环不可救。
      if (loopAborted) {
        retriedLoop = true;
        const sample = loopDetector.text().slice(-80);
        const repeats = 0; // 检测器内部已确认，这里只传 sample 供展示
        yield { type: 'thinking_loop', sample, repeats, retried: false };
        // 构造注入消息：在最后一条 user 消息后追加一条 user 消息（同角色追加，符合协议）。
        // 诱导文案：指出循环事实 + 要求基于已有分析直接给答案。
        const injected = t('turn.thinkingLoopInject');
        loopRetryMessages = [
          ...messages,
          stored({ role: 'user', content: injected }, { kind: 'user' }),
        ];
        continue; // 回到 for 循环，用注入后的消息重试
      }
      const msg = await stream.finalMessage();
      // 空响应契约：流正常结束但无正文也无工具调用。先按 stop_reason 分型：
      // - stop_reason==='max_tokens'：思考吃满了输出预算，正文没空间生成（配置性问题，
      //   重试无意义——预算组合不变必然复现）。不抛错，落 final 走下方 max_tokens 分支，
      //   携带 thinkingExhausted 标记让 loop 给「调 max_tokens / 降档」的确定性提示。
      // - 其余（end_turn 等）：真正的服务端瞬时空响应，抛 EmptyResponseError 走重试。
      //   emittedText 只标记正文；空响应诊断见下（hadReasoning 区分思考型空响应）。
      if (isEmptyResponse(msg)) {
        if (msg.stop_reason === 'max_tokens') {
          // thinking 预算耗尽自动降档：首轮 thinkingExhausted（仅 thinking 块、无正文/工具调用）
          // 且当前档位可降（不是 low、不是 off、未重试过），自动降到 low 重试 1 次。
          // 重试成功后 activeThinking 还原为原档位，用户无感知；失败则走下方 thinkingExhausted 提示路径。
          if (
            !retriedDowngrade &&
            thinking !== null &&
            thinking !== undefined &&
            thinking.level !== 'low'
          ) {
            retriedDowngrade = true;
            yield { type: 'thinking_downgrade', fromLevel: thinking.level, toLevel: 'low' };
            // 用降级后的 thinking 重发请求：覆盖本次调用的 thinking 参数，不影响外部会话状态
            const downgradeThinking: ThinkingParam = { level: 'low', budgetTokens: thinking.budgetTokens };
            const retryStream = provider.stream({ system, tools, messages: toWire(messages, wireOpts), signal, model, thinking: downgradeThinking });
            let retryThinkingIndex: number | undefined;
            const retryToolBlockIds = new Map<number, string>();
            for await (const event of retryStream) {
              if (signal?.aborted) break;
              if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
                emittedText = true;
                yield { type: 'text', text: event.delta.text };
              } else if (event.type === 'content_block_delta' && event.delta.type === 'input_json_delta') {
                const toolId = retryToolBlockIds.get(event.index);
                if (toolId !== undefined) yield { type: 'tool_args_delta', id: toolId, partialJson: event.delta.partial_json };
              } else if (event.type === 'content_block_start' && event.content_block.type === 'tool_use') {
                const block = event.content_block;
                retryToolBlockIds.set(event.index, block.id);
                yield { type: 'tool_forming', id: block.id, name: block.name };
              } else if (event.type === 'content_block_delta' && event.delta.type === 'thinking_delta') {
                yield { type: 'thinking_delta', text: event.delta.thinking };
              } else if (
                event.type === 'content_block_start' &&
                (event.content_block.type === 'thinking' || event.content_block.type === 'redacted_thinking')
              ) {
                retryThinkingIndex = event.index;
                yield { type: 'thinking_start' };
              } else if (event.type === 'content_block_stop' && event.index === retryThinkingIndex) {
                retryThinkingIndex = undefined;
                yield { type: 'thinking_end' };
              }
            }
            if (signal?.aborted) return { stopReason: 'aborted' };
            const retryMsg = await retryStream.finalMessage();
            if (isEmptyResponse(retryMsg) && retryMsg.stop_reason === 'max_tokens') {
              // 降级重试后仍耗尽：尝试 think-only 自动恢复（落盘 thinking + 注入直接回答）
              if (!retriedThinkOnly && thinking !== null && thinking !== undefined) {
                retriedThinkOnly = true;
                // 落盘的是原始耗尽轮次（msg）的 thinking——那是「最初的长思考」，
                // 是注入提示里「基于已有的分析」所指的分析主体；降档轮（retryMsg）
                // 的 thinking 是 low 档的再尝试，信息量更少，不作为恢复依据落盘。
                const thinkingBlocks = msg.content.filter(
                  (b: Anthropic.ContentBlock): b is Anthropic.ThinkingBlock => b.type === 'thinking',
                );
                // 即时落盘：耗尽轮次的 thinking 单独成一条 assistant 消息，
                // 注入的「直接回答」user 消息也落盘（供 resume / 排查 / 下次请求复用同一份历史）。
                if (thinkingBlocks.length > 0) {
                  messages.push(stored({ role: 'assistant', content: thinkingBlocks }, { kind: 'assistant' }));
                }
                messages.push(
                  stored(
                    { role: 'user', content: [{ type: 'text', text: t('turn.thinkOnlyInjectAnswer') }] },
                    { kind: 'user' },
                  ),
                );
                yield { type: 'thinking_recover', retried: false };
                const recoverStream = provider.stream({
                  system,
                  tools,
                  messages: toWire(messages, wireOpts),
                  signal,
                  model,
                  thinking,
                });
                let recoverThinkingIndex: number | undefined;
                for await (const event of recoverStream) {
                  if (signal?.aborted) break;
                  if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
                    emittedText = true;
                    yield { type: 'text', text: event.delta.text };
                  } else if (event.type === 'content_block_delta' && event.delta.type === 'thinking_delta') {
                    yield { type: 'thinking_delta', text: event.delta.thinking };
                  } else if (
                    event.type === 'content_block_start' &&
                    (event.content_block.type === 'thinking' || event.content_block.type === 'redacted_thinking')
                  ) {
                    recoverThinkingIndex = event.index;
                    yield { type: 'thinking_start' };
                  } else if (event.type === 'content_block_stop' && event.index === recoverThinkingIndex) {
                    recoverThinkingIndex = undefined;
                    yield { type: 'thinking_end' };
                  }
                }
                // 中断：thinking 与注入消息已落盘（中止前轮已落定），正文未成不落盘，直接 aborted。
                if (signal?.aborted) return { stopReason: 'aborted' };
                const recoverMsg = await recoverStream.finalMessage();
                // 注入恢复后仍耗尽：不再重试，退到提示路径。thinking 与注入消息已落盘，
                // 恢复轮次的空 thinking 不落盘（与正常路径「空响应不落盘」一致）。
                if (isEmptyResponse(recoverMsg) && recoverMsg.stop_reason === 'max_tokens') {
                  final = recoverMsg;
                  skipFinalPush = true; // 恢复轮次无正文，且 thinking/注入已落盘，跳过统一 push
                  break;
                }
                // 注入恢复成功：恢复正文即时落盘为独立 assistant 消息（thinking 已单独落盘，
                // 二者不合并——保留「前轮只思考、后轮直接作答」的轨迹分界，供 resume 与排查）。
                messages.push(stored({ role: 'assistant', content: recoverMsg.content }, { kind: 'assistant' }));
                final = recoverMsg;
                skipFinalPush = true; // 已即时落盘，跳过统一 push
                break;
              }
              // 不可恢复（thinking 为 null/undefined / 已重试过）：直接落 final，走提示路径
              final = retryMsg;
              break;
            }
            final = retryMsg;
            break;
          }
          // 不可降级（已是 low / off / 已重试过）：直接落 final，走 thinkingExhausted 提示路径
          final = msg;
          break;
        }
        // 带诊断上下文：空响应的成因决定可重试性，只报事实不猜原因。
        // maxTokens 必须一起带上——outputTokens 的绝对值无法区分两类成因，
        // 只有它与上限的比值能分开「预算烧光」（重发无用）与「正常结束但没写正文」（重试有效）。
        throw new EmptyResponseError('empty response (no text, no tool_use)', {
          hadReasoning: msg.content.some((b: Anthropic.ContentBlock) => b.type === 'thinking'),
          stopReason: msg.stop_reason,
          outputTokens: msg.usage?.output_tokens ?? 0,
          maxTokens: provider.maxTokens,
          model: msg.model,
          provider: providerName,
        });
      }
      final = msg;
      break;
    } catch (e) {
      if (signal?.aborted) return { stopReason: 'aborted' };
      // 上下文溢出：不报错，交给外层循环压缩历史后重试本回合（仅在尚未吐字时才有意义）
      if (!emittedText && isContextOverflowError(e)) {
        return { stopReason: 'overflow' };
      }
      if (!isRetryableError(e) || attempt >= RETRY_MAX_ATTEMPTS) {
        yield { type: 'error', message: errorMessageWithAdvice(e), cause: e };
        return { stopReason: 'error' };
      }
      // 吐字后断连（emittedText）：同样整轮重试。partial 正文只在 UI 的 DisplayItem，
      // 未落盘 messages（见下方 messages.push 仅在流成功后执行），故重发不会造成历史重复。
      // UI 侧靠 retry 事件的 boundary note 隔离：重试后正文另开 assistant 条目，不续接残文。
      // 流式单向、partial 无法原子回滚，整轮丢弃重试。
      const delay = computeRetryDelay(attempt, e);
      yield {
        type: 'retry',
        attempt,
        delayMs: delay,
        // 吐字后断连（emittedText）：屏幕上有残文，标记 hadPartial 让 UI 撤回残文气泡（B 方案）。
        hadPartial: emittedText,
        // cause 供 wire 落盘定位成因（空响应带诊断上下文，断连带网络 code）；UI 不消费。
        cause: e,
        message: emittedText
          ? t('turn.retryAfterPartial', { delay: Math.round(delay), attempt, max: RETRY_MAX_ATTEMPTS - 1 })
          : t('turn.retry', { delay: Math.round(delay), attempt, max: RETRY_MAX_ATTEMPTS - 1 }),
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

  if (!skipFinalPush) {
    messages.push(stored({ role: 'assistant', content: final.content }, { kind: 'assistant' }));
  }

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
    // 工具调用通道退化：零 tool_use，但正文里有调用标签——模型把调用打成了纯文本，工具从未执行。
    // 回合判定仍是 end_turn（确实没有工具要执行，控制流不变），只加标记让 loop 发 notice 消除静默。
    if (detectToolCallLeak(final)) {
      return { stopReason: 'end_turn', usage, toolCallLeak: true };
    }
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
      const preset: ToolResult = { content: `工具调用被拒绝：${auth.reason}`, isError: true };
      if (auth.errorCode !== undefined) preset.errorCode = auth.errorCode;
      prepared.push({ tu, access: { kind: 'all' }, preset });
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
          // 兜底长度上限：这一处赋值同时决定 tool_end 事件（→ items）与 makeToolResult（→ history），
          // 单点拦截覆盖三处副本，且界面与模型看到的是同一份内容。放在 hook 之后：hook 先见全文。
          p.result = capToolResult(result);
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
    yield { type: 'tool_end', id: p.tu.id, name: p.tu.name, result: result.content, isError: result.isError, errorCode: result.errorCode };
    toolResults.push(makeToolResult(p.tu.id, result));
    // 完成放行：被本任务卡住的后续任务现在启动，其 tool_start 排在本 tool_end 之后
    scheduler.drain();
    while (pendingStarts.length > 0) yield pendingStarts.shift()!;
  }
  messages.push(stored({ role: 'user', content: toolResults }, { kind: 'tool' }));

  return { stopReason: userAborted ? 'aborted' : 'tool_use', usage };
}

/**
 * 组装 tool_result 块。result.images/videos 非空时 content 从纯文本升格为块数组
 * [{type:'text',text}, ...mediaBlocks]（Anthropic 官方支持 tool_result 内嵌 image，
 * 这是 read_media 等工具把媒体回灌给模型的通道；video 块是扩展形状，官方类型无此块，
 * 由下游协议适配层翻译）。无媒体时维持纯文本形态不变。
 */
function makeToolResult(
  toolUseId: string,
  result: ToolResult,
): Anthropic.ToolResultBlockParam {
  const base = { type: 'tool_result' as const, tool_use_id: toolUseId, is_error: result.isError };
  const hasMedia = (result.images?.length ?? 0) > 0 || (result.videos?.length ?? 0) > 0;
  if (!hasMedia) {
    return { ...base, content: result.content };
  }
  const mediaBlocks = [
    ...(result.images ?? []).map((img) => ({
      type: 'image' as const,
      source: {
        type: 'base64' as const,
        media_type: img.mediaType as Anthropic.Base64ImageSource['media_type'],
        data: img.base64,
      },
    })),
    ...(result.videos ?? []).map((v) => ({
      type: 'video' as const,
      source: { type: 'base64' as const, media_type: v.mediaType, data: v.base64 },
    })),
  ];
  const content = [{ type: 'text' as const, text: result.content }, ...mediaBlocks];
  return { ...base, content: content as Anthropic.ToolResultBlockParam['content'] };
}
