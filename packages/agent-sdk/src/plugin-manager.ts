import type { AgentLoopOptions } from "@step-cli/core/agent/agent-loop.js";
import type { PluginInjectedMessage } from "@step-cli/core/plugins/types.js";
import type { TaskInputQueue } from "./input-queue.js";
import { userTurnTextFromMessage } from "./input-queue.js";

export interface PluginManager {
  beforeModelRequest: NonNullable<AgentLoopOptions["beforeModelRequest"]>;
  userPromptSubmit:
    | NonNullable<AgentLoopOptions["userPromptSubmit"]>
    | undefined;
}

export interface PluginManagerOptions {
  inputQueue: TaskInputQueue;
}

/**
 * SDK-owned plugin manager. Composed into AgentLoop via the
 * beforeModelRequest / userPromptSubmit hook slots.
 *
 * The drainer MUST be synchronous (no await on a promise that has not
 * already resolved); otherwise a priority:"now" message would slip past the
 * current step boundary and not land in memory before the next model call.
 */
export function createPluginManager(
  options: PluginManagerOptions,
): PluginManager {
  const { inputQueue } = options;

  const beforeModelRequest: PluginManager["beforeModelRequest"] = () => {
    const pending = inputQueue.drainPendingNow();
    if (pending.length === 0) return;
    const messages: PluginInjectedMessage[] = pending.map((message) => ({
      role: "user",
      content: userTurnTextFromMessage(message),
    }));
    return { messages };
  };

  return {
    beforeModelRequest,
    userPromptSubmit: undefined,
  };
}
