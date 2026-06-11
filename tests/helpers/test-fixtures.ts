import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// ---------------------------------------------------------------------------
// Filesystem fixture utilities for integration tests
// ---------------------------------------------------------------------------

/**
 * Returns the system temp directory.
 */
export function getTempDir(): string {
  return os.tmpdir();
}

/**
 * Normalizes two paths for comparison (resolves symlinks and case).
 */
export function pathEquals(a: string, b: string): boolean {
  return path.resolve(a) === path.resolve(b);
}

/**
 * Returns true if `child` is inside `parent`.
 */
export function pathContains(parent: string, child: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return !rel.startsWith("..") && !path.isAbsolute(rel);
}

/**
 * Creates a temporary directory with the given prefix.
 * Remember to call `cleanupFixtureDir(dir)` in afterEach.
 */
export async function createFixtureDir(prefix = "step-test-"): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), prefix));
}

/**
 * Recursively removes a fixture directory.
 */
export async function cleanupFixtureDir(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true });
}

/**
 * Writes a map of relative paths to content under `root`.
 * Automatically creates intermediate directories.
 */
export async function createFixtureFiles(
  root: string,
  files: Record<string, string>,
): Promise<void> {
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = path.join(root, relativePath);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, "utf-8");
  }
}

/**
 * Generates a file with `lines` lines of ~80-char padding text.
 */
export async function createLargeFile(
  dir: string,
  name: string,
  lines: number,
): Promise<string> {
  const filePath = path.join(dir, name);
  const content = Array.from(
    { length: lines },
    (_, i) => `line ${i.toString().padStart(6, "0")} ` + "x".repeat(70),
  ).join("\n");
  await fs.writeFile(filePath, content, "utf-8");
  return filePath;
}
