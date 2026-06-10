import fs from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { resolvePnpmCommand } from "./package-manager-command.mjs";

const repoRoot = process.cwd();
const ignoredDirNames = new Set([
  "dist",
  "node_modules",
  "coverage",
  ".turbo",
  ".cache",
]);

const buildTargets = [
  {
    name: "@step-cli/protocol",
    dirPath: "packages/protocol",
  },
  {
    name: "@step-cli/utils",
    dirPath: "packages/utils",
  },
  {
    name: "@step-cli/core",
    dirPath: "packages/core",
  },
  {
    name: "@step-cli/sdk",
    dirPath: "packages/sdk",
  },
  {
    name: "@step-cli/mcp",
    dirPath: "extensions/mcp",
  },
  {
    name: "@step-cli/llm",
    dirPath: "extensions/llm",
  },
  {
    name: "@step-cli/skills-builtin",
    dirPath: "skills/builtin",
  },
];

const args = new Set(process.argv.slice(2));
const staleOnly = args.has("--stale-only");
const dryRun = args.has("--dry-run");

if (args.has("--help")) {
  process.stdout.write(
    [
      "Usage: node scripts/build-packages.mjs [--stale-only] [--dry-run]",
      "",
      "Options:",
      "  --stale-only  build only packages whose src/package.json are newer than dist",
      "  --dry-run     print build decisions without executing package builds",
    ].join("\n") + "\n",
  );
  process.exit(0);
}

const decisions = [];

for (const target of buildTargets) {
  const absoluteDirPath = path.join(repoRoot, target.dirPath);
  const sourceMtimeMs = await readNewestInputMtimeMs(absoluteDirPath);
  const distMtimeMs = await readNewestFileMtimeMs(
    path.join(absoluteDirPath, "dist"),
  );
  const stale = distMtimeMs === null || sourceMtimeMs > distMtimeMs;

  decisions.push({
    ...target,
    stale,
    sourceMtimeMs,
    distMtimeMs,
  });
}

for (const decision of decisions) {
  if (staleOnly && !decision.stale) {
    process.stderr.write(`skip ${decision.name} (dist is up to date)\n`);
    continue;
  }

  const reason =
    decision.distMtimeMs === null
      ? "dist is missing"
      : "source inputs are newer than dist";

  if (dryRun) {
    process.stderr.write(`would build ${decision.name} (${reason})\n`);
    continue;
  }

  process.stderr.write(`build ${decision.name} (${reason})\n`);
  const pnpm = resolvePnpmCommand();
  await runCommand(pnpm.command, [
    ...pnpm.prefixArgs,
    "--filter",
    decision.name,
    "run",
    "build",
  ]);
}

if (dryRun) {
  const buildCount = decisions.filter((decision) =>
    staleOnly ? decision.stale : true,
  ).length;
  process.stderr.write(
    `dry-run complete (${buildCount} target${buildCount === 1 ? "" : "s"})\n`,
  );
}

async function readNewestInputMtimeMs(packageDirPath) {
  let newest = await readFileMtimeMs(path.join(packageDirPath, "package.json"));
  const srcNewest = await readNewestFileMtimeMs(path.join(packageDirPath, "src"));
  if (srcNewest !== null && (newest === null || srcNewest > newest)) {
    newest = srcNewest;
  }
  return newest ?? 0;
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
      if (entry.isDirectory() && ignoredDirNames.has(entry.name)) {
        continue;
      }

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

async function runCommand(command, commandArgs) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: repoRoot,
      env: process.env,
      stdio: "inherit",
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        reject(new Error(`${command} exited with signal ${signal}`));
        return;
      }

      if (code !== 0) {
        reject(new Error(`${command} exited with code ${code ?? 1}`));
        return;
      }

      resolve(undefined);
    });
  });
}
