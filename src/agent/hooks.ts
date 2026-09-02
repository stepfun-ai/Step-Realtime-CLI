import type { ToolResult } from '../tools/types.js';

/** 一次工具调用请求（授权/后处理钩子的入参）。 */
export interface ToolCallRequest {
  id: string;
  name: string;
  input: unknown;
}

/** 授权结果：放行，或拒绝并附原因（原因会作为 tool_result 回灌给模型）。 */
export type Authorization = { decision: 'allow' } | { decision: 'deny'; reason: string; errorCode?: string };

/** 停止后续接描述：inject 为下一轮要注入的用户消息文本。 */
export interface StopContinuation {
  inject: string;
}

/**
 * 循环钩子缝。让权限、结果截断/脱敏、自动续接等横切逻辑挂进无状态回合执行，
 * 而不污染 runTurn 核心。所有钩子可选，缺省即「放行 / 原样 / 不续接」。
 *
 * Phase 3 的权限系统通过 authorizeToolCall 挂入；未来用户 hooks 复用同一缝。
 */
export interface LoopHooks {
  /** 工具执行前的授权检查。默认放行。 */
  authorizeToolCall?(req: ToolCallRequest): Promise<Authorization> | Authorization;
  /** 工具结果回灌前的最后处理（截断 / 脱敏）。默认原样返回。 */
  finalizeToolResult?(
    req: ToolCallRequest,
    result: ToolResult,
  ): Promise<ToolResult> | ToolResult;
  /** 模型以非工具原因停止后，返回续接描述（inject 为下一轮注入文本）；null = 结束。默认 null。 */
  shouldContinueAfterStop?(): Promise<StopContinuation | null> | StopContinuation | null;
}

/** 解析授权：无钩子时默认放行。 */
export async function resolveAuthorization(
  hooks: LoopHooks,
  req: ToolCallRequest,
): Promise<Authorization> {
  if (hooks.authorizeToolCall === undefined) return { decision: 'allow' };
  return hooks.authorizeToolCall(req);
}

/** 解析结果后处理：无钩子时原样返回。 */
export async function resolveFinalizeResult(
  hooks: LoopHooks,
  req: ToolCallRequest,
  result: ToolResult,
): Promise<ToolResult> {
  if (hooks.finalizeToolResult === undefined) return result;
  return hooks.finalizeToolResult(req, result);
}

/** 解析停止后续接：无钩子时默认 null（结束）。 */
export async function resolveContinuation(hooks: LoopHooks): Promise<StopContinuation | null> {
  if (hooks.shouldContinueAfterStop === undefined) return null;
  return hooks.shouldContinueAfterStop();
}
