import type Anthropic from '@anthropic-ai/sdk';
import { stored, type StoredMessage } from '../message.js';

/** resume 恢复时给未配对 tool_use 补的 tool_result 文案（措辞与运行期用户中断的回灌一致）。 */
export const RESUME_INTERRUPT_TOOL_MSG =
  '上次执行被中断，本次工具调用没有完成。这不是系统错误，不要自动重试，按最新指示继续。';

/**
 * 尾部配对校验（resume 载入快照后、续跑前调用）。
 *
 * 运行期每个 tool_use 必配 tool_result 的保证建立在"messages 数组连续原子推进"之上；
 * 落盘引入了新断点：assistant 消息先入列，tool_result 要等整个工具执行段结束才入列。
 * 崩溃若发生在这段窗口里，盘上最后一条就是带 tool_use 的 assistant、没有配对的 tool_result，
 * 原样发给 provider 就是 400。
 *
 * 处理：为末条 assistant 里每个未配对的 tool_use 补合成一条 tool_result 消息。
 * 补合成而不截掉原条——截掉会让模型看不到自己发起过那次调用。
 * 原地修 messages，返回补的 tool_result 条数。
 */
export function repairToolPairing(messages: StoredMessage[]): number {
  // 收集历史里所有已应答的 tool_use_id
  const answered = new Set<string>();
  for (const m of messages) {
    const content = m.message.content;
    if (!Array.isArray(content)) continue;
    for (const b of content) {
      if (b.type === 'tool_result') answered.add(b.tool_use_id);
    }
  }
  // 只查末条 assistant：历史中间的配对由连续原子推进保证，孤儿只可能出现在尾部
  const last = messages[messages.length - 1];
  if (last === undefined || last.message.role !== 'assistant') return 0;
  const content = last.message.content;
  if (!Array.isArray(content)) return 0;
  const orphans = content.filter(
    (b): b is Anthropic.ToolUseBlockParam => b.type === 'tool_use' && !answered.has(b.id),
  );
  if (orphans.length === 0) return 0;
  const repair: Anthropic.ToolResultBlockParam[] = orphans.map((tu) => ({
    type: 'tool_result',
    tool_use_id: tu.id,
    content: RESUME_INTERRUPT_TOOL_MSG,
    is_error: true,
  }));
  messages.push(stored({ role: 'user', content: repair }, 'user'));
  return orphans.length;
}
