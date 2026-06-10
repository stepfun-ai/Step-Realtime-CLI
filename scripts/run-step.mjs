import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const repoRoot = process.cwd();
const scriptArgs = process.argv.slice(2);
const bunBin = process.env.STEP_BUN_BIN || process.execPath;
const require = createRequire(import.meta.url);

try {
  const exitCode = await main();
  if (exitCode !== 0) {
    process.exit(exitCode);
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`step-cli wrapper error: ${message}\n`);
  process.exit(1);
}

async function main() {
  let staleOnly = true;
  if (scriptArgs[0] === "--full") {
    staleOnly = false;
    scriptArgs.shift();
  } else if (scriptArgs[0] === "--stale-only") {
    scriptArgs.shift();
  }

  if (scriptArgs[0] === "--") {
    scriptArgs.shift();
  }

  const buildExitCode = await runCommand(process.execPath, [
    path.join(repoRoot, "scripts", "build-packages.mjs"),
    ...(staleOnly ? ["--stale-only"] : []),
  ]);
  if (buildExitCode !== 0) {
    return buildExitCode;
  }

  const entrypoint = path.join(repoRoot, "src", "index.ts");
  if (path.basename(bunBin).startsWith("bun")) {
    return runCommand(bunBin, [entrypoint, ...scriptArgs]);
  }

  return runCommand(bunBin, [
    "--import",
    pathToFileURL(require.resolve("tsx")).href,
    entrypoint,
    ...scriptArgs,
  ]);
}

async function runCommand(command, commandArgs) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: repoRoot,
      env: process.env,
      stdio: "inherit",
    });

    child.once("error", reject);
    child.once("exit", (code, signal) => {
      if (signal) {
        process.kill(process.pid, signal);
        return;
      }

      resolve(code ?? 1);
    });
  });
}
