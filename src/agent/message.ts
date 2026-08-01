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
 * 读路径兼容旧字符串形态（`normalizeOrigin` 归一化为 `{ kind: <旧字符串> }`）。
 *
 * `startsPromptTurn` 语义：区分「唤醒新回合的注入」与「中途注入」。
 * true = 这条消息唤醒一个新的 prompt 回合（消耗 prompt 槽位，如 idle 时后台通知直接开轮）；
 * false/缺省 = 在既有回合中途注入，不单独开轮。
 * 由通知生产点按 decideNotifyRoute 的分流结果填写（busy 中途注入=false，idle 直投=true）。
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
 * origin 归一化：旧盘上字符串形态升级为 `{ kind }` 对象形态；已是对象的直通（同引用）。
 * 所有从盘读入 StoredMessage 的路径都应过一遍（normalizeMessage），保证内存态只有对象形态。
 */
export function normalizeOrigin(origin: MessageOrigin | MessageOriginKind): MessageOrigin {
  return typeof origin === 'string' ? { kind: origin } : origin;
}

/** 读路径归一化：字符串 origin 的消息换成对象形态副本，已是对象的原样返回（同引用）。 */
export function normalizeMessage(m: StoredMessage): StoredMessage {
  // 盘上旧数据 origin 是字符串，类型上不可达故需 as 展开
  const raw = m.origin as MessageOrigin | MessageOriginKind;
  return typeof raw === 'string' ? { ...m, origin: { kind: raw } } : m;
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
  /** 来源标记（结构化对象；旧盘数据是字符串，读入时经 normalizeMessage 归一化）。 */
  origin: MessageOrigin;
  /** 稳定 id，供将来 append-only 持久化与 UI 时间线。 */
  id: string;
  /** ISO 时间戳，审计/展示用，不进 wire。 */
  ts: string;
}

/** 包一条 storage 消息（生成 id/ts）。origin 接受对象或便捷字符串，落盘一律为对象形态。 */
export function stored(
  message: Anthropic.MessageParam,
  origin: MessageOrigin | MessageOriginKind,
): StoredMessage {
  return { message, origin: normalizeOrigin(origin), id: randomUUID(), ts: new Date().toISOString() };
}

/** tool_result 内嵌 content 数组的块类型（官方为 text/image 等，见 Anthropic.ToolResultBlockParam）。 */
export type ToolResultInnerBlock = Exclude<
  Anthropic.ToolResultBlockParam['content'],
  string | undefined
>[number];

/** 深度遍历时回调会收到的块：顶层 ContentBlockParam 或 tool_result 内嵌块。 */
export type AnyContentBlock = Anthropic.ContentBlockParam | ToolResultInnerBlock;

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
