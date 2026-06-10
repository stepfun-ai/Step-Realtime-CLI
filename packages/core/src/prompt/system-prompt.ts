import type { PluginDependencyDeclaration } from "../plugins/types.js";
import type { SkillMetadata } from "../tools/skill-types.js";
import type {
  AgentOperatingMode,
  SystemPromptProfile,
  ToolSpec,
  ToolPresentationProfile,
} from "@step-cli/protocol";

const DEFAULT_BASE_SYSTEM_PROMPT = [
  "You are step-cli, a StepFun-developed terminal code agent focused on correctness and speed.",
  "Tool-first workflow: inspect the workspace with the tools available in this session before answering.",
  "For edits, prefer precise search/replace patches over full-file rewrites unless unavoidable.",
  "After edits, run focused validation (tests/typecheck/build or targeted commands) and report concrete outcomes.",
  "Control token usage aggressively: summarize long outputs, keep only key evidence, and cite exact paths.",
  "Exploit safe parallelism: when independent workstreams exist, prefer concurrent delegation over unnecessary serialization.",
  "Use model-native tool calling only; do not invent custom tool-call formats.",
  "Keep final responses concise and action-oriented.",
].join("\n");

const MINIMAL_BASE_SYSTEM_PROMPT = [
  "You are step-cli, a terminal coding agent.",
  "Use the available tools when needed and keep answers concise.",
].join("\n");

const MAIN_AGENT_EXECUTION_RIGOR_HEADER = "Main-agent execution rigor:";
const LEGACY_EXECUTION_RIGOR_HEADER = "Execution rigor:";
const MAIN_AGENT_EXECUTION_RIGOR_BULLETS = [
  "- Use tools aggressively while they keep producing new evidence; on substantial tasks, triple-digit tool-call counts can be appropriate, but never optimize for a quota.",
  "- Before attempting a fix, design or add the smallest useful test or check you can run first whenever the environment makes that feasible.",
  "- Spend time understanding the surrounding code and root cause instead of patching surface symptoms.",
  "- Be thorough in your reasoning, check edge cases, and explicitly note any remaining uncertainty.",
];
const LEGACY_MAIN_AGENT_EXECUTION_RIGOR_BULLETS = [
  "- Use tools aggressively when they keep producing new evidence; for substantial tasks, dozens or even 100+ tool calls are preferable to unsupported guesses.",
];
const MAIN_AGENT_EXECUTION_RIGOR_FRAGMENT_LINES = new Set([
  MAIN_AGENT_EXECUTION_RIGOR_HEADER,
  LEGACY_EXECUTION_RIGOR_HEADER,
  ...MAIN_AGENT_EXECUTION_RIGOR_BULLETS,
  ...LEGACY_MAIN_AGENT_EXECUTION_RIGOR_BULLETS,
]);
const MAIN_AGENT_EXECUTION_RIGOR_APPENDIX = [
  MAIN_AGENT_EXECUTION_RIGOR_HEADER,
  ...MAIN_AGENT_EXECUTION_RIGOR_BULLETS,
].join("\n");

type ToolReferenceStyle = "raw" | "grouped" | "neutral";

interface PromptToolFeatures {
  toolNames: Set<string>;
  groupedFamilies: Set<string>;
}

export function buildSystemPrompt(input: {
  basePrompt?: string;
  instructionPrompt?: string;
  mode: AgentOperatingMode;
  profile: SystemPromptProfile;
  toolPresentationProfile: ToolPresentationProfile;
  toolSpecs: ToolSpec[];
  skills: SkillMetadata[];
  pluginIds: string[];
  pluginDependencies: PluginDependencyDeclaration[];
}): string {
  const toolReferenceStyle =
    input.toolPresentationProfile === "obfuscated"
      ? "neutral"
      : input.toolPresentationProfile === "raw"
        ? "raw"
        : "grouped";

  if (input.profile === "minimal") {
    return buildMinimalSystemPrompt({
      basePrompt: input.basePrompt,
      instructionPrompt: input.instructionPrompt,
      mode: input.mode,
      toolSpecs: input.toolSpecs,
      toolReferenceStyle,
    });
  }

  return buildDefaultSystemPrompt({
    ...input,
    toolReferenceStyle,
  });
}

export function appendMainAgentExecutionRigor(basePrompt: string): string {
  const normalizedPrompt = normalizeWithoutTrailingExecutionRigor(basePrompt);
  if (!normalizedPrompt) {
    return MAIN_AGENT_EXECUTION_RIGOR_APPENDIX;
  }
  return `${normalizedPrompt}\n\n${MAIN_AGENT_EXECUTION_RIGOR_APPENDIX}`;
}

function normalizeWithoutTrailingExecutionRigor(basePrompt: string): string {
  const trimmedPrompt = basePrompt.trimEnd();
  if (!trimmedPrompt) {
    return "";
  }

  const lines = trimmedPrompt.split("\n");
  let cursor = lines.length;
  let removedAnyExecutionRigorLine = false;

  while (cursor > 0) {
    const line = lines[cursor - 1];
    if (!MAIN_AGENT_EXECUTION_RIGOR_FRAGMENT_LINES.has(line)) {
      break;
    }
    removedAnyExecutionRigorLine = true;
    cursor -= 1;
  }

  if (!removedAnyExecutionRigorLine) {
    return trimmedPrompt;
  }

  while (cursor > 0 && lines[cursor - 1].trim() === "") {
    cursor -= 1;
  }

  return lines.slice(0, cursor).join("\n").trimEnd();
}

function buildMinimalSystemPrompt(input: {
  basePrompt?: string;
  instructionPrompt?: string;
  mode: AgentOperatingMode;
  toolSpecs: ToolSpec[];
  toolReferenceStyle: ToolReferenceStyle;
}): string {
  const sections = [input.basePrompt?.trim() || MINIMAL_BASE_SYSTEM_PROMPT];
  const features = collectPromptToolFeatures(input.toolSpecs);
  if (input.instructionPrompt?.trim()) {
    sections.push(input.instructionPrompt.trim());
  }

  sections.push(
    input.mode === "plan"
      ? "This session is read-only planning mode. Inspect, analyze, and give concrete implementation guidance only."
      : "This session may inspect, edit, and execute when the corresponding tools are available and permitted.",
  );

  if (input.toolReferenceStyle === "neutral") {
    sections.push(
      "If tool identifiers are opaque, use the available discovery/meta capabilities to find the right tool.",
    );
  }

  if (hasPromptTool(features, "update_plan")) {
    sections.push(
      "For long or uncertain work, keep the session task plan accurate when that capability is available.",
    );
  }

  return sections.join("\n\n");
}

function buildDefaultSystemPrompt(input: {
  basePrompt?: string;
  instructionPrompt?: string;
  mode: AgentOperatingMode;
  toolSpecs: ToolSpec[];
  skills: SkillMetadata[];
  pluginIds: string[];
  pluginDependencies: PluginDependencyDeclaration[];
  toolReferenceStyle: ToolReferenceStyle;
}): string {
  const sections: string[] = [
    input.basePrompt?.trim() || DEFAULT_BASE_SYSTEM_PROMPT,
  ];
  const features = collectPromptToolFeatures(input.toolSpecs);
  const hasFindTools = hasPromptTool(features, "find_tools");
  const hasSkillFamily = hasPromptToolFamily(features, "skills");
  const hasSkillDiscoveryTools =
    hasSkillFamily ||
    (hasPromptTool(features, "search_skills") &&
      hasPromptTool(features, "load_skill"));
  const hasTaskFamily = hasPromptToolFamily(features, "task");
  const hasTeammateFamily = hasPromptToolFamily(features, "teammate");
  const hasSubagentTools =
    hasTaskFamily ||
    hasPromptTool(features, "task") ||
    hasPromptTool(features, "task_start");
  const hasAgentTeamTools =
    hasTeammateFamily || hasPromptTool(features, "spawn_teammate");
  const hasPlanTool = hasPromptTool(features, "update_plan");
  const hasCodeModeTools =
    hasPromptTool(features, "exec") && hasPromptTool(features, "wait");
  if (input.instructionPrompt?.trim()) {
    sections.push(input.instructionPrompt.trim());
  }

  const toolDisciplineLines = [
    "Tool discipline:",
    "- Use tools in small, verifiable steps.",
    input.toolReferenceStyle === "neutral"
      ? "- Prefer read/list capabilities before mutations."
      : "- Prefer read/list tools before mutations.",
    input.toolReferenceStyle === "neutral"
      ? "- Keep command execution scope minimal and explain why it is necessary."
      : "- For run_command, keep scope minimal and explain why it is necessary.",
  ];
  if (input.toolReferenceStyle === "neutral") {
    toolDisciplineLines.push(
      "- If tool identifiers are opaque, use the available discovery/meta capabilities to find the right tool.",
    );
    if (hasSkillDiscoveryTools) {
      toolDisciplineLines.push(
        "- Use the available skill-discovery and skill-load capabilities when you need reusable workflow instructions.",
      );
    }
  } else {
    if (hasFindTools) {
      toolDisciplineLines.push(
        input.toolReferenceStyle === "grouped"
          ? "- Use find_tools{query} when you know the intent but not the family tool name."
          : "- Use find_tools{query} when you know the intent but not the tool name.",
      );
    }
    if (hasSkillDiscoveryTools) {
      toolDisciplineLines.push(
        input.toolReferenceStyle === "grouped" && hasSkillFamily
          ? '- Use skills{action:"search", query} to discover available skills by workflow, tags, or description.'
          : "- Use search_skills{query} to discover available skills by workflow, tags, or description.",
        input.toolReferenceStyle === "grouped" && hasSkillFamily
          ? '- Use skills{action:"load", name} for the full skill body when you need detailed instructions.'
          : "- Use load_skill{name} for the full skill body when you need detailed instructions.",
      );
    }
    if (hasSkillDiscoveryTools) {
      toolDisciplineLines.push(
        "- If the user explicitly mentions $skill-name or [$skill-name](path), matching skills may already be auto-injected.",
      );
    }
  }

  sections.push(toolDisciplineLines.join("\n"));

  sections.push(
    input.mode === "plan"
      ? [
          "Operating mode: plan",
          "- This session is read-only planning mode. Only inspect and analyze with the tools available in this session.",
          "- Do not claim you edited files, ran commands, or validated changes unless the corresponding tool result exists in this session.",
          "- Produce concrete implementation guidance: files to touch, exact changes to make, validation steps, and key risks/blockers.",
        ].join("\n")
      : [
          "Operating mode: normal",
          "- This session may inspect, edit, and execute when the corresponding tools are available and permitted.",
          "- Make concrete changes when needed, then run focused validation and report exact outcomes.",
        ].join("\n"),
  );

  if (input.mode === "normal" && hasCodeModeTools) {
    sections.push(
      [
        "Code Mode:",
        "- When exec and wait are available, prefer exec for multi-step tool workflows instead of many single-tool turns.",
        "- Write JavaScript that calls nested tools as `tools.<identifier>(args)` and use wait with the returned cell_id when the exec cell is still running.",
        "- Prefer the structured patch/edit helper exposed inside `tools` for file edits instead of shelling out to patch helpers.",
      ].join("\n"),
    );
  }

  if (hasSubagentTools || hasAgentTeamTools) {
    const orchestrationLines = [
      "Delegation and concurrency:",
      "- If the work splits into independent branches, do not serialize those branches by default.",
      "- When the model/tool runtime allows it, issue multiple independent tool calls in the same assistant turn.",
      "- If parallel branches may edit overlapping files, prefer isolate_workspace=true to avoid collisions.",
    ];

    if (hasSubagentTools) {
      orchestrationLines.push(
        input.toolReferenceStyle === "grouped" && hasTaskFamily
          ? '- Use task{action:"run"} only when the parent must block on a one-shot delegated result before continuing.'
          : "- Use task only when the parent must block on a one-shot delegated result before continuing.",
        input.toolReferenceStyle === "grouped" && hasTaskFamily
          ? '- Use task{action:"start"} for finite background work; when several subtasks are independent, launch several task{action:"start"} calls in the same turn.'
          : "- Use task_start for finite background work; when several subtasks are independent, launch several task_start calls in the same turn.",
        input.toolReferenceStyle === "grouped" && hasTaskFamily
          ? '- After starting background subtasks, continue another branch or use task{action:"wait", wait_for:"first_ready"} to learn which active branch becomes actionable first.'
          : "- After starting background subtasks, continue another branch or use task_wait with wait_for=first_ready to learn which active branch becomes actionable first.",
        input.toolReferenceStyle === "grouped" && hasTaskFamily
          ? '- Use task{action:"wait", wait_for:"any"} when you specifically want to drain already pending background notifications.'
          : "- Use task_wait with wait_for=any when you specifically want to drain already pending background notifications.",
      );
    }

    if (hasAgentTeamTools) {
      orchestrationLines.push(
        input.toolReferenceStyle === "grouped" && hasTeammateFamily
          ? '- Use teammate{action:"spawn"} for longer-lived collaborators; when several roles can proceed independently, spawn multiple teammates in the same turn and coordinate through inbox messages.'
          : "- Use spawn_teammate for longer-lived collaborators; when several roles can proceed independently, spawn multiple teammates in the same turn and coordinate through inbox messages.",
      );
    }

    sections.push(orchestrationLines.join("\n"));
  }

  if (hasPlanTool) {
    sections.push(
      input.toolReferenceStyle === "neutral"
        ? [
            "Plan discipline:",
            "- For multi-step, long-running, or high-uncertainty work, maintain a concise session task plan with the available plan-update capability.",
            "- Treat each plan update as a full replacement of the ordered plan; keep statuses accurate and leave at most one item in_progress.",
          ].join("\n")
        : [
            "Plan discipline:",
            "- For multi-step, long-running, or high-uncertainty work, maintain a concise session task plan with update_plan.",
            "- Treat update_plan as a full replacement of the ordered plan; keep statuses accurate and leave at most one item in_progress.",
          ].join("\n"),
    );
  }

  if (input.skills.length > 0) {
    const skillLines = input.skills
      .slice(0, 40)
      .map(
        (skill) =>
          `- ${skill.name}: ${skill.short_description ?? skill.description}`,
      )
      .join("\n");

    sections.push(["Skill catalog:", skillLines].join("\n"));
  }

  if (input.pluginDependencies.length > 0) {
    const dependencyLines = input.pluginDependencies
      .slice(0, 24)
      .map(
        (dependency) =>
          `- ${dependency.pluginId}: ${dependency.type}:${dependency.value}${
            dependency.description ? ` (${dependency.description})` : ""
          }`,
      )
      .join("\n");

    sections.push(["Plugin dependencies:", dependencyLines].join("\n"));
  }

  sections.push(`Loaded plugins: ${input.pluginIds.join(", ") || "none"}`);

  return sections.join("\n\n");
}

function collectPromptToolFeatures(specs: ToolSpec[]): PromptToolFeatures {
  const toolNames = new Set<string>();
  const groupedFamilies = new Set<string>();

  for (const spec of specs) {
    toolNames.add(spec.definition.function.name);
    if (spec.grouping?.family) {
      groupedFamilies.add(spec.grouping.family);
    }
  }

  return {
    toolNames,
    groupedFamilies,
  };
}

function hasPromptTool(features: PromptToolFeatures, name: string): boolean {
  return features.toolNames.has(name);
}

function hasPromptToolFamily(
  features: PromptToolFeatures,
  family: string,
): boolean {
  return features.groupedFamilies.has(family) || features.toolNames.has(family);
}
