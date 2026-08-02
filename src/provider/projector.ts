import type Anthropic from '@anthropic-ai/sdk';

/**
 * 请求前统一整形（projection）：把内部消息序列修成任何 provider 都接受的最简形态。
 *
 * 设计来源：消息事件日志与后台通知设计 §5.3 / §7.5.2（参考主流实现
 * 修复清单）。输入输出都是 `Anthropic.MessageParam[]`——
 * 本模块刻意不 import 消息存储层（src/agent/message.ts），宿主元数据（origin/id/ts）
 * 由调用方在进本层之前剥掉（现有 toWire 已承担此责），保持投影层与存储层解耦。
 *
 * 修复清单（按序执行）：
 * 1. 孤儿 tool_result 修复：找不到对应 tool_use 的 tool_result 丢弃；
 *    有 tool_use 无 tool_result 的，合成一条错误 tool_result 闭合（崩在工具执行
 *    中途的历史不带闭合结果直接回灌会被服务端拒绝）。
 * 2. 合并连续同 role 消息（content 块直接拼接）。
 * 3. 首条消息不是 user 时，补一条空 user 消息（部分端点要求对话必须从 user 开始）。
 *
 * 不改动入参数组与消息对象，全部返回新对象。
 */

/** 合成闭合结果的占位文本：工具结果在宿主侧丢失（如崩溃中断），对模型如实标注。 */
const SYNTHETIC_TOOL_RESULT_TEXT = '[tool result missing: execution was interrupted]';

type Block = Anthropic.ContentBlockParam;

/** content 归一化为 block 数组（字符串包成单个 text block）。 */
function toBlocks(msg: Anthropic.MessageParam): Block[] {
  if (typeof msg.content === 'string') {
    return msg.content === '' ? [] : [{ type: 'text', text: msg.content }];
  }
  return [...msg.content];
}

/** 收集全部 assistant 消息里的 tool_use id（保持出现顺序）。 */
function collectToolUseIds(messages: Anthropic.MessageParam[]): string[] {
  const ids: string[] = [];
  for (const msg of messages) {
    if (msg.role !== 'assistant') continue;
    for (const block of toBlocks(msg)) {
      if (block.type === 'tool_use') ids.push(block.id);
    }
  }
  return ids;
}

/**
 * 第一步：孤儿 tool_result 丢弃 + 悬空 tool_use 合成闭合。
 * 合成结果优先并入紧随其后的 user 消息；该 assistant 之后没有 user 消息时，
 * 就地插入一条只含合成结果的 user 消息。
 */
function repairToolPairing(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const toolUseIds = new Set(collectToolUseIds(messages));
  const answered = new Set<string>();

  const out: Anthropic.MessageParam[] = messages.map((msg) => {
    const blocks = toBlocks(msg);
    const filtered = blocks.filter((block) => {
      if (block.type !== 'tool_result') return true;
      if (!toolUseIds.has(block.tool_use_id)) return false; // 孤儿，丢弃
      answered.add(block.tool_use_id);
      return true;
    });
    return { role: msg.role, content: filtered };
  });

  // 悬空 tool_use：按消息顺序找所属 assistant，合成错误结果闭合
  for (const id of collectToolUseIds(messages)) {
    if (answered.has(id)) continue;
    const synthetic: Block = {
      type: 'tool_result',
      tool_use_id: id,
      content: SYNTHETIC_TOOL_RESULT_TEXT,
      is_error: true,
    };
    const assistantIdx = out.findIndex(
      (msg) =>
        msg.role === 'assistant' &&
        (msg.content as Block[]).some((b) => b.type === 'tool_use' && b.id === id),
    );
    const next = out[assistantIdx + 1];
    if (next !== undefined && next.role === 'user') {
      out[assistantIdx + 1] = { role: 'user', content: [synthetic, ...(next.content as Block[])] };
    } else {
      out.splice(assistantIdx + 1, 0, { role: 'user', content: [synthetic] });
    }
  }
  return out;
}

/** 第二步：合并连续同 role 消息；空 content 的消息（修复后被掏空）直接丢弃。 */
function mergeConsecutiveSameRole(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];
  for (const msg of messages) {
    const blocks = toBlocks(msg);
    if (blocks.length === 0) continue;
    const last = out[out.length - 1];
    if (last !== undefined && last.role === msg.role) {
      out[out.length - 1] = { role: msg.role, content: [...(last.content as Block[]), ...blocks] };
    } else {
      out.push({ role: msg.role, content: blocks });
    }
  }
  return out;
}

/**
 * 投影入口：按「修复工具配对 → 合并同 role → 补首条 user」的顺序整形。
 * 空 user 消息用空字符串 content（部分端点要求 user 开场但接受空正文）；
 * 若目标端点连空正文也拒，由 degrader 的 strict 档再处理。
 */
export function projectMessages(messages: Anthropic.MessageParam[]): Anthropic.MessageParam[] {
  const repaired = repairToolPairing(messages);
  const merged = mergeConsecutiveSameRole(repaired);
  if (merged.length === 0 || merged[0]!.role !== 'user') {
    return [{ role: 'user', content: '' }, ...merged];
  }
  return merged;
}
