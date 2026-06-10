import fs from "node:fs/promises";
import path from "node:path";
import { isFileNotFound } from "@step-cli/utils/fs.js";
import {
  getWorkspaceTrustFilePath,
  type StepCliResolvedStorageLayout,
} from "../storage/layout.js";

interface WorkspaceTrustSnapshotV1 {
  schemaVersion: 1;
  workspaceRoot: string;
  trusted: boolean;
  trustedAt: string;
}

export class WorkspaceTrustStore {
  private readonly storageRootDir: string;
  private readonly filePath: string;

  constructor(storageLayout: StepCliResolvedStorageLayout) {
    this.storageRootDir = path.resolve(storageLayout.rootDir);
    this.filePath = getWorkspaceTrustFilePath(storageLayout);
  }

  getFilePath(): string {
    return this.filePath;
  }

  async isTrusted(): Promise<boolean> {
    try {
      const raw = await fs.readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      if (!isWorkspaceTrustSnapshot(parsed)) {
        return false;
      }
      return (
        parsed.trusted === true &&
        path.resolve(parsed.workspaceRoot) === this.storageRootDir
      );
    } catch (error) {
      if (isFileNotFound(error)) {
        return false;
      }
      return false;
    }
  }

  async markTrusted(): Promise<void> {
    const snapshot: WorkspaceTrustSnapshotV1 = {
      schemaVersion: 1,
      workspaceRoot: this.storageRootDir,
      trusted: true,
      trustedAt: new Date().toISOString(),
    };

    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    await fs.writeFile(
      this.filePath,
      `${JSON.stringify(snapshot, null, 2)}\n`,
      "utf8",
    );
  }
}

function isWorkspaceTrustSnapshot(
  value: unknown,
): value is WorkspaceTrustSnapshotV1 {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const candidate = value as Record<string, unknown>;
  return (
    candidate.schemaVersion === 1 &&
    typeof candidate.workspaceRoot === "string" &&
    typeof candidate.trusted === "boolean" &&
    typeof candidate.trustedAt === "string"
  );
}
