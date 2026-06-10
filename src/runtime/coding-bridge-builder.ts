import { createChatCompletionClient } from "@step-cli/llm";
import {
  CodingBridge,
  type CodingPermissionMode,
} from "@step-cli/realtime-voice";
import type { RealtimeSession } from "@step-cli/realtime";
import type { StepCliConfig, StepCliProvider } from "../gateway/runtime.js";

export interface BuildCodingBridgeInput {
  session: RealtimeSession;
  stepCliConfig: StepCliConfig;
  workspaceRoot: string;
  permissionMode?: CodingPermissionMode;
  maxTurns?: number;
  budgetUsd?: number;
  /** Override coding model (e.g. `step voice --coding-model <model-id>`).
   *  Defaults to stepCliConfig.model so voice and text share one default. */
  model?: string;
}

/** Construct a CodingBridge for the realtime voice extension.
 *
 *  Boundaries (see docs/realtime-voice-integration.md §2.3 / §6.5):
 *   - resolveStepCliRuntimeConfig has already produced stepCliConfig + workspaceRoot
 *     by the time we get here. This builder is the single place that turns the
 *     resolved config into a ChatCompletionClient and hands it to the bridge.
 *   - The voice extension never imports src/runtime/runtime-config.ts or the
 *     gateway directly; it receives a fully-built bridge.
 *   - StepCliConfig is shared with text mode and is NOT extended with
 *     voice-only fields. Voice-only knobs (permissionMode, maxTurns,
 *     budgetUsd, model override) flow through input, not stepCliConfig.
 */
export function buildCodingBridge(input: BuildCodingBridgeInput): CodingBridge {
  const client = createChatCompletionClient({
    provider: mapStepCliProviderToFactoryProvider(input.stepCliConfig.provider),
    baseUrl: input.stepCliConfig.baseUrl,
    apiKey: input.stepCliConfig.apiKey,
    timeoutMs: input.stepCliConfig.timeoutMs,
    openaiEndpointKind:
      input.stepCliConfig.provider === "response"
        ? "responses"
        : "chat-completions",
  });

  return new CodingBridge(
    input.session,
    {
      cwd: input.workspaceRoot,
      model: input.model ?? input.stepCliConfig.model,
      permissionMode: input.permissionMode ?? "bypassPermissions",
      maxTurns: input.maxTurns ?? 30,
      budgetUsd: input.budgetUsd ?? 5,
    },
    client,
  );
}

/** Map StepCliProvider ("openai" | "response" | "anthropic") onto the
 *  factory's binary provider switch. "response" uses the OpenAI-compatible
 *  client with the Responses endpointKind, but the factory routes by provider
 *  + an optional openaiEndpointKind override the caller can pass in later. */
function mapStepCliProviderToFactoryProvider(
  provider: StepCliProvider | undefined,
): "anthropic" | "openai-compat" {
  return provider === "anthropic" ? "anthropic" : "openai-compat";
}
