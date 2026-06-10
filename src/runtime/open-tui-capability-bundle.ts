import type { CreateLocalTuiClientApp } from "./local-tui-app.js";

export function parseOpenTuiEnabledValue(
  rawValue: string | undefined,
): boolean {
  const configuredValue = rawValue?.trim().toLowerCase();
  return configuredValue !== "0" && configuredValue !== "false";
}

export function isOpenTuiEnabledInCurrentBuild(): boolean {
  return false;
}

export async function loadOpenTuiClientAppFactoryAtRuntime(): Promise<CreateLocalTuiClientApp> {
  throw new Error("OpenTUI is disabled in this build");
}
