import type Anthropic from '@anthropic-ai/sdk';

/**
 * 悬空 tool_use 的合成 tool_result 文案：统一出口。
 *
 * 三处独立实现（wirelog.ts / subagent/repair.ts / projector.ts）的文案各不相同，
 * 现在归一为这一个常量，所有闭合路径共用。
 */
export const DANGLING_TOOL_RESULT_TEXT =
  '[工具调用未产生结果：执行被中断。不要重试这次调用，按最新指示继续。]';

/**
 * 为给定的 tool_use id 列表合成 error tool_result 块数组。
 *
 * 每个块都是 `is_error: true`，content 用统一文案。
 * 调用方按自己的数据形态（wire 层/存储层）决定怎么插入。
 */
export function synthesizeToolResultBlocks(
  toolUseIds: readonly string[],
): Anthropic.ToolResultBlockParam[] {
  return toolUseIds.map((id) => ({
    type: 'tool_result',
    tool_use_id: id,
    is_error: true,
    content: DANGLING_TOOL_RESULT_TEXT,
  }));
}
