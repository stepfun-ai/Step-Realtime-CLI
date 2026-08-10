import type { ToolResult } from '../tools/types.js';

/**
 * 工具结果的统一长度上限（兜底层）。
 *
 * ## 为什么需要它
 *
 * 2026-08-02 两次长会话 OOM（堆 4GB 撞顶）的排查结论之一：工具结果全仓没有任何长度上限。
 * 一份工具返回值会同时落到三处——事件流（`tool_end`）、TUI 侧 `items`（`kind:'tool'` 持有
 * `result` 全文，且不受模型侧压缩管辖）、模型侧 `history`。任何一个工具返回一份超大文本，
 * 就在堆上留下多份副本。
 *
 * 各工具自己的入口上限（如 web_fetch 的 `MAX_INLINE_CHARS`）是主约束；本模块是**兜底**：
 * 新增工具、外部 MCP 工具、hook 改写后的结果都会经过这里，不依赖每个工具自觉设限。
 *
 * ## 为什么中间截断而不是尾部截断
 *
 * 工具输出的头部通常是结构信息（表头、文件头、命令回显），尾部通常是结论（汇总行、错误栈的
 * 最内层、退出码）。只保头会丢结论，只保尾会丢上下文。保头尾、挖掉中间，是对模型最友好的一档。
 *
 * ## 为什么默认值比 web_fetch 的单条上限宽
 *
 * 400k 字符 ≈ 800KB（UTF-16），是 web_fetch `MAX_INLINE_CHARS`（200k）的两倍。兜底层设宽一档，
 * 保证正常路径由各工具的语义化上限决定行为（它们能给出针对性的恢复提示），本层只拦真正异常的
 * 体量，不干扰正常截断策略。
 */

/** 工具结果文本的兜底上限（字符数）。`0` 表示不限制。 */
export const DEFAULT_MAX_TOOL_RESULT_CHARS = 400_000;

/** 头部保留占比：头 60% / 尾 40%——头部的结构信息通常比尾部密度低，多留一些。 */
const HEAD_RATIO = 0.6;

/**
 * 中间截断：保留头尾，中间替换为标记（含被省略的字符数，让模型知道丢了多少）。
 * 未超限时原样返回同一引用（不复制字符串）。
 */
export function truncateMiddle(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) return text;
  const marker = (omitted: number): string =>
    `\n\n[... ${String(omitted)} characters omitted by the tool-result size cap ` +
    `(total ${String(text.length)}). Re-run with a narrower scope ` +
    `(offset/limit, more specific path or keyword) to see the middle part. ...]\n\n`;
  // 标记本身占预算：先按空标记估算切点，再用真实标记长度收敛一次即可（标记长度只依赖位数）
  const budget = Math.max(0, maxChars - marker(text.length).length);
  const headLen = Math.floor(budget * HEAD_RATIO);
  const tailLen = budget - headLen;
  const omitted = text.length - headLen - tailLen;
  // 预算被标记吃光（maxChars 配得极小）时退化为纯头部截断，避免产出比原文更长的结果
  if (budget <= 0) return text.slice(0, maxChars);
  return text.slice(0, headLen) + marker(omitted) + text.slice(text.length - tailLen);
}

/**
 * 对工具结果施加兜底上限。未超限时返回原对象（同一引用），超限时返回替换了 `content` 的浅拷贝。
 *
 * 只处理 `content` 文本：`images` 有自己的字节预算（readMedia 侧），`cause` 是内部元数据不进 wire。
 */
export function capToolResult(result: ToolResult, maxChars: number = DEFAULT_MAX_TOOL_RESULT_CHARS): ToolResult {
  if (maxChars <= 0 || result.content.length <= maxChars) return result;
  return { ...result, content: truncateMiddle(result.content, maxChars) };
}
