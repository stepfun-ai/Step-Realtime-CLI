import fs from "node:fs/promises";
import path from "node:path";
import type { ToolSpec } from "@step-cli/protocol";
import {
  applyUpdateChunks,
  listTouchedPaths,
  parseApplyPatchDocument,
  type ApplyPatchDocument,
} from "./apply-patch.js";
import {
  parseJsonObject,
  readRequiredStringField,
} from "@step-cli/core/tools/args.js";
import {
  resolveAddressedPathEntryInWorkspace,
  resolveAddressedExistingPathInWorkspace,
  resolveInWorkspace,
  resolveWritablePathInWorkspace,
  toWorkspaceRelative,
} from "@step-cli/utils/path.js";
import { createMultiPathWriteInspection } from "./tool-inspection.js";

interface ApplyPatchArgs {
  patch: string;
}

type ApplyPatchOperation = ApplyPatchDocument["operations"][number];
type PreparedPatchOperation =
  | {
      kind: "add";
      operation: Extract<ApplyPatchOperation, { kind: "add" }>;
      absolute: string;
      content: string;
    }
  | {
      kind: "delete";
      operation: Extract<ApplyPatchOperation, { kind: "delete" }>;
      absolute: string;
    }
  | {
      kind: "update";
      operation: Extract<ApplyPatchOperation, { kind: "update" }>;
      sourceAbsolute: string;
      destinationAbsolute: string;
      writeTargetAbsolute?: string;
      content: string;
    };

type PathSnapshot =
  | {
      kind: "absent";
      absolute: string;
    }
  | {
      kind: "file";
      absolute: string;
      content: Buffer;
      mode: number;
    }
  | {
      kind: "symlink";
      absolute: string;
      target: string;
    }
  | {
      kind: "directory";
      absolute: string;
      mode: number;
    };

export function createApplyPatchTool(): ToolSpec<ApplyPatchArgs> {
  return {
    definition: {
      type: "function",
      function: {
        name: "apply_patch",
        description:
          "Apply a structured multi-file patch. Prefer this over shelling out to apply_patch.",
        parameters: {
          type: "object",
          required: ["patch"],
          additionalProperties: false,
          properties: {
            patch: {
              type: "string",
              description:
                "Patch text in Codex apply_patch format beginning with '*** Begin Patch' and ending with '*** End Patch'.",
            },
          },
        },
      },
    },
    security: {
      risk: "write",
      defaultMode: "confirm",
    },
    parseArgs: (rawArgs) => {
      const payload = parseJsonObject(rawArgs);
      return {
        patch: readRequiredStringField(payload.patch, "patch"),
      };
    },
    inspect: ({ args }) => inspectApplyPatchArgs(args),
    execute: async (args, ctx) => {
      const document = parseApplyPatchDocument(args.patch);
      const changedPaths = await applyPatchDocument(
        ctx.workspaceRoot,
        document,
      );

      return {
        ok: true,
        summary:
          changedPaths.length === 1
            ? "Applied patch to 1 path"
            : `Applied patch to ${changedPaths.length} paths`,
        data: {
          changedPaths,
        },
      };
    },
  };
}

async function applyPatchDocument(
  workspaceRoot: string,
  document: ApplyPatchDocument,
): Promise<string[]> {
  const changed = new Set<string>();
  const preparedOperations = await preparePatchOperations(
    workspaceRoot,
    document,
  );
  const snapshots = await snapshotPreparedOperationPaths(
    workspaceRoot,
    preparedOperations,
  );

  try {
    for (const prepared of preparedOperations) {
      if (prepared.kind === "add") {
        const { absolute, content } = prepared;
        await fs.mkdir(path.dirname(absolute), { recursive: true });
        await fs.writeFile(absolute, content, "utf8");
        changed.add(toWorkspaceRelative(workspaceRoot, absolute));
        continue;
      }

      if (prepared.kind === "delete") {
        const { absolute } = prepared;
        await fs.rm(absolute);
        changed.add(toWorkspaceRelative(workspaceRoot, absolute));
        continue;
      }

      const { sourceAbsolute, destinationAbsolute, content } = prepared;
      await fs.mkdir(path.dirname(destinationAbsolute), { recursive: true });
      await fs.writeFile(destinationAbsolute, content, "utf8");
      if (destinationAbsolute !== sourceAbsolute) {
        await fs.rm(sourceAbsolute);
        changed.add(toWorkspaceRelative(workspaceRoot, sourceAbsolute));
      }
      changed.add(toWorkspaceRelative(workspaceRoot, destinationAbsolute));
    }
  } catch (error) {
    await restorePathSnapshots(snapshots);
    throw error;
  }

  return [...changed].sort((left, right) => left.localeCompare(right));
}

async function snapshotPreparedOperationPaths(
  workspaceRoot: string,
  preparedOperations: PreparedPatchOperation[],
): Promise<PathSnapshot[]> {
  const snapshots = new Map<string, PathSnapshot>();
  const addPathSnapshot = async (absolute: string): Promise<void> => {
    const resolved = path.resolve(absolute);
    if (!snapshots.has(resolved)) {
      snapshots.set(resolved, await snapshotPath(resolved));
    }
  };
  const addWritePathSnapshot = async (absolute: string): Promise<void> => {
    const parentDirectories = await collectMissingParentDirectories(
      workspaceRoot,
      absolute,
    );
    for (const parentDirectory of parentDirectories) {
      await addPathSnapshot(parentDirectory);
    }
    await addPathSnapshot(absolute);
  };

  for (const prepared of preparedOperations) {
    if (prepared.kind === "add") {
      await addWritePathSnapshot(prepared.absolute);
      continue;
    }

    if (prepared.kind === "delete") {
      await addPathSnapshot(prepared.absolute);
      continue;
    }

    await addPathSnapshot(prepared.sourceAbsolute);
    if (prepared.destinationAbsolute === prepared.sourceAbsolute) {
      await addPathSnapshot(prepared.destinationAbsolute);
    } else {
      await addWritePathSnapshot(prepared.destinationAbsolute);
    }
    if (prepared.writeTargetAbsolute) {
      await addPathSnapshot(prepared.writeTargetAbsolute);
    }
  }

  return [...snapshots.values()];
}

async function collectMissingParentDirectories(
  workspaceRoot: string,
  absolute: string,
): Promise<string[]> {
  const root = await fs.realpath(path.resolve(workspaceRoot));
  const missing: string[] = [];
  let current = path.dirname(path.resolve(absolute));

  while (isWithinDirectory(root, current) && current !== root) {
    try {
      await fs.lstat(current);
      break;
    } catch (error) {
      if (!isMissingPath(error)) {
        throw error;
      }
      missing.push(current);
      current = path.dirname(current);
    }
  }

  return missing.reverse();
}

function isWithinDirectory(root: string, absolute: string): boolean {
  const relative = path.relative(root, absolute);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

async function resolveSymlinkTarget(
  absolute: string,
): Promise<string | undefined> {
  try {
    const stat = await fs.lstat(absolute);
    return stat.isSymbolicLink() ? fs.realpath(absolute) : undefined;
  } catch (error) {
    if (isMissingPath(error)) {
      return undefined;
    }
    throw error;
  }
}

async function snapshotPath(absolute: string): Promise<PathSnapshot> {
  try {
    const stat = await fs.lstat(absolute);
    if (stat.isSymbolicLink()) {
      return {
        kind: "symlink",
        absolute,
        target: await fs.readlink(absolute),
      };
    }

    if (stat.isDirectory()) {
      return {
        kind: "directory",
        absolute,
        mode: stat.mode & 0o777,
      };
    }

    return {
      kind: "file",
      absolute,
      content: await fs.readFile(absolute),
      mode: stat.mode & 0o777,
    };
  } catch (error) {
    if (isMissingPath(error)) {
      return { kind: "absent", absolute };
    }
    throw error;
  }
}

async function restorePathSnapshots(snapshots: PathSnapshot[]): Promise<void> {
  for (const snapshot of [...snapshots].reverse()) {
    if (snapshot.kind === "directory") {
      await fs.mkdir(snapshot.absolute, { recursive: true });
      await fs.chmod(snapshot.absolute, snapshot.mode);
      continue;
    }

    await removePathIfPresent(snapshot.absolute);
    if (snapshot.kind === "absent") {
      continue;
    }

    await fs.mkdir(path.dirname(snapshot.absolute), { recursive: true });
    if (snapshot.kind === "symlink") {
      await fs.symlink(snapshot.target, snapshot.absolute);
      continue;
    }

    await fs.writeFile(snapshot.absolute, snapshot.content);
    await fs.chmod(snapshot.absolute, snapshot.mode);
  }
}

async function removePathIfPresent(absolute: string): Promise<void> {
  try {
    await fs.rm(absolute, { recursive: true, force: true });
  } catch (error) {
    if (isMissingPath(error)) {
      return;
    }
    throw error;
  }
}

function isMissingPath(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    ((error as NodeJS.ErrnoException).code === "ENOENT" ||
      (error as NodeJS.ErrnoException).code === "ENOTDIR"),
  );
}

async function preparePatchOperations(
  workspaceRoot: string,
  document: ApplyPatchDocument,
): Promise<PreparedPatchOperation[]> {
  const prepared: PreparedPatchOperation[] = [];
  const touched = new Map<string, string>();

  for (const operation of document.operations) {
    if (operation.kind === "add") {
      const absolute = await resolveWritablePathInWorkspace(
        workspaceRoot,
        operation.path,
      );
      registerTouchedPath(workspaceRoot, touched, absolute, operation);
      prepared.push({
        kind: "add",
        operation,
        absolute,
        content: `${operation.lines.join("\n")}\n`,
      });
      continue;
    }

    if (operation.kind === "delete") {
      const absolute = await resolveAddressedPathEntryInWorkspace(
        workspaceRoot,
        operation.path,
      );
      registerTouchedPath(workspaceRoot, touched, absolute, operation);
      prepared.push({
        kind: "delete",
        operation,
        absolute,
      });
      continue;
    }

    const sourceAbsolute = await resolveAddressedExistingPathInWorkspace(
      workspaceRoot,
      operation.path,
    );
    const destinationAbsolute = operation.moveTo
      ? await resolveWritablePathInWorkspace(workspaceRoot, operation.moveTo)
      : sourceAbsolute;
    if (operation.moveTo) {
      await assertMoveDestinationIsNotSymlink(workspaceRoot, operation.moveTo);
    }
    const writeTargetAbsolute =
      destinationAbsolute === sourceAbsolute
        ? await resolveSymlinkTarget(sourceAbsolute)
        : undefined;
    registerTouchedPath(workspaceRoot, touched, sourceAbsolute, operation);
    if (destinationAbsolute !== sourceAbsolute) {
      registerTouchedPath(
        workspaceRoot,
        touched,
        destinationAbsolute,
        operation,
      );
    }
    if (writeTargetAbsolute && writeTargetAbsolute !== sourceAbsolute) {
      registerTouchedPath(
        workspaceRoot,
        touched,
        writeTargetAbsolute,
        operation,
      );
    }
    const original = await fs.readFile(sourceAbsolute, "utf8");
    prepared.push({
      kind: "update",
      operation,
      sourceAbsolute,
      destinationAbsolute,
      writeTargetAbsolute,
      content: applyUpdateChunks(original, operation.chunks),
    });
  }

  return prepared;
}

async function assertMoveDestinationIsNotSymlink(
  workspaceRoot: string,
  targetPath: string,
): Promise<void> {
  const addressedDestination = resolveInWorkspace(workspaceRoot, targetPath);
  try {
    const stat = await fs.lstat(addressedDestination);
    if (stat.isSymbolicLink()) {
      throw new Error(
        `apply_patch move destination is a symbolic link: ${targetPath}`,
      );
    }
  } catch (error) {
    if (isMissingPath(error)) {
      return;
    }
    throw error;
  }
}

function registerTouchedPath(
  workspaceRoot: string,
  touched: Map<string, string>,
  absolute: string,
  operation: ApplyPatchOperation,
): void {
  const normalized = path.resolve(absolute);
  const operationDescription = describePatchOperation(operation);
  const previous = touched.get(normalized);
  if (previous) {
    throw new Error(
      `Conflicting apply_patch operations for ${toWorkspaceRelative(
        workspaceRoot,
        normalized,
      )}: ${previous}; ${operationDescription}`,
    );
  }

  touched.set(normalized, operationDescription);
}

function describePatchOperation(operation: ApplyPatchOperation): string {
  if (operation.kind === "add") {
    return `add ${operation.path}`;
  }
  if (operation.kind === "delete") {
    return `delete ${operation.path}`;
  }
  if (operation.moveTo) {
    return `move ${operation.path} -> ${operation.moveTo}`;
  }
  return `update ${operation.path}`;
}

function inspectApplyPatchArgs(args: ApplyPatchArgs) {
  const document = parseApplyPatchDocument(args.patch);
  const touchedPaths = listTouchedPaths(document);
  const fileOperations = document.operations.map((operation) => {
    if (operation.kind === "add") {
      return `add ${operation.path}`;
    }
    if (operation.kind === "delete") {
      return `delete ${operation.path}`;
    }
    if (operation.moveTo) {
      return `move ${operation.path} -> ${operation.moveTo}`;
    }
    return `update ${operation.path}`;
  });

  return createMultiPathWriteInspection(touchedPaths, {
    approvalFingerprint: touchedPaths.join("|"),
    inputHint:
      fileOperations.length === 1
        ? fileOperations[0]
        : `${fileOperations.length} file operations`,
    fileOperations,
  });
}
