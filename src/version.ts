import { readFileSync } from "node:fs";

export const STEP_CLI_VERSION_OVERRIDE_ENV = "STEP_CLI_VERSION_OVERRIDE";

export interface StepCliVersion {
  value: string;
  source: "override" | "embedded" | "fallback";
}

function readFallbackVersion(): string {
  // Source mode (tsx) and tsdown-built dist both keep package.json one level
  // above the file; bun-compiled binaries don't reach this path because
  // build-binary.mjs injects STEP_CLI_BUILD_VERSION at compile time.
  try {
    const url = new URL("../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(url, "utf8")) as { version?: unknown };
    if (typeof pkg.version === "string" && pkg.version.trim() !== "") {
      return pkg.version;
    }
  } catch {
    // fall through
  }
  return "0.0.0-dev";
}

const STEP_CLI_FALLBACK_VERSION = readFallbackVersion();

const embeddedBuildVersion = process.env.STEP_CLI_BUILD_VERSION?.trim() || null;
const overrideVersion =
  process.env[STEP_CLI_VERSION_OVERRIDE_ENV]?.trim() || null;

export const STEP_CLI_VERSION: StepCliVersion = {
  value: overrideVersion || embeddedBuildVersion || STEP_CLI_FALLBACK_VERSION,
  source: overrideVersion
    ? "override"
    : embeddedBuildVersion
      ? "embedded"
      : "fallback",
};
