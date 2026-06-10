import { spawn } from "node:child_process";
import process from "node:process";

interface ClipboardCommandSpec {
  command: string;
  args: readonly string[];
}

interface ResolveClipboardCommandSpecsInput {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
}

export async function copyTextToClipboard(text: string): Promise<void> {
  const specs = resolveClipboardCommandSpecs();
  const failures: string[] = [];

  for (const spec of specs) {
    try {
      await runClipboardCommand(spec, text);
      return;
    } catch (error) {
      failures.push(
        error instanceof Error
          ? `${spec.command}: ${error.message}`
          : `${spec.command}: ${String(error)}`,
      );
    }
  }

  const attemptedCommands = specs.map((spec) => spec.command).join(", ");
  throw new Error(
    failures.length > 0
      ? `Unable to copy transcript to clipboard. Tried ${attemptedCommands}. ${failures.at(-1) ?? ""}`.trim()
      : "Unable to copy transcript to clipboard on this platform.",
  );
}

export function resolveClipboardCommandSpecs(
  input: ResolveClipboardCommandSpecsInput = {},
): ClipboardCommandSpec[] {
  const env = input.env ?? process.env;
  const platform = input.platform ?? process.platform;
  const specs: ClipboardCommandSpec[] = [];
  const seen = new Set<string>();

  const pushSpec = (command: string, args: readonly string[] = []) => {
    const key = `${command}\u0000${args.join("\u0000")}`;
    if (seen.has(key)) {
      return;
    }

    seen.add(key);
    specs.push({ command, args });
  };

  switch (platform) {
    case "darwin":
      pushSpec("pbcopy");
      return specs;
    case "win32":
      pushSpec("clip");
      return specs;
    default:
      if (env.WSL_DISTRO_NAME || env.WSL_INTEROP) {
        pushSpec("clip.exe");
      }
      if (env.WAYLAND_DISPLAY) {
        pushSpec("wl-copy");
      }
      if (env.DISPLAY) {
        pushSpec("xclip", ["-selection", "clipboard"]);
        pushSpec("xsel", ["--clipboard", "--input"]);
      }

      pushSpec("wl-copy");
      pushSpec("xclip", ["-selection", "clipboard"]);
      pushSpec("xsel", ["--clipboard", "--input"]);
      return specs;
  }
}

function runClipboardCommand(
  spec: ClipboardCommandSpec,
  text: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(spec.command, [...spec.args], {
      stdio: ["pipe", "ignore", "pipe"],
    });
    let stderr = "";
    let settled = false;

    const finish = (callback: () => void) => {
      if (settled) {
        return;
      }

      settled = true;
      callback();
    };

    child.once("error", (error) => {
      finish(() => {
        reject(error);
      });
    });

    child.stderr?.on("data", (chunk: Buffer | string) => {
      stderr += chunk.toString();
    });

    child.once("close", (code, signal) => {
      if (code === 0) {
        finish(resolve);
        return;
      }

      const detail =
        stderr.trim() ||
        (signal
          ? `terminated by signal ${signal}`
          : `exited with code ${code ?? "unknown"}`);
      finish(() => {
        reject(new Error(detail));
      });
    });

    child.stdin?.once("error", (error) => {
      finish(() => {
        reject(error);
      });
    });

    child.stdin?.end(text);
  });
}
