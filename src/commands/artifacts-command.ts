import { Command } from "commander";
import path from "node:path";
import type { AgentHarnessKind } from "@step-cli/core/agent/harness-context.js";
import {
  BUILTIN_CLI_DEFAULTS,
  STEPCLI_CONFIG_ENV_NAMES,
} from "../bootstrap/config/defaults.js";
import {
  loadStepCliConfig,
  resolveExplicitConfigPath,
} from "../bootstrap/config/loader.js";
import {
  type AgentRunArtifactCategory,
  type AgentRunArtifactEntry,
  type AgentRunArtifactSummary,
} from "@step-cli/core/agent/run-artifact-store.js";
import {
  getAgentRunArtifactRootDirectory,
  listAgentRunArtifacts,
  readAgentRunArtifact,
} from "../gateway/artifacts/run-artifact-store.js";
import {
  resolveStorageLayout,
  resolveStorageRootDirectory,
  type StepCliResolvedStorageLayout,
} from "../gateway/storage/layout.js";
import { readFirstEnv, readOptionalString } from "./command-utils.js";
import {
  configureCommanderProgram,
  parseCommanderProgram,
} from "./commander-utils.js";
import { setStderrDevLogStorageRootDirectory } from "../runtime/stderr-dev-log.js";
import { parseNonNegativeInt } from "./option-parsers.js";

interface WriteTarget {
  write(chunk: string): unknown;
}

export interface ArtifactsCommandIo {
  stdout?: WriteTarget;
  stderr?: WriteTarget;
  cwd?: string;
}

interface ArtifactsListCliOptions {
  workspace?: string;
  config?: string;
  storageRootDir?: string;
  category?: AgentRunArtifactCategory;
  session?: string;
  goal?: string;
  attempt?: string;
  harnessKind?: AgentHarnessKind;
  harness?: string;
  label?: string;
  limit?: number;
  json?: boolean;
}

interface ArtifactsShowCliOptions {
  workspace?: string;
  config?: string;
  storageRootDir?: string;
  json?: boolean;
}

class InvalidArgumentError extends Error {}

export async function runArtifactsCommand(
  argv: string[],
  io: ArtifactsCommandIo = {},
): Promise<void> {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const cwd = io.cwd ?? process.cwd();
  const program = createArtifactsCommandProgram({ stdout, stderr, cwd });

  if (argv.length === 0) {
    program.outputHelp();
    return;
  }

  await parseCommanderProgram(program, ["node", "step artifacts", ...argv]);
}

function createArtifactsCommandProgram(input: {
  stdout: WriteTarget;
  stderr: WriteTarget;
  cwd: string;
}): Command {
  const program = configureCommanderProgram(new Command(), {
    writeOut: (chunk) => {
      input.stdout.write(chunk);
    },
    writeErr: (chunk) => {
      input.stderr.write(chunk);
    },
  });

  program
    .name("step artifacts")
    .description("Inspect persisted run artifacts")
    .showHelpAfterError()
    .addHelpText(
      "after",
      [
        "",
        "Examples:",
        "  step artifacts list --workspace /repo",
        "  step artifacts list --workspace /repo --session sess-123 --json",
        "  step artifacts show 20260320010203_subagent_fix-docs_attempt-1_abcd1234 --workspace /repo",
      ].join("\n"),
    );

  configureArtifactsListCommand(program, input);
  configureArtifactsShowCommand(program, input);
  return program;
}

function configureArtifactsListCommand(
  program: Command,
  input: { stdout: WriteTarget; cwd: string },
): void {
  program
    .command("list")
    .description("List persisted run artifacts")
    .option("-w, --workspace <path>", "Workspace root to inspect")
    .option(
      "--config <path>",
      "Path to step-cli config file (replaces default user/workspace lookup)",
    )
    .option(
      "--storage-root-dir <path>",
      "Override the configured storage root directory",
    )
    .option(
      "-c, --category <category>",
      "Filter by artifact category",
      parseArtifactCategoryOption,
    )
    .option("--session <sessionId>", "Filter by session id")
    .option("--goal <goalId>", "Filter by goal id")
    .option("--attempt <attemptId>", "Filter by attempt id")
    .option(
      "--harness-kind <kind>",
      "Filter by harness kind",
      parseHarnessKindOption,
    )
    .option("--harness <name>", "Filter by harness name")
    .option("--label <text>", "Filter by label substring")
    .option(
      "--limit <count>",
      "Limit the number of results",
      parseNonNegativeInt,
    )
    .option("--json", "Emit machine-readable JSON")
    .action(async (options: ArtifactsListCliOptions) => {
      const workspaceRoot = resolveWorkspaceRoot(input.cwd, options.workspace);
      const storageLayout = await resolveArtifactsStorageLayout({
        workspaceRoot,
        explicitConfigPath: options.config,
        cliStorageRootDir: options.storageRootDir,
      });
      setStderrDevLogStorageRootDirectory(storageLayout.rootDir);
      const artifacts = await listAgentRunArtifacts({
        workspaceRoot,
        storageLayout,
        category: options.category,
        sessionId: normalizeOptionalText(options.session),
        goalId: normalizeOptionalText(options.goal),
        attemptId: normalizeOptionalText(options.attempt),
        harnessKind: options.harnessKind,
        harnessName: normalizeOptionalText(options.harness),
        labelIncludes: normalizeOptionalText(options.label),
        limit: options.limit,
      });

      if (options.json) {
        writeJson(input.stdout, {
          workspaceRoot,
          artifactRoot: getAgentRunArtifactRootDirectory(storageLayout),
          count: artifacts.length,
          artifacts,
        });
        return;
      }

      input.stdout.write(renderArtifactList({ storageLayout, artifacts }));
    });
}

function configureArtifactsShowCommand(
  program: Command,
  input: { stdout: WriteTarget; cwd: string },
): void {
  program
    .command("show")
    .description("Show one persisted run artifact")
    .argument("<reference>", "Artifact id, relative path, or absolute path")
    .option("-w, --workspace <path>", "Workspace root to inspect")
    .option(
      "--config <path>",
      "Path to step-cli config file (replaces default user/workspace lookup)",
    )
    .option(
      "--storage-root-dir <path>",
      "Override the configured storage root directory",
    )
    .option("--json", "Emit machine-readable JSON")
    .action(async (reference: string, options: ArtifactsShowCliOptions) => {
      const workspaceRoot = resolveWorkspaceRoot(input.cwd, options.workspace);
      const storageLayout = await resolveArtifactsStorageLayout({
        workspaceRoot,
        explicitConfigPath: options.config,
        cliStorageRootDir: options.storageRootDir,
      });
      setStderrDevLogStorageRootDirectory(storageLayout.rootDir);
      const entry = await readAgentRunArtifact({
        workspaceRoot,
        reference,
        storageLayout,
      });

      if (!entry) {
        throw new Error(
          `Run artifact '${reference}' not found in ${workspaceRoot}`,
        );
      }

      if (options.json) {
        writeJson(input.stdout, {
          workspaceRoot,
          artifactRoot: getAgentRunArtifactRootDirectory(storageLayout),
          entry,
        });
        return;
      }

      input.stdout.write(renderArtifactShow(entry));
    });
}

function renderArtifactList(input: {
  storageLayout: StepCliResolvedStorageLayout;
  artifacts: AgentRunArtifactSummary[];
}): string {
  if (input.artifacts.length === 0) {
    return `No run artifacts found under ${getAgentRunArtifactRootDirectory(input.storageLayout)}.\n`;
  }

  const lines = [
    `Run artifacts (${input.artifacts.length}) under ${getAgentRunArtifactRootDirectory(input.storageLayout)}:`,
  ];

  for (const artifact of input.artifacts) {
    lines.push(
      "",
      `- [${artifact.category}] ${artifact.label}`,
      `  saved        ${artifact.savedAt ?? "-"}`,
      `  id           ${artifact.artifactId}`,
      `  scope        ${formatArtifactScope(artifact)}`,
      `  harness      ${formatArtifactHarness(artifact)}`,
      `  steps/tools  ${artifact.steps} / ${artifact.toolCalls}`,
      `  path         ${artifact.relativePath}`,
      `  prompt       ${artifact.promptPreview || "-"}`,
      `  output       ${artifact.outputPreview || "-"}`,
    );
  }

  return `${lines.join("\n")}\n`;
}

async function resolveArtifactsStorageLayout(input: {
  workspaceRoot: string;
  explicitConfigPath?: string;
  cliStorageRootDir?: string;
}): Promise<StepCliResolvedStorageLayout> {
  const loadedConfig = await loadStepCliConfig({
    workspaceRoot: input.workspaceRoot,
    explicitConfigPath: resolveExplicitConfigPath(
      readOptionalString(input.explicitConfigPath),
      readFirstEnv(STEPCLI_CONFIG_ENV_NAMES),
    ),
  });
  const storageRootOverride = readOptionalString(input.cliStorageRootDir);
  const storageRootDir = resolveStorageRootDirectory(
    input.workspaceRoot,
    storageRootOverride ??
      loadedConfig.storage?.rootDir ??
      BUILTIN_CLI_DEFAULTS.storage.rootDir,
  );
  const builtinLayout = BUILTIN_CLI_DEFAULTS.storage.layout;
  const configLayout = loadedConfig.storage?.layout ?? {};

  return resolveStorageLayout(storageRootDir, {
    ...builtinLayout,
    ...configLayout,
  });
}

function renderArtifactShow(entry: AgentRunArtifactEntry): string {
  const lines = [
    `artifact     ${entry.summary.artifactId}`,
    `category     ${entry.summary.category}`,
    `saved_at     ${entry.summary.savedAt ?? "-"}`,
    `path         ${entry.summary.relativePath}`,
    `label        ${entry.summary.label}`,
    `scope        ${formatArtifactScope(entry.summary)}`,
    `harness      ${formatArtifactHarness(entry.summary)}`,
    `stats        ${entry.summary.steps} step(s), ${entry.summary.toolCalls} tool call(s)`,
    `actions      ${entry.artifact.actions.length}`,
    `state_events ${entry.artifact.stateTimeline.length}`,
    "",
    "harness_json:",
    JSON.stringify(entry.artifact.harness, null, 2),
    "",
    "run_json:",
    JSON.stringify(entry.artifact.run, null, 2),
  ];

  if (entry.artifact.notes) {
    lines.push(
      "",
      "notes_json:",
      JSON.stringify(entry.artifact.notes, null, 2),
    );
  }

  lines.push(
    "",
    "prompt:",
    entry.artifact.prompt || "",
    "",
    "output:",
    entry.artifact.output || "",
  );
  return `${lines.join("\n")}\n`;
}

function formatArtifactScope(
  artifact: Pick<AgentRunArtifactSummary, "sessionId" | "goalId" | "attemptId">,
): string {
  return [
    `session ${artifact.sessionId ?? "-"}`,
    `goal ${artifact.goalId ?? "-"}`,
    `attempt ${artifact.attemptId ?? "-"}`,
  ].join("  ");
}

function formatArtifactHarness(
  artifact: Pick<
    AgentRunArtifactSummary,
    "harnessKind" | "harnessName" | "harnessId"
  >,
): string {
  const parts = [
    artifact.harnessKind ?? "-",
    artifact.harnessName ?? "-",
  ].filter((part) => part !== "-");
  const prefix = parts.length > 0 ? parts.join(" ") : "-";
  return artifact.harnessId ? `${prefix} (${artifact.harnessId})` : prefix;
}

function resolveWorkspaceRoot(
  cwd: string,
  workspace: string | undefined,
): string {
  return path.resolve(cwd, workspace ?? ".");
}

function normalizeOptionalText(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseArtifactCategoryOption(value: string): AgentRunArtifactCategory {
  if (value === "subagent" || value === "teammate") {
    return value;
  }
  throw new InvalidArgumentError("category must be 'subagent' or 'teammate'");
}

function parseHarnessKindOption(value: string): AgentHarnessKind {
  if (value === "main" || value === "subagent" || value === "teammate") {
    return value;
  }
  throw new InvalidArgumentError(
    "harness kind must be 'main', 'subagent', or 'teammate'",
  );
}

function writeJson(stdout: WriteTarget, value: unknown): void {
  stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
