import { promises as fs } from "node:fs";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import path from "node:path";
import type {
  JsonSchema,
  OpenAIToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolSpec,
} from "@step-cli/protocol";
import {
  asObject,
  optionalBoolean,
  optionalNumber,
  requireString,
  ToolArgError,
} from "./parsers.js";

interface ReadArgs {
  file_path: string;
  offset?: number;
  limit?: number;
}

interface WriteArgs {
  file_path: string;
  content: string;
}

interface EditArgs {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

const READ_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    file_path: { type: "string" },
    offset: { type: "number" },
    limit: { type: "number" },
  },
  required: ["file_path"],
  additionalProperties: false,
};

const WRITE_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    file_path: { type: "string" },
    content: { type: "string" },
  },
  required: ["file_path", "content"],
  additionalProperties: false,
};

const EDIT_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    file_path: { type: "string" },
    old_string: { type: "string" },
    new_string: { type: "string" },
    replace_all: { type: "boolean" },
  },
  required: ["file_path", "old_string", "new_string"],
  additionalProperties: false,
};

export function buildReadTool(): ToolSpec<ReadArgs> {
  const definition: OpenAIToolDefinition = {
    type: "function",
    function: {
      name: "Read",
      description: "Read a UTF-8 text file. Optional offset/limit (1-based).",
      parameters: READ_SCHEMA,
    },
  };
  return {
    definition,
    security: { risk: "read", defaultMode: "allow" },
    parseArgs: (raw) => parseReadArgs(raw),
    execute: async (args, ctx) => readFileExecute(args, ctx),
  };
}

export function buildWriteTool(): ToolSpec<WriteArgs> {
  const definition: OpenAIToolDefinition = {
    type: "function",
    function: {
      name: "Write",
      description:
        "Write UTF-8 text to a file (creates parent dirs as needed).",
      parameters: WRITE_SCHEMA,
    },
  };
  return {
    definition,
    security: { risk: "write", defaultMode: "allow" },
    parseArgs: (raw) => parseWriteArgs(raw),
    execute: async (args, ctx) => writeFileExecute(args, ctx),
  };
}

export function buildEditTool(): ToolSpec<EditArgs> {
  const definition: OpenAIToolDefinition = {
    type: "function",
    function: {
      name: "Edit",
      description:
        "Replace old_string with new_string in a file. old_string must be unique unless replace_all is true.",
      parameters: EDIT_SCHEMA,
    },
  };
  return {
    definition,
    security: { risk: "write", defaultMode: "allow" },
    parseArgs: (raw) => parseEditArgs(raw),
    execute: async (args, ctx) => editFileExecute(args, ctx),
  };
}

function parseReadArgs(rawArgs: string): ReadArgs {
  const obj = asObject(safeParse(rawArgs), "Read");
  return {
    file_path: requireString(obj, "file_path", "Read"),
    offset: optionalNumber(obj, "offset"),
    limit: optionalNumber(obj, "limit"),
  };
}

function parseWriteArgs(rawArgs: string): WriteArgs {
  const obj = asObject(safeParse(rawArgs), "Write");
  const content = obj.content;
  if (typeof content !== "string") {
    throw new ToolArgError(`Write: required string field "content" is missing`);
  }
  return {
    file_path: requireString(obj, "file_path", "Write"),
    content,
  };
}

function parseEditArgs(rawArgs: string): EditArgs {
  const obj = asObject(safeParse(rawArgs), "Edit");
  return {
    file_path: requireString(obj, "file_path", "Edit"),
    old_string: requireString(obj, "old_string", "Edit"),
    new_string: typeof obj.new_string === "string" ? obj.new_string : "",
    replace_all: optionalBoolean(obj, "replace_all"),
  };
}

function safeParse(rawArgs: string): unknown {
  if (!rawArgs?.trim()) return {};
  return JSON.parse(rawArgs);
}

async function readFileExecute(
  args: ReadArgs,
  ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const rejected = rejectWindowsPathOnPosix("Read", args.file_path);
  if (rejected) return rejected;
  const absolute = resolveWorkspacePath(ctx.workspaceRoot, args.file_path);
  const offset = Math.max(1, args.offset ?? 1);
  const limit = args.limit !== undefined && args.limit > 0 ? args.limit : null;
  try {
    return await readSlice(absolute, offset, limit);
  } catch (error) {
    return failed("Read", absolute, error);
  }
}

async function writeFileExecute(
  args: WriteArgs,
  ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const rejected = rejectWindowsPathOnPosix("Write", args.file_path);
  if (rejected) return rejected;
  const absolute = resolveWorkspacePath(ctx.workspaceRoot, args.file_path);
  await fs.mkdir(path.dirname(absolute), { recursive: true });
  await fs.writeFile(absolute, args.content, "utf8");
  return { ok: true, summary: `Wrote ${absolute}` };
}

async function editFileExecute(
  args: EditArgs,
  ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const rejected = rejectWindowsPathOnPosix("Edit", args.file_path);
  if (rejected) return rejected;
  const absolute = resolveWorkspacePath(ctx.workspaceRoot, args.file_path);
  let original: string;
  try {
    original = await fs.readFile(absolute, "utf8");
  } catch (error) {
    return failed("Edit", absolute, error);
  }
  let updated: string;
  if (args.replace_all) {
    updated = original.split(args.old_string).join(args.new_string);
    if (updated === original) {
      return {
        ok: false,
        summary: `old_string not found in ${absolute}`,
        error: { code: "NO_MATCH", message: "no occurrences" },
      };
    }
  } else {
    const first = original.indexOf(args.old_string);
    if (first === -1) {
      return {
        ok: false,
        summary: `old_string not found in ${absolute}`,
        error: { code: "NO_MATCH", message: "no occurrences" },
      };
    }
    const second = original.indexOf(args.old_string, first + 1);
    if (second !== -1) {
      return {
        ok: false,
        summary: `old_string is not unique in ${absolute} (multiple matches). Pass replace_all:true to replace every occurrence.`,
        error: { code: "AMBIGUOUS_MATCH", message: "not unique" },
      };
    }
    updated =
      original.slice(0, first) +
      args.new_string +
      original.slice(first + args.old_string.length);
  }
  await fs.writeFile(absolute, updated, "utf8");
  return { ok: true, summary: `Patched ${absolute}` };
}

/**
 * Stream the file via readline so a 50MB log with limit=100 doesn't allocate
 * the whole string. We bail out as soon as we've collected `limit` lines after
 * the offset, then close the stream.
 */
async function readSlice(
  absolute: string,
  offset: number,
  limit: number | null,
): Promise<ToolExecutionResult> {
  const stream = createReadStream(absolute, { encoding: "utf8" });
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  const collected: string[] = [];
  let lineNo = 0;
  try {
    for await (const line of reader) {
      lineNo += 1;
      if (lineNo < offset) continue;
      collected.push(`${lineNo}\t${line}`);
      if (limit !== null && collected.length >= limit) break;
    }
  } catch (error) {
    return failed("Read", absolute, error);
  } finally {
    stream.close();
    reader.close();
  }
  return { ok: true, summary: collected.join("\n") };
}

function resolveWorkspacePath(
  workspaceRoot: string,
  candidate: string,
): string {
  return path.isAbsolute(candidate)
    ? candidate
    : path.resolve(workspaceRoot, candidate);
}

const WINDOWS_DRIVE_PATH = /^[A-Za-z]:[\\/]/;

function rejectWindowsPathOnPosix(
  tool: "Read" | "Write" | "Edit",
  candidate: string,
): ToolExecutionResult | null {
  if (process.platform === "win32") return null;
  if (!WINDOWS_DRIVE_PATH.test(candidate)) return null;
  const summary =
    `${tool} rejected: file_path "${candidate}" looks like a Windows path, ` +
    `but the host platform is ${process.platform}. ` +
    `Use a POSIX path (absolute starting with "/" or relative to cwd) instead.`;
  return {
    ok: false,
    summary,
    error: { code: "INVALID_PATH", message: summary },
  };
}

function failed(
  toolName: string,
  target: string,
  error: unknown,
): ToolExecutionResult {
  if ((error as NodeJS.ErrnoException)?.code === "EISDIR") {
    return {
      ok: false,
      summary: `Path is a directory, not a file: ${target}`,
      error: { code: "IS_DIRECTORY", message: "expected file" },
    };
  }
  return {
    ok: false,
    summary: `${toolName} failed for ${target}: ${
      error instanceof Error ? error.message : String(error)
    }`,
    error: {
      code: (error as { code?: string } | undefined)?.code ?? "TOOL_FAILED",
      message: error instanceof Error ? error.message : String(error),
    },
  };
}
