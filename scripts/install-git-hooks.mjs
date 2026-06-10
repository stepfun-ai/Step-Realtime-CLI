import { execFileSync } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const { PREPEND_SCRIPT, skipInstall } = require("simple-git-hooks");

const VALID_GIT_HOOKS = [
  "applypatch-msg",
  "pre-applypatch",
  "post-applypatch",
  "pre-commit",
  "pre-merge-commit",
  "prepare-commit-msg",
  "commit-msg",
  "post-commit",
  "pre-rebase",
  "post-checkout",
  "post-merge",
  "pre-push",
  "pre-receive",
  "update",
  "proc-receive",
  "post-receive",
  "post-update",
  "reference-transaction",
  "push-to-checkout",
  "pre-auto-gc",
  "post-rewrite",
  "sendemail-validate",
  "fsmonitor-watchman",
  "p4-changelist",
  "p4-prepare-changelist",
  "p4-post-changelist",
  "p4-pre-submit",
  "post-index-change",
];

export function resolveHooksDirectory(projectRoot, runGit = runGitCommand) {
  const configuredHooksPath = tryRunGit(
    runGit,
    ["config", "--local", "--get", "core.hooksPath"],
    projectRoot,
  ).trim();

  if (configuredHooksPath) {
    return path.isAbsolute(configuredHooksPath)
      ? path.normalize(configuredHooksPath)
      : path.resolve(projectRoot, configuredHooksPath);
  }

  const commonGitDir = runGit(
    ["rev-parse", "--path-format=absolute", "--git-common-dir"],
    projectRoot,
  ).trim();

  return path.join(commonGitDir, "hooks");
}

export async function installConfiguredHooks({ hooksDir, config }) {
  const preserveUnused = Array.isArray(config.preserveUnused)
    ? config.preserveUnused
    : config.preserveUnused
      ? VALID_GIT_HOOKS
      : [];

  await fs.mkdir(hooksDir, { recursive: true });

  for (const hookName of VALID_GIT_HOOKS) {
    if (Object.prototype.hasOwnProperty.call(config, hookName)) {
      await writeHook(hooksDir, hookName, String(config[hookName]));
      continue;
    }

    if (!preserveUnused.includes(hookName)) {
      await removeManagedHook(hooksDir, hookName);
    }
  }
}

export async function readPackageHookConfig(projectRoot) {
  const packageJsonPath = path.join(projectRoot, "package.json");
  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
  const config = packageJson["simple-git-hooks"];

  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("simple-git-hooks config was not found in package.json");
  }

  return config;
}

export async function installGitHooks({
  projectRoot = process.cwd(),
  runGit = runGitCommand,
} = {}) {
  if (skipInstall()) {
    return;
  }

  const hooksDir = resolveHooksDirectory(projectRoot, runGit);
  const config = await readPackageHookConfig(projectRoot);

  await installConfiguredHooks({ hooksDir, config });
  console.log(`[INFO] Successfully set git hooks in ${hooksDir}`);
}

function runGitCommand(args, cwd) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function tryRunGit(runGit, args, projectRoot) {
  try {
    return runGit(args, projectRoot);
  } catch {
    return "";
  }
}

async function writeHook(hooksDir, hookName, command) {
  const hookPath = path.join(hooksDir, hookName);
  await fs.writeFile(hookPath, `${PREPEND_SCRIPT}${command}`, "utf8");
  await fs.chmod(hookPath, 0o755);
  console.log(
    `[INFO] Successfully set the ${hookName} with command: ${command}`,
  );
}

async function removeManagedHook(hooksDir, hookName) {
  const hookPath = path.join(hooksDir, hookName);
  let hook;
  try {
    hook = await fs.readFile(hookPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return;
    }
    throw error;
  }

  if (hook.startsWith(PREPEND_SCRIPT)) {
    await fs.rm(hookPath, { force: true });
  }
}

const isMain = process.argv[1]
  ? fileURLToPath(import.meta.url) === path.resolve(process.argv[1])
  : false;

if (isMain) {
  installGitHooks().catch((error) => {
    console.log(`[ERROR], Was not able to set git hooks. Error: ${error}`);
  });
}
