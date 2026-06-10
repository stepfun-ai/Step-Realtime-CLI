import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export function uniquePaths(paths: string[]): string[] {
  return [...new Set(paths.map((entry) => path.resolve(entry)))];
}

export function expandHomeDirectory(targetPath: string): string {
  if (targetPath === "~") {
    return os.homedir();
  }

  if (targetPath.startsWith("~/") || targetPath.startsWith("~\\")) {
    return path.join(os.homedir(), targetPath.slice(2));
  }

  return targetPath;
}

export function resolveStorageRootDirectory(
  workspaceRoot: string,
  storageRootDir: string,
): string {
  const expanded = expandHomeDirectory(storageRootDir);
  return path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(workspaceRoot, expanded);
}

export function resolveInWorkspace(
  workspaceRoot: string,
  targetPath: string,
): string {
  const resolved = path.resolve(workspaceRoot, targetPath);
  const normalizedRoot = path.resolve(workspaceRoot);

  if (resolved === normalizedRoot) {
    return resolved;
  }

  if (!resolved.startsWith(`${normalizedRoot}${path.sep}`)) {
    throw new Error(`Path escapes workspace root: ${targetPath}`);
  }

  return resolved;
}

export async function resolveExistingPathInWorkspace(
  workspaceRoot: string,
  targetPath: string,
): Promise<string> {
  const resolved = resolveInWorkspace(workspaceRoot, targetPath);
  const workspaceRootReal = await fs.realpath(path.resolve(workspaceRoot));
  await assertAddressedSymlinkParentInWorkspace(
    workspaceRootReal,
    resolved,
    targetPath,
  );
  const targetReal = await fs.realpath(resolved);

  assertRealPathInWorkspace(workspaceRootReal, targetReal, targetPath);
  return targetReal;
}

export async function resolveAddressedExistingPathInWorkspace(
  workspaceRoot: string,
  targetPath: string,
): Promise<string> {
  const resolved = resolveInWorkspace(workspaceRoot, targetPath);
  const workspaceRootReal = await fs.realpath(path.resolve(workspaceRoot));
  await assertAddressedSymlinkParentInWorkspace(
    workspaceRootReal,
    resolved,
    targetPath,
  );
  const targetReal = await fs.realpath(resolved);

  assertRealPathInWorkspace(workspaceRootReal, targetReal, targetPath);
  return resolved;
}

export async function resolveAddressedPathEntryInWorkspace(
  workspaceRoot: string,
  targetPath: string,
): Promise<string> {
  const resolved = resolveInWorkspace(workspaceRoot, targetPath);
  const workspaceRootReal = await fs.realpath(path.resolve(workspaceRoot));
  const stat = await assertAddressedSymlinkParentInWorkspace(
    workspaceRootReal,
    resolved,
    targetPath,
  );

  if (stat.isSymbolicLink()) {
    return resolved;
  }

  const targetReal = await fs.realpath(resolved);
  assertRealPathInWorkspace(workspaceRootReal, targetReal, targetPath);
  return resolved;
}

export async function resolveWritablePathInWorkspace(
  workspaceRoot: string,
  targetPath: string,
): Promise<string> {
  const resolved = resolveInWorkspace(workspaceRoot, targetPath);
  const workspaceRootReal = await fs.realpath(path.resolve(workspaceRoot));

  const existing = await findNearestExistingPath(resolved);
  assertRealPathInWorkspace(workspaceRootReal, existing.realPath, targetPath);

  return path.resolve(existing.realPath, ...existing.relativeParts);
}

async function findNearestExistingPath(
  resolvedPath: string,
  seenSymlinks = new Set<string>(),
): Promise<{
  realPath: string;
  relativeParts: string[];
}> {
  const relativeParts: string[] = [];
  let candidate = resolvedPath;

  while (true) {
    try {
      return {
        realPath: await fs.realpath(candidate),
        relativeParts,
      };
    } catch (error) {
      if (!isFileNotFound(error)) {
        throw error;
      }

      const symlinkTarget = await readSymlinkTarget(candidate);
      if (symlinkTarget) {
        const candidateKey = path.resolve(candidate);
        if (seenSymlinks.has(candidateKey)) {
          throw new Error(
            `Symlink cycle while resolving path: ${resolvedPath}`,
          );
        }
        seenSymlinks.add(candidateKey);

        return findNearestExistingPath(
          path.resolve(
            path.dirname(candidate),
            symlinkTarget,
            ...relativeParts,
          ),
          seenSymlinks,
        );
      }
    }

    const parent = path.dirname(candidate);
    if (parent === candidate) {
      throw new Error(`Unable to find existing path ancestor: ${resolvedPath}`);
    }

    relativeParts.unshift(path.basename(candidate));
    candidate = parent;
  }
}

async function assertAddressedSymlinkParentInWorkspace(
  workspaceRootReal: string,
  resolvedPath: string,
  targetPath: string,
): Promise<Awaited<ReturnType<typeof fs.lstat>>> {
  const stat = await fs.lstat(resolvedPath);
  if (stat.isSymbolicLink()) {
    const parentReal = await fs.realpath(path.dirname(resolvedPath));
    assertRealPathInWorkspace(workspaceRootReal, parentReal, targetPath);
  }
  return stat;
}

async function readSymlinkTarget(
  candidate: string,
): Promise<string | undefined> {
  try {
    const stat = await fs.lstat(candidate);
    if (!stat.isSymbolicLink()) {
      return undefined;
    }
    return fs.readlink(candidate);
  } catch (error) {
    if (isFileNotFound(error)) {
      return undefined;
    }
    throw error;
  }
}

function assertRealPathInWorkspace(
  workspaceRootReal: string,
  targetReal: string,
  targetPath: string,
): void {
  const relative = path.relative(workspaceRootReal, targetReal);
  if (relative === "") {
    return;
  }

  if (
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  ) {
    return;
  }

  throw new Error(`Path escapes workspace root: ${targetPath}`);
}

function isFileNotFound(error: unknown): boolean {
  return Boolean(
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT",
  );
}

export function toWorkspaceRelative(
  workspaceRoot: string,
  absolutePath: string,
): string {
  const relative = path.relative(workspaceRoot, absolutePath);
  if (!relative || relative === ".") {
    return ".";
  }
  return relative;
}
