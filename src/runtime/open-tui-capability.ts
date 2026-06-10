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

export interface ShouldAutoStartOpenTuiInput {
  buildEnabled: boolean;
  json: boolean;
  hasPrompt: boolean;
  hasAttachments: boolean;
  stdinIsTty: boolean;
  stdoutIsTty: boolean;
  platform?: NodeJS.Platform;
  openTuiEnvValue?: string;
}

export function shouldAutoStartOpenTui(
  input: ShouldAutoStartOpenTuiInput,
): boolean {
  if (
    !input.buildEnabled ||
    input.json ||
    input.hasPrompt ||
    input.hasAttachments ||
    !input.stdinIsTty ||
    !input.stdoutIsTty
  ) {
    return false;
  }

  const platform = input.platform ?? process.platform;
  if (platform !== "win32") {
    return true;
  }

  const configured = input.openTuiEnvValue?.trim().toLowerCase();
  return configured === "1" || configured === "true";
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
