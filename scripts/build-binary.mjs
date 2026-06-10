import path from "node:path";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";

const repoRoot = process.cwd();
const binaryName = process.platform === "win32" ? "step.exe" : "step";
const binaryPath = path.join(repoRoot, "dist", "bin", binaryName);
const bunBin =
  process.env.STEP_BUN_BIN || process.env.STEP_RELEASE_BUN_BIN || "bun";
const buildVersion =
  process.env.STEP_CLI_BUILD_VERSION || (await readPackageVersion(repoRoot));

if (process.argv.includes("--help")) {
  process.stdout.write(
    [
      "Usage: node scripts/build-binary.mjs",
      "",
      "Builds a current-platform CLI executable at dist/bin/step using Bun compile.",
    ].join("\n") + "\n",
  );
  process.exit(0);
}

await runCommand(process.execPath, [
  path.join(repoRoot, "scripts", "build-packages.mjs"),
  "--stale-only",
]);

await runCommand(bunBin, [
  "build",
  "--compile",
  "--env",
  "STEP_CLI_BUILD_*",
  `--outfile=${binaryPath}`,
  path.join(repoRoot, "src", "index.ts"),
], {
  STEP_CLI_BUILD_VERSION: buildVersion,
});

if (process.platform === "darwin") {
  await runBestEffortCommand("codesign", ["--remove-signature", binaryPath]);
  await runBestEffortCommand("codesign", ["--sign", "-", binaryPath]);
}

process.stdout.write(`Built CLI binary: ${path.relative(repoRoot, binaryPath)}\n`);

async function runBestEffortCommand(command, args) {
  try {
    await runCommand(command, args);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stdout.write(`warning: ${message}\n`);
  }
}

async function runCommand(command, args, extraEnv = {}) {
  await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: repoRoot,
      env: {
        ...process.env,
        ...extraEnv,
      },
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

async function readPackageVersion(root) {
  const packageJsonPath = path.join(root, "package.json");
  const raw = await fs.readFile(packageJsonPath, "utf8");
  const parsed = JSON.parse(raw);
  if (typeof parsed.version !== "string" || parsed.version.trim() === "") {
    throw new Error("package.json version is missing");
  }
  return parsed.version;
}
