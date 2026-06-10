import type { ChatCompletionClient } from "@step-cli/core/model-client.js";
import type { ToolSecurityDescriptor, ToolSpec } from "@step-cli/protocol";

export type PermissionMode =
  | "default"
  | "acceptEdits"
  | "bypassPermissions"
  | "plan"
  | "dontAsk"
  | "auto";

export interface PermissionResultAllow {
  behavior: "allow";
  updatedInput?: unknown;
}

export interface PermissionResultDeny {
  behavior: "deny";
  message: string;
  interrupt?: boolean;
}

export type PermissionResult = PermissionResultAllow | PermissionResultDeny;

export interface CanUseToolContext {
  toolUseId: string;
  signal?: AbortSignal;
}

export type CanUseTool = (
  toolName: string,
  input: unknown,
  context: CanUseToolContext,
) => Promise<PermissionResult> | PermissionResult;

export interface SdkMcpToolHandlerResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

export interface SdkMcpTool {
  name: string;
  description: string;
  inputSchema: unknown;
  handler: (
    args: unknown,
    extra: unknown,
  ) => Promise<SdkMcpToolHandlerResult> | SdkMcpToolHandlerResult;
  /** Override the default `risk:"write", defaultMode:"confirm"` permission policy. */
  security?: ToolSecurityDescriptor;
}

export interface McpServerInstance {
  name: string;
  version?: string;
  tools: SdkMcpTool[];
}

export interface QueryToolsPreset {
  type: "preset";
  preset: "stepfun_code";
}

export interface SDKAssistantMessage {
  type: "assistant";
  uuid?: string;
  session_id?: string;
  message: {
    role: "assistant";
    content: Array<
      | { type: "text"; text: string }
      | {
          type: "tool_use";
          id: string;
          name: string;
          input: unknown;
        }
    >;
  };
}

export interface SDKUserMessageFromSdk {
  type: "user";
  uuid?: string;
  session_id?: string;
  message: {
    role: "user";
    content: Array<
      | { type: "text"; text: string }
      | {
          type: "tool_result";
          tool_use_id: string;
          is_error?: boolean;
          content: string | Array<{ type: "text"; text: string }>;
        }
    >;
  };
}

export interface SDKStreamEventMessage {
  type: "stream_event";
  uuid?: string;
  session_id?: string;
  event:
    | {
        type: "text_delta";
        text: string;
      }
    | {
        type: "input_json_delta";
        partial_json: string;
        tool_use_id?: string;
      };
}

export type SDKSystemSubtype =
  | "status"
  | "compact_boundary"
  | "permission_denied";

export interface SDKSystemMessage {
  type: "system";
  uuid?: string;
  session_id?: string;
  subtype: SDKSystemSubtype;
  status?: string | null;
  tool_name?: string;
  tool_use_id?: string;
  decision_reason?: string;
}

export type SDKResultSubtype =
  | "success"
  | "error_max_turns"
  | "error_max_budget_usd"
  | "error_during_execution";

export interface SDKResultMessage {
  type: "result";
  uuid: string;
  session_id: string;
  subtype: SDKResultSubtype;
  result?: string;
  total_cost_usd: number;
  num_turns: number;
  duration_ms: number;
  error?: string;
}

export type SDKResultSuccess = Extract<
  SDKResultMessage,
  { subtype: "success" }
>;

export type SDKMessage =
  | SDKAssistantMessage
  | SDKUserMessageFromSdk
  | SDKStreamEventMessage
  | SDKSystemMessage
  | SDKResultMessage;

export interface SDKUserMessage {
  role: "user";
  content:
    | string
    | Array<
        | { type: "text"; text: string }
        | {
            type: "tool_result";
            tool_use_id: string;
            content: string;
            is_error?: boolean;
          }
      >;
  priority?: "now" | "next" | "later";
}

export interface QueryOptions {
  /**
   * Pre-built ChatCompletionClient. Host (e.g. CodingBridge) constructs this
   * from the resolved StepCliConfig and passes it in. SDK does not import
   * extensions/llm to preserve the agent-sdk-no-implementation-deps boundary.
   */
  client: ChatCompletionClient;
  /** Model identifier (transparently forwarded to the client). */
  model: string;
  /** Optional metadata; kept for cacheKey identity and logging. */
  baseUrl?: string;
  /** Optional metadata; never logged. */
  apiKey?: string;
  cwd: string;
  systemPrompt?: string;
  maxTurns?: number;
  maxBudgetUsd?: number;
  permissionMode?: PermissionMode;
  allowDangerouslySkipPermissions?: true;
  canUseTool?: CanUseTool;
  mcpServers?: Record<string, McpServerInstance>;
  tools?: QueryToolsPreset | ToolSpec[];
  allowedTools?: string[];
  includePartialMessages?: boolean;
  abortController?: AbortController;
  /**
   * Existing sessionId from a prior SDKResultSuccess.session_id. When provided
   * the SDK rehydrates the in-process ConversationMemory snapshot for that
   * session before running the new turn(s); when omitted the SDK mints a fresh
   * sessionId and starts a new memory.
   */
  resume?: string;
}

export interface Query extends AsyncIterable<SDKMessage> {
  interrupt(): Promise<void>;
}
