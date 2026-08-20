import { randomUUID } from 'node:crypto';
import type Anthropic from '@anthropic-ai/sdk';

/**
 * storage 层 message 的来源种类：决定 undo 边界、压缩处理、以及投影到 wire 时的取舍。
 * - user/assistant/tool：正常对话轮
 * - user_verbatim：压缩时保真保留的用户原话（wire 里就是普通 user 消息，storage 层可识别）
 * - compaction_summary：full 压缩产出的摘要（wire 里是普通文本，storage 层可识别）
 * - injection：注入的 system-reminder（append-only，压缩后可重注入）
 * - background_task：后台任务终态通知（由通知子系统经 buildSettleMessage 产生）
 *
 * `user_verbatim` 与 `user` 的分工：前者是压缩产物、不是真人这一轮的输入。
 * 因此它**不**参与轮次计数（turns.ts）与回退编辑（backtrack.ts）——那两处按 `kind === 'user'`
 * 判断，新类型天然被排除，这是有意的：否则 Ctrl+回退会把压缩保真块当成
 * 「上一条用户输入」取回输入框，轮数也会随压缩虚增。
 * 但它**要**参与下一轮压缩的保真选择（compact.ts 的 isCompactableUserOrigin），
 * 这正是原话能跨多轮压缩存活的机制。
 */
export type MessageOriginKind =
  | 'user'
  | 'user_verbatim'
  | 'assistant'
  | 'tool'
  | 'compaction_summary'
  | 'injection'
  | 'background_task';

/**
 * 结构化 origin：kind 是判别字段，其余为按需携带的载荷。
 * 内存与落盘一律为本对象形态（1.0 前破坏性清理：旧字符串形态不再归一化）。
 *
 * `startsPromptTurn` 语义：区分「唤醒新回合的注入」与「中途注入」。
 * true = 这条消息唤醒一个新的 prompt 回合（消耗 prompt 槽位，如 idle 时后台通知直接开轮）；
 * false/缺省 = 在既有回合中途注入，不单独开轮。
 * 由通知生产点按 decideNotifyRoute 的分流结果填写（busy 中途注入=false，idle 直投=true）。
 *
 * **当前状态：只写不读。** 生产代码里所有引用都是写入点（notify.ts / loop.ts / PiChat.ts / cli.ts），
 * 没有任何消费方据此改变行为——轮次计数走 turns.ts 的 `kind === 'user'`，与本字段无关。
 * 保留它是因为语义明确且已有测试锁定：将来若要让「唤醒型注入」参与轮次统计或 prompt 配额，
 * 判据就在这里。新增消费方时请一并更新本段说明。
 */
export interface MessageOrigin {
  kind: MessageOriginKind;
  /** 后台任务 id（kind === 'background_task' 的通知填写）。 */
  taskId?: string;
  /** 通知幂等键（去重与重放回填「已送达」集合用）。 */
  notificationId?: string;
  /** 来源 agent id（子 agent 通知路由用）。 */
  agentId?: string;
  /** true = 唤醒新回合的注入；缺省 = 中途注入。 */
  startsPromptTurn?: boolean;
}

/**
 * 该 storage 消息是否为「系统自撰的 user 角色消息」——即 wire 上是 user，但并非真人这一轮敲进来的输入。
 *
 * 协议约定要求这些内容必须挂在 user 角色下（工具结果回灌、system-reminder、压缩摘要都是如此），
 * 但它们对**用户视角**不是输入：把它们渲染成用户气泡，等于系统冒充用户说话。典型症状是
 * resume 后看到自己「说」过中断提示、后台任务 XML 信封、压缩摘要——那些话用户从没打过。
 *
 * 判定按白名单反向取：只有 `user`（真人本轮输入）与 `user_verbatim`（压缩保真下来的真人原话，
 * 内容仍是用户当初说的）算真人可见输入，其余 user 角色一律为系统自撰。
 * 新增 origin kind 时默认落进「系统自撰」侧，不会因为漏改而泄漏成用户气泡。
 *
 * UI 层要展示这些事件时，走各自的专用渲染（如后台任务用 note 条目提示），而不是伪装成用户输入。
 */
export function isSystemAuthoredUser(origin: MessageOrigin): boolean {
  return origin.kind !== 'user' && origin.kind !== 'user_verbatim';
}

/**
 * 存储层 message（信封结构）。内层 `message` 就是干净的 Anthropic wire 格式，
 * 元数据（origin/id/ts）一律在外层，绝不进 wire——发 provider 时用 toWire 取内层。
 * 这样元数据物理隔离，不可能泄漏进 Anthropic 请求（严格 schema，多余字段会 400）。
 *
 * 图片落盘形态：内存态 `message` 里图片 `source.data` 是原始 base64；落盘时（store.save/appendFull）
 * 会把大图卸载成附件文件、`source.data` 换成 `stepref:<sha256>` 指针（见 session/attachments.ts）。
 * 顶层图片块与 tool_result 数组 content 内嵌的图片块（read_media 回传）都按此处理。
 * 故从盘上读回的 StoredMessage 其图片可能是 stepref，发 provider 前由 toWire rehydrate 回 base64。
 */
export interface StoredMessage {
  /** 内层 = 干净 wire 格式。 */
  message: Anthropic.MessageParam;
  /** 来源标记（结构化对象形态，见 {@link MessageOrigin}）。 */
  origin: MessageOrigin;
  /** 稳定 id，供将来 append-only 持久化与 UI 时间线。 */
  id: string;
  /** ISO 时间戳，审计/展示用，不进 wire。 */
  ts: string;
}

/** 包一条 storage 消息（生成 id/ts）。origin 只接受对象形态（如 `{ kind: 'user' }`）。 */
export function stored(
  message: Anthropic.MessageParam,
  origin: MessageOrigin,
): StoredMessage {
  return { message, origin, id: randomUUID(), ts: new Date().toISOString() };
}

/** tool_result 内嵌 content 数组的块类型（官方为 text/image 等，见 Anthropic.ToolResultBlockParam）。 */
export type ToolResultInnerBlock = Exclude<
  Anthropic.ToolResultBlockParam['content'],
  string | undefined
>[number];

/**
 * 视频内容块：Anthropic 官方类型无此块（部分 anthropic 兼容端点定义了同形状扩展，
 * openai 协议侧由适配层翻译成 video_url）。source.data 落盘时同样走 stepref 卸载。
 */
export interface VideoBlock {
  type: 'video';
  source: { type: 'base64'; media_type: string; data: string };
}

/** 深度遍历时回调会收到的块：顶层 ContentBlockParam 或 tool_result 内嵌块。 */
export type AnyContentBlock = Anthropic.ContentBlockParam | ToolResultInnerBlock | VideoBlock;

/**
 * 深度遍历一条 wire 消息的 content 块：顶层块逐个回调，且下钻进 tool_result 的数组 content
 * （read_media 等工具回传的图片就内嵌在这里，只看顶层块的路径对它们不可见）。
 * tool_result 的 content 为 string 或缺省时不下钻（纯文本，无内嵌块）。
 */
export function forEachBlockDeep(
  content: Anthropic.MessageParam['content'],
  fn: (block: AnyContentBlock) => void,
): void {
  if (typeof content === 'string') return;
  for (const block of content) {
    fn(block);
    if (block.type === 'tool_result' && Array.isArray(block.content)) {
      for (const inner of block.content) fn(inner);
    }
  }
}

/**
 * 深度映射一条 wire 消息的 content 块（同样下钻 tool_result 的数组 content）。
 * fn 返回原块引用表示不变；任一回调返回新块时重建该层数组并标记 changed。
 * 无变化时 content 返回同引用（调用方可零成本判断未动）。
 */
export function mapBlocksDeep(
  content: Anthropic.MessageParam['content'],
  fn: (block: AnyContentBlock) => AnyContentBlock,
): { content: Anthropic.MessageParam['content']; changed: boolean } {
  if (typeof content === 'string') return { content, changed: false };
  let changed = false;
  const next = content.map((block) => {
    if (block.type === 'tool_result' && Array.isArray(block.content)) {
      let innerChanged = false;
      const inner = block.content.map((b) => {
        const mapped = fn(b);
        if (mapped !== b) innerChanged = true;
        return mapped as typeof b;
      });
      const mappedBlock = fn(block);
      if (mappedBlock !== block) {
        changed = true;
        return mappedBlock as typeof block;
      }
      if (!innerChanged) return block;
      changed = true;
      return { ...block, content: inner };
    }
    const mapped = fn(block);
    if (mapped !== block) changed = true;
    return mapped as typeof block;
  });
  return changed ? { content: next, changed: true } : { content, changed: false };
}
