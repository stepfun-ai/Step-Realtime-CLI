import type { SubagentProgressEvent } from '../agent/events.js';

/**
 * stream-json 输出信封（`-p --output-format stream-json`）。
 *
 * 契约：**每行一个 JSON 对象，顶层恒有 `type` 字段做判别式**，消费方按 `type` 分派即可，
 * 不需要递归解包。这与 Claude Agent SDK 的做法一致（其 `parent_tool_use_id` / `tool_use_id`
 * 平铺在顶层，而非把子事件嵌套进父事件的 payload）。
 *
 * 三个事件族共用一个平坦命名空间，靠 `type` 前缀区分来源：
 * - agent 循环事件：`AgentEvent` 原样输出（`text` / `tool_start` / `usage` / ...），无前缀
 * - 子 agent 事件：`subagent.*`
 * - 会话元信息：`session.*`
 *
 * 历史包袱：`resumeHintMeta` 曾带 `role: 'meta'` 字段，与 `AgentEvent` 的扁平结构不一致，
 * 消费方需要同时认 `type` 和 `role` 两套判别。2026-08-02 统一为只认 `type`，`role` 保留
 * 但标记为 deprecated（见 `session/resumeHint.ts`），下个 breaking 版本移除。
 */

/** 当前 stream-json 协议版本。信封结构或事件语义发生不兼容变更时递增。 */
export const STREAM_JSON_PROTOCOL_VERSION = 1;

/**
 * 子 agent 进度事件的 stream-json 形态。
 *
 * `subagent_id` 是并行子 agent 的归属锚点：同一轮里可能有多个子 agent 同时在跑，
 * 消费方靠它把 `subagent.tool` 归到正确的 `subagent.start` 下。runner 侧该 id 可能为
 * undefined（单发场景不分配 id），此时省略该字段而不是填空串——省略表示「无并行歧义」。
 */
export type SubagentStreamEvent =
  | { type: 'subagent.start'; subagent_id?: string; subagent_type: string; description: string }
  | { type: 'subagent.tool'; subagent_id?: string; name: string }
  | { type: 'subagent.usage'; subagent_id?: string; tokens: number }
  | { type: 'subagent.error'; subagent_id?: string; message: string }
  | {
      type: 'subagent.end';
      subagent_id?: string;
      is_error: boolean;
      /**
       * 子 agent 的结论文本。外部消费方靠它知道「干了什么」，而非只知道跑完了。
       * 超过 `SUBAGENT_SUMMARY_MAX` 时截断——实测子 agent 结论常达数百至上千字符，
       * 整段塞进逐行 JSON 会让单行体积失控。截断时置 `summary_truncated: true`，
       * 完整文本可凭 `session_id` 从子会话读取（同 Claude 用 output_file 指向完整产出的思路）。
       */
      summary?: string;
      /** summary 是否被截断。仅在真的截断时出现。 */
      summary_truncated?: boolean;
      /** 子会话 id，完整产出的取回凭据（也是 resume 的入口）。 */
      session_id?: string;
      /** 工具调用次数。 */
      tool_uses?: number;
      /** 墙钟耗时毫秒。 */
      duration_ms?: number;
    };

/** `subagent.end` 的 summary 在 wire 上的长度上限（字符）。超出截断并置 summary_truncated。 */
export const SUBAGENT_SUMMARY_MAX = 500;

/**
 * 把内部 `SubagentProgressEvent` 映射为 stream-json 事件。
 *
 * 字段命名从内部的 camelCase 转为 wire 上的 snake_case（`subagentType` → `subagent_type`、
 * `isError` → `is_error`），与 `session.resume_hint` 的 `session_id` 保持同一风格。
 * 内部类型改名不应波及对外契约，这层映射就是隔离带。
 */
export function toSubagentStreamEvent(
  id: string | undefined,
  ev: SubagentProgressEvent,
): SubagentStreamEvent {
  const base = id !== undefined ? { subagent_id: id } : {};
  switch (ev.kind) {
    case 'start':
      return { type: 'subagent.start', ...base, subagent_type: ev.subagentType, description: ev.description };
    case 'tool':
      return { type: 'subagent.tool', ...base, name: ev.name };
    case 'usage':
      return { type: 'subagent.usage', ...base, tokens: ev.tokens };
    case 'error':
      return { type: 'subagent.error', ...base, message: ev.message };
    case 'end': {
      // summary 截断：保留头部（结论通常在开头），尾部加省略号提示还有内容。
      const full = ev.summary;
      const truncated = full !== undefined && full.length > SUBAGENT_SUMMARY_MAX;
      const summary = truncated ? `${full.slice(0, SUBAGENT_SUMMARY_MAX)}…` : full;
      return {
        type: 'subagent.end',
        ...base,
        is_error: ev.isError,
        // 可选字段缺省时省略而非填 null：与 subagent_id 同一策略，让 JSON 保持精简，
        // 消费方按「字段在不在」判断而非比对空值。
        ...(summary !== undefined ? { summary } : {}),
        ...(truncated ? { summary_truncated: true } : {}),
        ...(ev.sessionId !== undefined ? { session_id: ev.sessionId } : {}),
        ...(ev.toolUses !== undefined ? { tool_uses: ev.toolUses } : {}),
        ...(ev.durationMs !== undefined ? { duration_ms: ev.durationMs } : {}),
      };
    }
  }
}

/**
 * 把冒泡到 `-p` 顶层的异常转成 agent 事件流里的结构化 `error` 事件。
 *
 * 存在的理由：没有这层，agent 循环的任何异常会走 Node 默认未捕获 rejection——
 * stream-json 消费方只拿到半截 JSON 流加一坨堆栈，收不到任何可判别的错误事件，
 * 且会话落盘与 resume 提示被整个跳过（会话丢失）。
 *
 * 对照 Claude Agent SDK 的「错误提升」（`query.py:340-349`）：CLI 报错时先发结构化
 * 错误再非零退出，SDK 用结构化文本替换无信息的 "exit code 1"。同一个取向——
 * **调用方拿到的必须是可消费的错误，不是一个孤零零的退出码。**
 *
 * 非 Error 抛出物（字符串、对象）一律 String 化，保证 message 恒为字符串。
 */
export function errorEventFromThrown(e: unknown): { type: 'error'; message: string } {
  return { type: 'error', message: e instanceof Error ? e.message : String(e) };
}

/**
 * 把 `AgentEvent` 序列化为 stream-json 的一行。
 *
 * 存在的理由是剥离内部字段：`error` 事件带 `cause`（原始异常对象，供子 agent 运行器识别
 * 429 做重排队），这是**内部元数据**——`JSON.stringify` 会把它整个吐出去，若 provider 把
 * 带 headers 的响应对象挂在上面，认证信息会直接出现在 stdout。对外只保留 message。
 *
 * 其余事件原样输出：它们的字段本就是对外契约的一部分。
 */
export function agentEventLine(ev: { type: string; [k: string]: unknown }): string {
  if (ev.type === 'error') {
    return JSON.stringify({ type: 'error', message: ev.message });
  }
  return JSON.stringify(ev);
}

/**
 * 子 agent 事件的 text 模式渲染（stderr）。
 *
 * 只渲染 `tool` 与 `error`：text 模式面向人眼，stdout 要保持可管道（只出 assistant 正文），
 * start/usage/end 的信息量对人类读者是噪声。返回 null 表示不渲染。
 * stream-json 模式不走这里——那边五种事件全要，程序消费方需要完整生命周期。
 */
export function subagentTextLine(ev: SubagentProgressEvent): string | null {
  if (ev.kind === 'tool') return `  [subagent] ${ev.name}\n`;
  if (ev.kind === 'error') return `  [subagent:error] ${ev.message}\n`;
  return null;
}
