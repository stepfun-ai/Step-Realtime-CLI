/**
 * 截断自动续写的循环守卫。
 *
 * 背景：`stop_reason=max_tokens` 是两种语义共用的信号——正文被切断（续写有效）与
 * 思考吃满预算、正文零输出（续写零进展）。后者由 `thinkingExhausted` 在 loop 层分派掉，
 * 本模块只处理前者：续写过程中如何识别病态循环。
 *
 * 设计原则：**能用确定性判据的地方绝不用阈值**。
 * 相似度阈值方案必然误伤长输出（代码样板、列表项、表格行、反复出现的术语都会让相似度虚高），
 * 而误伤的代价是正常任务被中断。所以主判据是「长度为零」「字符串完全相等」这类二值判断，
 * 阈值只用在确定性判据覆盖不到的文本病态上，且每个阈值都要能说出理据。
 *
 * 完整设计与实测依据见内部产品设计文档（截断自动续写与循环守卫设计）。
 */

/** 续写被拦下的原因。文案层据此选提示语，测试据此断言具体命中了哪条守卫。 */
export type ContinuationStopReason =
  /** 新增正文为空：零进展。 */
  | 'no_progress'
  /** 本轮新增与上轮完全相同：模型卡死。 */
  | 'identical_to_previous'
  /** 开头与首轮相同：丢了上下文从头重写。 */
  | 'restarted_from_beginning'
  /** 尾部周期性重复：复读机。 */
  | 'repeating_tail'
  /** 连续多轮产出极少：龟速循环。 */
  | 'stalled'
  /** 达到次数上限。 */
  | 'max_continues';

/** 守卫判定结果。safe=true 表示可以继续续写。 */
export type ContinuationVerdict =
  | { safe: true }
  | {
      safe: false;
      reason: ContinuationStopReason;
      /** 诊断细节（周期长度、已续写轮数等），进提示文案帮用户判断。 */
      detail?: number;
    };

/** 跨轮次累积的守卫状态。由 loop 持有，每次续写后更新。 */
export interface ContinuationState {
  /** 已自动续写的次数。 */
  count: number;
  /** 上一轮续写产出的正文（用于完全相等判定）。 */
  lastChunk?: string;
  /** 首轮（被截断那次）正文的开头片段（用于「从头重来」判定）。 */
  firstHead?: string;
  /** 连续「产出极少」的轮数。 */
  stalledStreak: number;
}

/**
 * 空初始状态：还没有任何续写产出时用它。
 *
 * 此时 `firstHead` 未设，因此「从头重来」判据自动跳过——首次截断时手里只有首轮正文本身，
 * 拿它跟自己比必然相等，会把每次首轮都误判成从头重来。`firstHead` 由首次
 * {@link advanceContinuation} 自动补上，之后该判据才开始生效。
 */
export function emptyContinuationState(): ContinuationState {
  return { count: 0, stalledStreak: 0 };
}

/** 用已知的首轮正文直接构造状态（测试与需要预置首轮特征的场景用）。 */
export function initialContinuationState(firstText: string): ContinuationState {
  return {
    count: 0,
    firstHead: headOf(firstText),
    stalledStreak: 0,
  };
}

/** 「从头重来」判定所用的开头片段长度上限。 */
const HEAD_LEN = 80;
/**
 * 「从头重来」判定的最小开头长度。首轮正文比这更短时**跳过该判定**——
 * 十来个字的开头不足以作为特征，「好的，我来继续」这类通用开场会让正常续写被误判。
 */
const MIN_HEAD_FOR_RESTART = 20;
/** 龟速判定：单轮新增少于该字符数即计入 stalled。正常续写一轮至少写完一句话。 */
const STALL_CHARS = 20;
/** 龟速判定：连续多少轮都低产才停。给 3 轮容错，避免偶发一次短输出就中断。 */
const STALL_STREAK = 3;
/** 周期检测的最大周期长度。超过这个长度的重复段已属罕见，且成本随之上升。 */
const MAX_PERIOD = 500;

function headOf(s: string): string {
  return s.trimStart().slice(0, HEAD_LEN);
}

/**
 * 某个周期长度需要重复几次才判定为异常。**周期越短要求越多**。
 *
 * 分级的目的是把「正常排版重复」与「模型卡住」分开，而不是用统一阈值一刀切：
 * - 短模式在正常文本里极常见（省略号、`---` 分隔线、缩进、`===` 边框），要求 20 次才算异常
 * - 20 字符以上的片段精确重复 3 次，正常写作几乎不会发生（代码样板也会有变量名差异）
 */
function minRepeatsFor(period: number): number {
  if (period <= 4) return 20;
  if (period < 20) return 6;
  return 3;
}

/**
 * 找出字符串尾部的周期性重复，返回周期长度；无重复返回 null。
 *
 * 从最短周期试起，检查「末尾 p 字符」是否与它前面的若干个 p 字符块**逐块完全相等**。
 * 只做字符串切片的相等比较，不引入任何相似度概念——要么完全是周期，要么不是。
 */
export function findRepeatingTail(s: string, maxPeriod = MAX_PERIOD): number | null {
  const n = s.length;
  const limit = Math.min(maxPeriod, Math.floor(n / 3));
  for (let p = 1; p <= limit; p++) {
    const need = minRepeatsFor(p);
    if (n < p * need) continue;
    const unit = s.slice(n - p);
    let ok = true;
    for (let k = 2; k <= need; k++) {
      if (s.slice(n - k * p, n - (k - 1) * p) !== unit) {
        ok = false;
        break;
      }
    }
    if (ok) return p;
  }
  return null;
}

/**
 * 判定本轮续写产出是否安全、可以继续。
 *
 * 检查顺序即优先级：三条确定性判据在前（零进展 / 完全相等 / 从头重来），
 * 两条文本病态判据在后（复读 / 龟速），次数上限兜底。
 * 先判确定性的，让停止理由尽可能精确——同一个病态可能同时命中多条，报最根本的那条更有用。
 *
 * @param chunk 本轮续写产出的正文（不含思考）。
 * @param state 跨轮状态，**本函数不修改它**（纯函数，便于穷举单测）；更新交 {@link advanceContinuation}。
 * @param maxContinues 次数上限；0 表示关闭自动续写。
 */
export function checkContinuationSafety(
  chunk: string,
  state: ContinuationState,
  maxContinues: number,
): ContinuationVerdict {
  if (maxContinues <= 0) return { safe: false, reason: 'max_continues', detail: 0 };

  const trimmed = chunk.trim();
  if (trimmed.length === 0) return { safe: false, reason: 'no_progress' };

  if (state.lastChunk !== undefined && chunk === state.lastChunk) {
    return { safe: false, reason: 'identical_to_previous' };
  }

  // 「从头重来」：用 firstHead 的实际长度去截本轮开头再比对。
  // 不能固定截 HEAD_LEN——首轮正文短于 HEAD_LEN 时，本轮的前 HEAD_LEN 会带上后续内容，
  // 两者永远不等，判定静默失效（这个缺陷由测试抓出来过）。
  const head = state.firstHead;
  if (head !== undefined && head.length >= MIN_HEAD_FOR_RESTART) {
    if (chunk.trimStart().slice(0, head.length) === head) {
      return { safe: false, reason: 'restarted_from_beginning' };
    }
  }

  const period = findRepeatingTail(chunk);
  if (period !== null) return { safe: false, reason: 'repeating_tail', detail: period };

  const nextStreak = trimmed.length < STALL_CHARS ? state.stalledStreak + 1 : 0;
  if (nextStreak >= STALL_STREAK) {
    return { safe: false, reason: 'stalled', detail: nextStreak };
  }

  if (state.count + 1 >= maxContinues) {
    return { safe: false, reason: 'max_continues', detail: state.count + 1 };
  }

  return { safe: true };
}

/**
 * 记入一轮续写产出，返回新状态（不修改入参）。
 *
 * 首次调用时用本轮产出的开头补上 `firstHead`——从下一轮起「从头重来」判据才有比较基准。
 */
export function advanceContinuation(chunk: string, state: ContinuationState): ContinuationState {
  const trimmed = chunk.trim();
  return {
    count: state.count + 1,
    lastChunk: chunk,
    firstHead: state.firstHead ?? headOf(chunk),
    stalledStreak: trimmed.length < STALL_CHARS ? state.stalledStreak + 1 : 0,
  };
}
