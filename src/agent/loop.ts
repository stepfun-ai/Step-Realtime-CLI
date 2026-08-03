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
): Promise<boolean> {
  if (!shouldCompact(usedTokens, thresholds)) return false;
  let acted = false;
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
   * 压缩饱和标记：一次压缩做完后**仍然**超阈值，说明剩下的历史压不动了
   * （保留窗口内的消息本身就超预算，或摘要请求反复失败）。
   *
   * 不设这个标记的后果是实测出来的：预检每回合都判一次，饱和状态下就变成每回合白烧
   * 一次摘要请求——花钱、拖慢、且每次都压不下来。所以饱和后本 run 内不再自动压缩，
   * 改为明确告知用户「压不下去了，请 /compact 或 /new」，把决定权交回去。
   */
  let compactionSaturated = false;

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
          : estimateTokens(messages) + frameworkTokens;
      if (
        await maybeCompact(
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
        )
      ) {
        lastUsage = undefined; // 历史已就地重写，旧快照的 measuredLength 不再对应任何下标
        yield { type: 'notice', message: t('loop.autoCompacted') };
        // 与循环内压缩同一口径：立刻用字符估算刷新状态栏，不等下一次真实 usage
        yield { type: 'usage', totalTokens: estimateTokens(messages), measuredLength: messages.length };
        // 确实压过了，但仍超阈值 → 剩下的历史压不动，置饱和，本 run 内不再自动压缩。
        // 用字符估算而非 preflightUsed——后者是压缩前的口径，压缩后已失效。
        //
        // 只在「压过了仍超限」时置位。压不动（maybeCompact 返回 false，例如历史还太短、
        // 保留窗口外没内容可摘要）**不算饱和**：历史继续增长后往往就能压了，此时置位会
        // 让本 run 后续再也不压缩。这个区别是实测踩出来的。
        if (shouldCompact(estimateTokens(messages), compaction)) {
          compactionSaturated = true;
          yield { type: 'notice', message: t('loop.overflow.noCompact') };
        }
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
    // 真实 usage 快照：供下一回合的发请求前预检使用。measuredLength 取 lenBefore
    // （= 发请求那一刻的历史长度），与 tool_use 分支既有算法口径一致：
    // 真实 usage 覆盖到 lenBefore，其后的新增消息用字符估算叠加。
    if (outcome.usage !== undefined) {
      lastUsage = { total: usageTotalTokens(outcome.usage), measuredLength: lenBefore };
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
        if (shouldCompact(estimateTokens(messages), compaction)) {
          compactionSaturated = true;
        }
        yield { type: 'notice', message: t('loop.overflow.retried') };
        // 状态栏刷新：本分支此前**漏了**这一条，导致保命压缩后占用数字仍停在压缩前的
        // 旧值，用户看到「提示压缩了、数字没动」，进而怀疑压缩没生效。循环内压缩分支
        // 早已这么做并写了注释说明理由，两条压缩路径的显示口径必须一致。
        yield { type: 'usage', totalTokens: estimateTokens(messages), measuredLength: messages.length };
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
