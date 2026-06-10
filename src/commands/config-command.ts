import path from "node:path";
import fs from "node:fs/promises";
import { Command } from "commander";
import {
  BUILTIN_CLI_DEFAULTS,
  STEPCLI_CONFIG_ENV_NAMES,
} from "../bootstrap/config/defaults.js";
import {
  loadStepCliConfig,
  getDefaultUserConfigPath,
  getDefaultWorkspaceConfigPath,
  resolveExplicitConfigPath,
  resolveStepCliConfigPaths,
  writeDefaultConfigTemplate,
  createDefaultConfigTemplate,
} from "../bootstrap/config/loader.js";
import type { StepCliConfigInspection } from "../runtime/runtime-config.js";
import { inspectStepCliConfig } from "../runtime/runtime-config.js";
import { maskSecretForDisplay } from "../runtime/runtime-utils.js";
import { setStderrDevLogStorageRootDirectory } from "../runtime/stderr-dev-log.js";
import {
  pathExists,
  readFirstEnv,
  readOptionalString,
} from "./command-utils.js";
import {
  configureCommanderProgram,
  parseCommanderProgram,
} from "./commander-utils.js";
import { parseConfigScope } from "./option-parsers.js";
import {
  resolveStorageRootDirectory,
  uniquePaths,
} from "@step-cli/utils/path.js";

export async function runConfigCommand(argv: string[]): Promise<void> {
  const configProgram = configureCommanderProgram(new Command());

  configProgram
    .name("step config")
    .description("Inspect or initialize step-cli config files")
    .showHelpAfterError();

  configProgram
    .command("path")
    .description("Show step-cli user/workspace config paths")
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
      setStderrDevLogStorageRootDirectory(
        await resolveConfigCommandStorageRootDirectory({
          workspaceRoot,
          explicitConfigPath,
        }),
      );
      const configPaths = resolveStepCliConfigPaths({
        workspaceRoot,
        explicitConfigPath,
      });
      const existingPaths = (
        await Promise.all(
          uniquePaths(
            explicitConfigPath
              ? [explicitConfigPath]
              : [
                  getDefaultUserConfigPath(),
                  getDefaultWorkspaceConfigPath(workspaceRoot),
                ],
          ).map(async (entryPath) =>
            (await pathExists(entryPath)) ? entryPath : undefined,
          ),
        )
      ).filter((entryPath): entryPath is string => Boolean(entryPath));

      if (options.json) {
        process.stdout.write(
          `${JSON.stringify(
            {
              ...configPaths,
              existingPaths,
            },
            null,
            2,
          )}\n`,
        );
        return;
      }

      process.stdout.write(
        [
          `user: ${configPaths.userConfigPath}`,
          `workspace: ${configPaths.workspaceConfigPath}`,
          `explicit: ${configPaths.explicitConfigPath ?? "(none)"}`,
          `existing: ${existingPaths.length > 0 ? existingPaths.join(", ") : "(none)"}`,
        ].join("\n") + "\n",
      );
    });

  configProgram
    .command("show")
    .description("Show merged config and resolved local runtime defaults")
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
      setStderrDevLogStorageRootDirectory(
        await resolveConfigCommandStorageRootDirectory({
          workspaceRoot,
          explicitConfigPath,
        }),
      );
      const inspection = await inspectStepCliConfig({
        workspaceRoot,
        explicitConfigPath,
      });
      const sanitized = sanitizeInspection(inspection);

      if (options.json) {
        process.stdout.write(`${JSON.stringify(sanitized, null, 2)}\n`);
        return;
      }

      process.stdout.write(renderInspection(sanitized));
    });

  configProgram
    .command("init")
    .description("Create a step-cli config template")
    .option("--path <path>", "Write to an explicit config path")
    .option(
      "--scope <scope>",
      "Config scope: user|workspace",
      parseConfigScope,
      "user",
    )
    .option("-w, --workspace <path>", "Workspace directory", process.cwd())
    .option("--force", "Overwrite an existing config file", false)
    .action(async (options) => {
      const workspaceRoot = path.resolve(options.workspace);
      setStderrDevLogStorageRootDirectory(
        await resolveConfigCommandStorageRootDirectory({
          workspaceRoot,
        }),
      );
      const targetPath =
        readOptionalString(options.path) ??
        (options.scope === "workspace"
          ? getDefaultWorkspaceConfigPath(workspaceRoot)
          : getDefaultUserConfigPath());
      const writtenPath = await writeDefaultConfigTemplate(targetPath, {
        force: options.force,
      });
      process.stdout.write(`Initialized step-cli config: ${writtenPath}\n`);
    });

  configProgram
    .command("sync")
    .description(
      "Fill in config keys added by newer versions that your existing config is missing (never overwrites your values). Preview by default; pass --write to apply.",
    )
    .option("--path <path>", "Explicit config path")
    .option(
      "--scope <scope>",
      "Config scope: user|workspace",
      parseConfigScope,
      "user",
    )
    .option("-w, --workspace <path>", "Workspace directory", process.cwd())
    .option("--write", "Apply the changes (default is preview only)", false)
    .action(async (options) => {
      const workspaceRoot = path.resolve(options.workspace);
      setStderrDevLogStorageRootDirectory(
        await resolveConfigCommandStorageRootDirectory({ workspaceRoot }),
      );
      const targetPath =
        readOptionalString(options.path) ??
        (options.scope === "workspace"
          ? getDefaultWorkspaceConfigPath(workspaceRoot)
          : getDefaultUserConfigPath());

      let raw: string;
      try {
        raw = await fs.readFile(targetPath, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          process.stderr.write(
            `Config not found: ${targetPath}\n  Run \`step config init\` to create it first.\n`,
          );
          process.exitCode = 1;
          return;
        }
        throw err;
      }

      let current: Record<string, unknown>;
      try {
        const parsed = JSON.parse(raw);
        if (!isPlainObject(parsed)) throw new Error("not an object");
        current = parsed;
      } catch (err) {
        process.stderr.write(
          `Failed to parse ${targetPath} as a JSON object: ${
            err instanceof Error ? err.message : String(err)
          }\n`,
        );
        process.exitCode = 1;
        return;
      }

      const template = JSON.parse(createDefaultConfigTemplate()) as Record<
        string,
        unknown
      >;
      const missing = collectMissingConfigKeys(template, current);

      if (missing.length === 0) {
        process.stdout.write(
          `Config is up to date — no missing keys. (${targetPath})\n`,
        );
        return;
      }

      process.stdout.write(
        `Missing keys in ${targetPath}:\n` +
          missing
            .map((m) => `  + ${m.path} = ${JSON.stringify(m.value)}`)
            .join("\n") +
          "\n",
      );

      if (!options.write) {
        process.stdout.write(
          "\n(preview only — re-run with --write to apply)\n",
        );
        return;
      }

      const backupPath = `${targetPath}.bak.${timestampForBackup()}`;
      await fs.copyFile(targetPath, backupPath);
      const merged = applyMissingConfigKeys(template, current);
      await fs.writeFile(
        targetPath,
        JSON.stringify(merged, null, 2) + "\n",
        "utf8",
      );
      process.stdout.write(
        `\nApplied ${missing.length} key(s) to ${targetPath} (backup: ${backupPath}).\n`,
      );
    });

  const parseArgv =
    argv.length > 0
      ? ["node", "step config", ...argv]
      : ["node", "step config", "--help"];
  await parseCommanderProgram(configProgram, parseArgv);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Keys present in the template but missing from current (deep). Existing keys
 *  are kept untouched — only genuinely absent keys are reported. Arrays/scalars
 *  count as "present" once the key exists (we never merge into a user's array
 *  or replace a user's value). */
function collectMissingConfigKeys(
  template: Record<string, unknown>,
  current: Record<string, unknown>,
  prefix = "",
): Array<{ path: string; value: unknown }> {
  const missing: Array<{ path: string; value: unknown }> = [];
  for (const [key, tval] of Object.entries(template)) {
    const p = prefix ? `${prefix}.${key}` : key;
    if (!(key in current)) {
      missing.push({ path: p, value: tval });
    } else if (isPlainObject(tval) && isPlainObject(current[key])) {
      missing.push(...collectMissingConfigKeys(tval, current[key], p));
    }
  }
  return missing;
}

/** Return a deep clone of current with template's missing keys filled in.
 *  Never overwrites an existing value. */
function applyMissingConfigKeys(
  template: Record<string, unknown>,
  current: Record<string, unknown>,
): Record<string, unknown> {
  const out: Record<string, unknown> = { ...current };
  for (const [key, tval] of Object.entries(template)) {
    if (!(key in out)) {
      out[key] = tval;
    } else if (isPlainObject(tval) && isPlainObject(out[key])) {
      out[key] = applyMissingConfigKeys(tval, out[key]);
    }
  }
  return out;
}

function timestampForBackup(): string {
  const d = new Date();
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}` +
    `-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
  );
}

async function resolveConfigCommandStorageRootDirectory(input: {
  workspaceRoot: string;
  explicitConfigPath?: string;
}): Promise<string> {
  const loadedConfig = await loadStepCliConfig({
    workspaceRoot: input.workspaceRoot,
    explicitConfigPath: input.explicitConfigPath,
  });

  return resolveStorageRootDirectory(
    input.workspaceRoot,
    loadedConfig.storage?.rootDir ?? BUILTIN_CLI_DEFAULTS.storage.rootDir,
  );
}

function sanitizeInspection(
  inspection: StepCliConfigInspection,
): Record<string, unknown> {
  const {
    userConfigPath,
    workspaceConfigPath,
    explicitConfigPath,
    loadedPaths,
    ...mergedBootstrapConfig
  } = inspection.loadedConfig;

  return {
    workspaceRoot: inspection.workspaceRoot,
    paths: {
      userConfigPath,
      workspaceConfigPath,
      explicitConfigPath,
      loadedPaths,
    },
    mergedConfig: {
      ...mergedBootstrapConfig,
      model: inspection.loadedConfig.model
        ? {
            ...inspection.loadedConfig.model,
            apiKey: maskSecretForDisplay(inspection.loadedConfig.model.apiKey),
          }
        : undefined,
      service: inspection.loadedConfig.service
        ? {
            ...inspection.loadedConfig.service,
            token: maskSecretForDisplay(inspection.loadedConfig.service.token),
          }
        : undefined,
      integrations: inspection.loadedConfig.integrations
        ? {
            ...inspection.loadedConfig.integrations,
            modelsProxy: inspection.loadedConfig.integrations.modelsProxy
              ? {
                  ...inspection.loadedConfig.integrations.modelsProxy,
                  apiKey: maskSecretForDisplay(
                    inspection.loadedConfig.integrations.modelsProxy.apiKey,
                  ),
                }
              : undefined,
          }
        : undefined,
    },
    runtime: {
      provider: inspection.runtime.provider,
      model: inspection.runtime.model,
      baseUrl: inspection.runtime.baseUrl,
      apiKey: {
        value: maskSecretForDisplay(inspection.runtime.apiKey.value),
        source: inspection.runtime.apiKey.source,
      },
      sharedOptions: inspection.runtime.sharedOptions,
      serviceOptions: {
        ...inspection.runtime.serviceOptions,
        token: maskSecretForDisplay(inspection.runtime.serviceOptions.token),
      },
      instructionFiles: inspection.runtime.instructionFiles,
      metadataProbeEligible: inspection.runtime.metadataProbeEligible,
    },
  };
}

function renderInspection(inspection: Record<string, unknown>): string {
  const typed = inspection as {
    workspaceRoot: string;
    paths: {
      userConfigPath: string;
      workspaceConfigPath: string;
      explicitConfigPath?: string;
      loadedPaths: string[];
    };
    runtime: {
      provider: { value?: string; source: string };
      model: { value: string; source: string };
      baseUrl: { value: string; source: string };
      apiKey: { value?: string; source: string };
      sharedOptions: {
        storageRootDir: { value: string; source: string };
      };
      serviceOptions: {
        host: string;
        port: number;
        token?: string;
        storageRootDir: string;
      };
      instructionFiles: Array<{
        path: string;
        source: string;
        format: string;
        activation?: string;
        pathPatterns?: string[];
        imports?: string[];
      }>;
      metadataProbeEligible: boolean;
    };
    mergedConfig: unknown;
  };

  return (
    [
      `workspace: ${typed.workspaceRoot}`,
      `user config: ${typed.paths.userConfigPath}`,
      `workspace config: ${typed.paths.workspaceConfigPath}`,
      `explicit config: ${typed.paths.explicitConfigPath ?? "(none)"}`,
      `loaded config files: ${typed.paths.loadedPaths.length > 0 ? typed.paths.loadedPaths.join(", ") : "(none)"}`,
      "",
      "runtime defaults:",
      `  provider: ${typed.runtime.provider.value ?? "(unset)"} (${typed.runtime.provider.source})`,
      `  model: ${typed.runtime.model.value} (${typed.runtime.model.source})`,
      `  baseUrl: ${typed.runtime.baseUrl.value} (${typed.runtime.baseUrl.source})`,
      `  apiKey: ${typed.runtime.apiKey.value ?? "(unset)"} (${typed.runtime.apiKey.source})`,
      `  service host: ${typed.runtime.serviceOptions.host}`,
      `  service port: ${typed.runtime.serviceOptions.port}`,
      `  service token: ${typed.runtime.serviceOptions.token ?? "(unset)"}`,
      `  storageRootDir: ${typed.runtime.serviceOptions.storageRootDir} (${typed.runtime.sharedOptions.storageRootDir.source})`,
      "  instruction files:",
      ...renderInstructionFiles(typed.runtime.instructionFiles).map(
        (line) => `    ${line}`,
      ),
      `  model metadata probe eligible: ${typed.runtime.metadataProbeEligible ? "yes" : "no"}`,
      "",
      "merged config:",
      JSON.stringify(typed.mergedConfig, null, 2),
    ].join("\n") + "\n"
  );
}

function renderInstructionFiles(
  files: Array<{
    path: string;
    source: string;
    format: string;
    activation?: string;
    pathPatterns?: string[];
    imports?: string[];
  }>,
): string[] {
  if (files.length === 0) {
    return ["(none)"];
  }

  return files.map((file) => {
    const details = [
      file.source,
      file.format,
      file.activation === "path" ? "deferred(path-scoped)" : "startup",
    ];

    if (file.pathPatterns && file.pathPatterns.length > 0) {
      details.push(`paths=${file.pathPatterns.join("|")}`);
    }

    if (file.imports && file.imports.length > 0) {
      details.push(`imports=${file.imports.length}`);
    }

    return `${file.path} (${details.join(", ")})`;
  });
}
