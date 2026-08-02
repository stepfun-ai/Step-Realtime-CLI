import type { ChatProvider } from '../provider/types.js';
import { t } from '../i18n.js';
import { toAnthropicTools } from '../tools/index.js';
import { filterToolsByCapabilities } from '../tools/capabilities.js';
import type { ToolContext } from '../tools/types.js';
import {
  billedTokens,
  COMPACT_USER_MESSAGE_MAX_TOKENS,
  estimateTokens,
  fullCompact,
  microCompact,
  OVERFLOW_SHRINK_RATIOS,
  shouldCompact,
  usageTotalTokens,
  type CompactionThresholds,
} from './compaction/compact.js';
import type { AgentEvent } from './events.js';
import { type LoopHooks, resolveContinuation } from './hooks.js';
import { type StoredMessage, stored } from './message.js';
import { buildSettleMessage, notificationIdFor } from './background/notify.js';
import type { WireEvent } from './wirelog.js';
import { runTurn } from './runTurn.js';

export type { AgentEvent } from './events.js';

/** 压缩时保留的最近消息条数。 */
const KEEP_RECENT = 6;
/** 单次 runAgent 内因溢出触发强制压缩重试的上限，防死循环。 */
const MAX_OVERFLOW_RETRIES = 3;
export interface RunAgentOptions {
  provider: ChatProvider;
  system: string;
  ctx: ToolContext;
  /** 会话历史（storage 层信封），会被就地追加消息，并在压缩时就地替换。 */
  messages: StoredMessage[];
  /** 中断信号：用户按 Esc 时触发，贯穿模型流与工具执行。 */
  signal?: AbortSignal;
  /** 循环钩子（权限、结果后处理、自动续接）。缺省即全部默认行为。 */
  hooks?: LoopHooks;
  /**
   * 单次 runAgent 内最多的 模型↔工具 往返轮数。默认 500——这是防死循环的「大断路器」，
   * 不作为主防线：上下文由循环内压缩（compaction）兜底，正常任务远不会触及此值。
   */
  maxIterations?: number;
  /** 工具白名单（工具名）。省略 = 全部工具。子 agent 用它收窄工具集。 */
  allowedTools?: readonly string[];
  /** 模型覆盖。省略 = 用 provider 默认模型。子 agent 可指定不同模型。 */
  model?: string;
  /** thinking 覆盖（三态：undefined 构造默认 / 对象覆盖 / null 抑制），透传到每回合的 provider.stream。 */
  thinking?: { budgetTokens?: number } | null;
  /** 压缩阈值。省略 = 不在循环内自动压缩（也不做溢出兜底压缩）。 */
  compaction?: CompactionThresholds;
  /** 压缩摘要专用模型覆盖（大小模型协同）。省略 = 用 provider 默认模型压缩。 */
  compactionModel?: string;
  /**
   * 用户原话保真预算覆盖（压缩时在摘要之外单独保留的用户原始消息）。
   * 省略 = 用 compact.ts 的默认值（20K / 头 2K）。溢出重试时会在此基础上再按收缩比缩小。
   */
  userMessageBudget?: { maxTokens?: number; headTokens?: number };
  /** 当前 TODO 清单（独立 store），压缩时拼进摘要尾部，防止压缩后丢任务进度。 */
  todos?: readonly { title: string; status: string }[];
  /**
   * 后台任务终态通知的 step 边界注入（TUI 交互模式开启）：busy 中终态的通知在每个
   * runTurn 回合结束后、模型下一次调用前 flush 进 messages，不等整个循环结束。
   * 缺省关闭（如 -p 模式维持退出时 drain 到 stderr）。
   */
  injectBackgroundNotifications?: boolean;
  /**
   * 事件日志写入钩（组合根注入）：循环内产生的非消息事件（context.apply_compaction、
   * background.notify_delivered）经它追加进 wire.jsonl。缺省 = 只走快照与消息日志通道。
   */
  onWireEvent?: (event: WireEvent) => void;
}

/** 就地把 target 的内容替换为 next（保持外部引用不变，压缩结果对调用方可见）。 */
function replaceMessages(target: StoredMessage[], next: StoredMessage[]): void {
  target.splice(0, target.length, ...next);
}

/** 求上次活动时间戳（ms）：最后一条 assistant 消息的 ts，没有则用最后一条消息 ts；空历史返回 undefined。 */
function lastActivityMs(messages: StoredMessage[]): number | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]!.origin.kind === 'assistant') return Date.parse(messages[i]!.ts);
  }
  const last = messages[messages.length - 1];
  return last === undefined ? undefined : Date.parse(last.ts);
}

/**
 * 循环内压缩：超阈值时先 micro（清旧 tool_result 正文，廉价），仍超再 full（LLM 摘要）。
 * 就地改 messages。返回是否发生了实际压缩（用于是否发 notice）。
 * micro 带缓存冷 gate：缓存仍热时跳过 micro（不击穿热前缀），直接评估 full（重建同构前缀更安全）。
 */
async function maybeCompact(
  provider: ChatProvider,
  messages: StoredMessage[],
  usedTokens: number,
  thresholds: CompactionThresholds,
  todos?: readonly { title: string; status: string }[],
  compactionModel?: string,
  userMessageBudget?: { maxTokens?: number; headTokens?: number },
  onWireEvent?: (event: WireEvent) => void,
): Promise<boolean> {
  if (!shouldCompact(usedTokens, thresholds)) return false;
  let acted = false;
  // 预防性压缩：micro 会原地改写历史击穿缓存，故仅在缓存已冷时做；热缓存交给 full 重建前缀
  const activity = lastActivityMs(messages);
  const micro = microCompact(
    messages,
    KEEP_RECENT,
    activity === undefined ? undefined : { lastActivityMs: activity },
  );
  if (micro.clearedCount > 0) {
    replaceMessages(messages, micro.messages);
    acted = true;
  }
  // micro 后无新 usage，用字符估算重判是否仍需 full
  if (shouldCompact(estimateTokens(messages), thresholds)) {
    const compacted = await fullCompact(
      provider,
      messages,
      KEEP_RECENT,
      todos,
      compactionModel,
      userMessageBudget,
    );
    if (compacted !== messages) {
      replaceMessages(messages, compacted);
      acted = true;
    }
  }
  // 压缩应用事件落盘：重放到此事件时内存历史整体替换为压缩后的存活序列
  if (acted) {
    onWireEvent?.({ type: 'context.apply_compaction', ts: new Date().toISOString(), messages: [...messages] });
  }
  return acted;
}

/**
 * 驱动一次 agent 交互：反复执行 runTurn 回合，直到模型不再要求工具、被中断或出错。
 * 自身不含回合内逻辑（那些在 runTurn），负责多回合编排、终止事件、循环内压缩与溢出兜底。
 */
export async function* runAgent(opts: RunAgentOptions): AsyncGenerator<AgentEvent> {
  const { provider, system, ctx, messages, signal, model, thinking, compaction } = opts;
  // 能力门控的工具卸载：模型未声明对应能力（如 image_in）时，门控工具（如 read_media）
  // 不进 tools 数组也不进执行白名单——模型看不到就不会尝试调用；工具内运行时检查保留为兜底。
  // ctx.capabilities 随 /model、/provider 切换刷新，本过滤每 run 生效、逐回合一致。
  const allowedTools =
    opts.allowedTools === undefined
      ? undefined
      : filterToolsByCapabilities(opts.allowedTools, ctx.capabilities);
  const hooks = opts.hooks ?? {};
  const maxIterations = opts.maxIterations ?? 500;
  const allowedSet = allowedTools === undefined ? undefined : new Set(allowedTools);
  let overflowRetries = 0;

  for (let iter = 0; iter < maxIterations; iter++) {
    // step 边界注入：上一回合期间终态的后台任务通知在此 flush 进 messages，
    // 模型本回合即可见（多条同时终态时各自独立条目同批注入，不合成单条大消息）
    if (opts.injectBackgroundNotifications === true && ctx.background !== undefined) {
      for (const task of ctx.background.drainSettled()) {
        // XML 信封 + 结构化 origin（background_task）：回合中途注入，不单独开轮（startsPromptTurn=false）
        const msg = buildSettleMessage(task, { startsPromptTurn: false });
        messages.push(msg);
        // 送达事件落盘：通知进历史即视为送达（与 append_message 回填互为冗余）
        opts.onWireEvent?.({
          type: 'background.notify_delivered',
          ts: msg.ts,
          taskId: task.id,
          status: task.status,
          notificationId: notificationIdFor(task),
        });
      }
    }
    // 每回合重新组装 tools：tool_search 等动态注册的工具（DYNAMIC_TOOLS）在下一回合
    // 就要带完整 schema 进请求，不能在循环外取一次快照复用
    const tools = toAnthropicTools(allowedTools);
    const lenBefore = messages.length;
    const turn = runTurn({ provider, system, tools, ctx, messages, hooks, signal, allowedTools: allowedSet, model, thinking });
    let step = await turn.next();
    while (!step.done) {
      yield step.value;
      step = await turn.next();
    }
    const outcome = step.value;
    // goal token 计量：每回合拿到真实 usage 即按计费口径累计（仅 active 累计，见 GoalMode.addTokens）
    if (outcome.usage !== undefined) ctx.goal?.addTokens(outcome.usage);

    switch (outcome.stopReason) {
      case 'aborted':
        messages.push(
          stored(
            {
              role: 'user',
              content: '用户中断了模型的本次输出。这不是系统错误，请等待用户的下一步指示。',
            },
            'injection',
          ),
        );
        yield { type: 'aborted' };
        return;
      case 'error':
        // error 事件已在 runTurn 内产出
        return;
      case 'overflow': {
        // 上下文溢出：强制压缩后原地重试本回合（不计入 iter，单独限次防死循环）
        if (compaction === undefined || overflowRetries >= MAX_OVERFLOW_RETRIES) {
          yield {
            type: 'error',
            message: t('loop.overflow.noCompact'),
          };
          return;
        }
        overflowRetries++;
        // 递进收缩：第 N 次重试用更狠的参数，避免三次重试跑同一套（压不下去还烧三次摘要调用）
        const ratio = OVERFLOW_SHRINK_RATIOS[Math.min(overflowRetries - 1, OVERFLOW_SHRINK_RATIOS.length - 1)]!;
        const keepRecent = Math.max(2, Math.floor(KEEP_RECENT * ratio));
        const userMaxTokens = Math.max(
          1_000,
          Math.floor((opts.userMessageBudget?.maxTokens ?? COMPACT_USER_MESSAGE_MAX_TOKENS) * ratio),
        );
        let acted = false;
        // 溢出保命路径：不带 cacheGate（腾空间优先于保缓存），门槛也压到 1 token（能省就省）
        const micro = microCompact(messages, keepRecent, undefined, 1);
        if (micro.clearedCount > 0) {
          replaceMessages(messages, micro.messages);
          acted = true;
        }
        const compacted = await fullCompact(
          provider,
          messages,
          keepRecent,
          opts.todos,
          opts.compactionModel,
          { maxTokens: userMaxTokens },
        );
        if (compacted !== messages) {
          replaceMessages(messages, compacted);
          acted = true;
        }
        if (!acted) {
          yield {
            type: 'error',
            message: t('loop.overflow.nothing'),
          };
          return;
        }
        // 溢出保命压缩同样落 apply_compaction 事件（与循环内压缩同一事实源口径）
        opts.onWireEvent?.({ type: 'context.apply_compaction', ts: new Date().toISOString(), messages: [...messages] });
        yield { type: 'notice', message: t('loop.overflow.retried') };
        iter--; // 抵消本轮自增，重试当前回合
        continue;
      }
      case 'max_tokens': {
        if (outcome.usage !== undefined) {
          yield {
            type: 'usage',
            totalTokens: usageTotalTokens(outcome.usage),
            measuredLength: messages.length,
            billedDelta: billedTokens(outcome.usage),
          };
        }
        // 截断提示（终止 + 明确提示，不自动续写）：带上当前上限便于用户调整。
        // thinkingExhausted：思考吃满预算、正文零输出——给「调 max_tokens / 降档」的确定性提示，
        // 而非普通截断的「回复继续」（继续也没用，预算组合不变必然复现）。
        const limit = provider.maxTokens;
        yield {
          type: 'notice',
          message: outcome.thinkingExhausted
            ? limit !== undefined
              ? t('loop.maxTokens.thinkingExhaustedWithLimit', { limit })
              : t('loop.maxTokens.thinkingExhausted')
            : limit !== undefined
              ? t('loop.maxTokens.truncatedWithLimit', { limit })
              : t('loop.maxTokens.truncated'),
        };
        yield { type: 'turn_done' };
        return;
      }
      case 'end_turn': {
        if (outcome.usage !== undefined) {
          yield {
            type: 'usage',
            totalTokens: usageTotalTokens(outcome.usage),
            measuredLength: messages.length,
            billedDelta: billedTokens(outcome.usage),
          };
        }
        // goal 等自主续接：不在本 run 内续跑，产出 continuation 事件回 App 层，由 App 发起下一轮 run
        const cont = await resolveContinuation(hooks);
        if (cont !== null) {
          yield { type: 'continuation', inject: cont.inject };
        }
        yield { type: 'turn_done' };
        return;
      }
      case 'tool_use': {
        if (outcome.usage !== undefined) {
          yield {
            type: 'usage',
            totalTokens: usageTotalTokens(outcome.usage),
            measuredLength: messages.length,
            billedDelta: billedTokens(outcome.usage),
          };
        }
        // 循环内压缩：用真实 usage（+ 本回合新增消息的尾部估算）判断，超阈值先 micro 再 full
        if (compaction !== undefined) {
          const used =
            outcome.usage !== undefined
              ? usageTotalTokens(outcome.usage) + estimateTokens(messages.slice(lenBefore))
              : estimateTokens(messages);
          if (await maybeCompact(provider, messages, used, compaction, opts.todos, opts.compactionModel, opts.userMessageBudget, opts.onWireEvent)) {
            yield { type: 'notice', message: t('loop.autoCompacted') };
            // 压缩后上下文占用已回落，但下一条真实 usage 要等下一回合 API 响应才到，
            // 期间状态栏会一直停在压缩前的旧值（实测：用户以为压缩没生效）。
            // 摘要调用的 usage 不代表会话口径，用字符估算让状态栏立刻反映压缩效果。
            // measuredLength=压缩后全长：该估算已覆盖当前全部消息，游标设为全长，显示层尾部为空、不再叠加。
            yield { type: 'usage', totalTokens: estimateTokens(messages), measuredLength: messages.length };
          }
        }
        continue; // 有工具结果回灌，进入下一回合
      }
    }
  }

  // maxIterations 撞线：单轮步数上限降级为「本 run 用完」——hook 给出续接描述时
  // 产出 continuation + turn_done 正常收尾（换下一个 run 继续）；
  // hook 缺省（headless、无 goal）返回 null，照旧 error，非 goal 场景行为不变。
  const cont = await resolveContinuation(hooks);
  if (cont !== null) {
    yield { type: 'continuation', inject: cont.inject };
    yield { type: 'turn_done' };
    return;
  }

  yield { type: 'error', message: t('loop.maxIterations', { max: maxIterations }) };
}
