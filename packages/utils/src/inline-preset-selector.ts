import type { UserTurnInput } from "@step-cli/protocol";

const INLINE_DELEGATION_PRESET_PATTERN =
  /^\s*(?:@([a-z][a-z0-9_-]*)|preset=([a-z][a-z0-9_-]*))(?:(\s+[\s\S]*)|$)/i;

export function extractInlineDelegationPresetFromUserTurn(
  input: UserTurnInput,
  options: {
    knownPresets?: Iterable<string>;
  } = {},
): UserTurnInput {
  const selection = parseInlineDelegationPresetSelector(input.content, options);
  if (!selection) {
    return input;
  }

  const systemPromptAppendix = appendSystemPromptAppendix(
    input.systemPromptAppendix,
    buildDelegationPresetSystemPromptAppendix(selection.preset),
  );

  return {
    ...input,
    content: selection.content,
    ...(systemPromptAppendix ? { systemPromptAppendix } : undefined),
  };
}

export function parseInlineDelegationPresetSelector(
  content: string,
  options: {
    knownPresets?: Iterable<string>;
  } = {},
): {
  preset: string;
  content: string;
} | null {
  if (typeof content !== "string" || content.length === 0) {
    return null;
  }

  const match = content.match(INLINE_DELEGATION_PRESET_PATTERN);
  if (!match) {
    return null;
  }

  const preset = normalizePresetName(match[1] ?? match[2] ?? "");
  if (!preset) {
    return null;
  }

  const knownPresets = normalizePresetNames(options.knownPresets);
  if (knownPresets && !knownPresets.has(preset)) {
    return null;
  }

  return {
    preset,
    content: (match[3] ?? "").replace(/^\s+/, ""),
  };
}

export function buildDelegationPresetSystemPromptAppendix(
  preset: string,
): string {
  return [
    "Delegation preset hint for this user turn:",
    `- If you create delegated teammate or subagent work, prefer preset "${preset}".`,
    "- Treat it as the default specialization unless the user explicitly asks for something else.",
  ].join("\n");
}

function appendSystemPromptAppendix(
  existing: string | undefined,
  next: string,
): string {
  const normalizedExisting = existing?.trim();
  if (!normalizedExisting) {
    return next;
  }

  return `${normalizedExisting}\n\n${next}`;
}

function normalizePresetNames(
  presets: Iterable<string> | undefined,
): ReadonlySet<string> | null {
  if (!presets) {
    return null;
  }

  const normalized = new Set<string>();
  for (const preset of presets) {
    const name = normalizePresetName(preset);
    if (name) {
      normalized.add(name);
    }
  }

  return normalized;
}

function normalizePresetName(value: string): string {
  return value.trim().toLowerCase();
}
