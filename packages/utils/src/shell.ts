import { spawn } from "node:child_process";

export interface ShellResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
  interrupted: boolean;
}

export interface RunShellOptions {
  cwd: string;
  timeoutMs: number;
  outputLimit: number;
  signal?: AbortSignal;
}

/**
 * Run a shell command and capture stdout/stderr with bounded memory and
 * proper cleanup. POSIX hosts kill the entire process group on
 * timeout/abort; Windows falls back to a direct child kill. Uses sliding
 * head+tail truncation so we keep both the command's preamble and its final
 * lines when output overflows.
 */
export async function runShell(
  command: string,
  options: RunShellOptions,
): Promise<ShellResult> {
  if (options.signal?.aborted) {
    return {
      stdout: "",
      stderr: "Process interrupted before start.",
      exitCode: -1,
      timedOut: false,
      interrupted: true,
    };
  }

  return new Promise<ShellResult>((resolve, reject) => {
    const child = spawn(command, {
      cwd: options.cwd,
      shell: true,
      env: process.env,
      detached: process.platform !== "win32",
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let interrupted = false;

    const killChild = () => {
      if (process.platform !== "win32" && typeof child.pid === "number") {
        try {
          process.kill(-child.pid, "SIGKILL");
          return;
        } catch {
          /* fallthrough */
        }
      }
      child.kill("SIGKILL");
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killChild();
    }, options.timeoutMs);

    const abortFromCaller = () => {
      interrupted = true;
      killChild();
    };

    options.signal?.addEventListener("abort", abortFromCaller, { once: true });

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout = enforceOutputLimit(
        `${stdout}${chunk.toString("utf8")}`,
        options.outputLimit,
      );
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = enforceOutputLimit(
        `${stderr}${chunk.toString("utf8")}`,
        options.outputLimit,
      );
    });

    child.on("error", (error) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abortFromCaller);
      reject(error);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", abortFromCaller);

      if (timedOut) {
        resolve({
          stdout,
          stderr: enforceOutputLimit(
            `${stderr}\nProcess killed after timeout (${options.timeoutMs}ms).`,
            options.outputLimit,
          ),
          exitCode: -1,
          timedOut: true,
          interrupted: false,
        });
        return;
      }
      if (interrupted) {
        resolve({
          stdout,
          stderr: enforceOutputLimit(
            `${stderr}\nProcess interrupted by user.`,
            options.outputLimit,
          ),
          exitCode: -1,
          timedOut: false,
          interrupted: true,
        });
        return;
      }
      resolve({
        stdout,
        stderr,
        exitCode: code ?? -1,
        timedOut: false,
        interrupted: false,
      });
    });
  });
}

/**
 * Head+tail truncation: keep 40% from the start and 60% from the end so both
 * the command's preamble and its final lines survive. The middle is replaced
 * by a `...[truncated N chars]...` marker.
 */
export function enforceOutputLimit(value: string, limit: number): string {
  if (value.length <= limit) return value;
  const tail = Math.floor(limit * 0.6);
  const head = Math.max(0, limit - tail);
  return `${value.slice(0, head)}\n...[truncated ${value.length - limit} chars]...\n${value.slice(value.length - tail)}`;
}
