/**
 * CLI handlers for VAD discovery + validation.
 *
 * These are pure functions returning strings / result objects — they do
 * NOT depend on any CLI framework (commander, yargs, raw parseArgs, etc),
 * and they do NOT persist anything. Persistence of the selected VAD is a
 * host concern: the selection lives in the main step-cli config's
 * `voice.defaults.vad` (written by `step vad set` in the host layer). This
 * module only validates a name against the known-adapter list — packages
 * must not know the host config.json shape.
 */

import { listAvailableVads } from "./resolver.js";

/**
 * Format the result of `step vad list` as a human-readable string.
 *
 * Columns:
 *   name (12)  status (16)  source (10)  module (rest)
 *   description on the next line, indented
 *   install hint if applicable, indented
 */
export async function handleVadList(): Promise<string> {
  const list = await listAvailableVads();
  const lines: string[] = ["Available VAD adapters:", ""];

  for (const v of list) {
    const status = v.installed ? "[✓ installed]" : "[✗ not installed]";
    const source = v.source === "built-in" ? "[built-in]" : "[plugin]";
    const head =
      `  ${v.name.padEnd(16)} ${status.padEnd(20)} ${source.padEnd(12)} ${v.module ?? ""}`.trimEnd();
    lines.push(head);
    if (v.description) {
      lines.push(`      ${v.description}`);
    }
    if (v.installHint) {
      lines.push(`      install: ${v.installHint}`);
    }
    lines.push("");
  }

  lines.push(
    "Select a VAD (persists to ~/.step-cli/config.json `voice.defaults.vad`):",
    "    step vad set energy      (built-in, default)",
    "    step vad set silero      (install first: pnpm setup:silero)",
    "",
    "Only duplex input mode uses the VAD; PTT bypasses it.",
  );
  return lines.join("\n");
}

export interface VadValidationResult {
  ok: boolean;
  /** Human-readable message — print to stderr when !ok. Empty when ok. */
  message: string;
}

/**
 * Validate a VAD adapter name against the known-adapter list, WITHOUT
 * persisting anything. The host writes the accepted name into the main
 * config's `voice.defaults.vad`.
 *
 * Refuses unknown names with a Levenshtein "did you mean X?" suggestion, and
 * refuses-with-hint if the adapter is known but not installed.
 */
export async function validateVadName(
  name: string,
): Promise<VadValidationResult> {
  const list = await listAvailableVads();
  const target = list.find((v) => v.name === name);

  if (!target) {
    const suggestion = nearestName(
      name,
      list.map((v) => v.name),
    );
    const lines = [
      `Unknown VAD adapter "${name}".`,
      suggestion ? `  Did you mean "${suggestion}"?` : null,
      "  Run `step vad list` to see all available adapters.",
    ].filter((l): l is string => l !== null);
    return { ok: false, message: lines.join("\n") };
  }

  if (!target.installed) {
    return {
      ok: false,
      message: [
        `VAD adapter "${name}" is known but not installed.`,
        `  Install: ${target.installHint}`,
        `  See docs/ for setup details.`,
      ].join("\n"),
    };
  }

  return { ok: true, message: "" };
}

function nearestName(input: string, candidates: string[]): string | null {
  let best: { name: string; d: number } | null = null;
  for (const name of candidates) {
    const d = editDistance(input, name);
    if (d <= 2 && (best === null || d < best.d)) {
      best = { name, d };
    }
  }
  return best?.name ?? null;
}

function editDistance(a: string, b: string): number {
  if (a === b) return 0;
  const al = a.length,
    bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;
  let prev = Array.from({ length: bl + 1 }, (_, j) => j);
  let curr = Array.from({ length: bl + 1 }, (_, j) => j);
  for (let j = 0; j <= bl; j++) prev[j] = j;
  for (let i = 1; i <= al; i++) {
    curr[0] = i;
    for (let j = 1; j <= bl; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(prev[j] + 1, curr[j - 1] + 1, prev[j - 1] + cost);
    }
    [prev, curr] = [curr, prev];
  }
  return prev[bl];
}
