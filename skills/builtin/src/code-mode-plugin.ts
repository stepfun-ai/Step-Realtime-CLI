import { CodeModeService } from "@step-cli/core/tools/code-mode/service.js";
import {
  parseJsonObject,
  readBooleanField,
  readIntegerField,
  readRequiredStringField,
} from "@step-cli/core/tools/args.js";
import type { ToolExecutionResult, ToolSpec } from "@step-cli/protocol";
import type {
  ToolPlugin,
  ToolPluginContext,
} from "@step-cli/core/plugins/types.js";

const EXEC_TOOL_NAME = "exec";
const WAIT_TOOL_NAME = "wait";

interface ExecArgs {
  code: string;
}

interface WaitArgs {
  cell_id: string;
  yield_time_ms?: number;
  max_tokens?: number;
  terminate?: boolean;
}

interface SerializedCodeModePluginState {
  version: 1;
  entries: Array<{
    workspaceRoot: string;
    sessionId: string;
    goalId: string;
    state: unknown;
  }>;
}

export function createCodeModePlugin(): ToolPlugin {
  const services = new Map<string, CodeModeService>();
  const pendingState = new Map<string, unknown>();

  const getKey = (
    context: Pick<ToolPluginContext, "workspaceRoot" | "harness">,
  ): string =>
    [
      context.workspaceRoot,
      context.harness.sessionId,
      context.harness.goalId,
    ].join("\u0000");

  const ensureService = (context: ToolPluginContext): CodeModeService => {
    const key = getKey(context);
    let service = services.get(key);
    if (!service) {
      service = new CodeModeService();
      const hydrated = pendingState.get(key);
      if (hydrated !== undefined) {
        service.loadState(hydrated);
        pendingState.delete(key);
      }
      services.set(key, service);
    }

    return service;
  };

  return {
    id: "code-mode-plugin",
    description:
      "Codex-style Code Mode with public exec/wait tools and internal nested tool bindings",
    register: (context) => {
      const service = ensureService(context);
      return [createExecTool(service), createWaitTool(service)];
    },
    hooks: {
      onUserInterrupt: () => {
        let interrupted = 0;
        for (const service of services.values()) {
          interrupted += service.interruptAll();
        }
        return interrupted > 0;
      },
    },
    exportState: (): SerializedCodeModePluginState => ({
      version: 1,
      entries: [...services.entries()].map(([key, service]) => {
        const [workspaceRoot = "", sessionId = "", goalId = ""] =
          key.split("\u0000");
        return {
          workspaceRoot,
          sessionId,
          goalId,
          state: service.exportState(),
        };
      }),
    }),
    loadState: (state) => {
      pendingState.clear();
      for (const service of services.values()) {
        service.loadState(undefined);
      }

      if (!state || typeof state !== "object" || Array.isArray(state)) {
        return;
      }

      const snapshot = state as Partial<SerializedCodeModePluginState>;
      if (snapshot.version !== 1 || !Array.isArray(snapshot.entries)) {
        return;
      }

      for (const entry of snapshot.entries) {
        if (!entry || typeof entry !== "object") {
          continue;
        }

        const workspaceRoot =
          typeof entry.workspaceRoot === "string" ? entry.workspaceRoot : "";
        const sessionId =
          typeof entry.sessionId === "string" ? entry.sessionId : "";
        const goalId = typeof entry.goalId === "string" ? entry.goalId : "";
        if (!workspaceRoot || !sessionId || !goalId) {
          continue;
        }

        const key = [workspaceRoot, sessionId, goalId].join("\u0000");
        const service = services.get(key);
        if (service) {
          service.loadState(entry.state);
        } else {
          pendingState.set(key, entry.state);
        }
      }
    },
    shutdown: async (reason) => {
      for (const service of services.values()) {
        service.shutdown(reason);
      }
      services.clear();
      pendingState.clear();
    },
  };
}

function createExecTool(service: CodeModeService): ToolSpec<ExecArgs> {
  return {
    definition: {
      type: "function",
      function: {
        name: EXEC_TOOL_NAME,
        description:
          "Run JavaScript that can orchestrate the other tools inside a single exec cell.",
        parameters: {
          type: "object",
          required: ["code"],
          additionalProperties: false,
          properties: {
            code: {
              type: "string",
              description:
                "JavaScript source. Optionally start with // @exec: { ... } on the first line.",
            },
          },
        },
      },
    },
    security: {
      risk: "meta",
      defaultMode: "allow",
    },
    parseArgs: (rawArgs) => {
      const payload = parseJsonObject(rawArgs);
      return {
        code: readRequiredStringField(payload.code, "code"),
      };
    },
    execute: async (args, ctx, runtime): Promise<ToolExecutionResult> => {
      return service.execute(args.code, ctx, runtime);
    },
  };
}

function createWaitTool(service: CodeModeService): ToolSpec<WaitArgs> {
  return {
    definition: {
      type: "function",
      function: {
        name: WAIT_TOOL_NAME,
        description: "Wait for or terminate the currently running exec cell.",
        parameters: {
          type: "object",
          required: ["cell_id"],
          additionalProperties: false,
          properties: {
            cell_id: {
              type: "string",
              description: "The cell_id returned by exec.",
            },
            yield_time_ms: {
              type: "integer",
              minimum: 0,
              description:
                "Maximum time to wait before returning control to the model.",
            },
            max_tokens: {
              type: "integer",
              minimum: 1,
              description: "Optional output budget for the rendered result.",
            },
            terminate: {
              type: "boolean",
              description:
                "Terminate the running cell instead of waiting for more output.",
            },
          },
        },
      },
    },
    security: {
      risk: "meta",
      defaultMode: "allow",
    },
    parseArgs: (rawArgs) => {
      const payload = parseJsonObject(rawArgs);
      return {
        cell_id: readRequiredStringField(payload.cell_id, "cell_id"),
        yield_time_ms: readIntegerField(payload.yield_time_ms, "yield_time_ms"),
        max_tokens: readIntegerField(payload.max_tokens, "max_tokens"),
        terminate: readBooleanField(payload.terminate, "terminate"),
      };
    },
    execute: async (args, ctx): Promise<ToolExecutionResult> => {
      return service.wait(
        {
          cellId: args.cell_id,
          yieldTimeMs: args.yield_time_ms,
          maxTokens: args.max_tokens,
          terminate: args.terminate,
        },
        ctx,
      );
    },
  };
}
