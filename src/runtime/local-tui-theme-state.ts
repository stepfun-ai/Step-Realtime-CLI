import fs from "node:fs/promises";
import path from "node:path";
import type { StepCliTuiThemeName } from "../tui/theme.js";

const LOCAL_TUI_STATE_DIRNAME = "clients";
const LOCAL_TUI_STATE_BASENAME = "tui-state.json";

interface LocalTuiState {
  themeName?: unknown;
}

export function resolveLocalTuiThemeStatePath(storageRootDir: string): string {
  return path.join(
    storageRootDir,
    LOCAL_TUI_STATE_DIRNAME,
    LOCAL_TUI_STATE_BASENAME,
  );
}

export async function readLocalTuiThemeState(
  storageRootDir: string,
): Promise<StepCliTuiThemeName | undefined> {
  try {
    const raw = await fs.readFile(
      resolveLocalTuiThemeStatePath(storageRootDir),
      "utf8",
    );
    const parsed = JSON.parse(raw) as LocalTuiState;
    return typeof parsed.themeName === "string" &&
      parsed.themeName.trim().length > 0
      ? parsed.themeName
      : undefined;
  } catch {
    return undefined;
  }
}

export async function writeLocalTuiThemeState(
  storageRootDir: string,
  themeName: StepCliTuiThemeName,
): Promise<void> {
  const statePath = resolveLocalTuiThemeStatePath(storageRootDir);
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(
    statePath,
    `${JSON.stringify({ themeName }, null, 2)}\n`,
    "utf8",
  );
}
