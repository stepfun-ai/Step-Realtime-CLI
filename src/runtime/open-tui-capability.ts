import type { CreateLocalTuiClientApp } from "./local-tui-app.js";

export function parseOpenTuiEnabledValue(
  rawValue: string | undefined,
): boolean {
  const configuredValue = rawValue?.trim().toLowerCase();
  return configuredValue !== "0" && configuredValue !== "false";
}

// Keep the process.env access inline so bundlers can replace it with a literal
// during bundle-time define folding.
const OPEN_TUI_ENABLED_IN_CURRENT_BUILD = parseOpenTuiEnabledValue(
  process.env.STEP_CLI_ENABLE_OPENTUI,
);

export function isOpenTuiEnabledInCurrentBuild(): boolean {
  return OPEN_TUI_ENABLED_IN_CURRENT_BUILD;
}

const loadOpenTuiRuntimeModule = OPEN_TUI_ENABLED_IN_CURRENT_BUILD
  ? async () => await import("./local-tui-app.js")
  : null;

export async function loadOpenTuiClientAppFactoryAtRuntime(): Promise<CreateLocalTuiClientApp> {
  if (!loadOpenTuiRuntimeModule) {
    throw new Error("OpenTUI is disabled in this build");
  }

  const runtimeModule = await loadOpenTuiRuntimeModule();
  if (typeof runtimeModule.createLocalTuiClientApp !== "function") {
    throw new Error("OpenTUI runtime did not export createLocalTuiClientApp()");
  }

  return runtimeModule.createLocalTuiClientApp;
}

/**
 * Returns true when the current process is running under Bun.
 *
 * `@opentui/core` ships a Bun-built bundle that uses `bun:ffi` (top-level
 * static imports) and `with { type: "file" }` import attributes for `.scm`
 * and `.wasm` assets. Node.js's strict ESM loader cannot evaluate these, so
 * the TUI code path must be skipped on Node.js. See:
 * https://github.com/stepfun-ai/Step-Realtime-CLI/issues/78
 */
export function isOpenTuiRuntimeSupported(): boolean {
  return (
    typeof process.versions.bun === "string" && process.versions.bun !== ""
  );
}
