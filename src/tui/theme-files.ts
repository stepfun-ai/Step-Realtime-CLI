import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import {
  TUI_THEME_COLOR_FIELD_NAMES,
  isValidTuiThemeColor,
  isValidTuiThemeName,
  type StepCliTuiThemeColors,
  type StepCliTuiThemeDefinition,
} from "./theme.js";

export interface StepCliInvalidTuiThemeFile {
  filePath: string;
  error: string;
}

export interface StepCliLoadedFileTuiThemes {
  themes: StepCliTuiThemeDefinition[];
  invalidFiles: StepCliInvalidTuiThemeFile[];
}

export async function loadFileBackedTuiThemes(
  themesDir: string,
): Promise<StepCliLoadedFileTuiThemes> {
  const files = await listThemeFiles(themesDir);
  const themes: StepCliTuiThemeDefinition[] = [];
  const invalidFiles: StepCliInvalidTuiThemeFile[] = [];

  for (const filePath of files) {
    try {
      themes.push(await readTuiThemeFile(filePath));
    } catch (error) {
      invalidFiles.push({
        filePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    themes,
    invalidFiles,
  };
}

export async function readTuiThemeFile(
  filePath: string,
): Promise<StepCliTuiThemeDefinition> {
  const raw = await fs.readFile(filePath, "utf8");
  return parseTuiThemeFileContent(raw, filePath);
}

export function parseTuiThemeFileContent(
  content: string,
  sourceLabel = "theme file",
): StepCliTuiThemeDefinition {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(
      `Failed to parse ${sourceLabel}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  return parseTuiThemeDefinition(parsed, sourceLabel);
}

export function parseTuiThemeDefinition(
  value: unknown,
  sourceLabel = "theme",
): StepCliTuiThemeDefinition {
  const root = readRecord(value);
  if (!root) {
    throw new Error(`Expected ${sourceLabel} to be an object`);
  }

  const name = readThemeName(root.name, `${sourceLabel}.name`);
  const colors = readTuiThemeColors(root.colors, `${sourceLabel}.colors`);

  return {
    name,
    colors,
  };
}

export function serializeTuiThemeDefinition(
  theme: StepCliTuiThemeDefinition,
): string {
  return `${JSON.stringify(
    {
      name: theme.name,
      colors: theme.colors,
    },
    null,
    2,
  )}\n`;
}

async function listThemeFiles(themesDir: string): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await fs.readdir(themesDir, {
      withFileTypes: true,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.join(themesDir, entry.name))
    .sort((left, right) => left.localeCompare(right));
}

function readThemeName(value: unknown, fieldPath: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`Expected ${fieldPath} to be a non-empty string`);
  }

  const normalized = value.trim();
  if (!isValidTuiThemeName(normalized)) {
    throw new Error(
      `Expected ${fieldPath} to match [a-z0-9_-] segments without spaces`,
    );
  }

  return normalized.toLowerCase();
}

function readTuiThemeColors(
  value: unknown,
  fieldPath: string,
): StepCliTuiThemeColors {
  const source = readRecord(value);
  if (!source) {
    throw new Error(`Expected ${fieldPath} to be an object`);
  }

  const colors = {} as Record<keyof StepCliTuiThemeColors, string>;
  for (const key of TUI_THEME_COLOR_FIELD_NAMES) {
    const raw = source[key];
    if (typeof raw !== "string" || raw.trim().length === 0) {
      throw new Error(`Expected ${fieldPath}.${key} to be a non-empty string`);
    }
    if (!isValidTuiThemeColor(raw)) {
      throw new Error(
        `Expected ${fieldPath}.${key} to be a hex color like #112233`,
      );
    }
    colors[key] = raw.trim();
  }

  return colors as StepCliTuiThemeColors;
}

function readRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
