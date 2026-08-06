import Anthropic from '@anthropic-ai/sdk';
import type { ModelCapability } from './capability-registry.js';
import { isContextOverflowError } from './retry.js';

/**
 * 按能力声明的主动降级 + 错误驱动的重投影链。
 *
 * 设计来源：消息事件日志与后台通知设计 §5.3 / §7.5.2。两条路径：
 * - 主动降级（{@link degradeMessages}）：发送前按 capability-registry 的声明，
 *   把模型不收的输入换掉/剥掉，不等服务端报错。
 * - 错误驱动重投影（{@link nextReprojectionLevel} + {@link applyReprojectionLevel}）：
 *   服务端用 413 / 400 拒绝时，沿 normal → media-degraded → media-stripped → strict
 *   逐档降级重发，每档每请求最多用一次（由调用方持有的 used 集合保证）。
 *
 * 不改动入参，全部返回新对象。
 */

/** 媒体块类型（当前处理 image / document 两类）。 */
const MEDIA_BLOCK_TYPES = new Set(['image', 'document']);

/** 媒体块占位文本：如实告知模型此处有媒体被省略。 */
const IMAGE_OMITTED_TEXT = '[image omitted: model has no image input]';
const DOCUMENT_OMITTED_TEXT = '[document omitted: model has no document input]';

/** 重投影档位（数组序即降级顺序）。 */
export const REPROJECTION_LEVELS = ['normal', 'media-degraded', 'media-stripped', 'strict'] as const;
export type ReprojectionLevel = (typeof REPROJECTION_LEVELS)[number];

type Block = Anthropic.ContentBlockParam;

function mediaPlaceholder(block: Block): Block {
  return {
    type: 'text',
    text: block.type === 'document' ? DOCUMENT_OMITTED_TEXT : IMAGE_OMITTED_TEXT,
  };
}

function isMediaBlock(block: Block): boolean {
  return MEDIA_BLOCK_TYPES.has(block.type);
}

function isThinkingBlock(block: Block): boolean {
  return block.type === 'thinking' || block.type === 'redacted_thinking';
}

/** 剥掉块上的 cache_control 字段；没有该字段的块原样返回（保留引用）。 */
function stripCacheControl(block: Block): Block {
  if (!('cache_control' in block)) return block;
  const { cache_control: _dropped, ...rest } = block as Block & { cache_control?: unknown };
  return rest as Block;
}

/** 映射一条消息；空的 content 数组原样保留（不在这里丢消息，避免改变轮次结构）。 */
function mapBlocks(msg: Anthropic.MessageParam, fn: (block: Block) => Block | null): Anthropic.MessageParam {
  if (typeof msg.content === 'string') return msg;
  const out: Block[] = [];
  for (const block of msg.content) {
    const mapped = fn(block);
    if (mapped !== null) out.push(mapped);
  }
  return { role: msg.role, content: out };
}

/**
 * 主动降级：按能力声明整形消息。
 * - image_in 为 false：媒体块换成占位文本（保留轮次结构，模型知道这里本来有图）。
 * - cache_control 为 false：剥掉所有块的 cache_control（不兼容个案在此收敛，
 *   请求代码不再特判）。
 * - reasoning 为 false：剥掉 thinking / redacted_thinking 块（模型不做推理，
 *   回灌 thinking 只会增加被拒风险）。
 */
export function degradeMessages(
  messages: Anthropic.MessageParam[],
  capability: ModelCapability,
): Anthropic.MessageParam[] {
  return messages.map((msg) =>
    mapBlocks(msg, (block) => {
      let b: Block | null = block;
      if (!capability.image_in && isMediaBlock(b)) b = mediaPlaceholder(b);
      if (!capability.reasoning && isThinkingBlock(b)) b = null;
      if (b !== null && !capability.cache_control) b = stripCacheControl(b);
      return b;
    }),
  );
}

/**
 * 应用一档重投影：
 * - normal：原样返回（主动降级已在发送前做过，此档不重投影）。
 * - media-degraded：保留最近 keepRecentImages 张图片，更旧的媒体块换占位文本。
 *   图片是上下文里最贵的块，触发降级（413/400 图片超限）时把旧图全剥掉会让模型
 *   「变瞎」——连当前正在看的图也丢了。保留最近 N 张（只降级旧图、留新图）。
 *   document 块不参与保留计数（场景少，统一换占位）。
 * - media-stripped：全部媒体块直接移除。
 * - strict：media-stripped 之上再剥 thinking 块与所有 cache_control（最保守形态）。
 *
 * keepRecentImages 缺省 0 = 维持旧行为（全换占位），不传入时不改变既有语义。
 */
export function applyReprojectionLevel(
  messages: Anthropic.MessageParam[],
  level: ReprojectionLevel,
  keepRecentImages = 0,
): Anthropic.MessageParam[] {
  if (level === 'normal') return messages;

  // media-degraded 且要保留最近 N 张时，先按消息逆序数出要保留的 image 块集合。
  // 同一块可能被多条消息引用（实际上不会，但防御），用 Set 去重。
  let keep: Set<Block> | undefined;
  if (level === 'media-degraded' && keepRecentImages > 0) {
    keep = new Set<Block>();
    outer: for (let mi = messages.length - 1; mi >= 0; mi--) {
      const content = messages[mi]!.content;
      if (typeof content === 'string') continue;
      for (let bi = content.length - 1; bi >= 0; bi--) {
        const block = content[bi]!;
        if (block.type === 'image') {
          keep.add(block);
          if (keep.size >= keepRecentImages) break outer;
        }
      }
    }
  }

  return messages.map((msg) =>
    mapBlocks(msg, (block) => {
      if (isMediaBlock(block)) {
        if (level === 'media-degraded') {
          return keep !== undefined && keep.has(block) ? block : mediaPlaceholder(block);
        }
        return null;
      }
      if (level === 'strict') {
        if (isThinkingBlock(block)) return null;
        return stripCacheControl(block);
      }
      return block;
    }),
  );
}

/**
 * 判断错误是否可触发重投影：413（载荷过大）与 400（媒体格式/结构问题）可降级；
 * 上下文溢出（400 里的特定子类）不可——那要靠压缩历史解决，降级无益。
 */
export function isReprojectableError(err: unknown): boolean {
  if (!(err instanceof Anthropic.APIError)) return false;
  if (err.status === 413) return true;
  if (err.status === 400) return !isContextOverflowError(err);
  return false;
}

/**
 * 给定错误与已用过的档位，返回下一档降级策略。
 * 不可重投影的错误、或后续档位已用尽，返回 null（调用方应抛错而不是重发）。
 * 每档每请求最多用一次：used 集合由调用方在一次请求的生命周期内持有并逐档累加。
 */
export function nextReprojectionLevel(
  err: unknown,
  used: ReadonlySet<ReprojectionLevel>,
): ReprojectionLevel | null {
  if (!isReprojectableError(err)) return null;
  // 从已用档位的最后一档之后开始找第一个没用过的档
  let start = 0;
  for (let i = 0; i < REPROJECTION_LEVELS.length; i++) {
    if (used.has(REPROJECTION_LEVELS[i]!)) start = i + 1;
  }
  for (let i = start; i < REPROJECTION_LEVELS.length; i++) {
    const level = REPROJECTION_LEVELS[i]!;
    if (!used.has(level)) return level;
  }
  return null;
}
