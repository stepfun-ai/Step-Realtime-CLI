/**
 * 阶跃星辰（StepFun）协议适配的公用件。
 *
 * ## 为什么需要这一层
 *
 * Step 的三个接口分别声明兼容 OpenAI Chat Completions、OpenAI Responses、
 * Anthropic Messages。经 2026-08-02 逐参数实测 + 官方文档比对，兼容程度分三档：
 *
 * | 接口 | 与上游官方的关系 | 结论 |
 * |---|---|---|
 * | Chat Completions | 取值域是官方子集（无 `content_filter` / `function_call`），另加 `reasoning` / `reasoning_content` 双字段 | 兼容 |
 * | Responses | `status` / `incomplete_details.reason` 均为官方子集 | 兼容 |
 * | Messages | **官方 `thinking.budget_tokens` 接受但静默无效**，Step 要的是顶层 `effort` | **不兼容** |
 *
 * 最后一行是本模块存在的理由：同一语义（控制思考深度）换了参数名与嵌套位置，
 * 任何「按协议族推导」的通用适配层都无法自动得出，必须显式适配。
 *
 * ## 实测依据（step-code-labs/api-param-semantics/param-truth.mjs，step-3.7-flash）
 *
 * - `thinking:{type:'enabled',budget_tokens:4096}` → 200，`stop_reason=max_tokens`，正文仅 628 字符（被截断）
 * - `effort:'low'` → 200，`stop_reason=end_turn`，正文 803 字符（正常收尾）
 * - `reasoning_effort` 取 `xhigh` / `none` / `bogus` 均返回 200：**Step 不校验 effort 取值域**，
 *   非法值被静默忽略，因此无法靠报错探测支持性，必须由本模块在客户端侧收敛。
 * - `reasoning_format` 三种取值下 `reasoning` 与 `reasoning_content` **恒双写且等长**，
 *   与文档「二选一」描述不符 → 解析侧读任一字段皆可，不需要发这个参数。
 *
 * 官方取值域来源：`@anthropic-ai/sdk` 的 `StopReason` 类型（node_modules 内即权威）、
 * OpenAI 官方文档的 `finish_reason` / `incomplete_details.reason` 枚举。
 */

import type Anthropic from '@anthropic-ai/sdk';

/**
 * Step 支持的思考强度档位。
 *
 * 三个接口共用同一套档位名，但**参数名与位置各不相同**（见 {@link stepEffortParam}）。
 * `step-3.5-flash-2603` 按官方文档只支持 low / high 两档；传 medium 不报错
 * （Step 不校验），落到服务端默认行为，故此处不做模型级裁剪，只保证发出去的值合法。
 */
export const STEP_EFFORTS = ['low', 'medium', 'high'] as const;

export type StepEffort = (typeof STEP_EFFORTS)[number];

/** 判定字符串是否为合法 Step 档位。 */
export function isStepEffort(value: unknown): value is StepEffort {
  return typeof value === 'string' && (STEP_EFFORTS as readonly string[]).includes(value);
}

/** Step 三个接口的 effort 参数形态。 */
export type StepChannel = 'messages' | 'chat' | 'responses';

/**
 * 按通道生成 effort 请求字段。三个接口参数名与嵌套层级都不同：
 *
 * - `messages`   → `{ output_config: { effort: 'low' } }`
 * - `chat`       → `{ reasoning_effort: 'low' }`（顶层）
 * - `responses`  → `{ reasoning: { effort: 'low' } }`（嵌套）
 *
 * ## messages 分支的位置曾经是错的（2026-08-03 修）
 *
 * 此前发的是**顶层 `effort`**，依据是早期实测「发了不报错」。但 Step 对未知参数
 * 一律静默忽略（见本文件头注释：`reasoning_effort` 传 `bogus` 也返回 200），
 * **「不报错」从来不能证明「生效」**。
 *
 * 官方[step-3.7-flash 文档](https://platform.stepfun.com/docs/zh/guides/models/step-3.7-flash)
 * 原文：「Chat Completions API 使用 `reasoning_effort` 控制推理强度；
 * Messages API 使用 `output_config.effort`」。这也与 Anthropic 官方方向一致——
 * Claude 4.6 起 `thinking.budget_tokens` 标记 deprecated，改用 `output_config.effort`。
 *
 * 症状：档位切换对 messages 通道完全无效果，且因为请求成功、思考照常返回，
 * 表面上一切正常，只有做配对实验统计输出 token 才能发现档位没起作用。
 *
 * @returns 可直接展开进请求体的片段；effort 为 undefined 时返回空对象（不发字段，走服务端默认）。
 */
export function stepEffortParam(
  channel: StepChannel,
  effort: StepEffort | undefined,
): Record<string, unknown> {
  if (effort === undefined) return {};
  switch (channel) {
    case 'messages':
      return { output_config: { effort } };
    case 'chat':
      return { reasoning_effort: effort };
    case 'responses':
      return { reasoning: { effort } };
  }
}

/**
 * Step Chat Completions 的 `finish_reason` → Anthropic `stop_reason`。
 *
 * Step 文档声明取值域为 `stop` / `length` / `tool_calls`，是 OpenAI 官方的子集
 * （不含 `content_filter` / `function_call`）。但网关与未来版本可能透传官方值，
 * 因此这里按**官方全集**处理，未知值不静默当正常结束。
 *
 * 与旧 `mapStopReason` 的差别：旧实现把一切未知值（含空串、`content_filter`）
 * 都归成 `end_turn`，导致内容拦截与协议异常被伪装成正常收尾。
 *
 * @param finishReason 服务端返回的原始值；null / 空串表示流未给出结束标志。
 * @param hasToolCalls 本轮是否累积到工具调用（个别网关末帧漏 finish_reason 时兜底）。
 * @returns Anthropic stop_reason；无信号时返回 null（由上层判定为异常空响应，而非正常结束）。
 */
export function mapStepChatFinishReason(
  finishReason: string | null | undefined,
  hasToolCalls: boolean,
): Anthropic.Message['stop_reason'] | null {
  if (hasToolCalls || finishReason === 'tool_calls' || finishReason === 'function_call') {
    return 'tool_use';
  }
  if (finishReason === 'length') return 'max_tokens';
  if (finishReason === 'stop') return 'end_turn';
  // content_filter：官方语义为「内容被过滤器拦截」，最接近 Anthropic 的 refusal。
  if (finishReason === 'content_filter') return 'refusal';
  // 空串 / null / undefined / 未知值：无有效结束信号，不冒充 end_turn。
  return null;
}

/**
 * Step Responses 的 `status` + `incomplete_details.reason` → Anthropic `stop_reason`。
 *
 * Responses 的 `status` 是**响应级状态**（completed / incomplete / failed），
 * 与另两个接口的「停止原因」不是同一层概念——真正对应停止原因的是
 * `incomplete_details.reason`。此前代码完全不读这两个字段、把 stop_reason 写死为
 * `tool_use` / `end_turn` 二选一，`incomplete` 被当成正常结束（空响应无声吞掉）。
 *
 * @param status 响应级状态。
 * @param incompleteReason `incomplete_details.reason`；Step 文档常见 `max_output_tokens`，
 *   官方另有 `content_filter`。
 * @param hasToolUse 输出里是否含工具调用。
 * @returns Anthropic stop_reason；status 缺失时返回 null（视作无信号）。
 */
export function mapStepResponsesStatus(
  status: string | undefined,
  incompleteReason: string | undefined,
  hasToolUse: boolean,
): Anthropic.Message['stop_reason'] | null {
  if (status === 'incomplete') {
    if (incompleteReason === 'content_filter') return 'refusal';
    // max_output_tokens 及其余未列举原因：都是「预算耗尽被切断」，对齐 max_tokens。
    return 'max_tokens';
  }
  if (status === 'completed') return hasToolUse ? 'tool_use' : 'end_turn';
  // failed / in_progress / cancelled / queued / 缺失：均非正常收尾，交上层分型处理。
  return null;
}

/**
 * Step Messages 的 `stop_reason` 归一。
 *
 * Step 文档声明 `end_turn` / `tool_use` / `max_tokens`，实测另有 `stop_sequence`
 * （命中 stop_sequences 时返回），均属 Anthropic 官方 StopReason 子集，可直接透传。
 * 官方还有 `pause_turn` / `refusal` 两个值 Step 未声明，透传同样安全。
 *
 * @returns 已知官方值原样返回；空值/未知值返回 null（不冒充 end_turn）。
 */
export function normalizeStepMessagesStopReason(
  stopReason: string | null | undefined,
): Anthropic.Message['stop_reason'] | null {
  const KNOWN: readonly string[] = [
    'end_turn',
    'max_tokens',
    'stop_sequence',
    'tool_use',
    'pause_turn',
    'refusal',
  ];
  if (typeof stopReason === 'string' && KNOWN.includes(stopReason)) {
    return stopReason as Anthropic.Message['stop_reason'];
  }
  return null;
}
