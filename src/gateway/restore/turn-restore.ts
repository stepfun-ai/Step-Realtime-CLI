import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { SessionSnapshotV4 } from "../session/session-store.js";
import type { ToolCallInspection } from "@step-cli/protocol";
import { isFileNotFound } from "@step-cli/utils/fs.js";
import { resolveInWorkspace } from "@step-cli/utils/path.js";

export interface TurnRestoreCaptureInfo {
  toolName: string;
  rawArgs: string;
  workspaceRoot: string;
  inspection?: ToolCallInspection;
}

export interface LatestTurnRestorePoint {
  snapshot: SessionSnapshotV4;
  startedAt: string;
  trackedFiles: number;
  externalEffects: string[];
}

export interface RestoreWorkspaceResult {
  trackedFiles: number;
  restoredFiles: number;
  deletedFiles: number;
  restoredPaths: string[];
  deletedPaths: string[];
}

interface FileBackupRecord {
  workspaceRoot: string;
  absolutePath: string;
  relativePath: string;
  existed: boolean;
  backupPath?: string;
  mode?: number;
}

interface TurnRestoreDraft {
  snapshot: SessionSnapshotV4;
  startedAt: string;
  backupRoot: string | null;
  fileBackups: Map<string, FileBackupRecord>;
  externalEffects: Set<string>;
}

interface TurnRestorePoint extends TurnRestoreDraft {
  externalEffects: Set<string>;
}

export class LatestTurnRestoreStore {
  private activeDraft: TurnRestoreDraft | null = null;
  private latestPoint: TurnRestorePoint | null = null;

  beginTurn(snapshot: SessionSnapshotV4): void {
    if (this.activeDraft) {
      throw new Error("A turn restore draft is already active.");
    }

    this.activeDraft = {
      snapshot,
      startedAt: new Date().toISOString(),
      backupRoot: null,
      fileBackups: new Map(),
      externalEffects: new Set(),
    };
  }

  async recordToolStart(info: TurnRestoreCaptureInfo): Promise<void> {
    const draft = this.activeDraft;
    if (!draft) {
      return;
    }

    for (const effect of info.inspection?.externalEffects ?? []) {
      if (effect.kind === "external-unsafe") {
        const label = effect.label?.trim();
        if (label) {
          draft.externalEffects.add(label);
        }
        continue;
      }

      for (const relativePath of normalizeRelativePaths(effect.relativePaths)) {
        await this.captureFileBackup(draft, info.workspaceRoot, relativePath);
      }
    }
  }

  async finishTurn(): Promise<void> {
    const draft = this.activeDraft;
    if (!draft) {
      return;
    }

    this.activeDraft = null;

    if (this.latestPoint) {
      await this.discardPoint(this.latestPoint);
    }

    this.latestPoint = {
      ...draft,
      fileBackups: new Map(draft.fileBackups),
      externalEffects: new Set(draft.externalEffects),
    };
  }

  getLatestPoint(): LatestTurnRestorePoint | null {
    if (!this.latestPoint) {
      return null;
    }

    return {
      snapshot: this.latestPoint.snapshot,
      startedAt: this.latestPoint.startedAt,
      trackedFiles: this.latestPoint.fileBackups.size,
      externalEffects: [...this.latestPoint.externalEffects].sort(
        (left, right) => left.localeCompare(right),
      ),
    };
  }

  getLatestSnapshot(): SessionSnapshotV4 | null {
    return this.latestPoint?.snapshot ?? null;
  }

  async restoreLatestWorkspace(): Promise<RestoreWorkspaceResult | null> {
    const point = this.latestPoint;
    if (!point) {
      return null;
    }

    let restoredFiles = 0;
    let deletedFiles = 0;
    const restoredPaths: string[] = [];
    const deletedPaths: string[] = [];
    const backups = [...point.fileBackups.values()];

    for (const backup of backups) {
      if (backup.existed) {
        if (!backup.backupPath) {
          throw new Error(`Missing backup payload for ${backup.relativePath}`);
        }

        const content = await fs.readFile(backup.backupPath);
        await fs.mkdir(path.dirname(backup.absolutePath), { recursive: true });
        await fs.writeFile(backup.absolutePath, content);
        if (typeof backup.mode === "number") {
          await fs.chmod(backup.absolutePath, backup.mode);
        }
        restoredFiles += 1;
        restoredPaths.push(backup.relativePath);
        continue;
      }

      await fs
        .rm(backup.absolutePath, { force: true })
        .catch((error: unknown) => {
          if (!isFileNotFound(error)) {
            throw error;
          }
        });
      await pruneEmptyParentDirectories(
        path.dirname(backup.absolutePath),
        backup.workspaceRoot,
      );
      deletedFiles += 1;
      deletedPaths.push(backup.relativePath);
    }

    return {
      trackedFiles: backups.length,
      restoredFiles,
      deletedFiles,
      restoredPaths,
      deletedPaths,
    };
  }

  async clearLatest(): Promise<void> {
    if (!this.latestPoint) {
      return;
    }

    await this.discardPoint(this.latestPoint);
    this.latestPoint = null;
  }

  private async captureFileBackup(
    draft: TurnRestoreDraft,
    workspaceRoot: string,
    relativePath: string,
  ): Promise<void> {
    const absolutePath = resolveInWorkspace(workspaceRoot, relativePath);
    if (draft.fileBackups.has(absolutePath)) {
      return;
    }

    const record: FileBackupRecord = {
      workspaceRoot: path.resolve(workspaceRoot),
      absolutePath,
      relativePath,
      existed: false,
    };

    try {
      const stat = await fs.stat(absolutePath);
      record.existed = true;
      record.mode = stat.mode;
      draft.backupRoot ??= await fs.mkdtemp(
        path.join(os.tmpdir(), "step-cli-restore-"),
      );
      record.backupPath = path.join(draft.backupRoot, `${randomUUID()}.bak`);
      await fs.copyFile(absolutePath, record.backupPath);
    } catch (error) {
      if (!isFileNotFound(error)) {
        throw error;
      }
    }

    draft.fileBackups.set(absolutePath, record);
  }

  private async discardPoint(point: TurnRestorePoint): Promise<void> {
    if (!point.backupRoot) {
      return;
    }

    await fs
      .rm(point.backupRoot, { recursive: true, force: true })
      .catch(() => {});
  }
}

function normalizeRelativePaths(relativePaths: string[] | undefined): string[] {
  if (!relativePaths) {
    return [];
  }

  return [
    ...new Set(relativePaths.map((entry) => entry.trim()).filter(Boolean)),
  ].sort((left, right) => left.localeCompare(right));
}

async function pruneEmptyParentDirectories(
  startDir: string,
  workspaceRoot: string,
): Promise<void> {
  const normalizedRoot = path.resolve(workspaceRoot);
  let current = path.resolve(startDir);

  while (
    current !== normalizedRoot &&
    current.startsWith(`${normalizedRoot}${path.sep}`)
  ) {
    try {
      await fs.rmdir(current);
    } catch (error) {
      if (isFileNotFound(error)) {
        current = path.dirname(current);
        continue;
      }

      if (isDirectoryNotEmpty(error)) {
        return;
      }

      throw error;
    }

    current = path.dirname(current);
  }
}

function isDirectoryNotEmpty(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    ((error as NodeJS.ErrnoException).code === "ENOTEMPTY" ||
      (error as NodeJS.ErrnoException).code === "EEXIST"),
  );
}
