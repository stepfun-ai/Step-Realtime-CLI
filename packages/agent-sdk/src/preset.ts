import type {
  JsonSchema,
  OpenAIToolDefinition,
  ToolExecutionResult,
  ToolSpec,
} from "@step-cli/protocol";
import {
  buildBashTool,
  buildEditTool,
  buildGlobTool,
  buildGrepTool,
  buildReadTool,
  buildWriteTool,
} from "@step-cli/core/tools/native-impls/index.js";
import { ERR_TOOL_NOT_SUPPORTED } from "./error-codes.js";
import { riskForToolName } from "./tool-risk.js";

/**
 * The `stepfun_code` preset tool surface. Three buckets:
 *
 *   1. Native implementations (Read / Write / Edit / Bash / Glob / Grep) —
 *      re-exported from packages/core/src/tools/native-impls/ so this SDK and
 *      any future consumer share one source of truth.
 *
 *   2. In-memory stubs (TodoWrite / ExitPlanMode / TaskCreate / Get / Update /
 *      List / ListMcpResources) — minimal session-local state so the model
 *      sees coherent results without us backing them with infra.
 *
 *   3. Graceful "not supported" responses (Task / WebFetch / WebSearch /
 *      AskUserQuestion / NotebookEdit / NotebookRead / BashOutput / KillBash /
 *      ReadMcpResource / EnterWorktree / ExitWorktree) — preset-allowed but
 *      execute returns ok:false with a "Do not retry" hint so the model
 *      swaps to a different tool instead of looping.
 */

export type PresetName = "stepfun_code";

export function resolvePresetToolSpecs(preset: PresetName): ToolSpec[] {
  if (preset !== "stepfun_code") return [];
  return [
    buildReadTool() as unknown as ToolSpec,
    buildWriteTool() as unknown as ToolSpec,
    buildEditTool() as unknown as ToolSpec,
    buildBashTool() as unknown as ToolSpec,
    buildGlobTool() as unknown as ToolSpec,
    buildGrepTool() as unknown as ToolSpec,
    ...buildMemoryStubs(),
    ...buildNotSupportedStubs(),
  ];
}

function buildMemoryStubs(): ToolSpec[] {
  const todos = new Map<string, unknown>();
  const tasks: { id: string; subject: string; status: string }[] = [];
  return [
    memoryStub(
      "TodoWrite",
      "Record an in-memory todo list (SDK-side noop persistence).",
      async (args) => {
        todos.set("latest", args);
        return { ok: true, summary: "todos recorded" };
      },
    ),
    memoryStub(
      "ExitPlanMode",
      "Acknowledge exit from plan mode (no-op).",
      async () => ({ ok: true, summary: "plan acknowledged" }),
    ),
    memoryStub(
      "TaskCreate",
      "Create an in-memory task (SDK-side stub).",
      async (args) => {
        const params = args as { subject?: string };
        const id = String(tasks.length + 1);
        tasks.push({
          id,
          subject: params.subject ?? "(no subject)",
          status: "pending",
        });
        return { ok: true, summary: `Task #${id} created` };
      },
    ),
    memoryStub(
      "TaskGet",
      "Fetch an in-memory task by id (SDK-side stub).",
      async (args) => {
        const params = args as { taskId?: string };
        const found = tasks.find((task) => task.id === params.taskId);
        if (!found)
          return { ok: false, summary: `Task ${params.taskId} not found` };
        return { ok: true, summary: JSON.stringify(found) };
      },
    ),
    memoryStub(
      "TaskUpdate",
      "Update an in-memory task (SDK-side stub).",
      async (args) => {
        const params = args as { taskId?: string; status?: string };
        const found = tasks.find((task) => task.id === params.taskId);
        if (!found)
          return { ok: false, summary: `Task ${params.taskId} not found` };
        if (params.status) found.status = params.status;
        return { ok: true, summary: `Task ${params.taskId} updated` };
      },
    ),
    memoryStub(
      "TaskList",
      "List in-memory tasks (SDK-side stub).",
      async () => ({
        ok: true,
        summary:
          tasks.length === 0
            ? "(no tasks)"
            : tasks.map((task) => JSON.stringify(task)).join("\n"),
      }),
    ),
    memoryStub(
      "ListMcpResources",
      "List in-process MCP resources (SDK-side stub returns empty).",
      async () => ({ ok: true, summary: "[]" }),
    ),
  ];
}

function buildNotSupportedStubs(): ToolSpec[] {
  return [
    notSupported(
      "Task",
      "Task subagent is not available in this environment. The current agent should continue handling the task directly. Do not retry Task; proceed with the next concrete step (Read/Edit/Bash/Grep).",
    ),
    notSupported(
      "WebFetch",
      "WebFetch is not yet implemented in this agent. To fetch a URL, use the Bash tool with curl or wget instead, e.g. `curl -sSL <url>`. Do not retry WebFetch.",
    ),
    notSupported(
      "WebSearch",
      "WebSearch is not available. If you need information from the web, ask the user for the specific URL and use Bash curl to fetch it. Do not retry WebSearch.",
    ),
    notSupported(
      "AskUserQuestion",
      "AskUserQuestion is not available in this environment (no synchronous user channel). Do not retry AskUserQuestion; restate the question in your assistant reply instead.",
    ),
    notSupported(
      "NotebookEdit",
      "NotebookEdit is not supported by this agent. Do not retry NotebookEdit; use Read/Edit/Write to operate on plain files instead.",
    ),
    notSupported(
      "NotebookRead",
      "NotebookRead is not supported by this agent. Do not retry NotebookRead; use Read to inspect files directly.",
    ),
    notSupported(
      "BashOutput",
      "BashOutput is not supported (no background bash). Do not retry BashOutput; run Bash synchronously.",
    ),
    notSupported(
      "KillBash",
      "KillBash is not supported (no background bash). Do not retry KillBash.",
    ),
    notSupported(
      "ReadMcpResource",
      "ReadMcpResource is not supported. Do not retry ReadMcpResource; call the exact mcp__* tool instead.",
    ),
    notSupported(
      "EnterWorktree",
      "EnterWorktree is not supported in this environment. Do not retry EnterWorktree; continue in the current workspace.",
    ),
    notSupported(
      "ExitWorktree",
      "ExitWorktree is not supported in this environment. Do not retry ExitWorktree.",
    ),
  ];
}

type ExecuteFn = (args: unknown) => Promise<ToolExecutionResult>;

function memoryStub(
  name: string,
  description: string,
  execute: ExecuteFn,
): ToolSpec {
  return buildStubSpec(name, description, execute);
}

function notSupported(name: string, summary: string): ToolSpec {
  return buildStubSpec(
    name,
    `${name} (not supported by @step-cli/agent-sdk).`,
    async () => ({
      ok: false,
      summary,
      error: { code: ERR_TOOL_NOT_SUPPORTED, message: summary },
    }),
  );
}

function buildStubSpec(
  name: string,
  description: string,
  execute: ExecuteFn,
): ToolSpec {
  const schema: JsonSchema = { type: "object", additionalProperties: true };
  const definition: OpenAIToolDefinition = {
    type: "function",
    function: { name, description, parameters: schema },
  };
  return {
    definition,
    security: { risk: riskForToolName(name), defaultMode: "allow" },
    parseArgs: (rawArgs: string): unknown => {
      if (!rawArgs?.trim()) return {};
      try {
        return JSON.parse(rawArgs);
      } catch (error) {
        throw new Error(
          `Failed to parse ${name} arguments: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      }
    },
    execute,
  };
}
