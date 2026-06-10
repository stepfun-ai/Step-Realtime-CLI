import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { Command } from "commander";
import {
  STEP_API_KEY_ENV_NAMES,
  STEPCLI_CONFIG_ENV_NAMES,
} from "../bootstrap/config/defaults.js";
import {
  loadStepCliConfig,
  resolveExplicitConfigPath,
} from "../bootstrap/config/loader.js";
import {
  configureCommanderProgram,
  parseCommanderProgram,
} from "./commander-utils.js";
import {
  pathExists,
  readFirstEnv,
  readOptionalString,
} from "./command-utils.js";

const execFileAsync = promisify(execFile);
const PLACEHOLDER_API_KEYS = new Set([
  "<your_api_key>",
  "<your_stepfun_api_key>",
]);

export type DoctorStatus = "ok" | "warn" | "error";

export interface DoctorCheck {
  status: DoctorStatus;
  message: string;
}

export interface DoctorReport {
  ok: boolean;
  checks: {
    node: DoctorCheck;
    pnpm: DoctorCheck;
    config: DoctorCheck;
    modelApiKey: DoctorCheck;
    voiceApiKey: DoctorCheck;
    chrome: DoctorCheck;
  };
}

export interface CreateDoctorReportOptions {
  workspaceRoot: string;
  explicitConfigPath?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  commandExists?: (name: string) => Promise<boolean>;
  findChrome?: () => Promise<string | undefined> | string | undefined;
}

export async function runDoctorCommand(argv: string[]): Promise<void> {
  const program = configureCommanderProgram(new Command());

  program
    .name("step doctor")
    .description("Check local step-cli installation and configuration")
    .option(
      "--config <path>",
      "Explicit config file path (replaces default user/workspace lookup)",
    )
    .option("-w, --workspace <path>", "Workspace directory", process.cwd())
    .option("--json", "JSON output", false)
    .action(async (options) => {
      const workspaceRoot = path.resolve(options.workspace);
      const explicitConfigPath = resolveExplicitConfigPath(
        readOptionalString(options.config),
        readFirstEnv(STEPCLI_CONFIG_ENV_NAMES),
      );
      const report = await createDoctorReport({
        workspaceRoot,
        explicitConfigPath,
      });

      if (options.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        process.stdout.write(renderDoctorReport(report));
      }

      if (!report.ok) {
        process.exitCode = 1;
      }
    });

  await parseCommanderProgram(program, ["node", "step doctor", ...argv]);
}

export async function createDoctorReport(
  options: CreateDoctorReportOptions,
): Promise<DoctorReport> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const commandExists =
    options.commandExists ??
    ((name: string) => defaultCommandExists(name, platform));
  const config = await inspectConfig(options);
  const voiceApiKey = await readVoiceApiKey(config.loadedPath);

  const checks = {
    node: inspectNodeVersion(),
    pnpm: await inspectCommand("pnpm", commandExists, {
      ok: "pnpm is available",
      warn: "pnpm was not found in PATH",
    }),
    config: config.check,
    modelApiKey: inspectApiKey(
      readFirstEnvFrom(env, STEP_API_KEY_ENV_NAMES) ?? config.modelApiKey,
      "Model API key is configured",
      "Model API key is missing or still uses the template placeholder",
    ),
    voiceApiKey: inspectApiKey(
      voiceApiKey,
      "Voice realtime API key is configured",
      "Voice realtime API key is missing or still uses the template placeholder",
    ),
    chrome: await inspectChrome(options.findChrome ?? defaultFindChrome),
  };

  return {
    ok: Object.values(checks).every((check) => check.status === "ok"),
    checks,
  };
}

export function renderDoctorReport(report: DoctorReport): string {
  return [
    "Step CLI doctor",
    renderCheck("Node.js", report.checks.node),
    renderCheck("pnpm", report.checks.pnpm),
    renderCheck("Config", report.checks.config),
    renderCheck("Model API key", report.checks.modelApiKey),
    renderCheck("Voice API key", report.checks.voiceApiKey),
    renderCheck("Chrome/Chromium", report.checks.chrome),
    "",
  ].join("\n");
}

async function inspectConfig(options: CreateDoctorReportOptions): Promise<{
  check: DoctorCheck;
  loadedPath?: string;
  modelApiKey?: string;
}> {
  try {
    const loaded = await loadStepCliConfig({
      workspaceRoot: options.workspaceRoot,
      explicitConfigPath: options.explicitConfigPath,
    });
    if (loaded.loadedPaths.length === 0) {
      return {
        check: {
          status: "warn",
          message: "No config file found; run `step config init`",
        },
      };
    }

    return {
      check: {
        status: "ok",
        message: `Loaded ${loaded.loadedPaths.join(", ")}`,
      },
      loadedPath: loaded.loadedPaths[loaded.loadedPaths.length - 1],
      modelApiKey: loaded.model?.apiKey,
    };
  } catch (error) {
    return {
      check: {
        status: "error",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

async function readVoiceApiKey(
  configPath: string | undefined,
): Promise<string | undefined> {
  if (!configPath || !(await pathExists(configPath))) {
    return undefined;
  }

  const raw = await fs.readFile(configPath, "utf8");
  const parsed = JSON.parse(raw) as {
    voice?: { realtime?: { apiKey?: unknown } };
  };
  const apiKey = parsed.voice?.realtime?.apiKey;
  return typeof apiKey === "string" ? apiKey : undefined;
}

function inspectNodeVersion(): DoctorCheck {
  const major = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  if (major >= 20) {
    return {
      status: "ok",
      message: `Node.js ${process.version} is supported`,
    };
  }

  return {
    status: "error",
    message: `Node.js ${process.version} is too old; Node.js 20+ is required`,
  };
}

async function inspectCommand(
  name: string,
  commandExists: (name: string) => Promise<boolean>,
  messages: { ok: string; warn: string },
): Promise<DoctorCheck> {
  return (await commandExists(name))
    ? { status: "ok", message: messages.ok }
    : { status: "warn", message: messages.warn };
}

async function inspectChrome(
  findChrome: () => Promise<string | undefined> | string | undefined,
): Promise<DoctorCheck> {
  const chromePath = await findChrome();
  if (chromePath) {
    return {
      status: "ok",
      message: `Chrome/Chromium found (${chromePath})`,
    };
  }

  return {
    status: "warn",
    message: "Chrome/Chromium was not found; AEC voice mode may need setup",
  };
}

function inspectApiKey(
  apiKey: string | undefined,
  okMessage: string,
  warnMessage: string,
): DoctorCheck {
  if (apiKey && !PLACEHOLDER_API_KEYS.has(apiKey.trim())) {
    return {
      status: "ok",
      message: okMessage,
    };
  }

  return {
    status: "warn",
    message: warnMessage,
  };
}

function renderCheck(label: string, check: DoctorCheck): string {
  return `  [${check.status.toUpperCase()}] ${label}: ${check.message}`;
}

function readFirstEnvFrom(
  env: NodeJS.ProcessEnv,
  names: readonly string[],
): string | undefined {
  for (const name of names) {
    const value = env[name];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

export function resolveCommandLookupExecutable(
  platform: NodeJS.Platform,
): string {
  return platform === "win32" ? "where" : "which";
}

async function defaultCommandExists(
  name: string,
  platform: NodeJS.Platform,
): Promise<boolean> {
  try {
    await execFileAsync(resolveCommandLookupExecutable(platform), [name]);
    return true;
  } catch {
    return false;
  }
}

async function defaultFindChrome(): Promise<string | undefined> {
  try {
    const aec = await import("@step-cli/realtime-aec");
    return aec.findChrome();
  } catch {
    return undefined;
  }
}
