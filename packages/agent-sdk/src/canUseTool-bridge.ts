import type {
  ToolApprovalDecision,
  ToolApprovalHandler,
  ToolApprovalRequest,
  ToolPermissionDecision,
  ToolPermissionPolicy,
  ToolSpec,
} from "@step-cli/protocol";
import { safeParseJson } from "@step-cli/utils/json.js";
import { TOOL_RISK, isAcceptEditsTool } from "./tool-risk.js";
import type { CanUseTool, PermissionMode, PermissionResult } from "./types.js";

export interface CanUseToolBridge {
  permissionPolicy: ToolPermissionPolicy | undefined;
  approvalHandler: ToolApprovalHandler | undefined;
  /**
   * Decisions populated on deny so the event-translator can synthesize a
   * `system{permission_denied}` event when the matching tool_result lands.
   */
  pendingDenials: Map<string, { message: string }>;
  /** Drop any per-turn state. Called from query.ts at every turn boundary. */
  onTurnBoundary: () => void;
}

export interface CanUseToolBridgeOptions {
  canUseTool?: CanUseTool;
  permissionMode?: PermissionMode;
  allowDangerouslySkipPermissions?: true;
  abortController?: AbortController;
}

/**
 * Three-layer gate:
 *   1. bypassPermissions / allowDangerouslySkipPermissions / "dontAsk" / "auto"
 *      → no permissionPolicy installed.
 *   2. acceptEdits + tool ∈ {Edit, Write, MultiEdit, NotebookEdit} → allow.
 *   3. otherwise → host canUseTool closure decides; deny writes pendingDenials.
 *
 * toolCallId arrives via ToolApprovalRequest (threaded through ToolRuntime),
 * so the bridge needs no side queue and no toolName-based FIFO. Stale denials
 * are cleared on each turn boundary to prevent cross-turn correlation drift
 * if a tool_use is rejected upstream and never reaches onToolResult.
 */
export function createCanUseToolBridge(
  options: CanUseToolBridgeOptions,
): CanUseToolBridge {
  const pendingDenials = new Map<string, { message: string }>();

  if (
    !options.canUseTool ||
    options.allowDangerouslySkipPermissions ||
    options.permissionMode === "bypassPermissions" ||
    options.permissionMode === "dontAsk" ||
    options.permissionMode === "auto"
  ) {
    return {
      permissionPolicy: undefined,
      approvalHandler: undefined,
      pendingDenials,
      onTurnBoundary: () => pendingDenials.clear(),
    };
  }

  const canUseTool = options.canUseTool;
  const permissionMode = options.permissionMode;

  const permissionPolicy: ToolPermissionPolicy = {
    evaluate(toolName: string): ToolPermissionDecision {
      const risk = TOOL_RISK[toolName] ?? "read";
      if (permissionMode === "acceptEdits" && isAcceptEditsTool(toolName)) {
        return { mode: "allow", reason: "acceptEdits preset", risk };
      }
      return { mode: "confirm", reason: "canUseTool gate", risk };
    },
  };

  const approvalHandler: ToolApprovalHandler = async (
    request: ToolApprovalRequest,
  ): Promise<ToolApprovalDecision> => {
    if (!request.toolCallId) {
      throw new Error(
        "canUseTool bridge requires ToolApprovalRequest.toolCallId; AgentLoop did not thread it through",
      );
    }
    const toolCallId = request.toolCallId;
    const parsedInput = safeParseJson<unknown>(request.rawArgs, {});
    let result: PermissionResult;
    try {
      result = await canUseTool(request.toolName, parsedInput, {
        toolUseId: toolCallId,
        signal: options.abortController?.signal,
      });
    } catch (error) {
      pendingDenials.set(toolCallId, {
        message:
          error instanceof Error ? error.message : "canUseTool threw an error",
      });
      return "deny";
    }
    if (result.behavior === "allow") return "allow-once";
    pendingDenials.set(toolCallId, { message: result.message });
    return "deny";
  };

  return {
    permissionPolicy,
    approvalHandler,
    pendingDenials,
    onTurnBoundary: () => pendingDenials.clear(),
  };
}

/**
 * Optional allowedTools filter. Names listed in allowedTools (and any mcp__
 * prefixes) become whitelist entries; specs whose definition name does not
 * appear are dropped. Returns the original list unchanged when allowedTools
 * is empty or undefined.
 */
export function filterToolSpecsByAllowedNames(
  specs: ToolSpec[],
  allowedTools: string[] | undefined,
): ToolSpec[] {
  if (!allowedTools || allowedTools.length === 0) return specs;
  const allow = new Set(allowedTools);
  return specs.filter((spec) => allow.has(spec.definition.function.name));
}
