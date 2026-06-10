const BEGIN_PATCH_MARKER = "*** Begin Patch";
const END_PATCH_MARKER = "*** End Patch";
const ADD_FILE_MARKER = "*** Add File: ";
const DELETE_FILE_MARKER = "*** Delete File: ";
const UPDATE_FILE_MARKER = "*** Update File: ";
const MOVE_TO_MARKER = "*** Move to: ";
const EOF_MARKER = "*** End of File";

interface ApplyPatchChunk {
  changeContext?: string;
  oldLines: string[];
  newLines: string[];
  isEndOfFile: boolean;
}

type ApplyPatchOperation =
  | {
      kind: "add";
      path: string;
      lines: string[];
    }
  | {
      kind: "delete";
      path: string;
    }
  | {
      kind: "update";
      path: string;
      moveTo?: string;
      chunks: ApplyPatchChunk[];
    };

export interface ApplyPatchDocument {
  operations: ApplyPatchOperation[];
}

export function parseApplyPatchDocument(source: string): ApplyPatchDocument {
  const normalized = unwrapPotentialHeredoc(source)
    .replace(/\r\n/g, "\n")
    .trim();
  const lines = normalized.split("\n");

  if (lines[0]?.trim() !== BEGIN_PATCH_MARKER) {
    throw new Error(`Patch must start with '${BEGIN_PATCH_MARKER}'`);
  }

  if (lines[lines.length - 1]?.trim() !== END_PATCH_MARKER) {
    throw new Error(`Patch must end with '${END_PATCH_MARKER}'`);
  }

  const operations: ApplyPatchOperation[] = [];
  let index = 1;

  while (index < lines.length - 1) {
    const line = lines[index]?.trimEnd() ?? "";
    if (line.trim().length === 0) {
      index += 1;
      continue;
    }

    if (line.startsWith(ADD_FILE_MARKER)) {
      const targetPath = line.slice(ADD_FILE_MARKER.length);
      if (!targetPath) {
        throw new Error(`Missing path for add-file hunk at line ${index + 1}`);
      }

      const fileLines: string[] = [];
      index += 1;
      while (index < lines.length - 1) {
        const current = lines[index] ?? "";
        if (current.startsWith("*** ")) {
          break;
        }
        if (!current.startsWith("+")) {
          throw new Error(
            `Add-file hunk only supports '+' lines (line ${index + 1})`,
          );
        }
        fileLines.push(current.slice(1));
        index += 1;
      }

      if (fileLines.length === 0) {
        throw new Error(`Add-file hunk for '${targetPath}' is empty`);
      }

      operations.push({
        kind: "add",
        path: targetPath,
        lines: fileLines,
      });
      continue;
    }

    if (line.startsWith(DELETE_FILE_MARKER)) {
      const targetPath = line.slice(DELETE_FILE_MARKER.length);
      if (!targetPath) {
        throw new Error(
          `Missing path for delete-file hunk at line ${index + 1}`,
        );
      }
      operations.push({
        kind: "delete",
        path: targetPath,
      });
      index += 1;
      continue;
    }

    if (line.startsWith(UPDATE_FILE_MARKER)) {
      const targetPath = line.slice(UPDATE_FILE_MARKER.length);
      if (!targetPath) {
        throw new Error(
          `Missing path for update-file hunk at line ${index + 1}`,
        );
      }

      index += 1;
      let moveTo: string | undefined;
      if ((lines[index] ?? "").startsWith(MOVE_TO_MARKER)) {
        moveTo = (lines[index] ?? "").slice(MOVE_TO_MARKER.length);
        if (!moveTo) {
          throw new Error(`Missing move destination for '${targetPath}'`);
        }
        index += 1;
      }

      const chunks: ApplyPatchChunk[] = [];
      let currentChunk: ApplyPatchChunk | null = null;

      while (index < lines.length - 1) {
        const current = lines[index] ?? "";
        const trimmed = current.trimEnd();

        if (trimmed.startsWith("*** ")) {
          break;
        }

        if (trimmed.length === 0) {
          if (!currentChunk || isChunkEmpty(currentChunk)) {
            index += 1;
            continue;
          }
        }

        if (trimmed === EOF_MARKER) {
          if (!currentChunk) {
            currentChunk = createEmptyChunk();
          }
          currentChunk.isEndOfFile = true;
          index += 1;
          continue;
        }

        if (trimmed === "@@" || trimmed.startsWith("@@ ")) {
          if (currentChunk && !isChunkEmpty(currentChunk)) {
            chunks.push(currentChunk);
          }
          currentChunk = createEmptyChunk();
          if (trimmed !== "@@") {
            currentChunk.changeContext = trimmed.slice(3);
          }
          index += 1;
          continue;
        }

        const prefix = current[0];
        if (prefix !== " " && prefix !== "+" && prefix !== "-") {
          throw new Error(
            `Invalid update hunk line '${current}' at line ${index + 1}`,
          );
        }

        if (!currentChunk) {
          currentChunk = createEmptyChunk();
        }

        const content = current.slice(1);
        if (prefix !== "+") {
          currentChunk.oldLines.push(content);
        }
        if (prefix !== "-") {
          currentChunk.newLines.push(content);
        }

        index += 1;
      }

      if (currentChunk && !isChunkEmpty(currentChunk)) {
        chunks.push(currentChunk);
      }

      if (chunks.length === 0) {
        throw new Error(`Update-file hunk for '${targetPath}' is empty`);
      }

      operations.push({
        kind: "update",
        path: targetPath,
        moveTo,
        chunks,
      });
      continue;
    }

    throw new Error(`Unrecognized patch marker at line ${index + 1}: ${line}`);
  }

  if (operations.length === 0) {
    throw new Error("Patch does not contain any hunks");
  }

  return { operations };
}

export function applyUpdateChunks(
  source: string,
  chunks: ApplyPatchDocument["operations"][number] extends infer T
    ? T extends { kind: "update"; chunks: infer U }
      ? U
      : never
    : never,
): string {
  const normalizedSource = source.replace(/\r\n/g, "\n");
  const hasTrailingNewline = normalizedSource.endsWith("\n");
  const sourceLines = splitTextLines(normalizedSource);
  const output: string[] = [];
  let cursor = 0;

  for (const chunk of chunks) {
    const matchIndex = findChunkStart(sourceLines, chunk, cursor);
    if (matchIndex < 0) {
      const detail =
        chunk.oldLines.length > 0
          ? chunk.oldLines.join("\\n")
          : chunk.changeContext
            ? `context:${chunk.changeContext}`
            : "(empty chunk)";
      throw new Error(`Could not apply patch chunk: ${detail}`);
    }

    output.push(...sourceLines.slice(cursor, matchIndex));
    output.push(...chunk.newLines);
    cursor = matchIndex + chunk.oldLines.length;
  }

  output.push(...sourceLines.slice(cursor));
  return joinTextLines(output, hasTrailingNewline);
}

export function listTouchedPaths(document: ApplyPatchDocument): string[] {
  const touched = new Set<string>();
  for (const operation of document.operations) {
    touched.add(operation.path);
    if (operation.kind === "update" && operation.moveTo) {
      touched.add(operation.moveTo);
    }
  }
  return [...touched].sort((left, right) => left.localeCompare(right));
}

function findChunkStart(
  lines: string[],
  chunk: ApplyPatchChunk,
  fromIndex: number,
): number {
  if (chunk.oldLines.length === 0) {
    if (chunk.isEndOfFile) {
      return lines.length;
    }

    if (chunk.changeContext) {
      const contextIndex = findLine(lines, chunk.changeContext, fromIndex);
      if (contextIndex >= 0) {
        return contextIndex + 1;
      }
    }

    return fromIndex;
  }

  let searchStart = fromIndex;
  if (chunk.changeContext) {
    const contextIndex = findLine(lines, chunk.changeContext, fromIndex);
    if (contextIndex >= 0) {
      searchStart = contextIndex;
    }
  }

  const firstPass = findSubsequence(
    lines,
    chunk.oldLines,
    searchStart,
    chunk.isEndOfFile,
  );
  if (firstPass >= 0) {
    return firstPass;
  }

  if (searchStart !== fromIndex) {
    return findSubsequence(lines, chunk.oldLines, fromIndex, chunk.isEndOfFile);
  }

  return -1;
}

function findLine(lines: string[], target: string, fromIndex: number): number {
  for (let index = fromIndex; index < lines.length; index += 1) {
    if (lines[index] === target) {
      return index;
    }
  }
  return -1;
}

function findSubsequence(
  lines: string[],
  needle: string[],
  fromIndex: number,
  mustEndAtFileEnd: boolean,
): number {
  if (needle.length === 0) {
    return fromIndex;
  }

  const maxIndex = lines.length - needle.length;
  for (let start = fromIndex; start <= maxIndex; start += 1) {
    let matched = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (lines[start + offset] !== needle[offset]) {
        matched = false;
        break;
      }
    }

    if (!matched) {
      continue;
    }

    if (mustEndAtFileEnd && start + needle.length !== lines.length) {
      continue;
    }

    return start;
  }

  return -1;
}

function splitTextLines(text: string): string[] {
  if (text.length === 0) {
    return [];
  }

  const parts = text.split("\n");
  if (parts[parts.length - 1] === "") {
    parts.pop();
  }
  return parts;
}

function joinTextLines(lines: string[], hasTrailingNewline: boolean): string {
  if (lines.length === 0) {
    return hasTrailingNewline ? "\n" : "";
  }

  const text = lines.join("\n");
  return hasTrailingNewline ? `${text}\n` : text;
}

function createEmptyChunk(): ApplyPatchChunk {
  return {
    oldLines: [],
    newLines: [],
    isEndOfFile: false,
  };
}

function isChunkEmpty(chunk: ApplyPatchChunk): boolean {
  return (
    !chunk.changeContext &&
    chunk.oldLines.length === 0 &&
    chunk.newLines.length === 0 &&
    !chunk.isEndOfFile
  );
}

function unwrapPotentialHeredoc(input: string): string {
  const trimmed = input.trim();
  const lines = trimmed.split("\n");
  if (
    lines.length >= 4 &&
    /^<<['"]?EOF['"]?$/.test(lines[0] ?? "") &&
    (lines[lines.length - 1] ?? "").endsWith("EOF")
  ) {
    return lines.slice(1, -1).join("\n");
  }
  return input;
}
