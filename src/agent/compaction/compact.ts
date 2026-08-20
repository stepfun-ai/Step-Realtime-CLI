import Anthropic from '@anthropic-ai/sdk';
import { DEFAULT_THINKING_LEVELS } from '../../config/config.js';
import { isAbortError } from '../../provider/retry.js';
import type { ChatProvider } from '../../provider/types.js';
import { isStepref, STEPREF_PREFIX } from '../../session/attachments.js';
import { logError } from '../../utils/logger.js';
import { mapBlocksDeep, stored, type MessageOrigin, type StoredMessage } from '../message.js';

const CLEARED_PLACEHOLDER = '[旧工具结果已清理以节省上下文]';

/**
 * 摘要信息量下限的封顶值（token）。
 * 实测事故：891K token 的历史被一条 56 字符的「摘要」替换掉，而旧代码只拦空串，
 * 于是灾难性遗忘静默发生。下限用来兜住这类失控产出。
 *
 * 口径统一用 token（而非字符）：同样体量的历史，中文的字符数约等于 token 数，
 * 英文约为 4 倍，若拿字符数比 token 基数，英文会拿到约 4 倍宽松的下限。
 */
const COMPACTION_SUMMARY_MIN_TOKENS_CAP = 200;

/**
 * 信息量下限相对被压缩量的比例（默认 2%）。
 * 不用固定值：被压缩段只有几十 token 时，一句话摘要本就够用，固定下限会把正常
 * 小压缩全判失败——更要紧的是，下限一旦超过原文体量，这道闸门就永远无法通过。
 * 故实际下限取 `min(cap, olderTokens × 此比例)`，用 min 把下限压在原文体量之下：
 * 压得越多，对摘要的信息量要求越高；压得少则几乎不设限。
 */
const COMPACTION_SUMMARY_MIN_RATIO = 0.02;

/**
 * 全量压缩摘要最大尝试次数。每次失败后收缩输入（丢弃最老消息 + 其后的孤儿 tool_result），
 * 按 empty/truncated 重试循环处理（同类实现常取 5 次；step-code 已有 user_verbatim
 * 保真兜底，取 3 次够用且少烧摘要调用）。
 */
const COMPACTION_MAX_RETRIES = 3;

/**
 * 降级交接的最短 token 门槛：3 次重试都因"过短"失败时，若候选非空且 ≥ 此值，
 * 接受为精简交接而非放弃压缩。
 *
 * 设计依据（2026-08-20 debug 包实证）：模型连续 3 次产出 58/175/132 token 的摘要，
 * 在 gateHint 下从 58→175 说明已尽力，175 只差 25 到 200 门槛仍被拒 → 放弃压缩。
 * 短摘要不一定是无效的：交接的价值在"接得上"而非"写够 N token"。132 token 若能
 * 精准覆盖关键决策与下一步，比放弃压缩（历史原样保留、迟早 overflow）更有价值。
 *
 * 50 是保守下限：过滤掉纯噪音短串（如"好的"/"继续"），同时不卡住真实但偏短的交接。
 * 仍要过 validateSummary 的复述拦截——降级只放宽长度，不放过复述垃圾。
 */
const COMPACTION_DEGRADED_MIN_TOKENS = 50;

/**
 * overflow 比例收缩比。
 * 摘要请求因输入太长触发 413 / context overflow 时，按此比例保留最近消息、
 * 丢弃更老消息，而不是直接 drop 一条——比例收缩对大输入更可控。
 * loop.ts 的溢出兜底路径也复用此数组，保证两处收缩节奏一致。
 */
export const OVERFLOW_SHRINK_RATIOS = [0.7, 0.5, 0.35] as const;

/**
 * 摘要输入的 tool_use 参数保真预算（字符，超长按头截断）。
 * 依据：2026-08-13 真实历史+真实端点的序列化方案对照实验——裸 `[调用工具 X]` 标记
 * 让摘要模型既丢失「确切命令/路径」的素材、又被标记密度诱导模仿（复述闸门的病源）；
 * 参数截断保留后交接质量实测跃升。
 */
export const TOOL_USE_ARGS_BUDGET = 400;
/** 摘要输入的单条 tool_result 内嵌文本保真预算（字符，超长按头截断）。 */
export const TOOL_RESULT_BUDGET = 1000;

/**
 * 摘要复述检测正则：匹配 serializeContent() 对 tool_use/tool_result/image/audio/video
 * 的内部标记。注意必须带 /g 且用 match 计数——判定看密度不看有无（见下）。
 * 2026-08-13 输入保真改造后 tool_use 标记带截断参数，但标记头 `[调用工具 ` 形态不变，
 * 本正则的匹配面不受影响；裸标记密度已大幅下降，本闸门退居兜底。
 */
const RECITATION_MARKERS = /\[调用工具 |\[工具结果\]|\[image |\[audio |\[video /g;

/**
 * 复述判定：标记**密度** ≥ 1 处/千字符 才判复述。
 *
 * 为什么不是「出现即拒」：2026-08-12 实测，一条 9.4 万字符的高保真交接笔记因零星提到
 * 几个 [image …] 标记被旧闸门（命中即拒）误判——交接笔记引用图片 hash 定位是合理且
 * 有用的（后续可按 hash 找回原图），而真正的复述（整段照抄序列化历史）标记密度极高
 * （工具密集段每几十到几百字符一个）。密度阈值把两者分开：
 * 56 字符垃圾摘要含 1 个标记 → 密度 17.8/千字符 → 拒；9.4 万字符笔记含 20 个 → 0.21 → 放。
 */
function isRecitation(summary: string): boolean {
  const count = summary.match(RECITATION_MARKERS)?.length ?? 0;
  return count * 1000 >= summary.length && count > 0;
}

/**
 * 媒体块降级标记：摘要请求因图片/音频/视频太大触发 413 / context overflow 时，
 * 把它们替换成轻量文本 marker 再试一次，而不是直接丢弃历史。
 */
const MEDIA_PART_MARKERS: Record<string, string> = {
  image: '[image]',
  audio: '[audio]',
  video: '[video]',
};

/**
 * 保真保留用户原始消息的 token 预算（默认 20K，对齐 256K 窗口约 7.6%）。
 * 压缩最大的信息损失是「用户当初到底要什么」被摘要转述掉——摘要是模型的二手转述，
 * 一旦措辞漂移，后续回合就会按错误理解继续干活（实测：压缩后误判项目路径）。
 * 故把用户原话当一等公民，在摘要之外单独留预算逐条保真保留。
 */
export const COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000;

/**
 * 用户消息预算中划给「最早消息」的份额（默认 2K，其余全给最近消息）。
 * 最早的消息通常载有任务定义与全局约束，最近的消息载有当前意图；
 * 中间段最容易被摘要覆盖，故预算不足时优先牺牲中间。
 */
export const COMPACT_USER_MESSAGE_HEAD_TOKENS = 2_000;

/**
 * micro 压缩的单条 tool_result 最小正文 token 门槛（默认 100）。
 * 低于此值的结果清掉省不下什么（还要塞一条占位文本），净收益接近零甚至为负，
 * 白白击穿缓存前缀并丢掉可能有用的短结果（如 exit code、单行路径）。
 */
export const MICRO_MIN_CONTENT_TOKENS = 100;

/**
 * 保真块占「被压缩段」token 的上限份额（默认 0.6）。
 * 超过就说明被压缩段太小、原话几乎就是全部内容，搬进保真块等于原地搬运而非压缩，
 * 此时退回纯摘要形态。真实长会话里 older 段含大量 assistant 输出与工具结果，
 * 用户原话占比通常远低于此，守卫不会触发。
 */
export const USER_BLOCK_MAX_SHARE = 0.6;

/**
 * 每张图片按固定 token 常数估算。
 * 图片的 base64/stepref 字符数与其真实视觉 token 成本无关，按字符数算会严重高估（一张 1MB 图 ≈ 46 万"token"）。
 * 取一个贴近视觉 token 量级的常数，避免有图时 /compact 展示与兜底判断失真。
 */
const PER_IMAGE_TOKENS = 1500;

/**
 * 文本 token 分桶估算：ASCII 字符约 4 个/token，非 ASCII（CJK/全角/emoji 等）约 1 个/token。
 * 比一刀切的 chars/3 更贴近真实分词——chars/3 对中文偏低、对英文偏高。
 * 纯函数，仅按 code point < 128 分桶，不追求精确（真实 usage 优先，估算只作尾部补充/兜底）。
 */
export function estimateTextTokens(text: string): number {
  let ascii = 0;
  let nonAscii = 0;
  for (const ch of text) {
    // 用 code point 判定（for..of 按 code point 迭代，emoji 等代理对算一个非 ASCII 字符）
    if (ch.codePointAt(0)! < 128) ascii++;
    else nonAscii++;
  }
  return Math.ceil(ascii / 4) + nonAscii;
}

/**
 * 粗略估算消息占用的 token 数。用于压缩阈值判断，不追求精确。
 * 启发式：文本按序列化后的字符数分桶（见 estimateTextTokens：ASCII÷4 + 非 ASCII×1）；
 * 图片块不按 base64/stepref 字符数算，改按 PER_IMAGE_TOKENS 常数（见上）。
 * tool_result 的 content 为块数组时下钻：内嵌 image 计 PER_IMAGE_TOKENS、内嵌 text 计文本，
 * 不再整体 JSON.stringify（否则内嵌 base64 会被全量计入文本，一张 1MB 图虚增几十万 token）。
 * 优先用 provider 返回的真实 usage（见 usageTotalTokens），本地估算只作尾部补充/兜底。
 */
export function estimateTokens(messages: readonly StoredMessage[]): number {
  let textTokens = 0;
  let images = 0;
  for (const m of messages) {
    const c = m.message.content;
    if (typeof c === 'string') {
      textTokens += estimateTextTokens(c);
      continue;
    }
    for (const block of c) {
      if (block.type === 'image') {
        images++;
      } else if (block.type === 'tool_result' && Array.isArray(block.content)) {
        // 内嵌块下钻：image 计常数、text 计文本，块外壳（type/tool_use_id）按 JSON 计
        textTokens += estimateTextTokens(JSON.stringify({ ...block, content: undefined }));
        for (const inner of block.content) {
          if (inner.type === 'image') images++;
          else if (inner.type === 'text') textTokens += estimateTextTokens(inner.text);
          else textTokens += estimateTextTokens(JSON.stringify(inner));
        }
      } else {
        textTokens += estimateTextTokens(JSON.stringify(block));
      }
    }
  }
  return textTokens + images * PER_IMAGE_TOKENS;
}

/**
 * 从 provider 返回的真实 usage 求上下文总占用 token：输入（含缓存读/写）+ 输出。
 * 这是压缩判断的主依据，比字符估算准得多。
 */
export function usageTotalTokens(usage: Anthropic.Usage): number {
  return (
    (usage.input_tokens ?? 0) +
    (usage.output_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    (usage.cache_creation_input_tokens ?? 0)
  );
}

/**
 * 本轮请求的计费 token 增量：input + output（Anthropic 的 input_tokens 本身已排除缓存命中部分，
 * 不再额外减去 cache_read；缓存命中不计费，未命中部分已含在 input_tokens 里）。
 * 与 usageTotalTokens（上下文占用快照）不同，这是逐轮单调递增的成本口径，
 * goal 预算计量与子 agent 卡片 token 展示共用此公式。
 */
export function billedTokens(usage: Anthropic.Usage): number {
  return (usage.input_tokens ?? 0) + (usage.output_tokens ?? 0);
}

/** 压缩触发阈值。 */
export interface CompactionThresholds {
  /** 模型上下文上限（token）。 */
  maxContextSize: number;
  /** 触发比例：占用达到 maxContextSize × 此值即压缩。 */
  triggerRatio: number;
  /** 预留量：剩余窗口不足此值即压缩（给下一次生成留安全垫）。 */
  reservedTokens: number;
}

/** 是否该压缩：占用超过比例阈值，或剩余窗口不足预留量（两条件取或）。 */
export function shouldCompact(usedTokens: number, t: CompactionThresholds): boolean {
  if (t.maxContextSize <= 0) return false;
  return (
    usedTokens >= t.maxContextSize * t.triggerRatio ||
    usedTokens + t.reservedTokens >= t.maxContextSize
  );
}

export interface MicroCompactResult {
  messages: StoredMessage[];
  /** 被清理正文的 tool_result 块数量。 */
  clearedCount: number;
}

/** 缓存冷阈值：距上次活动超过此时长（默认 1 小时），才认定 prompt cache 前缀已过期。 */
export const CACHE_COLD_MS = 60 * 60 * 1000;

/**
 * micro 压缩的缓存 gate：仅当缓存已冷时才允许原地改写历史。
 * lastActivityMs = 上次向 provider 发请求（约等于最后一条 assistant 消息）的时间戳。
 */
export interface MicroCompactCacheGate {
  lastActivityMs: number;
  /** 当前时间 ms，默认 Date.now()。 */
  nowMs?: number;
  /** 缓存冷阈值 ms，默认 CACHE_COLD_MS。 */
  cacheColdMs?: number;
}

/**
 * 微压缩：清空「较旧」的 tool_result 块正文（保留结构与最近 keepRecent 条消息完整）。
 * 只改内层 message 的正文、不删消息、不动信封元数据，tool_use↔tool_result 配对结构不变。
 * 返回新数组，不改动入参。
 *
 * 只清正文估算 ≥ minContentTokens（默认 100）的块：更小的结果清掉几乎省不下 token
 * （还要塞一条占位文本），净收益接近零，却白白丢掉可能有用的短结果（exit code、单行路径）
 * 并击穿缓存前缀。
 *
 * prompt cache 注意：原地改写历史内容会使该位置之后的缓存前缀全部失效——这不是「对缓存友好」的操作。
 * 故传入 cacheGate 时，仅当缓存已冷（距上次活动 ≥ cacheColdMs）才执行改写；缓存仍热时跳过（返回
 * clearedCount:0），把压缩让给 fullCompact（它替换头部并重建同构前缀，不额外击穿热缓存）。
 * 不传 cacheGate 时无条件改写——用于溢出保命场景（此时腾空间优先于保缓存）。
 */
export function microCompact(
  messages: StoredMessage[],
  keepRecent = 6,
  cacheGate?: MicroCompactCacheGate,
  minContentTokens = MICRO_MIN_CONTENT_TOKENS,
): MicroCompactResult {
  // 缓存仍热：跳过原地改写，避免击穿热前缀（交给 fullCompact 重建）
  if (cacheGate !== undefined) {
    const now = cacheGate.nowMs ?? Date.now();
    const coldMs = cacheGate.cacheColdMs ?? CACHE_COLD_MS;
    if (now - cacheGate.lastActivityMs < coldMs) {
      return { messages, clearedCount: 0 };
    }
  }
  const cutoff = Math.max(0, messages.length - keepRecent);
  let clearedCount = 0;
  const out = messages.map((sm, idx) => {
    if (idx >= cutoff) return sm;
    const msg = sm.message;
    if (msg.role !== 'user' || !Array.isArray(msg.content)) return sm;
    let changed = false;
    const content = msg.content.map((block) => {
      if (block.type !== 'tool_result' || block.content === CLEARED_PLACEHOLDER) return block;
      // 净收益门槛：小结果不值得清（省不下 token，还丢信息 + 击穿缓存）
      if (estimateTextTokens(JSON.stringify(block.content ?? '')) < minContentTokens) return block;
      clearedCount++;
      changed = true;
      return { ...block, content: CLEARED_PLACEHOLDER };
    });
    return changed ? { ...sm, message: { ...msg, content } } : sm;
  });
  return { messages: out, clearedCount };
}

/** 是否为「工具结果回灌」消息（内层 user 角色且含 tool_result 块）。 */
function isToolResultMsg(m: StoredMessage): boolean {
  const msg = m.message;
  return msg.role === 'user' && Array.isArray(msg.content) && msg.content.some((b) => b.type === 'tool_result');
}

/**
 * 摘要质量校验。不合格抛错，由 fullCompact 的重试循环捕获。
 *
 * 三类不合格：空白、信息量不足（相对当轮摘要输入量，见 COMPACTION_SUMMARY_MIN_RATIO）、
 * 复述内部标记。这是对旧实现「只拦空串」的补足——一条 56 字符的复述片段照样能
 * 替换掉几十万 token 的历史，且静默无告警。
 *
 * 摘要与 inputTokens 都按 estimateTextTokens 口径度量，中英文一致（见常量注释）。
 * inputTokens 是当轮实际发给摘要模型的序列化输入的估算（不是原始历史体量——
 * 摘要模型看到的是 serializeContent 之后的文本，分母必须与模型所见同口径）。
 */
export function validateSummary(summary: string, inputTokens: number): void {
  const trimmed = summary.trim();
  if (trimmed === '') throw new Error('compaction summary is empty');
  const minTokens = Math.min(
    COMPACTION_SUMMARY_MIN_TOKENS_CAP,
    Math.floor(inputTokens * COMPACTION_SUMMARY_MIN_RATIO),
  );
  const summaryTokens = estimateTextTokens(trimmed);
  if (summaryTokens < minTokens) {
    throw new Error(`compaction summary too short: ${summaryTokens} tokens < ${minTokens} required`);
  }
  if (isRecitation(trimmed)) {
    throw new Error('compaction summary contains recitation markers');
  }
}

/**
 * 把消息中的媒体块（image/audio/video）降级成轻量文本 marker。
 * 用于摘要请求因媒体太大触发 413 / context overflow 时的自救：先剥离媒体再重试，
 * 而不是直接丢掉整段历史。
 * 下钻 tool_result 的数组 content：read_media 回传的内嵌图片同样换成 marker。
 *
 * 无媒体块时返回原数组（changed=false），调用方可据此判断是否真正发生了剥离。
 */
export function replaceMediaPartsWithMarkers(messages: readonly StoredMessage[]): {
  messages: StoredMessage[];
  changed: boolean;
} {
  let changed = false;
  const out = messages.map((sm) => {
    const mapped = mapBlocksDeep(sm.message.content, (block) => {
      const marker = MEDIA_PART_MARKERS[block.type];
      if (marker === undefined) return block;
      return { type: 'text', text: marker } as Anthropic.TextBlockParam;
    });
    if (!mapped.changed) return sm;
    changed = true;
    return { ...sm, message: { ...sm.message, content: mapped.content } };
  });
  return { messages: out, changed };
}

/**
 * 按 token 预算从消息尾部往前取，然后 drop 开头因此变成孤儿的 tool_result。
 * 用于 overflow 比例收缩：保留最近消息，丢弃更老的消息。
 */
function takeRecentMessagesWithinTokenBudget(messages: StoredMessage[], tokenBudget: number): StoredMessage[] {
  let start = messages.length;
  let tokens = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const messageTokens = estimateTokens([messages[i]!]);
    if (tokens + messageTokens > tokenBudget) break;
    tokens += messageTokens;
    start = i;
  }
  // 至少保留最近一条；若 start=0 说明预算连最近一条都装不下，也保留它交给后续重试处理
  if (start === 0) start = 1;
  return dropOldestMessageAndLeadingToolResults(messages.slice(start));
}

/**
 * overflow 比例收缩：按 ratio 保留最近消息，降低摘要请求的输入长度。
 * ratios [0.7, 0.5, 0.35] 来自对同类实现压缩兜底策略的对齐。
 */
function shrinkCompactionHistoryAfterOverflow(messages: StoredMessage[], ratio: number): StoredMessage[] {
  if (messages.length <= 1) return messages.slice();
  const budget = Math.floor(estimateTokens(messages) * ratio);
  return takeRecentMessagesWithinTokenBudget(messages, budget);
}

/**
 * 摘要重试前收缩输入：丢弃最老一条消息，以及紧随其后因此变成孤儿的 tool_result，
 * 给摘要模型更少的输入，降低再次截断/空返的概率。
 */
function dropOldestMessageAndLeadingToolResults(messages: readonly StoredMessage[]): StoredMessage[] {
  if (messages.length <= 1) return messages.slice();
  let start = 1;
  while (start < messages.length && isToolResultMsg(messages[start]!)) start++;
  return messages.slice(start);
}

/**
 * 判断错误是否为上下文溢出或请求过大（413 / 400 prompt too long）。
 * 摘要请求可能因 older 段含大量文本/媒体而直接命中 provider 的窗口限制，需要特殊处理。
 */
function isContextOverflowOrTooLarge(err: unknown): boolean {
  if (!(err instanceof Anthropic.APIError)) return false;
  if (err.status === 413) return true;
  if (err.status !== 400) return false;
  const msg = String(err.message ?? '').toLowerCase();
  return (
    msg.includes('prompt is too long') ||
    msg.includes('too many tokens') ||
    msg.includes('context_length') ||
    msg.includes('context window') ||
    msg.includes('maximum context')
  );
}

/**
 * 从期望 cutoff 往后挪到安全切点：保证 recent 段首条不是孤儿 tool_result。
 * 若 recent 首条是 tool_result 消息，它配对的 tool_use（assistant）会落进被摘要吞掉的 older 段，
 * 压缩后就成了孤儿 → Anthropic 协议下会 400。往后挪把这条 tool_result 一并归入 older，
 * 使 older 末尾保持「assistant(tool_use) + user(tool_result)」成对完整。
 */
function safeCutoff(messages: StoredMessage[], desired: number): number {
  let c = Math.max(0, Math.min(desired, messages.length));
  while (c < messages.length && isToolResultMsg(messages[c]!)) c++;
  return c;
}

/**
 * 压缩时该 origin 的消息是否算「用户真实输入」（保真保留的候选）。
 *
 * `user` 是本轮真人输入；`user_verbatim` 是**上一轮压缩保真下来的原话**——必须一并收，
 * 否则原话只能活过一轮压缩：第二轮时它已不是 `user`，会被当普通内容喂进摘要变成二次转述
 * （实测过：第一轮路径原文还在，第二轮就没了）。收了它，衰减才由 token 预算竞争决定
 * （越旧越可能被挤出），而不是由结构一刀切。
 *
 * 其余一律不收：tool 是结果回灌、injection 是系统注入的 reminder（含上一轮的省略提示，
 * 每轮重新生成、不累积）、compaction_summary 是摘要、assistant 是模型自己的话。
 */
export function isCompactableUserOrigin(origin: MessageOrigin): boolean {
  return origin.kind === 'user' || origin.kind === 'user_verbatim';
}

/**
 * 纯确认语词表：整条消息（归一后）恰好等于其中一项时不占保真预算。
 *
 * 这类消息信息量为零，却会占预算，更要紧的是**稀释注意力**——模型看到一列保真消息
 * 会默认它们都重要，真正的关键信息被淹在「再继续」旁边。
 *
 * 只做**整条全等**匹配，不做包含/前缀匹配，也不用长度阈值：宁可留噪音，不可丢信号。
 * 「用方案 B」这类同样很短却载有决策的消息必须活下来。
 * （预算宽松时这道过滤可有可无；但溢出递进收缩会把预算压到 0.35 倍，此时它才见效。）
 */
const ACK_ONLY_PHRASES = new Set([
  '继续', '继续吧', '接着', '接着说', '好', '好的', '好吧', '行', '行吧', '可以', '嗯', '嗯嗯',
  '对', '对的', '是', '是的', '没问题', '知道了', '明白', '收到',
  'ok', 'okay', 'yes', 'y', 'ya', 'yeah', 'sure', 'go', 'go on', 'continue', 'next', 'thanks', 'thx',
]);

/** 归一化后判断是否为纯确认语（去首尾空白与尾部标点、转小写）。空内容同样视为无信息。 */
export function isAckOnlyText(text: string): boolean {
  const normalized = text
    .trim()
    .replace(/[。．.!！?？~～、,，;；:：\s]+$/u, '')
    .toLowerCase();
  if (normalized === '') return true;
  return ACK_ONLY_PHRASES.has(normalized);
}

/** 抽取一条消息里的纯文本（图片降级成 marker，工具块忽略；tool_result 内嵌块下钻提取）。 */
function extractUserText(content: Anthropic.MessageParam['content']): string {
  if (typeof content === 'string') return content;
  return content
    .map((b: Anthropic.ContentBlockParam) => {
      if (b.type === 'text') return b.text;
      if (b.type === 'image') return serializeImage(b);
      if (b.type === 'tool_result' && Array.isArray(b.content)) {
        return b.content.map(serializeInnerBlock).filter((s) => s !== '').join('\n');
      }
      return '';
    })
    .filter((s) => s !== '')
    .join('\n');
}

/**
 * 按 token 预算从文本尾部保留（丢头部）。用于最近消息：越靠后的表述越接近当前意图。
 * 按字符二分逼近（estimateTextTokens 对字符数单调不减），返回保留下来的后缀。
 */
function truncateTextFromEnd(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return '';
  if (estimateTextTokens(text) <= maxTokens) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTextTokens(text.slice(text.length - mid)) <= maxTokens) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(text.length - lo);
}

/** 按 token 预算从文本头部保留（丢尾部）。用于最早消息：任务定义通常在开头。 */
function truncateTextFromStart(text: string, maxTokens: number): string {
  if (maxTokens <= 0) return '';
  if (estimateTextTokens(text) <= maxTokens) return text;
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (estimateTextTokens(text.slice(0, mid)) <= maxTokens) lo = mid;
    else hi = mid - 1;
  }
  return text.slice(0, lo);
}

/** 截断标记：让模型知道这条原话不完整、缺失部分去摘要里找。 */
export const TRUNCATED_HEAD_SUFFIX = '\n…（本条后半已截断，其内容见交接摘要）';
export const TRUNCATED_TAIL_PREFIX = '…（本条前半已截断，其内容见交接摘要）\n';

/**
 * 落成保真消息：origin 统一为 `user_verbatim`（可跨轮继承），保留原 id/ts 便于追溯。
 * text 省略时原消息内容原样保留（含图片块）；给了 text 则内容替换为纯文本
 * （截断只能作用于文本，图片无法部分截断）。
 */
function toVerbatim(sm: StoredMessage, text?: string): StoredMessage {
  if (text === undefined) return { ...sm, origin: { kind: 'user_verbatim' } };
  return { ...sm, message: { role: 'user', content: text }, origin: { kind: 'user_verbatim' } };
}

/** 用户原话保真选择结果（元素为可直接入 messages 的保真消息）。 */
export interface UserMessageSelection {
  /** 最早的若干条（head 预算内）。 */
  head: StoredMessage[];
  /** 最近的若干条（tail 预算内）。 */
  tail: StoredMessage[];
  /** 是否发生了信息损失（中段丢弃或单条截断）。 */
  elided: boolean;
  /** 丢失的估算 token 数 = 候选总量 - 实际保留量（含被截断掉的部分）。 */
  omittedTokens: number;
}

/**
 * 在 token 预算内保真挑选用户原始消息，返回可直接入 messages 的保真消息。
 *
 * 规则：滤掉纯确认语 → 预算够则全留 → 不够则「最早 headTokens + 最近剩余预算」，
 * 单条超预算按方向截断（head 留开头、tail 留结尾）而非整条丢弃。
 * tail 边界那条被截掉的**前缀会回收进 head 候选**：
 * 一条巨大的 paste 因此能同时保住开头与结尾、只丢中间，而不是只剩个尾巴。
 * 纯函数，便于单测。
 */
export function selectCompactionUserMessages(
  messages: readonly StoredMessage[],
  maxTokens = COMPACT_USER_MESSAGE_MAX_TOKENS,
  headTokens = COMPACT_USER_MESSAGE_HEAD_TOKENS,
): UserMessageSelection {
  const empty: UserMessageSelection = { head: [], tail: [], elided: false, omittedTokens: 0 };
  if (maxTokens <= 0) return empty;

  // 候选：真实用户输入（含上一轮保真下来的），去掉纯确认语与空内容
  const candidates: { sm: StoredMessage; text: string; tokens: number }[] = [];
  for (const sm of messages) {
    if (!isCompactableUserOrigin(sm.origin)) continue;
    const text = extractUserText(sm.message.content).trim();
    if (text === '' || isAckOnlyText(text)) continue;
    candidates.push({ sm, text, tokens: estimateTextTokens(text) });
  }
  if (candidates.length === 0) return empty;

  const total = candidates.reduce((sum, c) => sum + c.tokens, 0);
  if (total <= maxTokens) {
    return { head: [], tail: candidates.map((c) => toVerbatim(c.sm)), elided: false, omittedTokens: 0 };
  }

  // 预算不足：先从最近往前填 tail（留 headBudget 给最早消息），再从最早往后填 head
  const headBudget = Math.min(Math.max(headTokens, 0), maxTokens);
  let tailRemaining = maxTokens - headBudget;
  const tail: StoredMessage[] = [];
  let headEndExclusive = candidates.length;
  let boundaryDroppedPrefix: { sm: StoredMessage; text: string; tokens: number } | undefined;
  for (let i = candidates.length - 1; i >= 0 && tailRemaining > 0; i--) {
    const c = candidates[i]!;
    if (c.tokens <= tailRemaining) {
      tail.push(toVerbatim(c.sm));
      tailRemaining -= c.tokens;
      headEndExclusive = i;
      continue;
    }
    // 单条超出剩余预算：留其结尾（当前意图在末尾）
    const keptSuffix = truncateTextFromEnd(c.text, tailRemaining);
    if (keptSuffix !== '') tail.push(toVerbatim(c.sm, TRUNCATED_TAIL_PREFIX + keptSuffix));
    headEndExclusive = i;
    // 被丢掉的前缀回收进 head 候选：大 paste 的开头同样有价值（任务定义、函数签名常在头部）
    const droppedPrefix = c.text.slice(0, c.text.length - keptSuffix.length);
    if (droppedPrefix !== '') {
      boundaryDroppedPrefix = { sm: c.sm, text: droppedPrefix, tokens: estimateTextTokens(droppedPrefix) };
    }
    break;
  }
  tail.reverse();

  const headCandidates = candidates.slice(0, headEndExclusive);
  if (boundaryDroppedPrefix !== undefined) headCandidates.push(boundaryDroppedPrefix);
  const head: StoredMessage[] = [];
  let headRemaining = headBudget;
  for (const c of headCandidates) {
    if (headRemaining <= 0) break;
    if (c.tokens <= headRemaining) {
      head.push(toVerbatim(c.sm, c.text));
      headRemaining -= c.tokens;
      continue;
    }
    const keptPrefix = truncateTextFromStart(c.text, headRemaining);
    if (keptPrefix !== '') head.push(toVerbatim(c.sm, keptPrefix + TRUNCATED_HEAD_SUFFIX));
    break;
  }

  // 丢失量 = 候选总量 - 实际保留量，含被截断掉的部分（只算整条丢弃会低报）
  let kept = 0;
  for (const sm of [...head, ...tail]) kept += estimateTextTokens(extractUserText(sm.message.content));
  return { head, tail, elided: true, omittedTokens: Math.max(0, total - kept) };
}

/**
 * 中段省略提示消息。用 `injection` origin：下一轮压缩不会把它当用户输入收集，
 * 因此每轮重新生成、不层层累积。
 */
export function createElisionMessage(omittedTokens: number): StoredMessage {
  const text = [
    '<system-reminder>',
    `压缩时省略了约 ${omittedTokens} tokens 的用户消息：上方是最早的用户输入，下方是最近的用户输入，` +
      '中间部分已丢弃，其内容由下方交接摘要覆盖。若下一步依赖被省略段的细节，先向用户确认，不要臆测。',
    '</system-reminder>',
  ].join('\n');
  return stored({ role: 'user', content: text }, { kind: 'injection' });
}

/** 摘要请求的 system prompt：定调「第一人称交接笔记」而非第三方报告。 */
const SUMMARY_SYSTEM =
  '你正在为「未来的自己」写一份交接笔记：这段对话即将被清空，只有你写下的内容能延续。' +
  '用第一人称、现在时写，像自己在推演下一步，不要写成第三方汇报。输出中文纯文本，不要调用任何工具。';

/**
 * 摘要请求的指令块（handoff 交接指令）。
 * 六条要求都在防一类具体的压缩后事故：意图漂移、已决选择被重开、结果值丢失需重跑、
 * 未知被当成已知、计划退化成只剩下一步、未验证声明被当成事实。
 */
const SUMMARY_INSTRUCTION = [
  '写一份交接笔记，让清空历史后的你能无缝继续。必须覆盖以下几点，但不要套用僵硬的小标题，让结构贴合任务本身：',
  '',
  '1. 当前请求到底要什么：你对其意图的理解，以及你已经消解掉的歧义。原话已在上方保真保留，不要复述；' +
    '但保真受 token 预算限制、较早的原话可能已被挤出或截断，凡是你判断下一步仍要依赖的关键事实' +
    '（路径、命名、接口、约束、数字），无论上方是否还在，都要在笔记里写清一遍；' +
    '若有多个请求并行，说清哪个主导下一步。',
  '2. 现在生效的约束：用户偏好、项目规则、环境与工具限制。把「已经定下的决策（选了什么、为什么）」' +
    '和「仍然待定的问题」分开写，避免下一轮悄悄重开已关闭的选择，或把未定的当成已定。',
  '3. 已经做了什么，要高保真：执行过的确切命令、动过的确切文件路径、每一步成功还是失败；' +
    '更要留结果本身——返回的具体值、关键行或报错原文、查到的 schema 或签名，因为重跑一遍可能很慢甚至不可能。' +
    '代码只留最终可用版本，中间尝试和已修掉的错误一律丢弃。',
  '4. 你仍然不知道什么：下一步依赖但这段对话从未确认过的东西——提到却没读过的文件、假设却没验证的接口、' +
    '用户还没回答的问题。把这些缺口点名，让下一轮去查而不是去猜。',
  '5. 前向计划，这里值得多投入：你现在掌握的上下文比之后任何时候都多，下一轮只会更少。' +
    '给出确切的下一条命令或工具调用，并且不要停在下一步——把剩下的步骤序列、这些步骤上你已经做好的决定、' +
    '你已能预见的障碍与应对，以及现在就能定下来的产出（确切的补丁、查询或最终答案的形态）一并写下。',
  '6. 对不确定性诚实：若之前声称「测试通过」「已修好」「文件已创建」但从未验证，明确写成未验证，' +
    '不要当作事实，下一轮依赖前必须重新核对。',
  '',
  'TODO 清单会从实时来源自动附在笔记下方，不要抄写它；清单装不下的是任务之间的推理——' +
  '为什么某项被重排或放弃、某项的决定如何约束另一项，记这些。',
  '',
  '保持简洁并与任务规模成比例：多步长任务值得详细，接近收尾的琐碎交流一两句就够，不要注水。',
  '只输出笔记正文。',
].join('\n');

/**
 * 全量压缩：把除最近 keepRecent 条外的较旧对话交给模型总结成一段 handoff 摘要，
 * 用「用户原话保真块 + 摘要」替换被压缩部分，保留最近消息。需要一次模型调用。
 *
 * 保真块（见 selectCompactionUserMessages）是对「摘要转述丢失原始意图」的正面修补：
 * 被压缩段里的用户原话在 token 预算内逐条原样保留，排在摘要之前，摘要垫在最后
 * （模型读完原话后最后看到的是「怎么继续」，注意力落在行动上）。
 *
 * 切点经 safeCutoff 校正，绝不拆散 tool_use↔tool_result。
 * 若无可压缩内容、无安全切点或摘要失败，原样返回（返回同引用，供调用方判断未压缩）。
 * model 为压缩摘要专用模型覆盖（大小模型协同），省略时用 provider 构造模型。
 * userBudget 覆盖用户原话保真预算（省略 = COMPACT_USER_MESSAGE_MAX_TOKENS）。
 *
 * signal 为中断信号：摘要调用可能耗时数十秒（历史越长越久），期间用户按 Esc 应当能放弃。
 * 中断语义是「彻底放弃本次压缩」而非「失败重试」——故中断不进重试环（否则按一次 Esc
 * 还要再等三轮请求），直接原样返回历史。
 *
 * **中断安全性**：本函数对入参 messages 只读，新序列先在局部算完，由调用方 replaceMessages
 * 一次性 splice 生效。因此中断只要发生在返回前，历史就一定处于压缩前的完整状态，
 * 不存在「压缩到一半」的中间态。这是中断可以做得如此简单的前提。
 */
export async function fullCompact(
  provider: ChatProvider,
  messages: StoredMessage[],
  keepRecent = 6,
  todos?: readonly { title: string; status: string }[],
  model?: string,
  userBudget?: { maxTokens?: number; headTokens?: number },
  signal?: AbortSignal,
): Promise<StoredMessage[]> {
  /**
   * 中断判定统一走这里读实时值。
   *
   * 不直接写 `signal?.aborted === true`：函数入口已有一次 early return，TS 的控制流分析会把
   * `aborted` 收窄成 `false`，后续同样的比较被判定为「永不成立」而报 TS2367。但运行时它确实会变——
   * 摘要请求 await 期间用户按 Esc 正是要检测的情形。读函数调用的返回值绕开收窄，语义也更清楚。
   */
  const aborted = (): boolean => signal?.aborted === true;
  // 进门即已中断：不发请求，原样返回（历史零改动）
  if (aborted()) return messages;
  const desired = messages.length - keepRecent;
  if (desired <= 1) return messages; // 太短，不值得压缩
  const cutoff = safeCutoff(messages, desired);
  // 没有安全切点，或安全切点会把最近消息压光 → 放弃（宁可不压，也不产生孤儿 tool_result）
  if (cutoff <= 1 || cutoff >= messages.length) return messages;
  const older = messages.slice(0, cutoff);
  const recent = messages.slice(cutoff);

  // 用户原话保真：只取被压缩掉的 older 段（recent 段本身完整保留，无需重复占预算）
  const selection = selectCompactionUserMessages(
    older,
    userBudget?.maxTokens ?? COMPACT_USER_MESSAGE_MAX_TOKENS,
    userBudget?.headTokens ?? COMPACT_USER_MESSAGE_HEAD_TOKENS,
  );

  // 摘要生成 + 质量校验 + 重试（按 empty/truncated 重试循环处理）。
  // 区分失败两类，重试策略不同：
  //   1. 请求层失败（网络/API/overflow/truncated）：overflow 先剥媒体再按比例收缩历史
  //      （[0.7, 0.5, 0.35]），其余 drop 最老消息——输入侧的病收缩输入来治；
  //   2. 闸门层失败（空白/过短/复述）：输出行为问题，**收缩输入只会更短**——
  //      2026-08-13 实测三次 160/97/106 tokens 单调走低放弃压缩。改走「追加提示 +
  //      原输入重试」（与反复述同一机制），输入保持不动。
  // 尝试耗尽则**原样返回**（同引用 = 未压缩），把「宁可不压」交给调用方处理，
  // 而不是让垃圾摘要吞掉历史。不抛错是刻意的：loop.ts 调用点无 try/catch，抛错会掀翻整个回合。
  const olderTokens = estimateTokens(older);
  let summary: string | undefined;
  // 降级素材：闸门"过短"失败时的候选，耗尽时若达门槛则接受为精简交接（不放弃压缩）
  let lastShortCandidate: string | undefined;
  let olderForSummary: StoredMessage[] = older;
  let mediaStripAttempted = false;
  let overflowShrinkCount = 0;
  // 闸门提示：闸门拦截是输出行为问题，丢消息不治本，追加提示原样重试
  let gateHint = '';
  for (let attempt = 1; attempt <= COMPACTION_MAX_RETRIES; attempt++) {
    // 每轮开工前检查：中断可能发生在上一轮请求之后、本轮之前（如收缩历史期间）
    if (aborted()) return messages;
    const historyText = olderForSummary
      .map((m) => `${m.message.role}: ${serializeContent(m.message.content)}`)
      .join('\n');
    const summaryPrompt =
      `${SUMMARY_INSTRUCTION}${gateHint}\n\n--- 以下是即将被清空的对话历史 ---\n\n` + historyText;
    // 闸门分母按当轮实际输入算（不含指令与提示等恒定开销——它们不是摘要要接替的内容，
    // 小历史里指令体量会压过正文、把及格线抬到错误量级）。摘要模型看到的是 serializeContent
    // 之后的文本，按原始历史（含 thinking/工具参数全文）估的分母模型从未见过——2026-08-13
    // 实测 34 万 token 历史骨架化后实收仅 1.9 万，按前者判分恒不及格。逐轮重算，不钉死。
    const inputTokens = estimateTextTokens(historyText);

    let candidate: string;
    try {
      const stream = provider.stream({
        system: SUMMARY_SYSTEM,
        tools: [],
        messages: [{ role: 'user', content: summaryPrompt }],
        model,
        // 压缩摘要压到最低思考档：摘要是机械交接任务，不需要推理深度；更关键的是
        // 思考模型面对超长历史输入时思考量爆炸，会吃光 max_tokens 使 text block 为空，
        // candidate 恒空 → 质量闸门必挂 → 重试耗尽放弃压缩（2026-08-11 实测现场）。
        // 用 low 而非 null：阶跃渠道「不发 effort」≠不思考，而是跑服务端默认深度（≈high），
        // null 会适得其反；low 档实测可压掉约 85% 思考量。sendThinking=false 的渠道
        // 此参数被门控拦下（字段不带出），是无害 no-op。
        thinking: { level: 'low', budgetTokens: DEFAULT_THINKING_LEVELS.low },
        signal,
      });
      const final: Anthropic.Message = await stream.finalMessage();
      candidate = final.content
        .filter((b): b is Anthropic.TextBlock => b.type === 'text')
        .map((b) => b.text)
        .join('');
      // 每次尝试落日志：stop_reason 与输入规模是分型「思考吃预算/截断/模型写薄」的关键证据，
      // 2026-08-13 的排查只能靠三行闸门日志倒推，此处补齐（含候选头部，供判断退化形态）
      logError(
        `[compaction] 摘要返回（第 ${attempt}/${COMPACTION_MAX_RETRIES} 次）：` +
          `输入约 ${inputTokens} tokens，stop_reason=${final.stop_reason ?? '-'}，候选 ${candidate.length} 字符`,
      );
    } catch (err) {
      // 用户中断：语义是「放弃压缩」，不是「这次失败换个规模再试」。
      // 必须在所有降级分支之前判定并直接返回，否则按一次 Esc 仍要走完剩余重试。
      if (aborted() || isAbortError(err)) return messages;
      const e = err as Error & { status?: number };
      logError(`[compaction] 摘要请求失败（第 ${attempt}/${COMPACTION_MAX_RETRIES} 次）：status=${e.status ?? '-'} ${String(e.message).slice(0, 300)}`);
      const isOverflow = isContextOverflowOrTooLarge(err);
      // overflow / 413：先剥离媒体块再试一次（媒体常是 413 主因，且 marker 仍保留定位信息）
      if (isOverflow && !mediaStripAttempted) {
        const stripped = replaceMediaPartsWithMarkers(olderForSummary);
        if (stripped.changed) {
          olderForSummary = stripped.messages;
          mediaStripAttempted = true;
          continue;
        }
      }
      // overflow / 413：按比例收缩历史（比例制比直接 drop 更可控）
      if (isOverflow && overflowShrinkCount < OVERFLOW_SHRINK_RATIOS.length) {
        overflowShrinkCount++;
        const ratio = OVERFLOW_SHRINK_RATIOS[overflowShrinkCount - 1]!;
        const before = olderForSummary.length;
        olderForSummary = shrinkCompactionHistoryAfterOverflow(olderForSummary, ratio);
        if (olderForSummary.length >= before) {
          // 收缩没丢消息（预算太紧）， fallback 到 drop oldest
          if (olderForSummary.length <= 1) return messages;
          olderForSummary = dropOldestMessageAndLeadingToolResults(olderForSummary);
        }
        continue;
      }
      // 其他失败或已无收缩空间：drop 最老一条 + 孤儿 tool_result
      if (olderForSummary.length <= 1) return messages;
      olderForSummary = dropOldestMessageAndLeadingToolResults(olderForSummary);
      continue;
    }

    // 质量闸门：三类失败（空白/过短/复述）都是输出行为问题，追加提示原输入重试，不收缩。
    try {
      validateSummary(candidate, inputTokens);
      summary = candidate;
      break;
    } catch (gateErr) {
      const reason = (gateErr as Error).message;
      logError(
        `[compaction] 摘要质量闸门拦截（第 ${attempt}/${COMPACTION_MAX_RETRIES} 次，候选 ${candidate.length} 字符）：${reason}；` +
          `候选头部：${candidate.trim().slice(0, 100)}`,
      );
      if (reason.includes('recitation')) {
        gateHint =
          '\n\n注意：上一次产出的摘要原样复述了历史里的序列化标记（[调用工具 …]、[工具结果]、[image …] 等），被判不合格。' +
          '那些标记只是历史渲染成文本时的占位形式，不要写进摘要；确需提及时用自己的话转述（如「读取了某张截图」）。';
        continue;
      }
      // 空白/过短：材料就在上方历史里，是摘要没写够。点明缺口与篇幅要求，原输入重试。
      // 过短时留一份候选作降级素材：耗尽后若达门槛，接受为精简交接而非放弃压缩。
      if (reason.includes('too short')) lastShortCandidate = candidate;
      gateHint =
        `\n\n注意：上一次产出的摘要被判不合格（${reason}）。这份笔记要独自接替上方整段历史：` +
        '执行过的确切命令、动过的文件路径、返回的关键结果、已定决策与待定问题、前向计划，都必须写实写够，' +
        '篇幅与历史规模相称，不要只写几句概括。';
      continue;
    }
  }
  // 尝试耗尽仍无合格摘要
  if (summary === undefined) {
    // 降级交接：3 次都因"过短"失败，但候选非空且达门槛时，接受为精简交接而非放弃压缩。
    // 比放弃好——压缩生效（上下文下降），同时加标注让模型知道这次交接偏薄，不致误当完整交接。
    // 仍要过 50 token 门槛 + 非空：纯噪音短串（"好的"/"继续"）仍拒。
    // 复述候选不在此列——闸门已拒，且复述不记录进 lastShortCandidate。
    if (lastShortCandidate !== undefined) {
      const degraded = lastShortCandidate.trim();
      if (degraded !== '' && estimateTextTokens(degraded) >= COMPACTION_DEGRADED_MIN_TOKENS) {
        logError(
          `[compaction] ${COMPACTION_MAX_RETRIES} 次均过短，降级接受精简交接（${estimateTextTokens(degraded)} tokens，未达质量标准但保留压缩）`,
        );
        summary = `[精简交接：以下摘要未达质量标准，关键信息如下]\n\n${degraded}`;
      }
    }
  }
  if (summary === undefined) {
    logError(`[compaction] ${COMPACTION_MAX_RETRIES} 次尝试均未产出合格摘要，放弃本次压缩（历史原样保留）`);
    return messages;
  }

  // TODO 本体存独立 store（不占 messages），压缩不丢；把当前清单拼进摘要尾部，让压缩后模型立刻看到进度
  const todoBlock = todos !== undefined ? renderTodoList(todos) : '';
  const summaryText = [`[早期对话摘要]\n${summary.trim()}`, todoBlock].filter((s) => s !== '').join('\n\n');

  /**
   * 产物结构：保真原话（独立 user_verbatim 消息）→ 省略提示 → 摘要 → assistant 确认 → recent。
   *
   * 原话作为**独立消息**而非摘要正文里的一段文本，是跨轮保真的前提：它们的 origin 是
   * user_verbatim，下一轮压缩的 isCompactableUserOrigin 认得，于是能继续参选；
   * 若把原话渲染进摘要消息，下一轮只看到一条 compaction_summary，原话必然退化成二次转述。
   *
   * 摘要排在原话之后：模型读完原话序列，最后看到的是「怎么继续」，注意力落在行动上。
   */
  const build = (withVerbatim: boolean): StoredMessage[] => {
    const verbatim = withVerbatim
      ? selection.elided
        ? [...selection.head, createElisionMessage(selection.omittedTokens), ...selection.tail]
        : [...selection.head, ...selection.tail]
      : [];
    return [
      ...verbatim,
      stored({ role: 'user', content: summaryText }, { kind: 'compaction_summary' }),
      stored({ role: 'assistant', content: '已了解上述摘要，继续。' }, { kind: 'assistant' }),
      ...recent,
    ];
  };

  // 净收益守卫：保真消息不该反过来主导被压缩段。被压缩段很小时（极端情形：只压掉两条消息，
  // 却把其中的用户原话整条搬出来），保真的成本会吃掉摘要省下的量，压缩退化成搬运。
  // 此时退回纯摘要形态。真实场景下 older 段动辄几万 token、用户原话占比很小，守卫不会触发。
  const verbatimCount = selection.head.length + selection.tail.length;
  const verbatimTokens = estimateTokens([...selection.head, ...selection.tail]);
  const worthKeeping = verbatimCount > 0 && verbatimTokens <= olderTokens * USER_BLOCK_MAX_SHARE;

  return build(worthKeeping);
}

/** 把 TODO 清单渲染成 markdown，供压缩摘要尾部拼接（TODO 本体存 store，压缩不丢）。 */
export function renderTodoList(todos: readonly { title: string; status: string }[], heading = '## TODO List'): string {
  if (todos.length === 0) return '';
  const lines = todos.map((t) => `- [${t.status}] ${t.title}`);
  return `${heading}\n${lines.join('\n')}`;
}

/** 序列化 tool_result 内嵌 content 数组的单个块（text 取文本，image 走 serializeImage marker，其余按类型占位）。 */
function serializeInnerBlock(
  b: Exclude<Anthropic.ToolResultBlockParam['content'], string | undefined>[number],
): string {
  if (b.type === 'text') return b.text;
  if (b.type === 'image') return serializeImage(b);
  return `[${b.type}]`;
}

/** 长文本按头截断并标注截断（摘要输入保真用：头部承载命令/路径/结果开头等关键信息）。 */
function truncateHead(text: string, budget: number): string {
  if (text.length <= budget) return text;
  return text.slice(0, budget) + '…[截断]';
}

/**
 * 把一条 wire 消息的 content 序列化成摘要模型可读的文本。
 *
 * 保真口径（2026-08-13 对照实验定稿，勿回退成裸标记）：
 * - thinking / redacted_thinking：**整块丢弃、不留标记**。它是模型自己的草稿，体量最大、
 *   对交接价值最低；且 `[thinking]` 这类不透明标记会诱导摘要模型模仿标记、把交接笔记
 *   写成续聊（实测：保留标记时摘要输出以 [thinking] 开头、仅 192 字符；去掉后产出
 *   4368 字符的合格交接）。
 * - tool_use：标记 + 参数 JSON 截断保留——摘要指令要求「确切命令、文件路径」，
 *   这些内容只存在于参数里，剥光等于让模型写它没见过的东西（实测剥光后摘要退化为
 *   11 字符的标记复述）。
 * - tool_result：内嵌文本截断保留（「返回的具体值」是重跑代价最高的信息）。
 * - image：维持 stepref marker（带 hash，可定位原图）。
 */
export function serializeContent(content: Anthropic.MessageParam['content']): string {
  if (typeof content === 'string') return content;
  return content
    .map((b: Anthropic.ContentBlockParam) => {
      if (b.type === 'text') return b.text;
      if (b.type === 'thinking' || b.type === 'redacted_thinking') return '';
      if (b.type === 'tool_use') {
        let args = '';
        try {
          args = JSON.stringify(b.input ?? {});
        } catch {
          args = '{}';
        }
        return `[调用工具 ${b.name}] ${truncateHead(args, TOOL_USE_ARGS_BUDGET)}`;
      }
      if (b.type === 'tool_result') {
        // 内嵌块数组（read_media 回传的图片等）下钻序列化，内嵌 image 落成 [image ...] 文本
        if (!Array.isArray(b.content)) return `[工具结果]`;
        const inner = b.content.map(serializeInnerBlock).filter((s) => s !== '').join(' ');
        if (inner === '') return '[工具结果]';
        return `[工具结果] ${truncateHead(inner, TOOL_RESULT_BUDGET)}`;
      }
      if (b.type === 'image') return serializeImage(b);
      return `[${b.type}]`;
    })
    .filter((s) => s !== '')
    .join(' ');
}

/**
 * 图片降级成 marker 文本：至少保留"这里有张图"的定位信息，而非字面 `[image]`。
 * 落盘引用式存储（stepref）时带 hash 前 8 位，如 `[image image/png a1b2c3d4]`；内联小图无 hash 只标 mediaType。
 */
function serializeImage(b: Anthropic.ImageBlockParam): string {
  if (b.source.type !== 'base64') return `[image ${b.source.type}]`;
  const mediaType = b.source.media_type;
  const data = b.source.data;
  if (isStepref(data)) {
    const hash = data.slice(STEPREF_PREFIX.length, STEPREF_PREFIX.length + 8);
    return `[image ${mediaType} ${hash}]`;
  }
  return `[image ${mediaType}]`;
}
