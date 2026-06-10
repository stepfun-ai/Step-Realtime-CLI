import fs from "node:fs/promises";
import type { UserAttachment } from "@step-cli/protocol";
import { parseImageAttachmentInput } from "@step-cli/utils/image-attachments.js";
import { parsePositiveInt } from "./option-parsers.js";

export function readOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : undefined;
}

export function readFirstEnv(names: readonly string[]): string | undefined {
  for (const name of names) {
    const value = readOptionalString(process.env[name]);
    if (value) {
      return value;
    }
  }

  return undefined;
}

export function readFirstPositiveIntEnv(
  names: readonly string[],
): number | undefined {
  const value = readFirstEnv(names);
  return value ? parsePositiveInt(value) : undefined;
}

export async function readPromptFromStdin(): Promise<string> {
  if (process.stdin.isTTY) {
    return "";
  }

  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  return Buffer.concat(chunks).toString("utf8").trim();
}

export async function readPromptCommandInput(input: {
  promptParts: string[];
  imageValues?: string[];
  baseDir: string;
}): Promise<{
  prompt: string;
  attachments: UserAttachment[];
}> {
  const promptArg =
    input.promptParts.length > 0 ? input.promptParts.join(" ") : "";
  const prompt = promptArg.length > 0 ? promptArg : await readPromptFromStdin();
  const attachments = (input.imageValues ?? []).map((value) =>
    parseImageAttachmentInput(value, input.baseDir),
  );

  return {
    prompt,
    attachments,
  };
}

export async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

export async function waitForTerminationSignal(): Promise<NodeJS.Signals> {
  return await new Promise((resolve) => {
    const signals: NodeJS.Signals[] = ["SIGINT", "SIGTERM"];
    const handlers = new Map<NodeJS.Signals, () => void>();
    const finish = (signal: NodeJS.Signals) => {
      for (const [name, handler] of handlers) {
        process.off(name, handler);
      }
      resolve(signal);
    };

    for (const signal of signals) {
      const handler = () => {
        finish(signal);
      };
      handlers.set(signal, handler);
      process.once(signal, handler);
    }
  });
}
