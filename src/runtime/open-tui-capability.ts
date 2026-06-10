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
