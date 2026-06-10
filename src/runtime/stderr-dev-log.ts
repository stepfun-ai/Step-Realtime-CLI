import fs from "node:fs/promises";
import path from "node:path";
import { stderr } from "node:process";
import { BUILTIN_CLI_DEFAULTS } from "../bootstrap/config/defaults.js";
import { resolveStorageRootDirectory } from "@step-cli/utils/path.js";

const DEV_LOG_PATH_SEGMENTS = ["logs", "dev.log"] as const;

let currentStorageRootDir = resolveStorageRootDirectory(
  process.cwd(),
  BUILTIN_CLI_DEFAULTS.storage.rootDir,
);
let installState:
  | {
      write: ReturnType<typeof createStderrMirrorWrite>;
      installed: true;
    }
  | undefined;
let directAppendPending = Promise.resolve();

export function resolveStderrDevLogPath(storageRootDir: string): string {
  return path.join(path.resolve(storageRootDir), ...DEV_LOG_PATH_SEGMENTS);
}

export function setStderrDevLogStorageRootDirectory(
  storageRootDir: string,
): void {
  currentStorageRootDir = path.resolve(storageRootDir);
}

export async function appendStderrDevLog(
  text: string,
  storageRootDir = currentStorageRootDir,
): Promise<void> {
  if (text.length === 0) {
    return;
  }

  directAppendPending = directAppendPending
    .then(async () => {
      const logPath = resolveStderrDevLogPath(storageRootDir);
      await fs.mkdir(path.dirname(logPath), { recursive: true });
      await fs.appendFile(logPath, text, "utf8");
    })
    .catch(() => {});

  await directAppendPending;
}

export function installProcessStderrDevLogCapture(): void {
  if (installState?.installed) {
    return;
  }

  const write = createStderrMirrorWrite({
    baseWrite: stderr.write.bind(stderr),
    getStorageRootDir: () => currentStorageRootDir,
  });

  stderr.write = write as typeof stderr.write;
  installState = { write, installed: true };
}

export function createStderrMirrorWrite(input: {
  baseWrite: NodeJS.WriteStream["write"];
  getStorageRootDir: () => string;
}): NodeJS.WriteStream["write"] & { flush(): Promise<void> } {
  let pending = Promise.resolve();

  const mirror = ((
    chunk: string | Uint8Array,
    encoding?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ): boolean => {
    const text = normalizeChunk(chunk, encoding);
    const storageRootDir = input.getStorageRootDir();
    if (text.length > 0) {
      pending = pending
        .then(async () => {
          const logPath = resolveStderrDevLogPath(storageRootDir);
          await fs.mkdir(path.dirname(logPath), { recursive: true });
          await fs.appendFile(logPath, text, "utf8");
        })
        .catch(() => {});
    }

    if (typeof encoding === "function") {
      return input.baseWrite(chunk, encoding);
    }

    return input.baseWrite(chunk, encoding, callback);
  }) as NodeJS.WriteStream["write"] & { flush(): Promise<void> };

  mirror.flush = async () => {
    await pending;
  };

  return mirror;
}

function normalizeChunk(
  chunk: string | Uint8Array,
  encoding?: BufferEncoding | ((error?: Error | null) => void),
): string {
  if (typeof chunk === "string") {
    return chunk;
  }

  const normalizedEncoding =
    typeof encoding === "string" ? encoding : ("utf8" as BufferEncoding);
  return Buffer.from(chunk).toString(normalizedEncoding);
}
