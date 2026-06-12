import type {
  AgentExecutionProfile,
  AgentHarnessKind,
} from "../runtime-context-types.js";
import type {
  StepCliInteractionProfile,
  ToolDependency,
  ToolSpec,
  UserTurnInput,
} from "@step-cli/protocol";

export interface ToolPluginHarnessContext {
  kind: AgentHarnessKind;
  name: string;
  depth: number;
  parentId?: string;
  sessionId: string;
  goalId: string;
  executionProfile: AgentExecutionProfile;
}

export interface ToolPluginContext {
  workspaceRoot: string;
  interactionProfile: StepCliInteractionProfile;
  harness: ToolPluginHarnessContext;
}

export interface PluginUserMessage {
  index: number;
  content: string;
}

export type PluginInjectedMessage = {
  role: "system" | "user";
  content: string;
  /** When true, the message is only for the model context and should not be rendered in the UI. */
  hidden?: boolean;
};

export interface PluginHookContext {
  workspaceRoot: string;
  step: number;
  toolCalls: number;
  now: string;
  harnessId?: string;
  harnessType?: AgentHarnessKind;
  harnessName?: string;
  harnessDepth?: number;
  parentHarnessId?: string;
  sessionId?: string;
  goalId?: string;
  attemptId?: string;
  executionProfile?: AgentExecutionProfile;
  userMessages: PluginUserMessage[];
}

export interface PluginHookResult {
  messages?: PluginInjectedMessage[];
  warnings?: string[];
}

export interface PluginUserPromptSubmitContext {
  workspaceRoot: string;
  now: string;
  harnessId?: string;
  harnessType?: AgentHarnessKind;
  harnessName?: string;
  harnessDepth?: number;
  parentHarnessId?: string;
  sessionId?: string;
  goalId?: string;
  attemptId?: string;
  executionProfile?: AgentExecutionProfile;
  prompt: UserTurnInput;
}

export interface PluginUserPromptSubmitResult {
  prompt?: UserTurnInput;
  stopReason?: string;
  warnings?: string[];
}

export interface PluginDependencyDeclaration extends ToolDependency {
  pluginId: string;
}

export interface ToolPluginHooks {
  /**
   * Called once per user turn before the prompt is written into memory
   * and before the model run starts. Hooks may rewrite or block the turn.
   */
  userPromptSubmit?: (
    context: PluginUserPromptSubmitContext,
  ) =>
    | Promise<PluginUserPromptSubmitResult | void>
    | PluginUserPromptSubmitResult
    | void;

  /**
   * Called before each model request (heartbeat/cron-style proactive hook).
   * The hook can inject system messages into the conversation memory.
   */
  beforeModelRequest?: (
    context: PluginHookContext,
  ) => Promise<PluginHookResult | void> | PluginHookResult | void;

  /**
   * Called when the user presses Ctrl+C in the interactive TUI.
   * Plugins should best-effort interrupt any long-running background work they own.
   */
  onUserInterrupt?: () => Promise<boolean | void> | boolean | void;
}

export interface ToolPlugin {
  id: string;
  description: string;
  dependencies?: ToolDependency[];
  register(context: ToolPluginContext): ToolSpec[];
  hooks?: ToolPluginHooks;
  shutdown?: (reason?: string) => Promise<void> | void;

  /**
   * Persist plugin runtime state into session snapshots.
   * Keep this small; snapshots may be autosaved frequently.
   */
  exportState?: () => unknown;

  /**
   * Hydrate plugin runtime state from a previously saved session snapshot.
   */
  loadState?: (state: unknown) => void;
}

export interface ToolPluginManifest {
  id: string;
  entry: string;
  enabled?: boolean;
  description?: string;
}

export interface LoadedToolPlugin {
  plugin: ToolPlugin;
  source: "builtin" | "external";
  rootPath?: string;
}

export interface LoadToolPluginsResult {
  plugins: LoadedToolPlugin[];
  warnings: string[];
}
