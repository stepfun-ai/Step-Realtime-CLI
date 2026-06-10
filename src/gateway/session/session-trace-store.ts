import fs from "node:fs/promises";
import path from "node:path";
import type { LlmTraceRecord } from "@step-cli/protocol";
import {
  getSessionTraceDirectory,
  type StepCliResolvedStorageLayout,
} from "../storage/layout.js";

export interface SessionTraceStoreOptions {
  keepLast?: number;
}

interface SessionTraceEntry {
  filePath: string;
  modifiedAt: number;
}

export class SessionTraceStore {
  private readonly keepLast: number;

  constructor(
    private readonly storageLayout: StepCliResolvedStorageLayout,
    options: SessionTraceStoreOptions = {},
  ) {
    this.keepLast = Math.max(0, options.keepLast ?? 200);
  }

  async record(record: LlmTraceRecord): Promise<void> {
    const traceDir = getSessionTraceDirectory(
      this.storageLayout,
      record.sessionId,
    );
    await fs.mkdir(traceDir, { recursive: true });

    const filePath = path.join(traceDir, buildTraceFileName(record));
    const tempPath = `${filePath}.tmp`;
    await fs.writeFile(tempPath, `${JSON.stringify(record, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await fs.rename(tempPath, filePath);

    if (this.keepLast > 0) {
      await this.trim(traceDir);
    }
  }

  private async trim(traceDir: string): Promise<void> {
    const entries = await fs.readdir(traceDir, { withFileTypes: true });
    const traceEntries: SessionTraceEntry[] = [];

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) {
        continue;
      }

      const filePath = path.join(traceDir, entry.name);
      const stats = await fs.stat(filePath);
      traceEntries.push({
        filePath,
        modifiedAt: stats.mtimeMs,
      });
    }

    traceEntries.sort((left, right) => {
      if (left.modifiedAt === right.modifiedAt) {
        return right.filePath.localeCompare(left.filePath);
      }

      return right.modifiedAt - left.modifiedAt;
    });

    for (const entry of traceEntries.slice(this.keepLast)) {
      await fs.rm(entry.filePath, { force: true });
    }
  }
}

function buildTraceFileName(record: LlmTraceRecord): string {
  const suffix =
    typeof record.requestAttempt === "number" && record.requestAttempt > 1
      ? `.attempt-${record.requestAttempt}`
      : "";
  return `${record.spanId}${suffix}.json`;
}
