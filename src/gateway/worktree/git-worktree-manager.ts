import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import type {
  AllocateWorktreeInput,
  AllocateWorktreeResult,
  AssignedWorktreeResult,
  ManagedWorktreeEntry,
  ManagedWorktreeOwnerKind,
  WorktreeManager,
} from "@step-cli/core/agent/worktree-manager.js";
import { isFileNotFound } from "@step-cli/utils/fs.js";

interface WorktreeIndex {
  version: 1;
  repoRoot: string;
  worktrees: ManagedWorktreeEntry[];
}

interface RepoContext {
  repoRoot: string;
  workspaceSubpath: string;
}

interface GitWorktreeInfo {
  path: string;
  branch?: string;
}

interface GitCommandResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export class GitWorktreeManager implements WorktreeManager {
  private readonly workspaceRoot: string;

  constructor(input: { workspaceRoot: string }) {
    this.workspaceRoot = path.resolve(input.workspaceRoot);
  }

  async allocate(
    input: AllocateWorktreeInput,
  ): Promise<AllocateWorktreeResult> {
    const repo = await this.detectRepoContext();
    if (!repo) {
      throw new Error(
        "Git worktree isolation requires running step-cli inside a git repository.",
      );
    }

    const worktreesRoot = path.join(repo.repoRoot, ".worktrees");
    await fs.mkdir(worktreesRoot, { recursive: true });

    const index = await this.loadIndex(repo.repoRoot);
    const warnings: string[] = [];
    const now = new Date().toISOString();
    const ownerName = input.ownerName.trim();
    const preferredName = normalizeWorktreeName(input.preferredName);

    let entry = index.worktrees.find(
      (candidate) =>
        candidate.ownerKind === input.ownerKind &&
        candidate.ownerName === ownerName,
    );

    if (entry && preferredName && entry.name !== preferredName) {
      warnings.push(
        `Worktree '${entry.name}' is already assigned to ${input.ownerKind} '${ownerName}'. Reusing the existing lane.`,
      );
    }

    if (!entry) {
      const desiredName =
        preferredName ?? buildDefaultWorktreeName(input.ownerKind, ownerName);
      const conflicting = index.worktrees.find(
        (candidate) => candidate.name === desiredName,
      );
      if (conflicting) {
        if (preferredName) {
          throw new Error(
            `Worktree name '${desiredName}' is already assigned to ${conflicting.ownerKind} '${conflicting.ownerName}'.`,
          );
        }
      }

      const name = preferredName
        ? desiredName
        : pickAvailableName(index.worktrees, desiredName);
      const branch = await this.pickAvailableBranch(
        repo.repoRoot,
        `wt/${name}`,
      );
      entry = {
        name,
        path: path.join(worktreesRoot, name),
        branch,
        ownerKind: input.ownerKind,
        ownerName,
        workspaceSubpath: repo.workspaceSubpath,
        status: "stale",
        createdAt: now,
        updatedAt: now,
      };
      index.worktrees.push(entry);
    } else if (entry.workspaceSubpath !== repo.workspaceSubpath) {
      warnings.push(
        entry.workspaceSubpath
          ? `Worktree '${entry.name}' keeps its original workspace subpath '${entry.workspaceSubpath}'.`
          : `Worktree '${entry.name}' stays anchored at the repository root.`,
      );
    }

    const activeWorktrees = await this.listGitWorktrees(repo.repoRoot);
    const active = activeWorktrees.find(
      (candidate) =>
        normalizeFsPath(candidate.path) === normalizeFsPath(entry.path),
    );

    if (!active) {
      if (await pathExists(entry.path)) {
        entry.status = "stale";
        entry.updatedAt = now;
        await this.saveIndex(index);
        throw new Error(
          `Worktree path '${entry.path}' already exists but is not registered with git. Remove it manually or choose a different worktree_name.`,
        );
      }

      const branchExists = await this.branchExists(repo.repoRoot, entry.branch);
      if (branchExists) {
        await this.runGit(repo.repoRoot, [
          "worktree",
          "add",
          entry.path,
          entry.branch,
        ]);
      } else {
        await this.runGit(repo.repoRoot, [
          "worktree",
          "add",
          "-b",
          entry.branch,
          entry.path,
        ]);
      }
    } else if (active.branch) {
      entry.branch = active.branch;
    }

    entry.status = "active";
    entry.updatedAt = now;
    await this.saveIndex(index);

    return {
      workspaceRoot: resolveWorktreeWorkspaceRoot(
        entry.path,
        entry.workspaceSubpath,
      ),
      worktree: { ...entry },
      warnings: warnings.length > 0 ? warnings : undefined,
    };
  }

  async findAssigned(
    ownerKind: ManagedWorktreeOwnerKind,
    ownerName: string,
  ): Promise<AssignedWorktreeResult | null> {
    const repo = await this.detectRepoContext();
    if (!repo) {
      return null;
    }

    const index = await this.loadIndex(repo.repoRoot);
    const entry = index.worktrees.find(
      (candidate) =>
        candidate.ownerKind === ownerKind &&
        candidate.ownerName === ownerName.trim(),
    );
    if (!entry) {
      return null;
    }

    return {
      workspaceRoot: resolveWorktreeWorkspaceRoot(
        entry.path,
        entry.workspaceSubpath,
      ),
      worktree: { ...entry },
    };
  }

  private async detectRepoContext(): Promise<RepoContext | null> {
    const resolvedWorkspace = this.workspaceRoot;
    const repoResult = await runGitCapture(resolvedWorkspace, [
      "rev-parse",
      "--show-toplevel",
    ]);
    if (repoResult.exitCode !== 0) {
      return null;
    }

    const repoRoot = path.resolve(repoResult.stdout.trim());
    const workspaceSubpath = normalizeWorkspaceSubpath(
      path.relative(repoRoot, resolvedWorkspace),
    );
    if (workspaceSubpath === null) {
      return null;
    }

    return {
      repoRoot,
      workspaceSubpath,
    };
  }

  private async loadIndex(repoRoot: string): Promise<WorktreeIndex> {
    const indexPath = path.join(repoRoot, ".worktrees", "index.json");
    try {
      const raw = await fs.readFile(indexPath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      const index = parseWorktreeIndex(parsed, repoRoot);
      if (!index) {
        throw new Error(`Invalid worktree index at ${indexPath}`);
      }
      return index;
    } catch (error) {
      if (isFileNotFound(error)) {
        return {
          version: 1,
          repoRoot,
          worktrees: [],
        };
      }
      throw error;
    }
  }

  private async saveIndex(index: WorktreeIndex): Promise<void> {
    const indexPath = path.join(index.repoRoot, ".worktrees", "index.json");
    await fs.mkdir(path.dirname(indexPath), { recursive: true });
    await fs.writeFile(
      indexPath,
      `${JSON.stringify(
        {
          version: index.version,
          repoRoot: index.repoRoot,
          worktrees: index.worktrees
            .map((entry) => ({ ...entry }))
            .sort((left, right) => left.name.localeCompare(right.name)),
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }

  private async listGitWorktrees(repoRoot: string): Promise<GitWorktreeInfo[]> {
    const output = await this.runGit(repoRoot, [
      "worktree",
      "list",
      "--porcelain",
    ]);
    const entries: GitWorktreeInfo[] = [];
    const blocks = output
      .split("\n\n")
      .map((block) => block.trim())
      .filter((block) => block.length > 0);

    for (const block of blocks) {
      const current: GitWorktreeInfo = {
        path: "",
      };

      for (const line of block.split("\n")) {
        if (line.startsWith("worktree ")) {
          current.path = path.resolve(line.slice("worktree ".length).trim());
          continue;
        }
        if (line.startsWith("branch refs/heads/")) {
          current.branch = line.slice("branch refs/heads/".length).trim();
        }
      }

      if (current.path) {
        entries.push(current);
      }
    }

    return entries;
  }

  private async pickAvailableBranch(
    repoRoot: string,
    baseBranch: string,
  ): Promise<string> {
    let candidate = baseBranch;
    let suffix = 2;

    while (await this.branchExists(repoRoot, candidate)) {
      candidate = `${baseBranch}-${suffix}`;
      suffix += 1;
    }

    return candidate;
  }

  private async branchExists(
    repoRoot: string,
    branch: string,
  ): Promise<boolean> {
    const result = await runGitCapture(repoRoot, [
      "show-ref",
      "--verify",
      "--quiet",
      `refs/heads/${branch}`,
    ]);
    return result.exitCode === 0;
  }

  private async runGit(repoRoot: string, args: string[]): Promise<string> {
    const result = await runGitCapture(repoRoot, args);
    if (result.exitCode !== 0) {
      const rendered = [result.stdout.trim(), result.stderr.trim()]
        .filter((entry) => entry.length > 0)
        .join("\n");
      throw new Error(
        rendered ||
          `git ${args.join(" ")} failed with exit code ${result.exitCode}`,
      );
    }
    return result.stdout.trimEnd();
  }
}

function buildDefaultWorktreeName(
  ownerKind: ManagedWorktreeOwnerKind,
  ownerName: string,
): string {
  return (
    normalizeWorktreeName(`${ownerKind}-${ownerName}`) ?? `${ownerKind}-lane`
  );
}

function pickAvailableName(
  entries: ManagedWorktreeEntry[],
  baseName: string,
): string {
  const used = new Set(entries.map((entry) => entry.name));
  if (!used.has(baseName)) {
    return baseName;
  }

  let suffix = 2;
  while (used.has(`${baseName}-${suffix}`)) {
    suffix += 1;
  }
  return `${baseName}-${suffix}`;
}

function normalizeWorktreeName(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) {
    return undefined;
  }

  const normalized = trimmed
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[._-]+|[._-]+$/g, "");

  return normalized.length > 0 ? normalized.slice(0, 80) : undefined;
}

function normalizeWorkspaceSubpath(value: string): string | null {
  if (!value || value === ".") {
    return "";
  }

  const normalized = path.normalize(value);
  if (normalized.startsWith("..") || path.isAbsolute(normalized)) {
    return null;
  }
  return normalized;
}

function resolveWorktreeWorkspaceRoot(
  worktreePath: string,
  workspaceSubpath: string,
): string {
  if (!workspaceSubpath) {
    return worktreePath;
  }
  return path.join(worktreePath, workspaceSubpath);
}

function parseWorktreeIndex(
  value: unknown,
  repoRoot: string,
): WorktreeIndex | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  if (
    candidate.version !== 1 ||
    typeof candidate.repoRoot !== "string" ||
    !Array.isArray(candidate.worktrees)
  ) {
    return null;
  }

  if (normalizeFsPath(candidate.repoRoot) !== normalizeFsPath(repoRoot)) {
    return null;
  }

  const worktrees: ManagedWorktreeEntry[] = [];
  for (const entry of candidate.worktrees) {
    const parsed = parseManagedWorktreeEntry(entry);
    if (parsed) {
      worktrees.push(parsed);
    }
  }

  return {
    version: 1,
    repoRoot,
    worktrees,
  };
}

function parseManagedWorktreeEntry(
  value: unknown,
): ManagedWorktreeEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate.name !== "string" ||
    typeof candidate.path !== "string" ||
    typeof candidate.branch !== "string" ||
    (candidate.ownerKind !== "subagent" &&
      candidate.ownerKind !== "teammate") ||
    typeof candidate.ownerName !== "string" ||
    typeof candidate.workspaceSubpath !== "string" ||
    typeof candidate.createdAt !== "string" ||
    typeof candidate.updatedAt !== "string"
  ) {
    return null;
  }

  const status = candidate.status;
  if (status !== "active" && status !== "stale") {
    return null;
  }

  if (normalizeWorkspaceSubpath(candidate.workspaceSubpath) === null) {
    return null;
  }

  return {
    name: candidate.name,
    path: path.resolve(candidate.path),
    branch: candidate.branch,
    ownerKind: candidate.ownerKind,
    ownerName: candidate.ownerName,
    workspaceSubpath: candidate.workspaceSubpath,
    status,
    createdAt: candidate.createdAt,
    updatedAt: candidate.updatedAt,
  };
}

async function runGitCapture(
  cwd: string,
  args: string[],
): Promise<GitCommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: process.env,
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      resolve({
        exitCode: code ?? -1,
        stdout,
        stderr,
      });
    });
  });
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

function normalizeFsPath(value: string): string {
  return path.resolve(value);
}
