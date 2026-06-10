import { randomUUID } from "node:crypto";
import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import type { StepCliTriggerDescriptor } from "@step-cli/protocol";
import { isFileNotFound } from "@step-cli/utils/fs.js";

export interface SessionTriggerStoreOptions {
  filePath: string;
}

export class SessionTriggerStore {
  private readonly filePath: string;

  constructor(options: SessionTriggerStoreOptions) {
    this.filePath = options.filePath;
  }

  getFilePath(): string {
    return this.filePath;
  }

  async load(): Promise<StepCliTriggerDescriptor[]> {
    let raw: string;
    try {
      raw = await fsPromises.readFile(this.filePath, "utf8");
    } catch (error) {
      if (isFileNotFound(error)) {
        return [];
      }
      throw error;
    }

    const trimmed = raw.trim();
    if (!trimmed) {
      return [];
    }

    const parsed: unknown = JSON.parse(trimmed);
    if (!Array.isArray(parsed)) {
      throw new Error(`Invalid trigger store payload: ${this.filePath}`);
    }

    return parsed as StepCliTriggerDescriptor[];
  }

  async save(triggers: readonly StepCliTriggerDescriptor[]): Promise<void> {
    await writeJsonFile(this.filePath, [...triggers]);
  }

  saveSync(triggers: readonly StepCliTriggerDescriptor[]): void {
    writeJsonFileSync(this.filePath, [...triggers]);
  }

  async upsert(
    trigger: StepCliTriggerDescriptor,
  ): Promise<StepCliTriggerDescriptor[]> {
    const triggers = await this.load();
    const index = triggers.findIndex(
      (entry) =>
        entry.sessionId === trigger.sessionId && entry.id === trigger.id,
    );

    if (index >= 0) {
      triggers[index] = trigger;
    } else {
      triggers.push(trigger);
    }

    await this.save(triggers);
    return triggers;
  }

  async delete(sessionId: string, triggerId: string): Promise<void> {
    const triggers = await this.load();
    const filtered = triggers.filter(
      (entry) => !(entry.sessionId === sessionId && entry.id === triggerId),
    );
    if (filtered.length === triggers.length) {
      return;
    }
    await this.save(filtered);
  }
}

async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  await fsPromises.writeFile(
    tempPath,
    `${JSON.stringify(value, null, 2)}\n`,
    "utf8",
  );
  await fsPromises.rename(tempPath, filePath);
}

function writeJsonFileSync(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${randomUUID()}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  fs.renameSync(tempPath, filePath);
}
