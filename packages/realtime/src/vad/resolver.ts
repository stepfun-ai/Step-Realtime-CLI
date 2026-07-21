/**
 * VAD adapter resolution and discovery.
 *
 * Two responsibilities:
 *   1. resolveVadAdapter(cfg)  — turn a user config value into a live adapter
 *   2. listAvailableVads()     — report all known VADs + their install state
 *
 * Built-in adapters are compiled into the SDK (just "energy" for now).
 * Plugins are loaded via dynamic import; the KNOWN_PLUGINS map lets users
 * write short names like "silero" instead of the full npm spec.
 *
 * Stability: this file's KNOWN_PLUGINS map uses the npm package names that
 * the plugins will have AFTER migration to step-cli. In the current
 * harness-ts repo, tsconfig.json paths maps these specifiers to local
 * sources under extensions/. Post-migration the paths entries are deleted
 * and the real npm packages take over — no code change here.
 */

import type { VadAdapter, VadConfig, VadFactory } from "./types.js";

// ─── Built-in adapters (compiled in, zero install cost) ─────────────────

const BUILT_IN: Record<string, () => Promise<VadFactory>> = {
  energy: async () => (await import("./energy-adapter.js")).createVadAdapter,
};

// ─── Known plugins (short-name → npm spec) ──────────────────────────────
//
// To add a new plugin (e.g. future stepfun streaming VAD):
//   1. Append entry here
//   2. Add description in PLUGIN_DESCRIPTIONS
//   3. (In current repo) add tsconfig paths mapping to local source
//   4. Document install in docs/

const KNOWN_PLUGINS: Record<string, string> = {
  silero: "@step-cli/realtime-vad-silero",
  // "stepfun-stream": "@step-cli/realtime-vad-stepfun",  // future
};

// The module whose resolvability actually decides whether a plugin can RUN.
// For in-repo plugins the wrapper package (KNOWN_PLUGINS value) is a workspace
// package with a tsconfig paths mapping, so it always resolves — even when the
// heavy native dep it loads at runtime is absent. Probe that native dep
// instead. silero's adapter dynamically imports `avr-vad` (which pulls the
// onnxruntime-node binary), so `avr-vad` is the honest install signal.
const PLUGIN_INSTALL_PROBES: Record<string, string> = {
  silero: "avr-vad",
};

const PLUGIN_DESCRIPTIONS: Record<string, string> = {
  silero: "Silero neural VAD (ONNX-based, low false-positive rate)",
};

// ─── Resolution ──────────────────────────────────────────────────────────

/**
 * Resolve a VadConfig (string or object) into a live VadAdapter instance.
 *
 * Throws with a helpful message if:
 *   - The plugin module isn't installed (suggests pnpm add ...)
 *   - The plugin's factory export is missing or not a function
 *   - The type name is unknown and not a valid module specifier
 */
export async function resolveVadAdapter(cfg: VadConfig): Promise<VadAdapter> {
  const normalized = typeof cfg === "string" ? { type: cfg } : cfg;
  const { type, options } = normalized;

  // Path 1: built-in
  if (type in BUILT_IN) {
    const factory = await BUILT_IN[type]!();
    return await factory(options);
  }

  // Path 2: known plugin short-name or arbitrary npm spec
  const moduleSpec = KNOWN_PLUGINS[type] ?? type;

  try {
    const mod = await import(moduleSpec);
    const factory: unknown =
      (mod as { createVadAdapter?: unknown }).createVadAdapter ??
      (mod as { default?: unknown }).default;
    if (typeof factory !== "function") {
      throw new Error(
        `VAD plugin "${moduleSpec}" must export createVadAdapter() or a default factory function`,
      );
    }
    return await (factory as VadFactory)(options);
  } catch (err) {
    if (isModuleNotFound(err)) {
      throw formatNotInstalledError(type, moduleSpec);
    }
    throw err;
  }
}

// ─── Discovery (for `vad list` command) ──────────────────────────────────

export interface VadInfo {
  /** Short name used in config (e.g. "energy", "silero"). */
  name: string;
  description: string;
  source: "built-in" | "plugin";
  /** For plugins, the npm module specifier resolveVadAdapter will import. */
  module?: string;
  /** Whether the underlying module is currently resolvable in this process. */
  installed: boolean;
  /** If not installed, the shell command suggested to install it. */
  installHint?: string;
}

/**
 * List all known VAD adapters with installation status.
 *
 * Used by `voice-agent vad list` for discoverability — the user shouldn't
 * have to read docs to find out what's available. Third-party plugins not
 * in KNOWN_PLUGINS won't show here, but the user can still reference them
 * by full module name.
 */
export async function listAvailableVads(): Promise<VadInfo[]> {
  const out: VadInfo[] = [
    {
      name: "energy",
      description:
        "Built-in energy VAD (zero deps, fair quality in quiet rooms)",
      source: "built-in",
      installed: true,
    },
  ];

  for (const [name, moduleSpec] of Object.entries(KNOWN_PLUGINS)) {
    // Probe the real runtime dep when one is registered (see
    // PLUGIN_INSTALL_PROBES); otherwise fall back to the wrapper package.
    const probeSpec = PLUGIN_INSTALL_PROBES[name] ?? moduleSpec;
    const installed = await canResolveModule(probeSpec);
    out.push({
      name,
      description: PLUGIN_DESCRIPTIONS[name] ?? "",
      source: "plugin",
      module: moduleSpec,
      installed,
      installHint: installed ? undefined : suggestInstallCmd(name, moduleSpec),
    });
  }

  return out;
}

// ─── Helpers ────────────────────────────────────────────────────────────

/**
 * Cheap check: can Node resolve this module without actually loading it?
 *
 * Tries import.meta.resolve first (Node 20+, sync, fastest). Falls back to
 * a dynamic import attempt — slower but guaranteed to work on older Node.
 * On any error we conservatively return false; the user gets a clear
 * install hint when they try to use the plugin.
 */
async function canResolveModule(spec: string): Promise<boolean> {
  type ImportMetaWithResolve = ImportMeta & {
    resolve?: (s: string) => string;
  };
  // Read import.meta indirectly so the CJS bundle (which cannot lower
  // `import.meta`) doesn't emit a SyntaxError at load time. In CJS context
  // this returns undefined and we drop straight to the dynamic-import branch.
  let meta: ImportMetaWithResolve | undefined;
  try {
    meta = (0, eval)(
      "typeof import !== 'undefined' ? import.meta : undefined",
    ) as ImportMetaWithResolve | undefined;
  } catch {
    meta = undefined;
  }

  if (meta && typeof meta.resolve === "function") {
    try {
      meta.resolve(spec);
      return true;
    } catch {
      return false;
    }
  }

  try {
    await import(spec);
    return true;
  } catch {
    return false;
  }
}

function isModuleNotFound(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: string; message?: string };
  return (
    e.code === "ERR_MODULE_NOT_FOUND" ||
    e.code === "MODULE_NOT_FOUND" ||
    /Cannot find (module|package)/i.test(e.message ?? "")
  );
}

function formatNotInstalledError(type: string, moduleSpec: string): Error {
  const knownNames = ["energy", ...Object.keys(KNOWN_PLUGINS)];
  const suggestion = nearestKnown(type, knownNames);
  const installCmd = suggestInstallCmd(type, moduleSpec);

  const lines = [
    `VAD plugin "${type}" is not installed.`,
    `  Module: ${moduleSpec}`,
    suggestion && suggestion !== type
      ? `  Did you mean "${suggestion}"?`
      : null,
    `  Install: ${installCmd}`,
    `  List all available: step vad list`,
  ].filter((l): l is string => l !== null);

  return new Error(lines.join("\n"));
}

// Per-plugin install commands. In-repo plugins are enabled via a setup script
// (they pull native deps), not a bare `pnpm add`.
const PLUGIN_INSTALL_HINTS: Record<string, string> = {
  silero: "pnpm setup:silero",
};

function suggestInstallCmd(name: string, moduleSpec: string): string {
  return PLUGIN_INSTALL_HINTS[name] ?? `pnpm add ${moduleSpec}`;
}

/**
 * Levenshtein-distance nearest neighbor for typo correction. Returns the
 * closest known name within edit-distance 2; null if no candidate is close
 * enough (so we don't suggest wild misses).
 */
function nearestKnown(input: string, candidates: string[]): string | null {
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
  const al = a.length;
  const bl = b.length;
  if (al === 0) return bl;
  if (bl === 0) return al;

  let prev = Array.from({ length: bl + 1 }, (_, j) => j);
  let curr = Array.from({ length: bl + 1 }, () => 0);

  for (let i = 1; i <= al; i++) {
    curr[0] = i;
    for (let j = 1; j <= bl; j++) {
      const cost = a.charCodeAt(i - 1) === b.charCodeAt(j - 1) ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1, // deletion
        curr[j - 1] + 1, // insertion
        prev[j - 1] + cost, // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[bl];
}
