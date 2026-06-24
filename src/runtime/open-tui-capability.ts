import type { CreateLocalTuiClientApp } from "./local-tui-app.js";
import { createLocalTuiClientApp } from "./local-tui-app.js";

export function isOpenTuiEnabledInCurrentBuild(): boolean {
  return true;
}

export async function loadOpenTuiClientAppFactoryAtRuntime(): Promise<CreateLocalTuiClientApp> {
  return createLocalTuiClientApp;
}
