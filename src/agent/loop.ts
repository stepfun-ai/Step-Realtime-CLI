import type { ChatProvider } from '../provider/types.js';
import { t } from '../i18n.js';
import { toAnthropicTools } from '../tools/index.js';
import { filterToolsByCapabilities } from '../tools/capabilities.js';
import type { ToolContext } from '../tools/types.js';
import {
  billedTokens,
  COMPACT_USER_MESSAGE_MAX_TOKENS,
  estimateTextTokens,
  estimateTokens,
  fullCompact,
  microCompact,
  OVERFLOW_SHRINK_RATIOS,
  shouldCompact,
  usageTotalTokens,
  type CompactionThresholds,
} from './compaction/compact.js';
import { EmptyResponseError } from '../provider/retry.js';
import type { AgentEvent } from './events.js';
import { type LoopHooks, resolveContinuation } from './hooks.js';
import { type StoredMessage, stored } from './message.js';
import { buildSettleMessage } from './background/notify.js';
import { crossedLocalMidnight, formatLocalNow } from './nowContext.js';
import type { WireEvent } from './wirelog.js';
import { runTurn } from './runTurn.js';
import { emptyContinuationState, advanceContinuation, checkContinuationSafety } from './continuation.js';
import { createRoundLoopDetector, fingerprintRound } from './roundLoop.js';

export type { AgentEvent } from './events.js';

/** 取最后一条 assistant 消息的正文文本（拼接所有 text 块，忽略思考/工具块）。无则空串。 */
function lastAssistantText(messages: StoredMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const sm = messages[i]!;
    if (sm.message.role !== 'assistant') continue;
    const content = sm.message.content;
    if (typeof content === 'string') return content;
    let out = '';
    for (const block of content) {
      if (block.type === 'text') out += block.text;
    }
    return out;
  }
  return '';
}

/** 守卫拦下自动续写时的用户提示：说清停在哪一步、为什么、下一步做什么。 */
function continuationStopMessage(
  reason: string,
  detail: number | undefined,
  limit: number | undefined,
): string {
  switch (reason) {
    case 'no_progress':
      return t('loop.continue.stop.noProgress');
    case 'identical_to_previous':
      return t('loop.continue.stop.identical');
    case 'restarted_from_beginning':
      return t('loop.continue.stop.restarted');
    case 'repeating_tail':
      return t('loop.continue.stop.repeating', { n: detail ?? 0 });
    case 'stalled':
      return t('loop.continue.stop.stalled', { n: detail ?? 0 });
    case 'max_continues':
      return limit !== undefined
        ? t('loop.continue.stop.maxWithLimit', { n: detail ?? 0, limit })
        : t('loop.continue.stop.max', { n: detail ?? 0 });
    default:
      return limit !== undefined
        ? t('loop.maxTokens.truncatedWithLimit', { limit })
        : t('loop.maxTokens.truncated');
  }
}

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
  /**
   * 输出被 `max_tokens` 截断时，自动续写的最大次数。默认 0（不自动续写，保持既有行为）。
   *
   * 只对「正文被截断」生效；「思考吃满预算、正文零输出」不走续写——那是预算配置问题，
   * 续写不改变预算，实测续两轮正文仍为空。判据是 `TurnOutcome.thinkingExhausted`。
   * 每轮续写产出都过 {@link checkContinuationSafety} 的循环守卫。
   */
  maxAutoContinues?: number;
  /** 模型覆盖。省略 = 用 provider 默认模型。子 agent 可指定不同模型。 */
  model?: string;
  /** thinking 覆盖（三态：undefined 构造默认 / 对象覆盖 / null 抑制），透传到每回合的 provider.stream。 */
  thinking?: { budgetTokens?: number } | null;
  /** 渠道名（如 stepfun / openai / anthropic），用于空响应诊断上下文。 */
  providerName?: string;
  /** 压缩阈值。省略 = 不在循环内自动压缩（也不做溢出兜底压缩）。 */
  compaction?: CompactionThresholds;
  /**
   * 上一次真实 usage 的快照，用作首个回合压缩预检的基准。
   *
   * 为什么需要由调用方传入：`lastUsage` 是本函数的局部状态，每次 runAgent 调用都从零开始，
   * 而用户每提交一条消息就是一次新调用。于是首回合只能退回纯字符估算——那个口径不含
   * system prompt 与 tools schema，实测只有真实占用的一半（185.8k vs 380.9k）。
   * 结果是单回合的纯对话轮永远按被低估一半的数字判断，长会话可以一路涨到接近满窗仍不压缩。
   *
   * 调用方（TUI / 无头入口）本就在维护同语义的显示口径，传进来即可让首回合也用真实基准。
   * `measuredLength` = 该 total 覆盖到历史的哪个下标，其后的新增消息按估算叠加。
   */
  initialUsage?: { total: number; measuredLength: number };
  /** 压缩摘要专用模型覆盖（大小模型协同）。省略 = 用 provider 默认模型压缩。 */
  compactionModel?: string;
  /**
   * 压缩摘要专用 provider（`[compaction] model` 指向的别名跨渠道时由组合根构造）。
   * 省略 = 用主会话 provider（同渠道换模型或未配置的情形）。
   */
  compactionProvider?: ChatProvider;
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
   * 用户主动插队（Ctrl+S steer）：共享可变数组，UI 把队列草稿塞进来，循环在 step 边界
   * （下一次模型调用前）取走注入。与队列语义的区别：队列等整个 run 结束，steer 在
   * 回合内边界就生效。只能由 UI 在 busy 时写入；数组就地 splice 清空。
   */
  steerQueue?: string[];
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
 * 循环内压缩的结果三态。
 *
 * 布尔返回不够用：`false` 混了两种完全不同的情况——「没超阈值、无需动手」与
 * 「超了阈值、动过手但压不出结果」。后者此前是**静默**的：fullCompact 失败会原样
 * 返回历史，调用点看到 false 便既不提示也不置饱和，于是每一轮都再烧一次摘要请求，
 * 用户全程看不到任何信号，直到最终 overflow 报错。三态把这两种分开。
 */
interface CompactOutcome {
  /** 历史确实被改写了（micro 清理或 full 摘要成功）。 */
  acted: boolean;
  /** 超了阈值、真的尝试过 full 摘要，但没能产出可用结果（失败或质量闸门未过）。 */
  attemptedButFailed: boolean;
}

/**
 * 循环内压缩：超阈值时先 micro（清旧 tool_result 正文，廉价），仍超再 full（LLM 摘要）。
 * 就地改 messages。返回三态结果（见 {@link CompactOutcome}）。
 * micro 带缓存冷 gate：缓存仍热时跳过 micro（不击穿热前缀），直接评估 full（重建同构前缀更安全）。
 *
 * signal 透传给 full 压缩的模型调用：full 要等一次完整摘要请求（长历史可达数十秒），
 * 期间用户按 Esc 应当能放弃。中断时 fullCompact 原样返回历史，本函数据此不发 apply_compaction
 * 事件、不落盘，会话停在压缩前状态。micro 是本地纯计算、瞬时完成，无需中断。
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
  compactionProvider?: ChatProvider,
  signal?: AbortSignal,
): Promise<CompactOutcome> {
  if (!shouldCompact(usedTokens, thresholds)) return { acted: false, attemptedButFailed: false };
  let acted = false;
  let attemptedButFailed = false;
  // micro 之前的估算基线，供下面按比例折算 usedTokens 用
  const estBefore = estimateTokens(messages);
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
  /**
   * micro 之后是否仍需 full。
   *
   * 不能直接拿 `estimateTokens(messages)` 重判：那个口径只算 messages、不含 system prompt
   * 与 tools schema，实测只有真实占用的一半。用它重判会把「其实仍然超线」判成「已经够了」，
   * 于是 full 永不执行——调用方即便传入了准确的真实 usage 也被这一步抹掉。
   *
   * 改为保住 usedTokens 的量级：micro 没清理任何东西时历史未变，原值直接有效；
   * 清理过则按估算的缩减比例折算，既反映 micro 的收益，又不丢失真实口径。
   */
  const afterMicro =
    micro.clearedCount > 0 && estBefore > 0
      ? Math.round(usedTokens * (estimateTokens(messages) / estBefore))
      : usedTokens;
  if (shouldCompact(afterMicro, thresholds)) {
    const compacted = await fullCompact(
      compactionProvider ?? provider,
      messages,
      KEEP_RECENT,
      todos,
      compactionModel,
      userMessageBudget,
      signal,
    );
    if (compacted !== messages) {
      replaceMessages(messages, compacted);
      acted = true;
    } else if (signal?.aborted !== true) {
      // full 动过手却原样返回：摘要请求失败、或质量闸门连续未过。
      // 中断除外——那是用户主动放弃，不是失败。
      attemptedButFailed = true;
    }
  }
  // 压缩应用事件落盘：重放到此事件时内存历史整体替换为压缩后的存活序列
  if (acted) {
    onWireEvent?.({ type: 'context.apply_compaction', ts: new Date().toISOString(), messages: [...messages] });
  }
  return { acted, attemptedButFailed };
}

/**
 * 驱动一次 agent 交互：反复执行 runTurn 回合，直到模型不再要求工具、被中断或出错。
 * 自身不含回合内逻辑（那些在 runTurn），负责多回合编排、终止事件、循环内压缩与溢出兜底。
 */
export async function* runAgent(opts: RunAgentOptions): AsyncGenerator<AgentEvent> {
  const { provider, system, ctx, messages, signal, model, thinking, providerName, compaction, maxAutoContinues = 0 } = opts;
  const safeMaxAutoContinues = maxAutoContinues ?? 0;
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
  /**
   * 单轮步数上限前的分级提醒标记：每档在一轮交互内只触发一次。
   *
   * 阈值按 maxIterations 的比例计算（不硬编码），覆盖可配置的小值场景。
   * 两档比例写成具名常量，注释选型理由。
   */
  const MID_RATIO = 0.5; // 50%：首道预警——烧掉一半预算时提醒，留足收尾空间
  const LATE_RATIO = 0.8; // 80%：末道预警——逼近上限，必须立即收敛
  const midThreshold = Math.floor(maxIterations * MID_RATIO);
  const lateThreshold = Math.floor(maxIterations * LATE_RATIO);
  // 防止极小 maxIterations 下两档撞在同一轮（如 maxIterations=1 → 两档都是 0）
  let midWarned = false;
  let lateWarned = false;
  /**
   * 上一次真实 usage 的快照，供**发请求前**的压缩预检使用（见循环顶部的 preflight）。
   *
   * 为什么要记它：预检发生在 API 响应之前，本回合没有真实 usage 可用；而纯字符估算
   * 不含 system prompt 与 tools schema，会系统性低估。折中口径与 TUI 状态栏一致——
   * 「上一轮真实 usage（已覆盖到 measuredLength 条）+ 之后新增消息的估算」。
   * 压缩就地改写 messages 后此快照失效，必须清空，否则 measuredLength 会指向
   * 已不存在的下标、把整段历史当成「已测量」而漏算。
   *
   * 初值取自 `opts.initialUsage`：本函数每次调用都重建局部状态，而用户每提交一条消息
   * 就是一次新调用。不接住外部快照的话首回合必然退回估算，实测那个口径只有真实占用的
   * 一半，于是单回合的纯对话轮永远按被低估的数字判断，长会话能一路涨到接近满窗仍不压缩。
   */
  let lastUsage: { total: number; measuredLength: number } | undefined = opts.initialUsage;
  /**
   * 框架侧固定开销（system prompt + tools schema）的估算值。
   *
   * **只在没有真实 usage、必须靠字符估算判断时叠加。** `estimateTokens` 的入参只有 messages，
   * 而窗口上限 `maxContextSize` 装的是 system + tools + messages 三样，两者口径不对等；
   * 本项目这部分尤其重（指令文件全文、技能清单、数十个工具的完整 JSON Schema）。
   * 有真实 usage 时绝不能加——真实值本身已含这两部分，再加即双算。
   *
   * 取一次不逐回合重算：动态注册的工具会让 tools 略有变化，量级远小于本项修正的偏差。
   */
  const frameworkTokens =
    estimateTextTokens(system) + estimateTextTokens(JSON.stringify(toAnthropicTools(allowedTools)));
  /**
   * 纯估算口径下的「当前总占用」：历史估算 + 框架固定开销。
   *
   * 存在的理由是**口径一致**。窗口上限装的是 system + tools + messages 三样，
   * 任何要跟 `maxContextSize` 比较、或要显示给用户当占用的数字，都必须是同一口径。
   * 此前压缩后刷新状态栏与饱和判定都用裸 `estimateTokens(messages)`，比预检口径少了
   * 框架开销（实测约 27k / 147k，约 18%），两个后果都真实存在：
   * 状态栏在压缩后先掉到偏低值、下一轮真实 usage 回来又跳上去（用户看到数字忽高忽低）；
   * 饱和判定被低估后判成「没超线」，于是下一轮又压一次（多烧一次摘要请求且几乎无收益）。
   *
   * 有真实 usage 时不要用这个函数——真实值本身已含框架部分，叠加即双算。
   */
  const estimatedUsedWithFramework = (): number => estimateTokens(messages) + frameworkTokens;
  /**
   * 压缩饱和标记：一次压缩做完后**仍然**超阈值，说明剩下的历史压不动了
   * （保留窗口内的消息本身就超预算，或摘要请求反复失败）。
   *
   * 不设这个标记的后果是实测出来的：预检每回合都判一次，饱和状态下就变成每回合白烧
   * 一次摘要请求——花钱、拖慢、且每次都压不下来。所以饱和后本 run 内不再自动压缩，
   * 改为明确告知用户「压不下去了，请 /compact 或 /new」，把决定权交回去。
   */
  let compactionSaturated = false;
  let contState: ReturnType<typeof emptyContinuationState> | undefined;
  /**
   * 跨回合零进展检测器（循环外创建，每次 runAgent 自然归零）。
   *
   * 挂在 tool_use 分支的 continue 前：当模型连续多轮产出完全相同的 assistant 消息
   * 且工具结果也无变化时，判定零进展循环并注入警告或硬停。
   * 检测器内部有状态（streak），由本函数持有生命周期。
   */
  const roundLoopDetector = createRoundLoopDetector();

  for (let iter = 0; iter < maxIterations; iter++) {
    // step 边界注入：上一回合期间终态的后台任务通知在此 flush 进 messages，
    // 模型本回合即可见（多条同时终态时各自独立条目同批注入，不合成单条大消息）
    if (opts.injectBackgroundNotifications === true && ctx.background !== undefined) {
      for (const task of ctx.background.drainSettled()) {
        // XML 信封 + 结构化 origin（background_task）：回合中途注入，不单独开轮（startsPromptTurn=false）
        const msg = buildSettleMessage(task, { startsPromptTurn: false });
        messages.push(msg);
        // delivered 事件不在此落盘：消息本体要等回合末 persist 才落盘，事件先写会留下
        // 「事件在、消息不在」的崩溃窗口——对账误判已送达，通知丢失（待办 #17）。
        // 统一由 persist 与消息本体同刻补写；消息带 background_task origin，补写可寻址。
      }
    }
    // 用户主动插队（Ctrl+S）：step 边界取走共享数组注入，模型本回合即可见。
    // 注入即视为用户消息（kind: 'user'）：是用户的原话，回放/压缩口径与正常输入一致。
    if (opts.steerQueue !== undefined && opts.steerQueue.length > 0) {
      const steered = opts.steerQueue.splice(0);
      messages.push(
        stored(
          { role: 'user', content: t('loop.steerInject', { text: steered.join('\n\n') }) },
          { kind: 'user' },
        ),
      );
      yield { type: 'notice', message: t('loop.steerInjected', { count: steered.length }) };
    }
    // ── 跨天提醒 ──
    // 会话跨过本地午夜后，system prompt 里那份时间快照的日期部分就错了。system 整块打
    // cache_control（见 provider/prepare.ts 的 buildSystemBlocks），逐轮改写它会连带
    // 让其后的 tools 与历史缓存断点一起失效，所以不动 system，改用一条注入消息修正。
    //
    // baseline 取「最后一条消息的本地日期」而不是局部状态变量：runLoop 每个 prompt 回合
    // 重新调用一次，局部变量在回合边界就重置了，而跨天几乎总是发生在回合之间——用局部
    // 变量等于永远检测不到。messages 跨回合累积且落盘，resume 后同样成立。
    // 注入的提醒自身成为最后一条消息、其 ts 即今天，故天然只注入一次，不需要 warned 标记。
    const nowForDateCheck = new Date();
    if (crossedLocalMidnight(messages[messages.length - 1]?.ts, nowForDateCheck)) {
      messages.push(
        stored(
          { role: 'user', content: t('loop.dateChanged', { now: formatLocalNow(nowForDateCheck) }) },
          { kind: 'injection' },
        ),
      );
    }
    // 单轮步数分级提醒：达到 mid（50%）/ late（80%）阈值时各注入一次，不重复。
    // 挂在循环顶部而非 tool_use 分支：保证 roundLoop.stop 等提前返回的场景下
    // 也能在命中阈值时发出提醒（与 roundLoop 的接线并列，不互相吞没）。
    // iter + 1 = 已完成轮数，与 maxIterations 撞线判定同一口径。
    const turnCount = iter + 1;
    if (!midWarned && turnCount >= midThreshold) {
      midWarned = true;
      messages.push(
        stored(
          { role: 'user', content: t('loop.turnWarning.mid', { n: turnCount, max: maxIterations }) },
          { kind: 'injection' },
        ),
      );
      yield { type: 'notice', message: t('loop.turnWarning.mid', { n: turnCount, max: maxIterations }) };
    } else if (!lateWarned && turnCount >= lateThreshold) {
      lateWarned = true;
      messages.push(
        stored(
          { role: 'user', content: t('loop.turnWarning.late', { n: turnCount, max: maxIterations }) },
          { kind: 'injection' },
        ),
      );
      yield { type: 'notice', message: t('loop.turnWarning.late', { n: turnCount, max: maxIterations }) };
    }
    // 发请求前的压缩预检。**这是本轮补上的缺口**：原先压缩只挂在 `tool_use` 分支
    // （即「回合结束、且模型确实调了工具」），于是三条常见路径完全绕过压缩——
    // 纯对话轮（`end_turn`）、用户 Esc 中断（`aborted`，直接 return）、以及新一轮
    // run 的第一个回合。长会话在这些路径下会带着已超限的上下文继续发请求，直到
    // API 自己报 overflow 才被动补救；若模型实际窗口比配置的 maxContextSize 更宽，
    // API 不报错，就会长期停在「显示超限、照常运行」的状态（实测现象）。
    //
    // 所以压缩检查不能只挂在某一种回合结局上：**每次发请求前都要判一次**，这是
    // 唯一能覆盖全部路径的位置。
    if (compaction !== undefined && !compactionSaturated) {
      const preflightUsed =
        lastUsage !== undefined
          ? lastUsage.total + estimateTokens(messages.slice(lastUsage.measuredLength))
          : estimatedUsedWithFramework();
      const outcome = await maybeCompact(
        provider,
        messages,
        preflightUsed,
        compaction,
        opts.todos,
        opts.compactionModel,
        opts.userMessageBudget,
        opts.onWireEvent,
        opts.compactionProvider,
        signal,
      );
      if (outcome.acted) {
        lastUsage = undefined; // 历史已就地重写，旧快照的 measuredLength 不再对应任何下标
        yield { type: 'notice', message: t('loop.autoCompacted') };
        // 与循环内压缩同一口径：立刻用字符估算刷新状态栏，不等下一次真实 usage
        yield { type: 'usage', totalTokens: estimatedUsedWithFramework(), measuredLength: messages.length };
        // 确实压过了，但仍超阈值 → 剩下的历史压不动，置饱和，本 run 内不再自动压缩。
        // 用字符估算而非 preflightUsed——后者是压缩前的口径，压缩后已失效。
        //
        // 只在「压过了仍超限」时置位。压不动（历史还太短、保留窗口外没内容可摘要）
        // **不算饱和**：历史继续增长后往往就能压了，此时置位会让本 run 后续再也不压缩。
        // 这个区别是实测踩出来的。
        if (shouldCompact(estimatedUsedWithFramework(), compaction)) {
          compactionSaturated = true;
          yield { type: 'notice', message: t('loop.overflow.noCompact') };
        }
      } else if (outcome.attemptedButFailed) {
        // 超了阈值、full 摘要动过手但没产出可用结果（请求失败或质量闸门连续未过）。
        // 这条路径此前完全静默：不提示、不置饱和，于是每一轮都再烧一次摘要请求，
        // 用户直到最终 overflow 报错才知道压缩一直在失败。
        // 现在明确告知并置饱和——同一个 run 内它几乎必然继续失败，重试只是重复花钱。
        compactionSaturated = true;
        yield { type: 'notice', message: t('loop.compactFailed') };
      }
    }
    // 每回合重新组装 tools：tool_search 等动态注册的工具（DYNAMIC_TOOLS）在下一回合
    // 就要带完整 schema 进请求，不能在循环外取一次快照复用
    const tools = toAnthropicTools(allowedTools);
    const lenBefore = messages.length;
    const turn = runTurn({ provider, system, tools, ctx, messages, hooks, signal, allowedTools: allowedSet, model, thinking, providerName });
    let step = await turn.next();
    while (!step.done) {
      // 请求级异常落盘（审计）：retry / error 事件在 wire 留下踪迹，否则空响应/断连那轮
      // 在调试包里完全无记录（无 model.usage 也无 error），事后无法排查。error 的 cause
      // 若是 EmptyResponseError，带诊断上下文（stop_reason/hadReasoning/token 比值）便于定位。
      const ev = step.value;
      if (ev.type === 'retry') {
        // 重试落盘：cause 若是 EmptyResponseError，带空响应诊断上下文（能看到是空响应触发的重试，
        // 及其 stop_reason/hadReasoning/token 比值）；否则只记通用 retry。
        const retryCtx = ev.cause instanceof EmptyResponseError ? ev.cause.context : undefined;
        opts.onWireEvent?.({
          type: 'turn.issue',
          ts: new Date().toISOString(),
          kind: retryCtx !== undefined ? 'empty' : 'retry',
          message: ev.message,
          attempt: ev.attempt,
          delayMs: ev.delayMs,
          ...(retryCtx?.stopReason !== undefined ? { stopReason: retryCtx.stopReason } : {}),
          ...(retryCtx?.hadReasoning !== undefined ? { hadReasoning: retryCtx.hadReasoning } : {}),
          ...(retryCtx?.outputTokens !== undefined ? { outputTokens: retryCtx.outputTokens } : {}),
          ...(retryCtx?.maxTokens !== undefined ? { maxTokens: retryCtx.maxTokens } : {}),
          ...(retryCtx?.model !== undefined ? { model: retryCtx.model } : model !== undefined ? { model } : {}),
          ...(retryCtx?.provider !== undefined ? { provider: retryCtx.provider } : {}),
        });
      } else if (ev.type === 'error') {
        const cause = ev.cause;
        const emptyCtx = cause instanceof EmptyResponseError ? cause.context : undefined;
        opts.onWireEvent?.({
          type: 'turn.issue',
          ts: new Date().toISOString(),
          kind: emptyCtx !== undefined ? 'empty' : 'error',
          message: ev.message,
          ...(emptyCtx?.stopReason !== undefined ? { stopReason: emptyCtx.stopReason } : {}),
          ...(emptyCtx?.hadReasoning !== undefined ? { hadReasoning: emptyCtx.hadReasoning } : {}),
          ...(emptyCtx?.outputTokens !== undefined ? { outputTokens: emptyCtx.outputTokens } : {}),
          ...(emptyCtx?.maxTokens !== undefined ? { maxTokens: emptyCtx.maxTokens } : {}),
          ...(emptyCtx?.model !== undefined ? { model: emptyCtx.model } : model !== undefined ? { model } : {}),
          ...(emptyCtx?.provider !== undefined ? { provider: emptyCtx.provider } : {}),
        });
      }
      yield step.value;
      step = await turn.next();
    }
    const outcome = step.value;
    // 真实 usage 快照：供下一回合的发请求前预检使用。measuredLength 取 lenBefore
    // （= 发请求那一刻的历史长度），与 tool_use 分支既有算法口径一致：
    // 真实 usage 覆盖到 lenBefore，其后的新增消息用字符估算叠加。
    if (outcome.usage !== undefined) {
      lastUsage = { total: usageTotalTokens(outcome.usage), measuredLength: lenBefore };
    }
    // usage 落盘：每轮一条，是上下文占用类问题唯一的事后审计凭据（详见 WireEvent['model.usage'] 注释）。
    // 放在 switch **之前**的公共位置：三个停止原因分支各有一处 usage yield，在分支里落盘会漏掉
    // 未来新增的分支，而这里只要服务端给了 usage 就必然记上一条。
    // estimatedTokens 与 totalTokens 同时记：前者是预检实际使用的口径，后者是真实值，
    // 两者比值就是预检的可信度，没有它就无法判断「预检为什么没触发」。
    if (outcome.usage !== undefined) {
      const u = outcome.usage;
      opts.onWireEvent?.({
        type: 'model.usage',
        ts: new Date().toISOString(),
        ...(model !== undefined ? { model } : {}),
        totalTokens: usageTotalTokens(u),
        billedTokens: billedTokens(u),
        ...(u.input_tokens !== undefined && u.input_tokens !== null ? { inputTokens: u.input_tokens } : {}),
        ...(u.output_tokens !== undefined && u.output_tokens !== null ? { outputTokens: u.output_tokens } : {}),
        ...(u.cache_read_input_tokens !== undefined && u.cache_read_input_tokens !== null
          ? { cacheReadTokens: u.cache_read_input_tokens }
          : {}),
        ...(u.cache_creation_input_tokens !== undefined && u.cache_creation_input_tokens !== null
          ? { cacheCreationTokens: u.cache_creation_input_tokens }
          : {}),
        estimatedTokens: estimateTokens(messages),
        frameworkTokens,
        measuredLength: lenBefore,
        stopReason: outcome.stopReason,
      });
    }
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
            { kind: 'injection' },
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
          opts.compactionProvider ?? provider,
          messages,
          keepRecent,
          opts.todos,
          opts.compactionModel,
          { maxTokens: userMaxTokens },
          signal,
        );
        if (compacted !== messages) {
          replaceMessages(messages, compacted);
          acted = true;
        }
        // 中断优先于一切压缩结果判定：保命压缩期间按 Esc 时，无论 micro 是否清理出收益、
        // 也无论 full 是否压成，都按中断如实收尾。
        //
        // 位置很关键，两种错法都踩过：
        //   放在 `!acted` 分支内 → micro 恰好有收益时（acted=true）绕过检查，走「已压缩、
        //     重试」路径，用户先看到压缩提示，要等下一回合 runTurn 进门才返回 aborted。
        //   放在 `!acted` 分支后 → 压不出空间且已中断时误报「无可压缩内容」错误，
        //     把中断说成失败。
        if (signal?.aborted === true) {
          yield { type: 'aborted' };
          return;
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
        lastUsage = undefined; // 历史已重写，快照失效（否则下一轮预检会漏算）
        // 保命压缩已是最激进的一档（keepRecent 与用户原话预算都按 ratio 收紧过）。它做完仍
        // 超阈值，说明真的压不动了——此时置饱和，避免 `iter--` 重试后回到循环顶部又立刻压
        // 一次（保命压缩这条路径原本绕过了饱和守卫，会连发两次摘要请求）。
        if (shouldCompact(estimatedUsedWithFramework(), compaction)) {
          compactionSaturated = true;
        }
        yield { type: 'notice', message: t('loop.overflow.retried') };
        // 状态栏刷新：本分支此前**漏了**这一条，导致保命压缩后占用数字仍停在压缩前的
        // 旧值，用户看到「提示压缩了、数字没动」，进而怀疑压缩没生效。循环内压缩分支
        // 早已这么做并写了注释说明理由，两条压缩路径的显示口径必须一致。
        yield { type: 'usage', totalTokens: estimatedUsedWithFramework(), measuredLength: messages.length };
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
        const limit = provider.maxTokens;
        // B 类：思考吃满预算、正文零输出。先判这一条，因为它走「预算配置问题」提示，
        // 不该进入自动续写守卫。
        if (outcome.thinkingExhausted === true) {
          yield {
            type: 'notice',
            message:
              limit !== undefined
                ? t('loop.maxTokens.thinkingExhaustedWithLimit', { limit })
                : t('loop.maxTokens.thinkingExhausted'),
          };
          // goal 等自主续接：max_tokens 出口同样要过续跑裁决——曾在此直接 turn_done
          // 静默停跑（2026-08-15 根因 B），goal active 时必须产出 continuation
          const contEx = await resolveContinuation(hooks);
          if (contEx !== null) {
            yield { type: 'continuation', inject: contEx.inject };
          }
          yield { type: 'turn_done' };
          return;
        }
        // A 类：正文被截断。有实质产出，续写会推进，交循环守卫决定能不能续。
        const chunk = lastAssistantText(messages);
        contState ??= emptyContinuationState();
        const verdict = checkContinuationSafety(chunk, contState, safeMaxAutoContinues);
        if (verdict.safe) {
          contState = advanceContinuation(chunk, contState);
          messages.push(
            stored({ role: 'user', content: t('loop.continue.prompt') }, { kind: 'injection' }),
          );
          yield { type: 'notice', message: t('loop.continue.auto', { n: contState.count }) };
          continue; // 进入下一回合续写
        }
        // 守卫拦下或未开启自动续写：报明确理由，让用户知道停在哪一步、下一步做什么
        yield {
          type: 'notice',
          message: continuationStopMessage(verdict.reason, verdict.detail, limit),
        };
        // goal 等自主续接：同上——守卫拦停的是「文本续写」，不是 goal 续跑，两者不互相豁免
        const contStop = await resolveContinuation(hooks);
        if (contStop !== null) {
          yield { type: 'continuation', inject: contStop.inject };
        }
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
        // 工具调用通道退化：模型把工具调用打成了纯文本，工具一个也没执行。
        // 不修复只告知——静默是这里最贵的部分（用户会以为文件真被改了）。放在 continuation 之前，
        // 保证自主续接场景下用户也能先看到这条。
        if (outcome.toolCallLeak === true) {
          yield { type: 'notice', message: t('loop.toolCallLeak') };
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
        // 跨回合零进展检测：在本轮 assistant + tool_result 完整落地后、下一回合继续前检查。
        // 只挂 tool_use 分支——end_turn 直接收尾、max_tokens 走 continuation 守卫，
        // 这两个分支天然不会陷入「调用与结果双双不变」的循环。
        const fingerprint = fingerprintRound(messages);
        const loopVerdict = roundLoopDetector.observe(fingerprint);
        if (loopVerdict.action === 'warn') {
          // 第 3 轮相同：注入警告给模型一次机会（不打断循环）
          messages.push(
            stored({ role: 'user', content: t('loop.roundLoop.inject') }, { kind: 'injection' }),
          );
          yield { type: 'notice', message: t('loop.roundLoop.warn', { n: loopVerdict.streak }) };
          continue; // 模型看到警告后重试，进入下一回合
        }
        if (loopVerdict.action === 'stop') {
          // 第 4 轮仍相同：硬停（模型行为问题，不是系统故障，不用 error 事件）
          yield { type: 'notice', message: t('loop.roundLoop.stop') };
          yield { type: 'turn_done' };
          return;
        }
        // 这里**不再**做压缩：本回合结束等价于下一回合开始，而循环顶部的预检就在那个
        // 位置、用同一口径（`lastUsage.total + 尾部估算`，lastUsage 正是用本回合的
        // usage 与 lenBefore 记的）判一次。两处都留会让同一位置被评估两遍，超阈值时
        // 连发两次摘要请求——多花一次 LLM 调用，且第二次几乎必然无收益。
        continue; // 有工具结果回灌，进入下一回合（预检在那里生效）
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
