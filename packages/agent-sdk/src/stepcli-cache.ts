import { AgentLoop } from "@step-cli/core/agent/agent-loop.js";
import type { AgentLoopOptions } from "@step-cli/core/agent/agent-loop.js";
import {
  ConversationMemory,
  type ConversationMemoryState,
} from "@step-cli/core/agent/conversation-memory.js";
import {
  buildDefaultMemoryConfig,
  buildDefaultRunConfig,
  DEFAULT_COMMAND_OUTPUT_LIMIT,
  DEFAULT_COMMAND_TIMEOUT_MS,
} from "@step-cli/core/agent/default-configs.js";
import { ToolRuntime } from "@step-cli/core/tools/runtime.js";
import type { ChatCompletionClient } from "@step-cli/core/model-client.js";
import type {
  StepCliInteractionProfile,
  ToolApprovalHandler,
  ToolExecutionContext,
  ToolPermissionPolicy,
  ToolSpec,
} from "@step-cli/protocol";

export interface AgentLoopBundle {
  agent: AgentLoop;
  memory: ConversationMemory;
  tools: ToolRuntime;
  setSignal: (signal: AbortSignal | undefined) => void;
}

export interface CreateAgentLoopArgs {
  client: ChatCompletionClient;
  model: string;
  workspaceRoot: string;
  systemPrompt: string;
  toolSpecs: ToolSpec[];
  hooks?: AgentLoopOptions["hooks"];
  userPromptSubmit?: AgentLoopOptions["userPromptSubmit"];
  beforeModelRequest?: AgentLoopOptions["beforeModelRequest"];
  signal?: AbortSignal;
  maxSteps?: number;
  memoryState?: ConversationMemoryState;
  permissionPolicy?: ToolPermissionPolicy;
  approvalHandler?: ToolApprovalHandler;
}

const DEFAULT_INTERACTION_PROFILE: StepCliInteractionProfile = {
  surface: "service",
  canAskUser: false,
};

/**
 * Build an AgentLoop directly without going through
 * `packages/core/src/agent/harness.ts`'s AgentHarnessFactory. The factory is
 * tailored to the gateway-style host (skill registry, code-mode bindings,
 * presentation profiles, run-artifact store) — none of which the SDK uses or
 * exposes. We accept hooks, plugin slots, and a ToolSpec list directly from
 * the caller, which keeps the SDK self-contained and predictable.
 *
 * If `harness.ts` ever grows base hooks that every consumer should receive
 * (e.g. cross-cutting telemetry), revisit this divergence and either extract
 * a thinner factory from core or have agent-sdk subscribe to the same hook
 * source explicitly.
 */
export function createAgentLoopBundle(
  args: CreateAgentLoopArgs,
): AgentLoopBundle {
  const runConfig = buildDefaultRunConfig(
    args.maxSteps !== undefined ? { maxSteps: args.maxSteps } : {},
  );
  const memoryConfig = buildDefaultMemoryConfig(runConfig);
  const memory = new ConversationMemory(memoryConfig);
  if (args.memoryState) memory.loadState(args.memoryState);

  const toolContext: ToolExecutionContext = {
    workspaceRoot: args.workspaceRoot,
    commandTimeoutMs: DEFAULT_COMMAND_TIMEOUT_MS,
    commandOutputLimit: DEFAULT_COMMAND_OUTPUT_LIMIT,
    signal: args.signal,
    interaction: {
      profile: DEFAULT_INTERACTION_PROFILE,
    },
  };

  const tools = new ToolRuntime(args.toolSpecs, toolContext, {
    permissionPolicy: args.permissionPolicy,
    approvalHandler: args.approvalHandler,
  });

  const agent = new AgentLoop({
    model: args.model,
    client: args.client,
    memory,
    tools,
    systemPrompt: args.systemPrompt,
    workspaceRoot: args.workspaceRoot,
    config: runConfig,
    hooks: args.hooks,
    userPromptSubmit: args.userPromptSubmit,
    beforeModelRequest: args.beforeModelRequest,
    signal: args.signal,
  });

  return {
    agent,
    memory,
    tools,
    setSignal: (signal) => agent.setSignal(signal),
  };
}
