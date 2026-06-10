import type { StepCliAgentPresetConfig } from "../agent-preset-config.js";
import type {
  AgentExecutionProfileOverrides,
  AgentHarnessKind,
} from "../runtime-context-types.js";

export type AgentPresetTarget = Exclude<AgentHarnessKind, "main">;

export interface AgentPreset {
  name: string;
  description: string;
  targetHarnessKind: AgentPresetTarget;
  promptAppendix: string;
  allowedTools?: string[];
  executionProfileOverride?: AgentExecutionProfileOverrides;
  hidden?: boolean;
  defaultRole?: string;
}

export interface AgentPresetRegistry {
  presets: AgentPreset[];
  byKey: ReadonlyMap<string, AgentPreset>;
}

const BUILTIN_AGENT_PRESETS: AgentPreset[] = [
  {
    name: "general",
    description:
      "Balanced default delegated worker for broad implementation tasks.",
    targetHarnessKind: "subagent",
    promptAppendix: [
      "General preset:",
      "- Work directly toward the delegated outcome.",
      "- Gather only the context you need, then execute decisively.",
      "- Call out concrete risks, follow-ups, and verification results.",
    ].join("\n"),
  },
  {
    name: "general",
    description: "Balanced default teammate for broad collaboration tasks.",
    targetHarnessKind: "teammate",
    promptAppendix: [
      "General teammate preset:",
      "- Triage inbox work pragmatically and keep the lead informed.",
      "- Escalate only when coordination or approval is genuinely needed.",
      "- Summaries should be concise, actionable, and easy to hand off.",
    ].join("\n"),
    defaultRole: "generalist",
  },
  {
    name: "explore",
    description:
      "Investigative delegated worker optimized for discovery and evidence gathering.",
    targetHarnessKind: "subagent",
    promptAppendix: [
      "Explore preset:",
      "- Start by mapping the relevant code, docs, configs, and logs.",
      "- Prefer evidence-backed findings over guesses.",
      "- Surface the most relevant files, commands, and open questions.",
    ].join("\n"),
  },
  {
    name: "explore",
    description:
      "Investigative teammate focused on research and evidence gathering.",
    targetHarnessKind: "teammate",
    promptAppendix: [
      "Explore teammate preset:",
      "- Investigate broadly before converging on recommendations.",
      "- Send back concrete findings, not just hypotheses.",
      "- Highlight uncertainty and what would resolve it fastest.",
    ].join("\n"),
    defaultRole: "researcher",
  },
  {
    name: "review",
    description:
      "Read-heavy reviewer focused on regressions, risks, and missing validation.",
    targetHarnessKind: "subagent",
    promptAppendix: [
      "Review preset:",
      "- Prioritize correctness, regressions, edge cases, and missing tests.",
      "- Lead with concrete findings and supporting evidence.",
      "- Avoid making code changes unless the task explicitly asks for them.",
    ].join("\n"),
    allowedTools: ["find_tools", "list_directory", "read_file", "run_command"],
  },
  {
    name: "review",
    description:
      "Persistent reviewer teammate focused on findings and validation gaps.",
    targetHarnessKind: "teammate",
    promptAppendix: [
      "Review teammate preset:",
      "- Inspect changes critically and report the most important findings first.",
      "- Prefer reproducible evidence, failing cases, or concrete code references.",
      "- Keep the lead updated when review scope or risk changes.",
    ].join("\n"),
    allowedTools: ["find_tools", "list_directory", "read_file", "run_command"],
    defaultRole: "reviewer",
  },
  {
    name: "planner",
    description:
      "Delegated planner focused on decomposition, sequencing, and checkpoints.",
    targetHarnessKind: "subagent",
    promptAppendix: [
      "Planner preset:",
      "- Break the work into a clear executable plan before diving deep.",
      "- Track dependencies, assumptions, and decision points explicitly.",
      "- Make it easy for the parent agent to choose the next action.",
    ].join("\n"),
  },
  {
    name: "planner",
    description:
      "Persistent planning teammate for sequencing, coordination, and checkpoints.",
    targetHarnessKind: "teammate",
    promptAppendix: [
      "Planner teammate preset:",
      "- Convert goals into phased plans with clear next actions.",
      "- Flag blockers, approvals, and coordination points early.",
      "- Keep plans concise enough for the lead to approve quickly.",
    ].join("\n"),
    defaultRole: "planner",
  },
];

export function createAgentPresetRegistry(
  configPresets: StepCliAgentPresetConfig[] | undefined,
): AgentPresetRegistry {
  const merged = new Map<string, AgentPreset>();

  for (const preset of BUILTIN_AGENT_PRESETS) {
    merged.set(
      buildPresetKey(preset.targetHarnessKind, preset.name),
      clonePreset(preset),
    );
  }

  for (const preset of configPresets ?? []) {
    const key = buildPresetKey(preset.targetHarnessKind, preset.name);
    const base = merged.get(key);
    const mergedPreset = mergePresetConfig(base, preset);
    merged.set(key, mergedPreset);
  }

  const presets = [...merged.values()].sort(comparePresets);
  return {
    presets,
    byKey: new Map(
      presets.map((preset) => [
        buildPresetKey(preset.targetHarnessKind, preset.name),
        preset,
      ]),
    ),
  };
}

export function resolveAgentPreset(
  registry: AgentPresetRegistry | undefined,
  targetHarnessKind: AgentPresetTarget,
  name: string | undefined,
): AgentPreset | undefined {
  const normalizedName = normalizePresetName(name);
  if (!normalizedName) {
    return undefined;
  }

  return registry?.byKey.get(buildPresetKey(targetHarnessKind, normalizedName));
}

export function applyAgentPresetPromptAppendix(
  systemPrompt: string,
  preset: AgentPreset | undefined,
): string {
  const appendix = preset?.promptAppendix?.trim();
  if (!appendix) {
    return systemPrompt;
  }

  return `${systemPrompt}\n\n${appendix}`;
}

export function applyAgentPresetExecutionProfile(
  executionProfile: AgentExecutionProfileOverrides | undefined,
  preset: AgentPreset | undefined,
): AgentExecutionProfileOverrides | undefined {
  const normalizedPresetProfile = normalizeExecutionProfileOverride(
    preset?.executionProfileOverride,
  );
  const normalizedExecutionProfile =
    normalizeExecutionProfileOverride(executionProfile);

  return normalizeExecutionProfileOverride({
    ...normalizedPresetProfile,
    ...normalizedExecutionProfile,
  });
}

export function applyAgentPresetAllowedTools(input: {
  allowedTools?: string[];
  preset?: AgentPreset;
  mandatoryTools?: string[];
}): string[] | undefined {
  if (input.allowedTools !== undefined) {
    return dedupeToolNames(input.allowedTools);
  }

  if (input.preset?.allowedTools === undefined) {
    return undefined;
  }

  const requested = [...input.preset.allowedTools];
  if (input.mandatoryTools && input.mandatoryTools.length > 0) {
    requested.push(...input.mandatoryTools);
  }

  return dedupeToolNames(requested);
}

function mergePresetConfig(
  base: AgentPreset | undefined,
  override: StepCliAgentPresetConfig,
): AgentPreset {
  const promptAppendix =
    override.promptAppendix?.trim() ?? base?.promptAppendix?.trim();
  if (!promptAppendix) {
    throw new Error(
      `Agent preset '${override.name}' (${override.targetHarnessKind}) must define promptAppendix, either directly or by overriding a built-in preset.`,
    );
  }

  const executionProfileOverride = mergeExecutionProfileOverride(
    base?.executionProfileOverride,
    override.executionProfileOverride,
  );
  const allowedTools =
    override.allowedTools !== undefined
      ? dedupeToolNames(override.allowedTools)
      : base?.allowedTools
        ? [...base.allowedTools]
        : undefined;

  return {
    name: override.name,
    description:
      override.description?.trim() ||
      base?.description ||
      `Custom delegated preset '${override.name}' for ${override.targetHarnessKind}.`,
    targetHarnessKind: override.targetHarnessKind,
    promptAppendix,
    allowedTools,
    executionProfileOverride,
    hidden: override.hidden ?? base?.hidden,
    defaultRole:
      override.targetHarnessKind === "teammate"
        ? override.defaultRole?.trim() || base?.defaultRole
        : undefined,
  };
}

function mergeExecutionProfileOverride(
  base: AgentExecutionProfileOverrides | undefined,
  override: AgentExecutionProfileOverrides | undefined,
): AgentExecutionProfileOverrides | undefined {
  const normalizedBase = normalizeExecutionProfileOverride(base);
  const normalizedOverride = normalizeExecutionProfileOverride(override);

  return normalizeExecutionProfileOverride({
    ...normalizedBase,
    ...normalizedOverride,
  });
}

function clonePreset(preset: AgentPreset): AgentPreset {
  return {
    ...preset,
    allowedTools: preset.allowedTools ? [...preset.allowedTools] : undefined,
    executionProfileOverride: normalizeExecutionProfileOverride(
      preset.executionProfileOverride,
    ),
  };
}

function comparePresets(left: AgentPreset, right: AgentPreset): number {
  const targetDelta = left.targetHarnessKind.localeCompare(
    right.targetHarnessKind,
  );
  if (targetDelta !== 0) {
    return targetDelta;
  }

  return left.name.localeCompare(right.name);
}

function buildPresetKey(
  targetHarnessKind: AgentPresetTarget,
  name: string,
): string {
  return `${targetHarnessKind}:${normalizePresetName(name)}`;
}

function normalizePresetName(name: string | undefined): string {
  return name?.trim().toLowerCase() ?? "";
}

function dedupeToolNames(names: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const rawName of names) {
    const name = rawName.trim();
    if (!name || seen.has(name)) {
      continue;
    }
    seen.add(name);
    deduped.push(name);
  }

  return deduped;
}

function normalizeExecutionProfileOverride(
  override: AgentExecutionProfileOverrides | undefined,
): AgentExecutionProfileOverrides | undefined {
  if (!override) {
    return undefined;
  }

  const normalized: AgentExecutionProfileOverrides = {};

  if (override.workspaceMode) {
    normalized.workspaceMode = override.workspaceMode;
  }
  if (override.memoryMode) {
    normalized.memoryMode = override.memoryMode;
  }
  if (override.priority) {
    normalized.priority = override.priority;
  }

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}
