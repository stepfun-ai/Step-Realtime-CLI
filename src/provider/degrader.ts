import Anthropic from '@anthropic-ai/sdk';
import type { ModelCapability } from './capability-registry.js';
import { isContextOverflowError } from './retry.js';
import type { ChatProvider } from './types.js';

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
const VIDEO_OMITTED_TEXT = '[video omitted: model has no video input]';
/**
 * 降级重投影换下的旧图占位文本：必须保留「原图曾存在、因 API 限制被移除」的语义。
 * 模型在前面的轮次可能描述过这些图，只写 [image omitted] 会让它以为自己记错了；
 * 写明原因它才能把「我看过的图」和「现在看不到」调和起来（失忆问题的缓解：
 * 公开 issue 里有「占位语义不清导致模型反复引用已不可见的图」的真实案例）。
 */
const IMAGE_DEGRADED_TEXT = '[image removed: exceeded API image limit, older images dropped to retry]';

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

/** 降级重投影的占位（与主动降级区分文案：这里是「图曾被看到、因超限被移除」）。 */
function degradedPlaceholder(block: Block): Block {
  return {
    type: 'text',
    text: block.type === 'document' ? DOCUMENT_OMITTED_TEXT : IMAGE_DEGRADED_TEXT,
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

/**
 * 映射一条消息；空的 content 数组原样保留（不在这里丢消息，避免改变轮次结构）。
 * 下钻 tool_result 的数组 content：read_media 回灌的图片/视频块内嵌在内层，
 * 只看顶层会让投影与降级对它们全部失效（2026-08-13 视频支持时发现的既有缺口：
 * 内嵌图片此前也不参与投影与 keepRecent 计数）。
 */
function mapBlocks(msg: Anthropic.MessageParam, fn: (block: Block) => Block | null): Anthropic.MessageParam {
  if (typeof msg.content === 'string') return msg;
  const out: Block[] = [];
  for (const block of msg.content) {
    let mapped = fn(block);
    if (mapped !== null && mapped.type === 'tool_result' && Array.isArray(mapped.content)) {
      const inner: unknown[] = [];
      for (const ib of mapped.content) {
        const m2 = fn(ib as Block);
        if (m2 !== null) inner.push(m2);
      }
      mapped = { ...mapped, content: inner } as Block;
    }
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
      // video 块独立门控（官方类型无此块，按运行时形状判定）：模型未声明 video_in 时
      // 发送前换占位文本，与 image 投影同一层生效（2026-08-13 read_media 视频支持引入）。
      if (!capability.video_in && (b as unknown as { type: string }).type === 'video') {
        b = { type: 'text', text: VIDEO_OMITTED_TEXT };
      }
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
  // 下钻 tool_result 内嵌块：read_media 回灌的图片在内层，漏数会把「最近的图」判成旧图剥掉。
  let keep: Set<Block> | undefined;
  if (level === 'media-degraded' && keepRecentImages > 0) {
    keep = new Set<Block>();
    const collect = (block: Anthropic.ContentBlockParam): boolean => {
      if (block.type === 'tool_result' && Array.isArray(block.content)) {
        for (let ii = block.content.length - 1; ii >= 0; ii--) {
          if (collect(block.content[ii] as Anthropic.ContentBlockParam)) return true;
        }
        return false;
      }
      if (block.type === 'image') {
        keep!.add(block);
        return keep!.size >= keepRecentImages;
      }
      return false;
    };
    outer: for (let mi = messages.length - 1; mi >= 0; mi--) {
      const content = messages[mi]!.content;
      if (typeof content === 'string') continue;
      for (let bi = content.length - 1; bi >= 0; bi--) {
        if (collect(content[bi]!)) break outer;
      }
    }
  }

  return messages.map((msg) =>
    mapBlocks(msg, (block) => {
      if (isMediaBlock(block)) {
        if (level === 'media-degraded') {
          return keep !== undefined && keep.has(block) ? block : degradedPlaceholder(block);
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
 * 各通道「图片/媒体超限」报错文案的方言集合（全部来自真实 issue 与实测）。
 *
 * 背景：同一语义（媒体太多/太大）在不同厂商的报错文案完全不同——
 * - stepfun 实测（2026-08-06）：`Input images too many. model: ..., max: 60, input: 61`
 * - Anthropic 协议（公开 issue 实录）：`image exceeds 5 MB maximum` /
 *   `image dimensions exceed max allowed size (for many-image requests)`
 * - Gemini/Vertex（多厂商代理层 issue 实录）：`You can only include 10 image links`
 * - OpenAI 兼容网关（公开 issue 实录）：`Image base64 size ... exceeds API limit`
 * - vLLM 系推理端：`At most N image(s) may be provided in one request`
 * - 智谱 BigModel（2026-08-13 实测，glm-x-preview-k）：`messages.content.type 参数非法，
 *   取值范围 ['text']`——端点只接受 text 一种 content part，带 image_url 即 400。
 *   我们发出的非 text part 只有图片，所以这句等价于「不收图片」。
 *
 * 判定原则：只在文案**明确指向媒体**时算可重投影。裸 400（参数错误等）不匹配任何
 * 关键词时不降级——把普通 400 也降级会掩盖真正的调用 bug。413（载荷过大）不加
 * 关键词约束：该状态码语义唯一（请求实体过大），且媒体是 bulk 请求里唯一可能
 * 撑爆载荷的内容。
 */
const MEDIA_ERROR_PATTERNS: readonly RegExp[] = [
  /too many images|images too many/i,
  /image(s)? (exceeds?|too (large|many|big))/i,
  /image dimensions exceed/i,
  /\d+ image links/i,
  /at most \d+ image/i,
  /image base64 size.*exceeds/i,
  /image.*(limit|maximum)/i,
  /payload (too )?large/i,
  // 端点只收 text part（智谱等）：我们发出的非 text part 只有图片，命中即媒体问题
  /content\.type.{0,30}(参数非法|取值范围|invalid|not supported|must be)/i,
];

/**
 * 发送前能力投影（provider 包装器）：image_in=false 时把请求消息里的媒体块
 * 换成占位文本再发，不等服务端 400。只投影请求参数，不改历史存储——切回多模态
 * 模型后图片自动恢复。与错误驱动的重投影链互补：声明过的端点零失败请求，
 * 未声明的端点仍由 400 方言降级链兜底（2026-08-13 设计：能力声明 + 发送前投影）。
 *
 * image_in=true（默认）时原样返回 inner，零包装零开销。
 */
export function withCapabilityProjection<T extends ChatProvider>(
  inner: T,
  capability: ModelCapability,
): T {
  if (capability.image_in) return inner;
  const wrapped = Object.create(Object.getPrototypeOf(inner)) as T;
  Object.assign(wrapped, inner);
  wrapped.stream = (params: Parameters<ChatProvider['stream']>[0]) =>
    inner.stream({ ...params, messages: degradeMessages(params.messages, capability) });
  return wrapped;
}

/** 从错误上提取可匹配的文本（message + error.type，覆盖 SDK 包装与裸 Error）。 */
function errorText(err: unknown): string {
  if (err instanceof Error) return `${err.message} ${err.name}`;
  return String(err);
}

/**
 * 判断错误是否可触发重投影。
 *
 * 两条路径：
 * - 413（载荷过大）：语义唯一，直接可降级。
 * - 400：只在文案命中媒体方言（{@link MEDIA_ERROR_PATTERNS}）且不是上下文溢出时
 *   可降级——400 是「请求无效」的泛化码，裸 400 降级会掩盖真正的调用 bug。
 *
 * 错误类型不限于 Anthropic.APIError：openai 通道的 httpErrorToApiError 已把
 * HTTP 错误统一包装成 Anthropic.APIError（status + 原始文案保留），但裸 Error
 * （网关非 JSON 响应等）也走文案匹配兜底。
 */
export function isReprojectableError(err: unknown): boolean {
  const status =
    err instanceof Anthropic.APIError && typeof err.status === 'number' ? err.status : undefined;
  if (status === 413) return true;
  if (status !== undefined && status !== 400) return false;
  // status 为 400 或错误无 status（裸 Error）：靠文案判定
  if (err instanceof Anthropic.APIError && isContextOverflowError(err)) return false;
  const text = errorText(err);
  return MEDIA_ERROR_PATTERNS.some((p) => p.test(text));
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
