import type { ToolCallInspection } from "@step-cli/protocol";
import { shortenLine } from "@step-cli/utils/text.js";

const DEFAULT_HINT_MAX_CHARS = 96;

export function createCommandInspection(
  command: string,
  label: string,
): ToolCallInspection {
  const normalizedCommand = normalizeInlineText(command);

  return {
    ...(normalizedCommand
      ? {
          command: normalizedCommand,
          inputHint: shortenLine(normalizedCommand, DEFAULT_HINT_MAX_CHARS),
        }
      : {}),
    externalEffects: [
      {
        kind: "external-unsafe",
        label,
      },
    ],
  };
}

export function createReadPathInspection(
  relativePath: string | undefined,
): ToolCallInspection | undefined {
  const normalizedPath = normalizeRelativePath(relativePath);
  if (!normalizedPath) {
    return undefined;
  }

  return {
    inputHint: normalizedPath,
    touchedPaths: [normalizedPath],
  };
}

export function createWritePathInspection(
  relativePath: string | undefined,
  operation: string,
): ToolCallInspection | undefined {
  const normalizedPath = normalizeRelativePath(relativePath);
  if (!normalizedPath) {
    return undefined;
  }

  return createMultiPathWriteInspection([normalizedPath], {
    inputHint: normalizedPath,
    fileOperations: [`${operation} ${normalizedPath}`],
  });
}

export function createMultiPathWriteInspection(
  relativePaths: Iterable<string>,
  options?: {
    approvalFingerprint?: string;
    inputHint?: string;
    fileOperations?: string[];
  },
): ToolCallInspection | undefined {
  const normalizedPaths = normalizeRelativePaths(relativePaths);
  if (normalizedPaths.length === 0) {
    return undefined;
  }

  return {
    ...(options?.approvalFingerprint
      ? { approvalFingerprint: options.approvalFingerprint }
      : {}),
    ...(options?.inputHint
      ? { inputHint: shortenLine(options.inputHint, DEFAULT_HINT_MAX_CHARS) }
      : {}),
    ...(options?.fileOperations && options.fileOperations.length > 0
      ? {
          fileOperations: options.fileOperations.map((entry) =>
            shortenLine(entry, DEFAULT_HINT_MAX_CHARS),
          ),
        }
      : {}),
    touchedPaths: normalizedPaths,
    externalEffects: [
      {
        kind: "file-write",
        relativePaths: normalizedPaths,
      },
    ],
  };
}

export function normalizeRelativePaths(
  relativePaths: Iterable<string>,
): string[] {
  const normalized = new Set<string>();
  for (const entry of relativePaths) {
    const trimmed = normalizeRelativePath(entry);
    if (trimmed) {
      normalized.add(trimmed);
    }
  }
  return [...normalized].sort((left, right) => left.localeCompare(right));
}

function normalizeRelativePath(
  relativePath: string | undefined,
): string | undefined {
  const trimmed = relativePath?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeInlineText(value: string): string | undefined {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length > 0 ? normalized : undefined;
}
