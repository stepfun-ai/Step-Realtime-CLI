import type { Dirent } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { ToolExecutionResult, ToolSpec } from "@step-cli/protocol";
import { clamp } from "@step-cli/utils/math.js";
import {
  resolveExistingPathInWorkspace,
  resolveWritablePathInWorkspace,
} from "@step-cli/utils/path.js";
import {
  parseJsonObject,
  readBooleanField,
  readIntegerField,
  readRequiredStringField,
  readStringField,
} from "@step-cli/core/tools/args.js";
import {
  createReadPathInspection,
  createWritePathInspection,
} from "./tool-inspection.js";
import { applyToolResultTruncationHint } from "./tool-result-truncation.js";

const DEFAULT_LIST_MAX_ENTRIES = 200;
const DEFAULT_READ_MAX_CHARS = 24_000;
const DEFAULT_READ_START = 1;
interface ListDirectoryArgs {
  path?: string;
  max_entries?: number;
  include_hidden?: boolean;
}

interface ReadFileArgs {
  path: string;
  start_line?: number;
  end_line?: number;
  max_chars?: number;
}

interface WriteFileArgs {
  path: string;
  content: string;
}

interface EditFileArgs {
  path: string;
  search: string;
  replace: string;
  replace_all?: boolean;
}

export function createFileTools(): ToolSpec[] {
  return [
    createListDirectoryTool(),
    createReadFileTool(),
    createWriteFileTool(),
    createEditFileTool(),
  ];
}

function createListDirectoryTool(): ToolSpec<ListDirectoryArgs> {
  return {
    definition: {
      type: "function",
      function: {
        name: "list_directory",
        description:
          "List one directory with directories first. Prefer this before recursive shell listing.",
        parameters: {
          type: "object",
          properties: {
            path: {
              type: "string",
              description: "Relative directory path. Defaults to '.'",
            },
            max_entries: {
              type: "integer",
              minimum: 1,
              maximum: 1000,
              description: "Maximum entries to return",
            },
            include_hidden: {
              type: "boolean",
              description: "Include dotfiles and hidden directories",
            },
          },
        },
      },
    },
    security: {
      risk: "read",
      defaultMode: "allow",
    },
    supportsParallel: true,
    parseArgs: (rawArgs) => {
      const payload = parseJsonObject(rawArgs);
      return {
        path: readStringField(payload.path),
        max_entries: readIntegerField(payload.max_entries, "max_entries"),
        include_hidden: readBooleanField(
          payload.include_hidden,
          "include_hidden",
        ),
      };
    },
    inspect: ({ args }) => createReadPathInspection(args.path ?? "."),
    execute: async (args, ctx) => {
      const targetPath = args.path ?? ".";
      const absolute = await resolveExistingPathInWorkspace(
        ctx.workspaceRoot,
        targetPath,
      );
      const entries = await fs.readdir(absolute, { withFileTypes: true });
      const includeHidden = args.include_hidden ?? false;
      const visibleEntries = entries
        .filter((entry) => includeHidden || !entry.name.startsWith("."))
        .sort((left, right) => {
          const leftDir = left.isDirectory();
          const rightDir = right.isDirectory();
          if (leftDir !== rightDir) {
            return leftDir ? -1 : 1;
          }
          return left.name.localeCompare(right.name);
        });

      const maxEntries = clamp(
        args.max_entries ?? DEFAULT_LIST_MAX_ENTRIES,
        1,
        1000,
      );
      const renderedEntries = visibleEntries.slice(0, maxEntries);
      const truncatedCount = Math.max(
        0,
        visibleEntries.length - renderedEntries.length,
      );
      const lines = renderedEntries.map((entry) => renderDirectoryEntry(entry));
      if (truncatedCount > 0) {
        lines.push(`... (${truncatedCount} more entries)`);
      }

      const directoryCount = visibleEntries.filter((entry) =>
        entry.isDirectory(),
      ).length;
      const fileCount = visibleEntries.length - directoryCount;

      return {
        ok: true,
        summary: `Listed ${targetPath} (${renderedEntries.length}/${visibleEntries.length} entries)`,
        content: lines.join("\n") || "(empty directory)",
        data: {
          path: targetPath,
          returnedEntries: renderedEntries.length,
          totalEntries: visibleEntries.length,
          directories: directoryCount,
          files: fileCount,
          truncated: truncatedCount > 0,
        },
      };
    },
  };
}

function createReadFileTool(): ToolSpec<ReadFileArgs> {
  return {
    definition: {
      type: "function",
      function: {
        name: "read_file",
        description:
          "Read a text file with optional line range. Prefer this over shell cat for token efficiency.",
        parameters: {
          type: "object",
          required: ["path"],
          properties: {
            path: { type: "string", description: "Relative file path" },
            start_line: {
              type: "integer",
              minimum: 1,
              description: "1-based start line",
            },
            end_line: {
              type: "integer",
              minimum: 1,
              description: "1-based end line",
            },
            max_chars: {
              type: "integer",
              minimum: 200,
              maximum: 120000,
              description: "Max returned characters",
            },
          },
        },
      },
    },
    security: {
      risk: "read",
      defaultMode: "allow",
    },
    supportsParallel: true,
    parseArgs: (rawArgs) => {
      const payload = parseJsonObject(rawArgs);
      return {
        path: readRequiredStringField(payload.path, "path"),
        start_line: readIntegerField(payload.start_line, "start_line"),
        end_line: readIntegerField(payload.end_line, "end_line"),
        max_chars: readIntegerField(payload.max_chars, "max_chars"),
      };
    },
    inspect: ({ args }) => createReadPathInspection(args.path),
    execute: async (args, ctx) => {
      const absolute = await resolveExistingPathInWorkspace(
        ctx.workspaceRoot,
        args.path,
      );
      const content = await fs.readFile(absolute, "utf8");
      const lines = content.split(/\r?\n/);

      const startLine = Math.max(
        DEFAULT_READ_START,
        args.start_line ?? DEFAULT_READ_START,
      );
      const inclusiveEnd = Math.min(
        lines.length,
        Math.max(startLine, args.end_line ?? lines.length),
      );

      const sliced = lines.slice(startLine - 1, inclusiveEnd);
      const rendered = sliced
        .map((line, index) => `${startLine + index}: ${line}`)
        .join("\n");

      const maxChars = clamp(
        args.max_chars ?? DEFAULT_READ_MAX_CHARS,
        200,
        Math.max(200, ctx.commandOutputLimit * 2),
      );
      const resultContent = applyToolResultTruncationHint({
        toolName: "read_file",
        summary: `Read ${args.path} lines ${startLine}-${inclusiveEnd} (${sliced.length} lines)`,
        content: rendered,
        maxChars,
      });

      return {
        ok: true,
        summary: resultContent.summary,
        content: resultContent.content,
        truncation: resultContent.truncation,
        data: {
          path: args.path,
          startLine,
          endLine: inclusiveEnd,
          selectedLines: sliced.length,
          totalLines: lines.length,
        },
      };
    },
  };
}

function createWriteFileTool(): ToolSpec<WriteFileArgs> {
  return {
    definition: {
      type: "function",
      function: {
        name: "write_file",
        description:
          "Write full content to a file. Creates parent directories if missing.",
        parameters: {
          type: "object",
          required: ["path", "content"],
          properties: {
            path: { type: "string", description: "Relative file path" },
            content: { type: "string", description: "Full file content" },
          },
        },
      },
    },
    security: {
      risk: "write",
      defaultMode: "confirm",
    },
    parseArgs: (rawArgs) => {
      const payload = parseJsonObject(rawArgs);
      return {
        path: readRequiredStringField(payload.path, "path"),
        content: readRequiredStringField(payload.content, "content"),
      };
    },
    inspect: ({ args }) => createWritePathInspection(args.path, "write"),
    execute: async (args, ctx) => {
      const absolute = await resolveWritablePathInWorkspace(
        ctx.workspaceRoot,
        args.path,
      );
      await fs.mkdir(path.dirname(absolute), { recursive: true });
      await fs.writeFile(absolute, args.content, "utf8");
      const contentPreview = buildFilePreview(args.content);

      return {
        ok: true,
        summary: `Wrote ${args.content.length} chars to ${args.path}`,
        data: {
          path: args.path,
          bytesWritten: Buffer.byteLength(args.content, "utf8"),
          charsWritten: args.content.length,
          contentPreview,
        },
      };
    },
  };
}

function createEditFileTool(): ToolSpec<EditFileArgs> {
  return {
    definition: {
      type: "function",
      function: {
        name: "edit_file",
        description: "Edit file content by literal search/replace.",
        parameters: {
          type: "object",
          required: ["path", "search", "replace"],
          properties: {
            path: { type: "string", description: "Relative file path" },
            search: { type: "string", description: "Literal string to find" },
            replace: { type: "string", description: "Replacement string" },
            replace_all: {
              type: "boolean",
              description: "Replace all matches",
            },
          },
        },
      },
    },
    security: {
      risk: "write",
      defaultMode: "confirm",
    },
    parseArgs: (rawArgs) => {
      const payload = parseJsonObject(rawArgs);
      return {
        path: readRequiredStringField(payload.path, "path"),
        search: readRequiredStringField(payload.search, "search"),
        replace: readRequiredStringField(payload.replace, "replace"),
        replace_all: readBooleanField(payload.replace_all, "replace_all"),
      };
    },
    inspect: ({ args }) => createWritePathInspection(args.path, "edit"),
    execute: async (args, ctx) => {
      if (args.search.length === 0) {
        return {
          ok: false,
          summary: "search must not be empty",
          error: {
            code: "INVALID_ARGUMENT",
            message: "search must not be empty",
          },
        };
      }

      const absolute = await resolveExistingPathInWorkspace(
        ctx.workspaceRoot,
        args.path,
      );
      const original = await fs.readFile(absolute, "utf8");
      const occurrences = countOccurrences(original, args.search);

      if (occurrences === 0) {
        return {
          ok: false,
          summary: `No matches for search string in ${args.path}`,
          data: {
            path: args.path,
            replacedCount: 0,
          },
        };
      }

      const replaceAll = args.replace_all ?? false;
      const updated = replaceAll
        ? original.split(args.search).join(args.replace)
        : original.replace(args.search, args.replace);
      const replacedCount = replaceAll ? occurrences : 1;

      await fs.writeFile(absolute, updated, "utf8");

      const beforePreview = buildFilePreview(args.search);
      const afterPreview = buildFilePreview(args.replace);

      return {
        ok: true,
        summary: `Updated ${args.path}, replaced ${replacedCount} occurrence(s)`,
        content: `search:\n${beforePreview}\n\nreplace:\n${afterPreview}`,
        data: {
          path: args.path,
          replacedCount,
          replaceAll,
          searchPreview: beforePreview,
          replacePreview: afterPreview,
        },
      };
    },
  };
}

function countOccurrences(text: string, needle: string): number {
  let count = 0;
  let start = 0;

  while (true) {
    const index = text.indexOf(needle, start);
    if (index < 0) {
      return count;
    }
    count += 1;
    start = index + needle.length;
  }
}

function renderDirectoryEntry(entry: Dirent): string {
  if (entry.isDirectory()) {
    return `dir  ${entry.name}/`;
  }
  if (entry.isSymbolicLink()) {
    return `link ${entry.name}@`;
  }
  return `file ${entry.name}`;
}

function buildFilePreview(text: string): string {
  return text;
}

export function renderToolResultSummary(result: ToolExecutionResult): string {
  return `${result.ok ? "ok" : "error"}: ${result.summary}`;
}
