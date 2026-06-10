import { randomUUID } from "node:crypto";
import {
  applyAgentPresetAllowedTools,
  applyAgentPresetExecutionProfile,
  applyAgentPresetPromptAppendix,
  resolveAgentPreset,
  type AgentPresetRegistry,
} from "./agent-presets.js";
import {
  AgentHarnessFactory,
  type AgentHarnessCreation,
  type AgentHarnessOptions,
} from "./harness.js";
import {
  cloneExecutionProfile,
  resolveExecutionProfile,
  type AgentExecutionProfile,
  type AgentExecutionProfileOverrides,
  type AgentHarnessKind,
} from "./harness-context.js";
import type { ToolPluginContext } from "../plugins/types.js";
import { appendMainAgentExecutionRigor } from "../prompt/system-prompt.js";

const ONE_SHOT_SUBAGENT_APPENDIX = [
  "Subagent mode:",
  "- You are a delegated coding subagent that usually starts with a snapshot of the parent conversation as handoff context.",
  "- If the parent used context_mode=fresh, the handoff snapshot may be empty.",
  "- Complete the assigned task directly instead of discussing orchestration.",
  "- Use tools as needed, then return a concise summary for the parent agent.",
  "- Include concrete files, commands, errors, and remaining risks when relevant.",
].join("\n");

const BACKGROUND_SUBTASK_APPENDIX = [
  "Background subtask mode:",
  "- You are a delegated coding subagent running asynchronously for the parent agent.",
  "- Your first turn usually starts from a snapshot of the parent conversation unless the parent requested context_mode=fresh.",
  "- Treat each prompt as the next turn in the same delegated subtask session.",
  "- Preserve continuity across turns, but stay focused on the delegated scope.",
  "- Use tools as needed, then return a concise operational summary for the parent agent.",
  "- Include concrete files, commands, errors, and remaining risks when relevant.",
].join("\n");

const TEAMMATE_APPENDIX = [
  "Persistent teammate mode:",
  "- Treat each inbox batch as a concrete assignment and report useful outcomes.",
  "- Keep your own memory across turns; do not assume the lead sees your full context.",
  "- Use request_plan_approval before major plans that need lead confirmation.",
  "- If you receive a shutdown_request, answer with respond_shutdown and wrap up the turn cleanly.",
].join("\n");

const TEAMMATE_MANDATORY_TOOL_NAMES = [
  "send_message",
  "read_inbox",
  "request_plan_approval",
  "respond_shutdown",
];

type CompileHarnessBaseOptions = Omit<
  AgentHarnessOptions,
  "kind" | "executionProfile" | "sessionId" | "goalId" | "systemPrompt"
> & {
  executionProfile?: AgentExecutionProfileOverrides;
  sessionId?: string;
  goalId?: string;
  systemPrompt?: string;
  allowedTools?: string[];
};

interface CompileDelegatedPresetOptions {
  preset?: string;
  presetRegistry?: AgentPresetRegistry;
}

type CompileHarnessOptions = CompileHarnessBaseOptions & {
  kind: AgentHarnessKind;
};

type NormalizedHarnessOptions = AgentHarnessOptions & {
  executionProfile: AgentExecutionProfile;
  sessionId: string;
  goalId: string;
};

export type SubagentScaffoldMode = "sync" | "background";

export interface CompiledHarness extends AgentHarnessCreation {
  systemPrompt: string;
  allowedTools?: string[];
}

export interface CompileMainHarnessOptions extends CompileHarnessBaseOptions {}

export interface CompileSubagentHarnessOptions
  extends CompileHarnessBaseOptions, CompileDelegatedPresetOptions {
  label: string;
  mode: SubagentScaffoldMode;
}

export interface CompileTeammateHarnessOptions
  extends CompileHarnessBaseOptions, CompileDelegatedPresetOptions {
  role: string;
  lead: string;
}

export function compileMainHarness(
  factory: AgentHarnessFactory,
  options: CompileMainHarnessOptions,
): CompiledHarness {
  return compileHarness(factory, {
    ...options,
    kind: "main",
    systemPrompt: appendMainAgentExecutionRigor(
      options.systemPrompt ?? factory.getDefaultSystemPrompt(),
    ),
  });
}

export function compileSubagentHarness(
  factory: AgentHarnessFactory,
  options: CompileSubagentHarnessOptions,
): CompiledHarness {
  const preset = resolveAgentPreset(
    options.presetRegistry,
    "subagent",
    options.preset,
  );
  const presetWarnings = buildPresetWarnings(
    "subagent",
    options.preset,
    preset,
  );
  const baseSystemPrompt =
    options.systemPrompt ??
    buildSubagentSystemPrompt(
      factory.getDefaultSystemPrompt(),
      options.label,
      options.mode,
    );
  const systemPrompt = applyAgentPresetPromptAppendix(baseSystemPrompt, preset);
  const executionProfile = applyAgentPresetExecutionProfile(
    options.executionProfile,
    preset,
  );
  const requestedAllowedTools = applyAgentPresetAllowedTools({
    allowedTools: options.allowedTools,
    preset,
  });

  const compiled = compileHarness(factory, {
    ...options,
    name: options.name ?? options.label,
    kind: "subagent",
    systemPrompt,
    executionProfile,
    allowedTools: resolveAllowedTools(
      factory,
      {
        ...options,
        executionProfile,
        allowedTools: requestedAllowedTools,
      },
      "subagent",
    ),
  });

  return {
    ...compiled,
    warnings: [...presetWarnings, ...compiled.warnings],
  };
}

export function compileTeammateHarness(
  factory: AgentHarnessFactory,
  options: CompileTeammateHarnessOptions,
): CompiledHarness {
  const preset = resolveAgentPreset(
    options.presetRegistry,
    "teammate",
    options.preset,
  );
  const presetWarnings = buildPresetWarnings(
    "teammate",
    options.preset,
    preset,
  );
  const baseSystemPrompt =
    options.systemPrompt ??
    buildTeammateSystemPrompt(
      factory.getDefaultSystemPrompt(),
      options.name,
      options.role,
      options.lead,
    );
  const systemPrompt = applyAgentPresetPromptAppendix(baseSystemPrompt, preset);
  const executionProfile = applyAgentPresetExecutionProfile(
    options.executionProfile,
    preset,
  );
  const requestedAllowedTools = applyAgentPresetAllowedTools({
    allowedTools: options.allowedTools,
    preset,
    mandatoryTools: TEAMMATE_MANDATORY_TOOL_NAMES,
  });

  const compiled = compileHarness(factory, {
    ...options,
    kind: "teammate",
    systemPrompt,
    executionProfile,
    allowedTools: resolveAllowedTools(
      factory,
      {
        ...options,
        executionProfile,
        allowedTools: requestedAllowedTools,
      },
      "teammate",
    ),
  });

  return {
    ...compiled,
    warnings: [...presetWarnings, ...compiled.warnings],
  };
}

export function buildSubagentSystemPrompt(
  basePrompt: string,
  label: string,
  mode: SubagentScaffoldMode,
): string {
  const appendix =
    mode === "background"
      ? BACKGROUND_SUBTASK_APPENDIX
      : ONE_SHOT_SUBAGENT_APPENDIX;
  return `${basePrompt}\n\n${appendix}\nTask label: ${label}`;
}

export function buildTeammateSystemPrompt(
  basePrompt: string,
  name: string,
  role: string,
  lead: string,
): string {
  return [
    basePrompt,
    TEAMMATE_APPENDIX,
    `- You are teammate '${name}' with role '${role}'.`,
    `- Your lead is '${lead}'. Coordinate using send_message and read_inbox.`,
  ].join("\n\n");
}

function compileHarness(
  factory: AgentHarnessFactory,
  options: CompileHarnessOptions,
): CompiledHarness {
  const normalized = normalizeHarnessOptions(factory, options);
  const created = factory.createHarness({
    ...normalized,
    systemPrompt: options.systemPrompt,
    allowedTools: options.allowedTools,
  });

  return {
    ...created,
    systemPrompt: options.systemPrompt ?? factory.getDefaultSystemPrompt(),
    allowedTools:
      options.allowedTools !== undefined
        ? [...options.allowedTools]
        : undefined,
  };
}

function normalizeHarnessOptions(
  factory: AgentHarnessFactory,
  options: CompileHarnessOptions,
): NormalizedHarnessOptions {
  const kind = options.kind;
  return {
    ...options,
    sessionId: options.sessionId ?? randomUUID(),
    goalId:
      options.goalId ??
      (kind === "main" ? "main:root" : `${kind}:${options.id}`),
    executionProfile: resolveExecutionProfile(kind, options.executionProfile),
  };
}

function resolveAllowedTools(
  factory: AgentHarnessFactory,
  options: CompileHarnessBaseOptions,
  kind: AgentHarnessKind,
): string[] {
  const requested = dedupeToolNames(options.allowedTools);
  if (options.allowedTools !== undefined) {
    return requested;
  }

  const normalized = normalizeHarnessOptions(factory, {
    ...options,
    kind,
  });
  const available = factory.buildToolSpecs(
    buildToolContext(factory, normalized),
  ).specs;

  return available
    .map((spec) => spec.definition.function.name)
    .filter((name, index, names) => names.indexOf(name) === index);
}

function buildToolContext(
  factory: AgentHarnessFactory,
  options: NormalizedHarnessOptions,
): ToolPluginContext {
  return {
    workspaceRoot: options.workspaceRoot,
    interactionProfile: factory.getInteractionProfile(),
    harness: {
      kind: options.kind,
      name: options.name,
      depth: options.depth,
      parentId: options.parentId,
      sessionId: options.sessionId,
      goalId: options.goalId,
      executionProfile: cloneExecutionProfile(options.executionProfile),
    },
  };
}

function dedupeToolNames(names: string[] | undefined): string[] {
  if (!names) {
    return [];
  }

  const seen = new Set<string>();
  const unique: string[] = [];
  for (const rawName of names) {
    const name = rawName.trim();
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    unique.push(name);
  }
  return unique;
}

function buildPresetWarnings(
  kind: "subagent" | "teammate",
  requestedPreset: string | undefined,
  resolvedPreset: { name: string } | undefined,
): string[] {
  const normalizedPreset = requestedPreset?.trim();
  if (!normalizedPreset || resolvedPreset) {
    return [];
  }

  return [
    `Requested ${kind} preset '${normalizedPreset}' was not found. Using the default ${kind} scaffolding.`,
  ];
}
