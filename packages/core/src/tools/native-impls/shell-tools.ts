import { promises as fs } from "node:fs";
import { spawn } from "node:child_process";
import path from "node:path";
import type {
  JsonSchema,
  OpenAIToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolSpec,
} from "@step-cli/protocol";
import { runShell } from "@step-cli/utils/shell.js";
import {
  asObject,
  optionalNumber,
  optionalString,
  requireString,
  ToolArgError,
} from "./parsers.js";

const SKIP_DIRECTORY_NAMES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  ".turbo",
  ".next",
  ".cache",
  "target",
  "out",
]);

const JSGREP_MAX_FILE_BYTES = 2 * 1024 * 1024; // 2MB binary/large guard
const JSGREP_BINARY_PROBE_BYTES = 8 * 1024;
const WALKDIR_PARALLEL_FANOUT = 16;

interface BashArgs {
  command: string;
  timeout?: number;
}

interface GlobArgs {
  pattern: string;
  path?: string;
}

interface GrepArgs {
  pattern: string;
  path?: string;
  include?: string;
}

const BASH_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    command: { type: "string" },
    timeout: { type: "number" },
  },
  required: ["command"],
  additionalProperties: false,
};

const GLOB_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    pattern: { type: "string" },
    path: { type: "string" },
  },
  required: ["pattern"],
  additionalProperties: false,
};

const GREP_SCHEMA: JsonSchema = {
  type: "object",
  properties: {
    pattern: { type: "string" },
    path: { type: "string" },
    include: { type: "string" },
    output_mode: { type: "string" },
  },
  required: ["pattern"],
  additionalProperties: false,
};

export function buildBashTool(): ToolSpec<BashArgs> {
  const definition: OpenAIToolDefinition = {
    type: "function",
    function: {
      name: "Bash",
      description: "Run a shell command in the workspace root.",
      parameters: BASH_SCHEMA,
    },
  };
  return {
    definition,
    security: { risk: "execute", defaultMode: "allow" },
    parseArgs: (raw) => parseBashArgs(raw),
    execute: async (args, ctx) => bashExecute(args, ctx),
  };
}

export function buildGlobTool(): ToolSpec<GlobArgs> {
  const definition: OpenAIToolDefinition = {
    type: "function",
    function: {
      name: "Glob",
      description:
        "Find files in the workspace by glob pattern. Returns absolute paths.",
      parameters: GLOB_SCHEMA,
    },
  };
  return {
    definition,
    security: { risk: "read", defaultMode: "allow" },
    parseArgs: (raw) => parseGlobArgs(raw),
    execute: async (args, ctx) => globExecute(args, ctx),
  };
}

export function buildGrepTool(): ToolSpec<GrepArgs> {
  const definition: OpenAIToolDefinition = {
    type: "function",
    function: {
      name: "Grep",
      description:
        "Search file contents with a regex. Prefers ripgrep; falls back to a JS walker.",
      parameters: GREP_SCHEMA,
    },
  };
  return {
    definition,
    security: { risk: "read", defaultMode: "allow" },
    parseArgs: (raw) => parseGrepArgs(raw),
    execute: async (args, ctx) => grepExecute(args, ctx),
  };
}

function parseBashArgs(rawArgs: string): BashArgs {
  const obj = asObject(safeParse(rawArgs), "Bash");
  return {
    command: requireString(obj, "command", "Bash"),
    timeout: optionalNumber(obj, "timeout"),
  };
}

function parseGlobArgs(rawArgs: string): GlobArgs {
  const obj = asObject(safeParse(rawArgs), "Glob");
  return {
    pattern: requireString(obj, "pattern", "Glob"),
    path: optionalString(obj, "path"),
  };
}

function parseGrepArgs(rawArgs: string): GrepArgs {
  const obj = asObject(safeParse(rawArgs), "Grep");
  return {
    pattern: requireString(obj, "pattern", "Grep"),
    path: optionalString(obj, "path"),
    include: optionalString(obj, "include"),
  };
}

function safeParse(rawArgs: string): unknown {
  if (!rawArgs?.trim()) return {};
  return JSON.parse(rawArgs);
}

const DANGEROUS_COMMAND_PATTERNS = [
  /(^|\s|\||;|&&)rm\s+(-rf?|--recursive)\s+\/(\s|$)/,
  /(^|\s|\||;|&&)rm\s+(-rf?|--recursive)\s+~(\s|$|\/)/,
  /(^|\s|\||;|&&)dd\s+/,
  /(^|\s|\||;|&&)mkfs\.\w+/,
  /(^|\s|\||;|&&)fdisk\s+/,
  /(^|\s|\||;|&&)mkswap\s+/,
  /(^|\s|\||;|&&)shutdown\s+/,
  /(^|\s|\||;|&&)reboot\s+/,
  /(^|\s|\||;|&&)chmod\s+777\s+\//,
  /(^|\s|\||;|&&)chown\s+/,
  /(^|\s|\||;|&&)>(\s*\/dev\/(sda|sdb|nvme|mmc))/,
];

function validateShellCommand(command: string): ToolExecutionResult | null {
  for (const pattern of DANGEROUS_COMMAND_PATTERNS) {
    if (pattern.test(command)) {
      const summary =
        `Bash: command blocked for safety — pattern matched by security guardrail. ` +
        `If this is a legitimate operation, consider using a more targeted tool or ` +
        `command. Matched pattern: ${pattern}`;
      return {
        ok: false,
        summary,
        error: { code: "COMMAND_BLOCKED", message: summary },
      };
    }
  }
  return null;
}

async function bashExecute(
  args: BashArgs,
  ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const blocked = validateShellCommand(args.command);
  if (blocked) return blocked;
  const timeoutMs = args.timeout ?? ctx.commandTimeoutMs;
  const result = await runShell(args.command, {
    cwd: ctx.workspaceRoot,
    timeoutMs,
    outputLimit: ctx.commandOutputLimit,
    signal: ctx.signal,
  });
  const merged = (
    result.stdout + (result.stderr ? `\n${result.stderr}` : "")
  ).trim();
  if (result.timedOut) {
    return {
      ok: false,
      summary: `Command timed out after ${timeoutMs}ms\n${merged}`,
      error: { code: "TIMEOUT", message: "command timed out" },
    };
  }
  if (result.interrupted) {
    return {
      ok: false,
      summary: `Command interrupted\n${merged}`,
      error: { code: "INTERRUPTED", message: "command interrupted" },
    };
  }
  if (result.exitCode !== 0) {
    return {
      ok: false,
      summary: `Command exited with code ${result.exitCode}\n${merged}`,
      error: { code: "NONZERO_EXIT", message: `exit ${result.exitCode}` },
    };
  }
  return { ok: true, summary: merged };
}

async function globExecute(
  args: GlobArgs,
  ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const base = args.path
    ? resolveWorkspacePath(ctx.workspaceRoot, args.path)
    : ctx.workspaceRoot;
  const regex = globToRegex(args.pattern);
  const matches: string[] = [];
  await walkDir(base, async (filePath) => {
    const rel = path.relative(ctx.workspaceRoot, filePath);
    if (regex.test(rel)) matches.push(filePath);
  });
  matches.sort();
  return {
    ok: true,
    summary: matches.length === 0 ? "(no matches)" : matches.join("\n"),
  };
}

async function grepExecute(
  args: GrepArgs,
  ctx: ToolExecutionContext,
): Promise<ToolExecutionResult> {
  const base = args.path
    ? resolveWorkspacePath(ctx.workspaceRoot, args.path)
    : ctx.workspaceRoot;
  const rg = await runRipgrep(args.pattern, base, args.include);
  if (rg !== null) return { ok: true, summary: rg };
  const fallback = await jsGrep(args.pattern, base, args.include);
  return { ok: true, summary: fallback };
}

/**
 * Parallel walker with bounded fan-out. Sibling directories are explored
 * concurrently (5-10× speedup over sequential await) but we cap concurrent
 * children per directory at WALKDIR_PARALLEL_FANOUT so we don't exhaust FDs
 * on deep trees.
 */
async function walkDir(
  dir: string,
  visit: (filePath: string) => Promise<void> | void,
): Promise<void> {
  let entries: import("node:fs").Dirent[];
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  const dirs: string[] = [];
  const files: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIRECTORY_NAMES.has(entry.name)) continue;
      dirs.push(path.join(dir, entry.name));
    } else if (entry.isFile()) {
      files.push(path.join(dir, entry.name));
    }
  }
  for (const file of files) await visit(file);
  for (let i = 0; i < dirs.length; i += WALKDIR_PARALLEL_FANOUT) {
    const slice = dirs.slice(i, i + WALKDIR_PARALLEL_FANOUT);
    await Promise.all(slice.map((child) => walkDir(child, visit)));
  }
}

function globToRegex(pattern: string): RegExp {
  let regex = "";
  let i = 0;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === "*") {
      if (pattern[i + 1] === "*") {
        regex += ".*";
        i += 2;
      } else {
        regex += "[^/]*";
        i += 1;
      }
      continue;
    }
    if (ch === "?") {
      regex += "[^/]";
      i += 1;
      continue;
    }
    if (/[.+^${}()|[\]\\]/.test(ch ?? "")) {
      regex += `\\${ch}`;
    } else {
      regex += ch;
    }
    i += 1;
  }
  return new RegExp(`^${regex}$`);
}

async function runRipgrep(
  pattern: string,
  cwd: string,
  include?: string,
): Promise<string | null> {
  return new Promise((resolve) => {
    const args = ["--line-number", "--no-heading", "--with-filename", pattern];
    if (include) args.push("--glob", include);
    args.push(cwd);
    let stdout = "";
    let stderr = "";
    let child;
    try {
      child = spawn("rg", args);
    } catch {
      resolve(null);
      return;
    }
    child.stdout?.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", () => resolve(null));
    child.on("close", (code) => {
      if (code === 0 || code === 1) {
        resolve(stdout.trim());
        return;
      }
      if (stderr) resolve(stderr.trim());
      resolve(null);
    });
  });
}

const REDOS_PATTERNS = [
  /\(\S+(?:\+\+|\*+|\+\?|\*\?)+\S*\)\s*[+*]/,
  /\(\S*(?:\|.*){2,}\)\s*[+*]/,
  /\((?:\w|\|){2,}\)\s*\+/,
  /\(.*\)\s*\{\d+,\}/,
];

function hasRedosRisk(pattern: string): boolean {
  for (const re of REDOS_PATTERNS) {
    if (re.test(pattern)) return true;
  }
  return false;
}

function createSafeRegex(pattern: string): RegExp | null {
  try {
    if (hasRedosRisk(pattern)) return null;
    return new RegExp(pattern);
  } catch {
    return null;
  }
}

/**
 * Pure-JS regex grep used when ripgrep is unavailable. Skips files larger
 * than JSGREP_MAX_FILE_BYTES and sniffs the first 8KB for a NUL byte so a
 * 100MB binary doesn't block the scan or balloon RSS.
 */
async function jsGrep(
  pattern: string,
  base: string,
  include?: string,
): Promise<string> {
  const regex = createSafeRegex(pattern);
  if (!regex) {
    return `(pattern skipped — could not compile or ReDoS guardrail triggered)`;
  }
  const includeRegex = include ? globToRegex(include) : null;
  const out: string[] = [];
  await walkDir(base, async (file) => {
    if (includeRegex) {
      const rel = path.relative(base, file);
      if (!includeRegex.test(rel)) return;
    }
    let stat: import("node:fs").Stats;
    try {
      stat = await fs.stat(file);
    } catch {
      return;
    }
    if (stat.size > JSGREP_MAX_FILE_BYTES) return;
    if (await looksBinary(file)) return;
    let body: string;
    try {
      body = await fs.readFile(file, "utf8");
    } catch {
      return;
    }
    const lines = body.split("\n");
    for (let i = 0; i < lines.length; i += 1) {
      if (regex.test(lines[i] ?? "")) {
        out.push(`${file}:${i + 1}:${lines[i]}`);
      }
    }
  });
  return out.length === 0 ? "(no matches)" : out.join("\n");
}

async function looksBinary(file: string): Promise<boolean> {
  let handle: import("node:fs/promises").FileHandle | undefined;
  try {
    handle = await fs.open(file, "r");
    const buffer = Buffer.alloc(JSGREP_BINARY_PROBE_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    for (let i = 0; i < bytesRead; i += 1) {
      if (buffer[i] === 0) return true;
    }
    return false;
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function resolveWorkspacePath(
  workspaceRoot: string,
  candidate: string,
): string {
  const resolved = path.isAbsolute(candidate)
    ? candidate
    : path.resolve(workspaceRoot, candidate);
  const normalized = path.resolve(resolved);
  if (!normalized.startsWith(path.resolve(workspaceRoot))) {
    throw new ToolArgError(
      `Path "${candidate}" resolves outside the workspace root "${workspaceRoot}"`,
    );
  }
  return normalized;
}
