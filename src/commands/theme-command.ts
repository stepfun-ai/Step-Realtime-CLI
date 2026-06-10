import fs from "node:fs/promises";
import path from "node:path";
import { Command } from "commander";
import {
  BUILTIN_CLI_DEFAULTS,
  STEPCLI_CONFIG_ENV_NAMES,
} from "../bootstrap/config/defaults.js";
import {
  loadStepCliConfig,
  resolveExplicitConfigPath,
} from "../bootstrap/config/loader.js";
import {
  getThemesDirectory,
  resolveStorageLayout,
  resolveStorageRootDirectory,
  type StepCliResolvedStorageLayout,
} from "../gateway/storage/layout.js";
import { readLocalTuiThemeState } from "../runtime/local-tui-theme-state.js";
import { setStderrDevLogStorageRootDirectory } from "../runtime/stderr-dev-log.js";
import {
  DEFAULT_TUI_THEME_NAME,
  getBuiltinTuiThemes,
  mergeTuiThemes,
  resolveTuiTheme,
} from "../tui/theme.js";
import {
  loadFileBackedTuiThemes,
  readTuiThemeFile,
  serializeTuiThemeDefinition,
} from "../tui/theme-files.js";
import {
  pathExists,
  readFirstEnv,
  readOptionalString,
} from "./command-utils.js";
import {
  configureCommanderProgram,
  parseCommanderProgram,
} from "./commander-utils.js";

interface WriteTarget {
  write(chunk: string): unknown;
}

export interface ThemeCommandIo {
  stdout?: WriteTarget;
  stderr?: WriteTarget;
  cwd?: string;
}

interface ThemeExportCliOptions {
  workspace?: string;
  config?: string;
  storageRootDir?: string;
}

export async function runThemeCommand(
  argv: string[],
  io: ThemeCommandIo = {},
): Promise<void> {
  const stdout = io.stdout ?? process.stdout;
  const stderr = io.stderr ?? process.stderr;
  const cwd = io.cwd ?? process.cwd();
  const program = createThemeCommandProgram({ stdout, stderr, cwd });

  await parseCommanderProgram(program, ["node", "step theme", ...argv]);
}

function createThemeCommandProgram(input: {
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
    .name("step theme")
    .description("Export or validate TUI theme files")
    .showHelpAfterError()
    .option("-w, --workspace <path>", "Workspace root to inspect")
    .option(
      "--config <path>",
      "Path to step-cli config file (replaces default user/workspace lookup)",
    )
    .option(
      "--storage-root-dir <path>",
      "Override the configured storage root directory",
    )
    .action(async (options: ThemeExportCliOptions) => {
      const workspaceRoot = resolveWorkspaceRoot(input.cwd, options.workspace);
      const storageLayout = await resolveThemeStorageLayout({
        workspaceRoot,
        explicitConfigPath: options.config,
        cliStorageRootDir: options.storageRootDir,
      });
      setStderrDevLogStorageRootDirectory(storageLayout.rootDir);

      const currentTheme = await resolveCurrentTuiTheme(storageLayout);
      const themesDir = getThemesDirectory(storageLayout);
      const targetPath = path.join(themesDir, `${currentTheme.name}.json`);
      if (await pathExists(targetPath)) {
        input.stdout.write(
          `Theme file already exists, leaving unchanged: ${targetPath}\n`,
        );
        return;
      }

      await fs.mkdir(themesDir, { recursive: true });
      await fs.writeFile(
        targetPath,
        serializeTuiThemeDefinition(currentTheme),
        {
          encoding: "utf8",
          flag: "wx",
        },
      );
      input.stdout.write(`Wrote theme file: ${targetPath}\n`);
    });

  program
    .command("check")
    .description("Validate a custom TUI theme file")
    .argument("<file>", "Theme file path")
    .action(async (file: string) => {
      const absolutePath = path.resolve(input.cwd, file);
      const theme = await readTuiThemeFile(absolutePath);
      input.stdout.write(
        `Theme file is valid: ${absolutePath} (${theme.name})\n`,
      );
    });

  return program;
}

async function resolveThemeStorageLayout(input: {
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

async function resolveCurrentTuiTheme(
  storageLayout: StepCliResolvedStorageLayout,
) {
  const selectedThemeName =
    (await readLocalTuiThemeState(storageLayout.rootDir)) ??
    DEFAULT_TUI_THEME_NAME;
  const loadedFileThemes = await loadFileBackedTuiThemes(
    getThemesDirectory(storageLayout),
  );
  const availableThemes = mergeTuiThemes([
    ...getBuiltinTuiThemes(),
    ...loadedFileThemes.themes,
  ]);

  return resolveTuiTheme(availableThemes, selectedThemeName);
}

function resolveWorkspaceRoot(cwd: string, workspace?: string): string {
  return path.resolve(cwd, workspace ?? ".");
}
