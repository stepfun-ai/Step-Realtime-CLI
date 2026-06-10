import fs from "node:fs/promises";
import path from "node:path";
import { DEFAULT_MODEL } from "../bootstrap/config/defaults.js";

export type ResolvedValueSource =
  | "cli"
  | "env"
  | "config"
  | "config.modelsProxy"
  | "config.service"
  | "metadata"
  | "fallback"
  | "computed";

export interface ResolvedValue<T> {
  value: T;
  source: ResolvedValueSource;
}

export interface ResolvedValueCandidate<T> {
  value: T | undefined;
  source: ResolvedValueSource;
}

export function resolveValue<T>(
  candidates: Array<ResolvedValueCandidate<T> | undefined>,
  fallback: ResolvedValueCandidate<T>,
): ResolvedValue<T> {
  for (const candidate of candidates) {
    if (candidate?.value !== undefined) {
      return {
        value: candidate.value as T,
        source: candidate.source,
      };
    }
  }

  return {
    value: fallback.value as T,
    source: fallback.source,
  };
}

export function resolveOptionalValue<T>(
  candidates: Array<ResolvedValueCandidate<T> | undefined>,
): ResolvedValue<T | undefined> {
  for (const candidate of candidates) {
    if (candidate?.value !== undefined) {
      return {
        value: candidate.value,
        source: candidate.source,
      };
    }
  }

  return {
    value: undefined,
    source: "computed",
  };
}

export async function readSystemPromptFile(filePath: string): Promise<string> {
  const absolutePath = path.resolve(filePath);
  const content = await fs.readFile(absolutePath, "utf8");
  if (content.trim().length === 0) {
    throw new Error(`System prompt file is empty: ${absolutePath}`);
  }
  return content;
}

export function resolveModelsProxyDefaultModel(
  models: string[] | undefined,
): string | undefined {
  if (!models || models.length === 0) {
    return undefined;
  }

  return [
    models.find((model) => model === DEFAULT_MODEL),
    models.find(
      (model) => model.startsWith("step/") && !model.startsWith("ccr/"),
    ),
    models.find((model) => model === `ccr/${DEFAULT_MODEL}`),
    models.find((model) => model.startsWith("ccr/step/")),
    models[0],
  ].find((model): model is string => Boolean(model));
}

export function maskSecretForDisplay(
  value: string | undefined,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return "";
  }

  return "<redacted>";
}
