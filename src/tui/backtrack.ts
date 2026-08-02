import type { StoredMessage } from '../agent/message.js';
import type { DisplayItem } from './types.js';

/**
 * 从一条 user StoredMessage 里抽回纯文本（用于 backtrack 时 prefill 回输入框）。
 * content 可能是纯字符串，也可能是 [文本块?, ...图片块]；图片块丢弃，只取文本。
 */
export function extractUserText(msg: StoredMessage): string {
  const content = msg.message.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter((b): b is { type: 'text'; text: string } => (b as { type?: string }).type === 'text')
    .map((b) => b.text)
    .join('');
}

/**
 * 计算「回退编辑上一条用户消息」后的历史与取回文本。
 *
 * 找到 history 里最后一条 origin.kind === 'user' 的消息，把它及其之后的全部历史都截断掉
 * （其后的 assistant/tool 回复一并回滚），并返回该消息的文本用于 prefill。
 * 没有可回退的 user 消息时返回 null。
 */
export function computeBacktrack(
  history: StoredMessage[],
): { history: StoredMessage[]; prefill: string } | null {
  let idx = -1;
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i]!.origin.kind === 'user') {
      idx = i;
      break;
    }
  }
  if (idx === -1) return null;
  return { history: history.slice(0, idx), prefill: extractUserText(history[idx]!) };
}

/**
 * 计算 items（转录区）回退：移除最后一条 kind === 'user' 的条目及其之后的所有条目，
 * 与 computeBacktrack 的历史截断在视觉上对齐（回滚最近一个用户回合）。
 * 没有 user 条目时原样返回。
 */
export function truncateItemsAtLastUser(items: DisplayItem[]): DisplayItem[] {
  let idx = -1;
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i]!.kind === 'user') {
      idx = i;
      break;
    }
  }
  if (idx === -1) return items;
  return items.slice(0, idx);
}
