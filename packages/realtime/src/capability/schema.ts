/**
 * Render tool schemas as the [[ACTION]] protocol text injected into
 * instructions for stateless backends (which don't support native tools).
 *
 * Format proven empirically in probes/experiment_text (21/21 hit rate)
 * — see SPEC §3.4.
 */

import type { ToolSchema, ParamSchema } from "./types.js";

/** Stable [[ACTION]] protocol rules. Always present whenever any tool is
 *  registered — does NOT depend on which tools are loaded. Belongs in the
 *  system prompt (instructions) so the model treats it as core behavior. */
export function renderActionProtocolRules(): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("# 工具调用协议 (重要, 必读)");
  lines.push("");
  lines.push(
    "你**没有任何内部能力**完成「可用工具」列表里的任何动作 — 必须通过下面的标记调用, 系统才会真正执行。可用工具的清单和参数在另一条 style-instruction 消息里。",
  );
  lines.push("");
  lines.push("调用格式 (用方括号 [[ ]], 不能用尖括号):");
  lines.push("");
  lines.push("[[ACTION]]");
  lines.push(`{"name": "<tool_name>", "arguments": {...}}`);
  lines.push("[[/ACTION]]");
  lines.push("");
  lines.push("**严格规则 (违反会导致用户体验异常)**:");
  lines.push(
    "- **不许假装调过**: 不能说「我查一下...」、「让我试试...」、「暂时查不到...」、「系统工具调用失败」之类的话**而不真发 [[ACTION]] 标记**。要么真发标记调用, 要么直接告诉用户你不能做这件事。",
  );
  lines.push(
    "- **不要复述历史结果**: 即使历史对话里有过相同问题的答复, 如果当前用户在重新问 (比如「现在几点」、「我喜欢什么」), 必须重新发 [[ACTION]] 拿新鲜数据, 不要从记忆里抄。",
  );
  lines.push(
    "- **调工具时输出尽量简洁**: 不要先念出工具名或参数, 整段回复就是 [[ACTION]] 标记本身; 系统会回填结果, 你拿到结果再用自然语言回答用户。",
  );
  lines.push(
    "- **不知道参数就反问**: 如果信息不足以确定参数 (比如不知道用户想换成哪个具体音色), 先反问用户澄清, 不要瞎填。",
  );
  return lines.join("\n");
}

/** Dynamic tool catalog. Changes whenever capabilities are registered/
 *  unregistered. Sent via a separate channel (e.g. style-instruction
 *  history item) so updating tools doesn't churn the system prompt. */
export function renderToolCatalog(schemas: ToolSchema[]): string {
  if (schemas.length === 0) return "";
  const lines: string[] = [];
  lines.push("可用工具 (用上面 [[ACTION]] 协议调用):");
  lines.push("");
  for (const s of schemas) {
    lines.push(formatSchemaForPrompt(s));
    lines.push("");
  }
  return lines.join("\n");
}

/** Legacy combined renderer — kept for callers that still want one blob.
 *  Equivalent to renderActionProtocolRules() + renderToolCatalog(). */
export function renderToolsAsActionProtocol(schemas: ToolSchema[]): string {
  if (schemas.length === 0) return "";
  return renderActionProtocolRules() + "\n\n" + renderToolCatalog(schemas);
}

function formatSchemaForPrompt(s: ToolSchema): string {
  const lines: string[] = [];
  lines.push(`## ${s.name}`);
  lines.push(s.description);
  const props = s.parameters.properties;
  if (Object.keys(props).length > 0) {
    lines.push("参数:");
    for (const [name, p] of Object.entries(props)) {
      const required = s.parameters.required?.includes(name) ? " (必填)" : "";
      lines.push(`- ${name}${required}: ${describeParam(p)}`);
    }
  }
  return lines.join("\n");
}

function describeParam(p: ParamSchema): string {
  const parts: string[] = [p.type];
  if (p.enum) parts.push(`enum=${JSON.stringify(p.enum)}`);
  if (p.minimum !== undefined) parts.push(`min=${p.minimum}`);
  if (p.maximum !== undefined) parts.push(`max=${p.maximum}`);
  let s = parts.join(", ");
  if (p.description) s += ` — ${p.description}`;
  return s;
}
