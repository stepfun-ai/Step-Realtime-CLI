import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);

const DEFAULT_SOURCE_ROOTS = ["src", "packages", "apps", "extensions"];
const DEFAULT_DIST_ENTRIES = [
  "dist/index.js",
  "extensions/llm/dist/index.js",
  "extensions/mcp/dist/index.js",
  "packages/protocol/dist/index.js",
  "packages/utils/dist/index.js",
  "packages/core/dist/index.js",
  "packages/sdk/dist/index.js",
];

export function getRepositoryRoot(fromUrl = import.meta.url) {
  return path.resolve(path.dirname(fileURLToPath(fromUrl)), "..");
}

export async function resolveStepCliEntrypoint(options = {}) {
  const repoRoot = options.repoRoot ?? getRepositoryRoot();
  const argv = options.argv ?? process.argv.slice(2);
  const stderr = options.stderr ?? process.stderr;
  const packageResolver = options.packageResolver ?? defaultPackageResolver;
  const sourceRoots = options.sourceRoots ?? DEFAULT_SOURCE_ROOTS;
  const requiredDistEntries =
    options.requiredDistEntries ?? DEFAULT_DIST_ENTRIES;

  const srcEntry = path.join(repoRoot, "src", "index.ts");
  const distEntry = path.join(repoRoot, "dist", "index.js");
  const hasSourceEntry = (await readFileMtimeMs(srcEntry)) !== null;
  const tsxImportPath = resolvePackagePath("tsx", packageResolver);
  const tsxAvailable = tsxImportPath !== null;
  const distStatus = await readDistStatus(repoRoot, requiredDistEntries);
  const newestSourceMtimeMs = await readNewestRootsMtimeMs(
    repoRoot,
    sourceRoots,
  );
  const distStale =
    newestSourceMtimeMs !== null &&
    (distStatus.newestMtimeMs === null ||
      newestSourceMtimeMs > distStatus.newestMtimeMs);

  if (hasSourceEntry && (!distStatus.ready || distStale) && tsxAvailable) {
    if (distStale && distStatus.ready) {
      stderr.write(
        "step-cli: detected newer source files than dist; running src/index.ts via tsx\n",
      );
    } else {
      stderr.write(
        "step-cli: build artifacts are missing or incomplete; running src/index.ts via tsx\n",
      );
    }

    return {
      kind: "spawn-tsx",
      entryPath: srcEntry,
      command: process.execPath,
      args: ["--import", pathToFileURL(tsxImportPath).href, srcEntry, ...argv],
    };
  }

  if (distStatus.ready) {
    if (distStale && hasSourceEntry && !tsxAvailable) {
      stderr.write(
        "step-cli: source files are newer than dist, but tsx is unavailable; continuing with dist/index.js\n",
      );
    }

    return {
      kind: "import-dist",
      entryPath: distEntry,
    };
  }

  if (hasSourceEntry && tsxAvailable) {
    stderr.write(
      "step-cli: dist artifacts are unavailable; running src/index.ts via tsx\n",
    );
    return {
      kind: "spawn-tsx",
      entryPath: srcEntry,
      command: process.execPath,
      args: ["--import", pathToFileURL(tsxImportPath).href, srcEntry, ...argv],
    };
  }

  const missingArtifacts =
    distStatus.missingPaths.length > 0
      ? ` Missing: ${distStatus.missingPaths.join(", ")}.`
      : "";
  throw new Error(
    `Unable to find a runnable entrypoint. Checked ${distEntry} and ${srcEntry}.${missingArtifacts} Install dev dependencies or run pnpm build.`,
  );
}

export async function runResolvedEntrypoint(entrypoint) {
  if (entrypoint.kind === "import-dist") {
    await import(pathToFileURL(entrypoint.entryPath).href);
    return;
  }

  await new Promise((resolve, reject) => {
    const child = spawn(entrypoint.command, entrypoint.args, {
      cwd: process.cwd(),
      env: process.env,
      stdio: "inherit",
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }

      process.exitCode = code ?? 1;
      resolve(undefined);
    });
  });
}

function resolvePackagePath(specifier, packageResolver) {
  try {
    return packageResolver(specifier);
  } catch {
    return null;
  }
}

function defaultPackageResolver(specifier) {
  return require.resolve(specifier);
}

async function readDistStatus(repoRoot, requiredEntries) {
  const missingPaths = [];
  let newestMtimeMs = null;

  for (const relativeEntry of requiredEntries) {
    const absoluteEntry = path.join(repoRoot, relativeEntry);
    const entryMtimeMs = await readFileMtimeMs(absoluteEntry);
    if (entryMtimeMs === null) {
      missingPaths.push(relativeEntry);
      continue;
    }

    if (newestMtimeMs === null || entryMtimeMs > newestMtimeMs) {
      newestMtimeMs = entryMtimeMs;
    }
  }

  return {
    ready: missingPaths.length === 0,
    newestMtimeMs,
    missingPaths,
  };
}

async function readNewestRootsMtimeMs(repoRoot, roots) {
  let newest = null;

  for (const root of roots) {
    const rootNewest = await readNewestFileMtimeMs(path.join(repoRoot, root));
    if (rootNewest !== null && (newest === null || rootNewest > newest)) {
      newest = rootNewest;
    }
  }

  return newest;
}

async function readFileMtimeMs(filePath) {
  try {
    const stats = await fs.stat(filePath);
    return stats.isFile() ? stats.mtimeMs : null;
  } catch {
    return null;
  }
}

async function readNewestFileMtimeMs(entryPath) {
  try {
    const stats = await fs.stat(entryPath);
    if (stats.isFile()) {
      return stats.mtimeMs;
    }

    if (!stats.isDirectory()) {
      return null;
    }

    let newest = null;
    const entries = await fs.readdir(entryPath, { withFileTypes: true });
    for (const entry of entries) {
      const childPath = path.join(entryPath, entry.name);
      const childNewest = await readNewestFileMtimeMs(childPath);
      if (childNewest !== null && (newest === null || childNewest > newest)) {
        newest = childNewest;
      }
    }

    return newest;
  } catch {
    return null;
  }
}
