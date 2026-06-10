import fs from "node:fs";
import path from "node:path";

export function discoverProjectSearchDirs(startDir: string): string[] {
  const resolvedStart = path.resolve(startDir);
  const gitRoot = findGitRoot(resolvedStart);
  if (!gitRoot) {
    return [resolvedStart];
  }

  const chain: string[] = [];
  let cursor = resolvedStart;
  while (true) {
    chain.push(cursor);
    if (cursor === gitRoot) {
      break;
    }

    const parent = path.dirname(cursor);
    if (parent === cursor) {
      break;
    }
    cursor = parent;
  }

  return chain.reverse();
}

export function findGitRoot(startDir: string): string | null {
  let cursor = path.resolve(startDir);
  while (true) {
    if (hasGitMarker(cursor)) {
      return cursor;
    }

    const parent = path.dirname(cursor);
    if (parent === cursor) {
      return null;
    }
    cursor = parent;
  }
}

function hasGitMarker(dir: string): boolean {
  try {
    return fs.existsSync(path.join(dir, ".git"));
  } catch {
    return false;
  }
}
