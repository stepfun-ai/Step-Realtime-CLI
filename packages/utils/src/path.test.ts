import { describe, it, expect } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  uniquePaths,
  expandHomeDirectory,
  resolveStorageRootDirectory,
} from "./path.js";

// ---------------------------------------------------------------------------
// path.ts (from batch2)
// ---------------------------------------------------------------------------
describe("uniquePaths", () => {
  it("deduplicates identical paths", () => {
    const result = uniquePaths(["/a/b", "/a/b", "/a/b"]);
    expect(result).toHaveLength(1);
  });

  it("resolves relative paths to absolute and deduplicates", () => {
    const cwd = process.cwd();
    const result = uniquePaths(["foo", "./foo", `${cwd}/foo`]);
    expect(result).toHaveLength(1);
    expect(result[0]).toBe(path.resolve(cwd, "foo"));
  });

  it("keeps distinct paths separate", () => {
    const result = uniquePaths(["/a/b", "/c/d"]);
    expect(result).toHaveLength(2);
  });
});

describe("expandHomeDirectory", () => {
  it("expands ~/ to home directory", () => {
    const home = os.homedir();
    expect(expandHomeDirectory("~/projects")).toBe(path.join(home, "projects"));
  });

  it("expands bare ~ to home directory", () => {
    expect(expandHomeDirectory("~")).toBe(os.homedir());
  });

  it("passes through paths that do not start with ~", () => {
    expect(expandHomeDirectory("/absolute/path")).toBe("/absolute/path");
    expect(expandHomeDirectory("relative/path")).toBe("relative/path");
  });

  it("handles ~\\ style paths (Windows backslash)", () => {
    const home = os.homedir();
    expect(expandHomeDirectory("~\\projects")).toBe(
      path.join(home, "projects"),
    );
  });

  it("does not expand ~user style paths", () => {
    // Only bare ~ and ~/ are expanded
    expect(expandHomeDirectory("~otheruser/file")).toBe("~otheruser/file");
  });
});

describe("resolveStorageRootDirectory", () => {
  it("resolves an absolute path as-is", async () => {
    const tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "step-test-resolve-"),
    );
    try {
      const result = resolveStorageRootDirectory(tmpDir, "/absolute/storage");
      expect(result).toBe(path.resolve("/absolute/storage"));
    } finally {
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it("resolves a relative path against workspaceRoot", async () => {
    const tmpDir = await fs.mkdtemp(
      path.join(os.tmpdir(), "step-test-relative-"),
    );
    try {
      const result = resolveStorageRootDirectory(tmpDir, "storage/data");
      expect(result).toBe(path.resolve(tmpDir, "storage/data"));
    } finally {
      await fs.rm(tmpDir, { recursive: true });
    }
  });

  it("expands ~ and resolves against home", () => {
    const home = os.homedir();
    const result = resolveStorageRootDirectory(
      "/some/workspace",
      "~/mystorage",
    );
    expect(result).toBe(path.resolve(path.join(home, "mystorage")));
  });

  it("resolves . as workspace root for relative path", async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "step-test-dot-"));
    try {
      const result = resolveStorageRootDirectory(tmpDir, ".");
      expect(result).toBe(path.resolve(tmpDir));
    } finally {
      await fs.rm(tmpDir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// path.ts (additional tests from batch4)
// ---------------------------------------------------------------------------

// resolveInWorkspace and toWorkspaceRelative need additional imports
import { resolveInWorkspace, toWorkspaceRelative } from "./path.js";

describe("resolveInWorkspace", () => {
  const root = path.resolve("/workspace");

  it("resolves a simple relative path", () => {
    expect(resolveInWorkspace(root, "src/file.ts")).toBe(
      path.resolve(root, "src/file.ts"),
    );
  });

  it("resolves '.' as workspace root", () => {
    expect(resolveInWorkspace(root, ".")).toBe(root);
  });

  it("throws when path escapes workspace via ..", () => {
    expect(() => resolveInWorkspace(root, "../../etc/passwd")).toThrow(
      "Path escapes workspace root",
    );
  });

  it("throws on absolute path outside workspace", () => {
    expect(() => resolveInWorkspace(root, "/etc/passwd")).toThrow(
      "Path escapes workspace root",
    );
  });

  it("allows absolute path inside workspace", () => {
    expect(resolveInWorkspace(root, path.join(root, "src/file.ts"))).toBe(
      path.resolve(root, "src/file.ts"),
    );
  });

  it("allows nested .. that stays within workspace", () => {
    expect(resolveInWorkspace(root, "src/../lib/file.ts")).toBe(
      path.resolve(root, "lib/file.ts"),
    );
  });
});

describe("toWorkspaceRelative", () => {
  const root = path.resolve("/project");

  it("returns relative path for nested file", () => {
    expect(toWorkspaceRelative(root, path.resolve(root, "src/index.ts"))).toBe(
      path.join("src", "index.ts"),
    );
  });

  it("returns '.' for workspace root itself", () => {
    expect(toWorkspaceRelative(root, root)).toBe(".");
  });

  it("returns '.' for root with trailing slash", () => {
    // path.resolve normalizes trailing slashes away
    expect(toWorkspaceRelative(root, path.resolve(root))).toBe(".");
  });
});

describe("expandHomeDirectory additional cases", () => {
  it("handles plain ~", () => {
    // Result should be the home directory (OS-dependent)
    const result = expandHomeDirectory("~");
    expect(result).not.toContain("~");
    expect(path.isAbsolute(result)).toBe(true);
  });

  it("handles ~/sub/dir", () => {
    const result = expandHomeDirectory("~/Documents");
    expect(result).not.toContain("~");
    expect(result).toMatch(/Documents$/);
  });

  it("does not expand ~otheruser", () => {
    expect(expandHomeDirectory("~otheruser")).toBe("~otheruser");
  });

  it("passes through regular absolute paths", () => {
    expect(expandHomeDirectory("/usr/local/bin")).toBe("/usr/local/bin");
  });
});

describe("resolveStorageRootDirectory additional cases", () => {
  it("resolves relative path against workspace", () => {
    const result = resolveStorageRootDirectory("/workspace", ".cache");
    expect(result).toBe(path.resolve("/workspace", ".cache"));
  });

  it("resolves ~-prefixed path to absolute", () => {
    const result = resolveStorageRootDirectory("/workspace", "~/data");
    expect(path.isAbsolute(result)).toBe(true);
    expect(result).not.toContain("~");
  });
});
