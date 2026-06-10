import { spawn } from "node:child_process";
import type { ToolSpec } from "@step-cli/protocol";
import { clamp } from "@step-cli/utils/math.js";
import { resolveExistingPathInWorkspace } from "@step-cli/utils/path.js";
import {
  parseJsonObject,
  readIntegerField,
  readRequiredStringField,
  readStringField,
} from "@step-cli/core/tools/args.js";
import { enforceOutputLimit, renderCommandOutput } from "./command-output.js";
import { createCommandInspection } from "./tool-inspection.js";
import { applyToolResultTruncationHint } from "./tool-result-truncation.js";

const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 120_000;

interface CommandArgs {
  command: string;
  cwd?: string;
  timeout_ms?: number;
  max_output_chars?: number;
}

interface CommandExecutionResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

export function createCommandTool(): ToolSpec<CommandArgs> {
  return {
    definition: {
      type: "function",
      function: {
        name: "run_command",
        description:
          "Run a shell command in workspace. Use for tests, grep, formatters, and build checks.",
        parameters: {
          type: "object",
          required: ["command"],
          properties: {
            command: { type: "string", description: "Shell command string" },
            cwd: { type: "string", description: "Relative working directory" },
            timeout_ms: {
              type: "integer",
              minimum: MIN_TIMEOUT_MS,
              maximum: MAX_TIMEOUT_MS,
            },
            max_output_chars: {
              type: "integer",
              minimum: 200,
              maximum: 120000,
              description: "Output character cap for stdout+stderr",
            },
          },
        },
      },
    },
    security: {
      risk: "execute",
      defaultMode: "confirm",
    },
    parseArgs: (rawArgs) => {
      const payload = parseJsonObject(rawArgs);
      return {
        command: readRequiredStringField(payload.command, "command"),
        cwd: readStringField(payload.cwd),
        timeout_ms: readIntegerField(payload.timeout_ms, "timeout_ms"),
        max_output_chars: readIntegerField(
          payload.max_output_chars,
          "max_output_chars",
        ),
      };
    },
    inspect: ({ args }) => createCommandInspection(args.command, "run_command"),
    execute: async (args, ctx) => {
      const timeoutMs = clamp(
        args.timeout_ms ?? ctx.commandTimeoutMs,
        MIN_TIMEOUT_MS,
        MAX_TIMEOUT_MS,
      );
      const outputLimit = clamp(
        args.max_output_chars ?? ctx.commandOutputLimit,
        200,
        120_000,
      );
      const commandResult = ctx.signal?.aborted
        ? createInterruptedCommandResult()
        : await runCommand({
            command: args.command,
            cwd: await resolveExistingPathInWorkspace(
              ctx.workspaceRoot,
              args.cwd ?? ".",
            ),
            timeoutMs,
            outputLimit,
            signal: ctx.signal,
          });

      const rendered = renderCommandOutput({
        ...commandResult,
        sanitize: true,
      });
      const success = commandResult.exitCode === 0;
      const timedOutHint = commandResult.timedOut ? " (timed out)" : "";
      const resultContent = applyToolResultTruncationHint({
        toolName: "run_command",
        summary: `Command exit ${commandResult.exitCode}${timedOutHint}`,
        content: rendered,
        maxChars: outputLimit,
      });

      return {
        ok: success,
        summary: resultContent.summary,
        content: resultContent.content,
        truncation: resultContent.truncation,
        data: {
          command: args.command,
          cwd: args.cwd ?? ".",
          exitCode: commandResult.exitCode,
          timedOut: commandResult.timedOut,
          stdoutChars: commandResult.stdout.length,
          stderrChars: commandResult.stderr.length,
        },
      };
    },
  };
}

async function runCommand(input: {
  command: string;
  cwd: string;
  timeoutMs: number;
  outputLimit: number;
  signal?: AbortSignal;
}): Promise<CommandExecutionResult> {
  if (input.signal?.aborted) {
    return createInterruptedCommandResult();
  }

  return new Promise((resolve, reject) => {
    const child = spawn(input.command, {
      cwd: input.cwd,
      shell: true,
      env: process.env,
      detached: process.platform !== "win32",
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let interrupted = false;

    const killChild = (): void => {
      if (process.platform !== "win32" && typeof child.pid === "number") {
        try {
          process.kill(-child.pid, "SIGKILL");
          return;
        } catch {
          // Fall back to killing the immediate shell process.
        }
      }
      child.kill("SIGKILL");
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killChild();
    }, input.timeoutMs);

    const abortFromCaller = (): void => {
      interrupted = true;
      killChild();
    };

    input.signal?.addEventListener("abort", abortFromCaller, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      stdout = enforceOutputLimit(
        `${stdout}${chunk.toString("utf8")}`,
        input.outputLimit,
      );
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr = enforceOutputLimit(
        `${stderr}${chunk.toString("utf8")}`,
        input.outputLimit,
      );
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abortFromCaller);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      input.signal?.removeEventListener("abort", abortFromCaller);

      if (timedOut) {
        resolve({
          stdout,
          stderr: enforceOutputLimit(
            `${stderr}\nProcess killed after timeout (${input.timeoutMs}ms).`,
            input.outputLimit,
          ),
          exitCode: -1,
          timedOut: true,
        });
        return;
      }

      if (interrupted) {
        resolve({
          stdout,
          stderr: enforceOutputLimit(
            `${stderr}\nProcess interrupted by user.`,
            input.outputLimit,
          ),
          exitCode: -1,
          timedOut: false,
        });
        return;
      }

      resolve({
        stdout,
        stderr,
        exitCode: code ?? -1,
        timedOut: false,
      });
    });
  });
}

function createInterruptedCommandResult(): CommandExecutionResult {
  return {
    stdout: "",
    stderr: "Process interrupted by user.",
    exitCode: -1,
    timedOut: false,
  };
}
