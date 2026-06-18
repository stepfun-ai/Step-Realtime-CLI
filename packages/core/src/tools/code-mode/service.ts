import { randomUUID } from "node:crypto";
import { inspect } from "node:util";
import vm from "node:vm";
import type {
  CodeModeToolBinding,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolRuntimeApi,
} from "@step-cli/protocol";
import { truncateText } from "@step-cli/utils/text.js";

const CODE_MODE_PRAGMA_PREFIX = "// @exec:";
const DEFAULT_EXEC_YIELD_TIME_MS = 10_000;
const DEFAULT_WAIT_YIELD_TIME_MS = 10_000;
const MAX_JS_SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const MAX_RENDER_CHARS = 120_000;
const MIN_RENDER_CHARS = 200;
const RUNTIME_BOOT_TIMEOUT_MS = 1_000;

type CellStatus = "running" | "completed" | "failed" | "terminated";

interface NestedToolCall {
  toolName: string;
  identifier: string;
  ok: boolean;
  summary: string;
  /** Short hint about the input (e.g. the command run, file read, query searched) */
  inputHint?: string;
  /** Affected file paths extracted from tool inspection metadata. */
  paths?: string[];
  /** Per-file operation details for write tools (e.g. "update src/foo.ts"). */
  fileOps?: string[];
}

interface ParsedExecInput {
  code: string;
  yieldTimeMs: number;
  maxOutputTokens?: number;
}

type CodeModeNestedTools = Record<
  string,
  (args: unknown) => Promise<ToolExecutionResult>
>;

interface CodeModeSandbox {
  console: Console;
  tools: CodeModeNestedTools;
  state: Record<string, unknown>;
  self: Record<string, unknown>;
  setTimeout: typeof setTimeout;
  clearTimeout: typeof clearTimeout;
  setInterval: typeof setInterval;
  clearInterval: typeof clearInterval;
  AbortController: typeof AbortController;
  URL: typeof URL;
  URLSearchParams: typeof URLSearchParams;
  TextEncoder: typeof TextEncoder;
  TextDecoder: typeof TextDecoder;
}

interface RunningCell {
  id: string;
  startedAt: number;
  code: string;
  abortController: AbortController;
  consoleLines: string[];
  status: CellStatus;
  result?: unknown;
  nestedCalls: NestedToolCall[];
  errorText?: string;
  maxOutputTokens?: number;
  completion: Promise<void>;
}

interface SerializableCodeModeState {
  version: 1;
  nextCellId: number;
  state: Record<string, unknown>;
}

interface WaitOptions {
  cellId: string;
  yieldTimeMs?: number;
  maxTokens?: number;
  terminate?: boolean;
}

export class CodeModeService {
  private readonly storedState: Record<string, unknown> = {};
  private readonly runningCells = new Map<string, RunningCell>();
  private nextCellId = 1;

  async execute(
    code: string,
    ctx: ToolExecutionContext,
    runtime: ToolRuntimeApi,
  ): Promise<ToolExecutionResult> {
    const parsed = parseExecInput(code);
    const cell = this.startCell(parsed, runtime);

    const abortCurrentCell = (): void => {
      this.terminateCell(cell, "terminated by caller");
    };

    const removeAbortListener = bindAbortTermination(
      ctx.signal,
      abortCurrentCell,
    );
    try {
      const completed = await waitForSettlement(
        cell,
        parsed.yieldTimeMs,
        ctx.signal,
      );
      if (!completed) {
        this.runningCells.set(cell.id, cell);
        return renderCellResult({
          cell,
          status: "running",
          commandOutputLimit: ctx.commandOutputLimit,
          maxTokens: parsed.maxOutputTokens,
        });
      }

      this.runningCells.delete(cell.id);
      return renderCellResult({
        cell,
        status: cell.status,
        commandOutputLimit: ctx.commandOutputLimit,
        maxTokens: parsed.maxOutputTokens,
      });
    } finally {
      removeAbortListener();
    }
  }

  async wait(
    input: WaitOptions,
    ctx: ToolExecutionContext,
  ): Promise<ToolExecutionResult> {
    const cell = this.runningCells.get(input.cellId);
    if (!cell) {
      return {
        ok: false,
        summary: `Unknown exec cell '${input.cellId}'`,
        error: {
          code: "UNKNOWN_CELL",
          message: `Cell '${input.cellId}' is not running`,
        },
      };
    }

    if (input.terminate) {
      this.terminateCell(cell, "terminated by wait");
      this.runningCells.delete(cell.id);
      return renderCellResult({
        cell,
        status: "terminated",
        commandOutputLimit: ctx.commandOutputLimit,
        maxTokens: input.maxTokens,
      });
    }

    const yieldTimeMs = normalizeYieldTimeMs(
      input.yieldTimeMs,
      DEFAULT_WAIT_YIELD_TIME_MS,
    );
    const abortCurrentCell = (): void => {
      this.terminateCell(cell, "terminated by caller");
    };

    const removeAbortListener = bindAbortTermination(
      ctx.signal,
      abortCurrentCell,
    );
    try {
      const completed = await waitForSettlement(cell, yieldTimeMs, ctx.signal);
      if (!completed) {
        return renderCellResult({
          cell,
          status: "running",
          commandOutputLimit: ctx.commandOutputLimit,
          maxTokens: input.maxTokens,
        });
      }

      this.runningCells.delete(cell.id);
      return renderCellResult({
        cell,
        status: cell.status,
        commandOutputLimit: ctx.commandOutputLimit,
        maxTokens: input.maxTokens,
      });
    } finally {
      removeAbortListener();
    }
  }

  interruptAll(): number {
    const active = [...this.runningCells.values()];
    for (const cell of active) {
      this.terminateCell(cell, "interrupted by user");
      this.runningCells.delete(cell.id);
    }
    return active.length;
  }

  shutdown(reason = "shutdown"): void {
    for (const cell of this.runningCells.values()) {
      this.terminateCell(cell, reason);
    }
    this.runningCells.clear();
  }

  exportState(): SerializableCodeModeState {
    return {
      version: 1,
      nextCellId: this.nextCellId,
      state: toSerializableRecord(this.storedState),
    };
  }

  loadState(state: unknown): void {
    this.shutdown("state reloaded");
    for (const key of Object.keys(this.storedState)) {
      delete this.storedState[key];
    }
    this.nextCellId = 1;

    if (!state || typeof state !== "object") {
      return;
    }

    const candidate = state as Partial<SerializableCodeModeState>;
    if (candidate.version !== 1) {
      return;
    }

    if (
      typeof candidate.nextCellId === "number" &&
      Number.isInteger(candidate.nextCellId) &&
      candidate.nextCellId > 0
    ) {
      this.nextCellId = candidate.nextCellId;
    }

    if (
      candidate.state &&
      typeof candidate.state === "object" &&
      !Array.isArray(candidate.state)
    ) {
      Object.assign(
        this.storedState,
        toSerializableRecord(candidate.state as Record<string, unknown>),
      );
    }
  }

  private startCell(
    input: ParsedExecInput,
    runtime: ToolRuntimeApi,
  ): RunningCell {
    const cellId = `cell-${this.nextCellId}-${randomUUID().slice(0, 6)}`;
    this.nextCellId += 1;
    const abortController = new AbortController();
    const consoleLines: string[] = [];
    const cell: RunningCell = {
      id: cellId,
      startedAt: Date.now(),
      code: input.code,
      abortController,
      consoleLines,
      status: "running",
      nestedCalls: [],
      maxOutputTokens: input.maxOutputTokens,
      completion: Promise.resolve(),
    };

    const bindings = runtime.getCodeModeToolBindings();
    const tools = createToolBindings(
      bindings,
      runtime,
      cell,
      abortController.signal,
    );
    const consoleObject = createConsoleCapture(consoleLines);
    const sandbox: CodeModeSandbox = {
      console: consoleObject,
      tools,
      state: this.storedState,
      self: {},
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      AbortController,
      URL,
      URLSearchParams,
      TextEncoder,
      TextDecoder,
    };
    // Compatibility shim for stale Code Mode snippets that still call
    // self.arguments() to discover the nested tool bindings.
    sandbox.self = createLegacySelfCompat(sandbox, tools);

    const context = vm.createContext(sandbox);
    const script = new vm.Script(`(async () => {\n${input.code}\n})()`, {
      filename: `${cell.id}.exec.js`,
    });

    const execution = Promise.resolve()
      .then(() =>
        script.runInContext(context, { timeout: RUNTIME_BOOT_TIMEOUT_MS }),
      )
      .then((value) => {
        if (cell.status !== "terminated") {
          cell.status = "completed";
          cell.result = value;
        }
      })
      .catch((error) => {
        if (cell.status !== "terminated") {
          cell.status = "failed";
          cell.errorText =
            error instanceof Error
              ? error.stack || error.message
              : String(error);
        }
      });

    cell.completion = execution;
    return cell;
  }

  private terminateCell(cell: RunningCell, reason: string): void {
    if (
      cell.status === "completed" ||
      cell.status === "failed" ||
      cell.status === "terminated"
    ) {
      return;
    }

    cell.status = "terminated";
    cell.errorText = reason;
    cell.abortController.abort(reason);
  }
}

function createToolBindings(
  bindings: CodeModeToolBinding[],
  runtime: ToolRuntimeApi,
  cell: RunningCell,
  signal: AbortSignal,
): CodeModeNestedTools {
  const tools: CodeModeNestedTools = {};

  for (const binding of bindings) {
    tools[binding.identifier] = async (args: unknown) => {
      const rawArgs = stringifyNestedArgs(args);
      const result = await runtime.executeNestedTool(
        binding.toolName,
        rawArgs,
        { signal },
      );
      const inspection = runtime.inspectTool(binding.toolName, rawArgs, {
        result,
      });
      const call: NestedToolCall = {
        toolName: binding.toolName,
        identifier: binding.identifier,
        ok: result.ok,
        summary: result.summary || (result.ok ? "ok" : "failed"),
      };
      const inputHint = inspection?.inputHint;
      if (inputHint) {
        call.inputHint = inputHint;
      }
      const paths = inspection?.touchedPaths ?? [];
      if (paths.length > 0) {
        call.paths = paths;
      }
      const fileOps = inspection?.fileOperations ?? [];
      if (fileOps.length > 0) {
        call.fileOps = fileOps;
      }
      cell.nestedCalls.push(call);
      return result;
    };
  }

  return Object.freeze(tools);
}

function createLegacySelfCompat(
  sandbox: CodeModeSandbox,
  tools: CodeModeNestedTools,
): Record<string, unknown> {
  const selfCompat = Object.create(sandbox) as Record<string, unknown>;

  Object.defineProperty(selfCompat, "arguments", {
    value: async () => tools,
    enumerable: false,
    writable: false,
    configurable: false,
  });
  Object.defineProperty(selfCompat, "self", {
    value: selfCompat,
    enumerable: false,
    writable: false,
    configurable: false,
  });

  return selfCompat;
}

function stringifyNestedArgs(args: unknown): string {
  if (args === undefined) {
    return "{}";
  }

  return JSON.stringify(args);
}

function createConsoleCapture(lines: string[]): Console {
  const push = (...args: unknown[]): void => {
    const rendered = args
      .map((value) =>
        inspect(value, { depth: 4, colors: false, breakLength: 100 }),
      )
      .join(" ");
    lines.push(rendered);
  };

  return {
    log: push,
    info: push,
    warn: push,
    error: push,
    debug: push,
    trace: push,
    dir: (value: unknown) => {
      push(value);
    },
    assert: (condition: unknown, ...args: unknown[]) => {
      if (!condition) {
        push("Assertion failed", ...args);
      }
    },
    clear: () => {
      lines.length = 0;
    },
    count: () => undefined,
    countReset: () => undefined,
    group: push,
    groupCollapsed: push,
    groupEnd: () => undefined,
    table: (tabularData: unknown) => {
      push(tabularData);
    },
    time: () => undefined,
    timeEnd: () => undefined,
    timeLog: () => undefined,
  } as Console;
}

async function waitForSettlement(
  cell: RunningCell,
  yieldTimeMs: number,
  signal?: AbortSignal,
): Promise<boolean> {
  if (cell.status !== "running") {
    return true;
  }

  const outcome = await Promise.race([
    cell.completion.then(() => "completed" as const),
    delay(yieldTimeMs, signal)
      .then(() => "timeout" as const)
      .catch(() => "aborted" as const),
  ]);

  if (outcome === "completed") {
    await cell.completion;
    return true;
  }

  if (outcome === "aborted") {
    return cell.status !== "running";
  }

  return false;
}

function bindAbortTermination(
  signal: AbortSignal | undefined,
  onAbort: () => void,
): () => void {
  if (!signal) {
    return () => undefined;
  }

  if (signal.aborted) {
    onAbort();
    return () => undefined;
  }

  signal.addEventListener("abort", onAbort, { once: true });
  return () => {
    signal.removeEventListener("abort", onAbort);
  };
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      resolve();
    }, ms);

    const abort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(createAbortError(signal));
    };

    if (signal?.aborted) {
      abort();
      return;
    }

    signal?.addEventListener("abort", abort, { once: true });
  });
}

function createAbortError(signal?: AbortSignal): Error {
  const reason = signal?.reason;
  if (reason instanceof Error) {
    return reason;
  }

  return new Error(
    typeof reason === "string" && reason.trim().length > 0
      ? reason
      : "Run interrupted by user.",
  );
}

function renderCellResult(input: {
  cell: RunningCell;
  status: CellStatus;
  commandOutputLimit: number;
  maxTokens?: number;
}): ToolExecutionResult {
  const prefixLines: string[] = [];
  const tailLines: string[] = [];
  let summary = "";
  let ok = true;

  switch (input.status) {
    case "running": {
      const toolCount = input.cell.nestedCalls.length;
      summary =
        toolCount > 0
          ? `Script running · ${toolCount} tool call${toolCount === 1 ? "" : "s"} so far`
          : `Script running with cell_id ${input.cell.id}`;
      prefixLines.push(summary);
      break;
    }
    case "completed": {
      const toolCount = input.cell.nestedCalls.length;
      summary =
        toolCount > 0
          ? `Script completed · ${toolCount} tool call${toolCount === 1 ? "" : "s"}`
          : "Script completed";
      break;
    }
    case "failed":
      summary = "Script failed";
      ok = false;
      break;
    case "terminated":
      summary = "Script terminated";
      break;
  }

  const codeSection =
    input.cell.code.trim().length > 0
      ? ["Code:", "```js", input.cell.code, "```"].join("\n")
      : null;

  // Tool call summary — compact, high-density
  if (input.cell.nestedCalls.length > 0) {
    const calls = input.cell.nestedCalls;
    const totalCalls = calls.length;

    if (totalCalls <= 8) {
      // Few calls: show each individually with inputHint
      for (const call of calls) {
        const mark = call.ok ? "✓" : "✗";
        const hint =
          call.inputHint ||
          (call.fileOps && call.fileOps.length > 0
            ? call.fileOps.join(", ")
            : "") ||
          (call.paths && call.paths.length > 0 ? call.paths.join(", ") : "");
        const hintStr = hint
          ? ` ${hint.length > 60 ? hint.slice(0, 57) + "..." : hint}`
          : "";
        tailLines.push(`${mark} ${call.toolName}${hintStr}`);
      }
    } else {
      // Many calls: group by tool, show count and key details
      const callsByTool = new Map<
        string,
        { count: number; ok: number; hints: string[] }
      >();
      for (const call of calls) {
        const existing = callsByTool.get(call.toolName);
        const hint =
          call.inputHint ||
          (call.fileOps && call.fileOps.length > 0 ? call.fileOps[0] : "") ||
          (call.paths && call.paths.length > 0 ? call.paths[0] : "");
        if (existing) {
          existing.count++;
          if (call.ok) existing.ok++;
          if (hint && existing.hints.length < 3) existing.hints.push(hint);
        } else {
          callsByTool.set(call.toolName, {
            count: 1,
            ok: call.ok ? 1 : 0,
            hints: hint ? [hint] : [],
          });
        }
      }
      for (const [name, info] of callsByTool) {
        const status =
          info.ok === info.count ? "✓" : `${info.ok}/${info.count}`;
        tailLines.push(`${status} ${name} ×${info.count}`);
        for (const h of info.hints) {
          const short = h.length > 68 ? h.slice(0, 65) + "..." : h;
          tailLines.push(`  ${short}`);
        }
        if (info.hints.length < info.count && info.count > info.hints.length) {
          const more = info.count - info.hints.length;
          if (more > 0 && info.hints.length > 0)
            tailLines.push(`  … +${more} more`);
        }
      }
    }
  }

  // Console output — clean, with ">" prefix
  if (input.cell.consoleLines.length > 0) {
    tailLines.push("Console:");
    tailLines.push(input.cell.consoleLines.join("\n"));
  }

  if (input.status === "completed") {
    const returnedToolResult = renderReturnedToolResult(input.cell.result);
    if (returnedToolResult) {
      tailLines.push("Result:");
      tailLines.push(returnedToolResult);
    }
  }

  if (input.status === "completed" && input.cell.result === undefined) {
    tailLines.push("Diagnostic:");
    tailLines.push("Script completed without a returned result.");
    tailLines.push(
      "Return the final value directly from the top-level exec body if you need it in the model context.",
    );
    tailLines.push(
      "Do not wrap the script in `(async () => { ... })()` because exec already provides an async context.",
    );
  }

  if (
    (input.status === "failed" || input.status === "terminated") &&
    input.cell.errorText
  ) {
    tailLines.push("Error:");
    tailLines.push(input.cell.errorText);
  }

  const maxChars = resolveMaxOutputChars(
    input.commandOutputLimit,
    input.maxTokens ?? input.cell.maxOutputTokens,
  );
  const prefixText = prefixLines.join("\n");
  const tailText = tailLines.join("\n");
  const sections: string[] = [];
  if (prefixText.length > 0) {
    sections.push(prefixText);
  }
  if (codeSection) {
    sections.push(codeSection);
  }

  let renderedContent = "";
  let renderedTruncation: ReturnType<typeof truncateText>["truncation"];
  if (!codeSection) {
    const rendered = truncateText({
      text: [...sections, tailText]
        .filter((part) => part.length > 0)
        .join("\n"),
      maxChars,
      strategy: "head_tail",
    });
    renderedContent = rendered.text;
    renderedTruncation = rendered.truncation;
  } else {
    const fixedText = sections.join("\n");
    const separator = fixedText.length > 0 && tailText.length > 0 ? 1 : 0;
    const remainingChars = maxChars - fixedText.length - separator;
    if (remainingChars <= 0) {
      const rendered = truncateText({
        text: [...sections, tailText]
          .filter((part) => part.length > 0)
          .join("\n"),
        maxChars,
        strategy: "head_tail",
      });
      renderedContent = rendered.text;
      renderedTruncation = rendered.truncation;
    } else if (tailText.length === 0) {
      renderedContent = fixedText;
    } else {
      const renderedTail = truncateText({
        text: tailText,
        maxChars: remainingChars,
        strategy: "head_tail",
      });
      renderedContent = [fixedText, renderedTail.text].join("\n");
      renderedTruncation = renderedTail.truncation;
    }
  }

  return {
    ok,
    summary,
    content: renderedContent,
    truncation: renderedTruncation,
    data: {
      cell_id: input.cell.id,
      status: input.status,
      running: input.status === "running",
    },
  };
}

function renderReturnedToolResult(value: unknown): string | null {
  if (!isToolExecutionResultLike(value)) {
    return null;
  }

  const content =
    typeof value.content === "string" ? value.content.trim() : undefined;
  if (content) {
    return content;
  }

  const summary =
    typeof value.summary === "string" ? value.summary.trim() : undefined;
  if (summary) {
    return summary;
  }

  if (
    value.error &&
    typeof value.error === "object" &&
    typeof value.error.message === "string" &&
    value.error.message.trim()
  ) {
    return value.error.message.trim();
  }

  if (value.data !== undefined) {
    return inspect(value.data, { depth: 4, colors: false, breakLength: 100 });
  }

  return value.ok ? "ok" : "failed";
}

function isToolExecutionResultLike(
  value: unknown,
): value is Pick<
  ToolExecutionResult,
  "ok" | "summary" | "content" | "data" | "error"
> {
  return (
    value !== null &&
    typeof value === "object" &&
    "ok" in value &&
    typeof value.ok === "boolean"
  );
}

function parseExecInput(source: string): ParsedExecInput {
  const trimmed = source.trim();
  if (!trimmed) {
    throw new Error(
      'exec requires a non-empty code string. Optionally start with // @exec: {"yield_time_ms":10000,"max_output_tokens":1000}.',
    );
  }

  const firstNewline = source.indexOf("\n");
  const firstLine = firstNewline >= 0 ? source.slice(0, firstNewline) : source;
  const rest = firstNewline >= 0 ? source.slice(firstNewline + 1) : "";
  const pragma = firstLine.trimStart().startsWith(CODE_MODE_PRAGMA_PREFIX)
    ? firstLine.trimStart().slice(CODE_MODE_PRAGMA_PREFIX.length).trim()
    : undefined;

  if (!pragma) {
    return {
      code: source,
      yieldTimeMs: DEFAULT_EXEC_YIELD_TIME_MS,
    };
  }

  if (!rest.trim()) {
    throw new Error(
      "exec pragma must be followed by JavaScript source on subsequent lines",
    );
  }

  let parsedDirective: unknown;
  try {
    parsedDirective = JSON.parse(pragma);
  } catch (error) {
    throw new Error(
      `exec pragma must be valid JSON with supported fields yield_time_ms and max_output_tokens: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (
    !parsedDirective ||
    typeof parsedDirective !== "object" ||
    Array.isArray(parsedDirective)
  ) {
    throw new Error(
      "exec pragma must be a JSON object with supported fields yield_time_ms and max_output_tokens",
    );
  }

  const payload = parsedDirective as Record<string, unknown>;
  for (const key of Object.keys(payload)) {
    if (key !== "yield_time_ms" && key !== "max_output_tokens") {
      throw new Error(
        `exec pragma only supports yield_time_ms and max_output_tokens; got '${key}'`,
      );
    }
  }

  return {
    code: rest,
    yieldTimeMs: normalizeSafeInteger(
      payload.yield_time_ms,
      "yield_time_ms",
      DEFAULT_EXEC_YIELD_TIME_MS,
    ),
    maxOutputTokens:
      payload.max_output_tokens === undefined
        ? undefined
        : normalizeSafeInteger(payload.max_output_tokens, "max_output_tokens"),
  };
}

function normalizeYieldTimeMs(
  value: number | undefined,
  fallback: number,
): number {
  return normalizeSafeInteger(value, "yield_time_ms", fallback);
}

function normalizeSafeInteger(
  value: unknown,
  field: string,
  fallback?: number,
): number {
  if (value === undefined) {
    if (fallback === undefined) {
      throw new Error(`${field} must be a non-negative safe integer`);
    }
    return fallback;
  }

  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < 0 ||
    value > MAX_JS_SAFE_INTEGER
  ) {
    throw new Error(`${field} must be a non-negative safe integer`);
  }

  return value;
}

function resolveMaxOutputChars(
  commandOutputLimit: number,
  maxTokens?: number,
): number {
  if (
    typeof maxTokens === "number" &&
    Number.isFinite(maxTokens) &&
    maxTokens > 0
  ) {
    return Math.max(
      MIN_RENDER_CHARS,
      Math.min(MAX_RENDER_CHARS, maxTokens * 4),
    );
  }

  return Math.max(
    MIN_RENDER_CHARS,
    Math.min(MAX_RENDER_CHARS, commandOutputLimit),
  );
}

function toSerializableRecord(
  value: Record<string, unknown>,
): Record<string, unknown> {
  return (
    (toSerializable(value, new WeakSet()) as Record<string, unknown>) ?? {}
  );
}

function toSerializable(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) {
    return value;
  }

  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (typeof value === "function" || typeof value === "symbol") {
    return undefined;
  }

  if (Array.isArray(value)) {
    return value.map((entry) => toSerializable(entry, seen));
  }

  if (typeof value === "object") {
    if (seen.has(value)) {
      return "[Circular]";
    }

    seen.add(value);
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(
      value as Record<string, unknown>,
    )) {
      const normalized = toSerializable(child, seen);
      if (normalized !== undefined) {
        output[key] = normalized;
      }
    }
    seen.delete(value);
    return output;
  }

  return String(value);
}
