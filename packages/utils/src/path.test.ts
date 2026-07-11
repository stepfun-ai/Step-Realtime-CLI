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

// ---------------------------------------------------------------------------
// Filesystem-touching resolvers (real temp dirs + symlinks)
// ---------------------------------------------------------------------------
import {
  resolveExistingPathInWorkspace,
  resolveAddressedExistingPathInWorkspace,
  resolveAddressedPathEntryInWorkspace,
  resolveWritablePathInWorkspace,
} from "./path.js";

const isWindows = process.platform === "win32";

async function makeWorkspace(): Promise<string> {
  // Use realpath so macOS /var -> /private/var symlink does not confuse
  // workspace-containment checks.
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "step-ws-"));
  return fs.realpath(dir);
}

describe("resolveExistingPathInWorkspace", () => {
  it("returns the real path of an existing file inside the workspace", async () => {
    const root = await makeWorkspace();
    try {
      await fs.writeFile(path.join(root, "file.txt"), "hi");
      const result = await resolveExistingPathInWorkspace(root, "file.txt");
      expect(result).toBe(path.join(root, "file.txt"));
    } finally {
      await fs.rm(root, { recursive: true });
    }
  });

  it.skipIf(isWindows)(
    "resolves a symlink target that lives inside the workspace",
    async () => {
      const root = await makeWorkspace();
      try {
        await fs.writeFile(path.join(root, "real.txt"), "data");
        await fs.symlink(
          path.join(root, "real.txt"),
          path.join(root, "link.txt"),
        );
        const result = await resolveExistingPathInWorkspace(root, "link.txt");
        // Returns the resolved real target.
        expect(result).toBe(path.join(root, "real.txt"));
      } finally {
        await fs.rm(root, { recursive: true });
      }
    },
  );

  it.skipIf(isWindows)(
    "throws when a symlink points outside the workspace",
    async () => {
      const root = await makeWorkspace();
      const outside = await makeWorkspace();
      try {
        await fs.writeFile(path.join(outside, "secret.txt"), "x");
        await fs.symlink(
          path.join(outside, "secret.txt"),
          path.join(root, "escape.txt"),
        );
        await expect(
          resolveExistingPathInWorkspace(root, "escape.txt"),
        ).rejects.toThrow("Path escapes workspace root");
      } finally {
        await fs.rm(root, { recursive: true });
        await fs.rm(outside, { recursive: true });
      }
    },
  );

  it.skipIf(isWindows)(
    "throws when the symlink's parent dir escapes the workspace",
    async () => {
      const root = await makeWorkspace();
      const outside = await makeWorkspace();
      try {
        // 'sub' inside root is a symlink to an outside dir; addressing
        // sub/inner.txt makes the symlink parent check fail.
        await fs.mkdir(path.join(outside, "real-dir"));
        await fs.writeFile(path.join(outside, "real-dir", "inner.txt"), "y");
        await fs.symlink(
          path.join(outside, "real-dir"),
          path.join(root, "sub"),
          "dir",
        );
        // 'sub' itself is a symlink whose realpath is outside.
        await expect(
          resolveExistingPathInWorkspace(root, "sub"),
        ).rejects.toThrow("Path escapes workspace root");
      } finally {
        await fs.rm(root, { recursive: true });
        await fs.rm(outside, { recursive: true });
      }
    },
  );

  it("rejects for a non-existent path (ENOENT from realpath)", async () => {
    const root = await makeWorkspace();
    try {
      await expect(
        resolveExistingPathInWorkspace(root, "missing.txt"),
      ).rejects.toThrow();
    } finally {
      await fs.rm(root, { recursive: true });
    }
  });
});

describe("resolveAddressedExistingPathInWorkspace", () => {
  it.skipIf(isWindows)(
    "returns the addressed (non-real) resolved path",
    async () => {
      const root = await makeWorkspace();
      try {
        await fs.writeFile(path.join(root, "real.txt"), "data");
        await fs.symlink(
          path.join(root, "real.txt"),
          path.join(root, "link.txt"),
        );
        const result = await resolveAddressedExistingPathInWorkspace(
          root,
          "link.txt",
        );
        // Unlike resolveExistingPathInWorkspace, returns the addressed link path.
        expect(result).toBe(path.join(root, "link.txt"));
      } finally {
        await fs.rm(root, { recursive: true });
      }
    },
  );

  it.skipIf(isWindows)("throws when symlink escapes workspace", async () => {
    const root = await makeWorkspace();
    const outside = await makeWorkspace();
    try {
      await fs.writeFile(path.join(outside, "secret.txt"), "x");
      await fs.symlink(
        path.join(outside, "secret.txt"),
        path.join(root, "escape.txt"),
      );
      await expect(
        resolveAddressedExistingPathInWorkspace(root, "escape.txt"),
      ).rejects.toThrow("Path escapes workspace root");
    } finally {
      await fs.rm(root, { recursive: true });
      await fs.rm(outside, { recursive: true });
    }
  });
});

describe("resolveAddressedPathEntryInWorkspace", () => {
  it.skipIf(isWindows)(
    "returns the resolved path early for a symlink entry",
    async () => {
      const root = await makeWorkspace();
      try {
        await fs.writeFile(path.join(root, "real.txt"), "data");
        await fs.symlink(
          path.join(root, "real.txt"),
          path.join(root, "link.txt"),
        );
        const result = await resolveAddressedPathEntryInWorkspace(
          root,
          "link.txt",
        );
        expect(result).toBe(path.join(root, "link.txt"));
      } finally {
        await fs.rm(root, { recursive: true });
      }
    },
  );

  it("resolves a regular file entry and validates real path", async () => {
    const root = await makeWorkspace();
    try {
      await fs.writeFile(path.join(root, "plain.txt"), "data");
      const result = await resolveAddressedPathEntryInWorkspace(
        root,
        "plain.txt",
      );
      expect(result).toBe(path.join(root, "plain.txt"));
    } finally {
      await fs.rm(root, { recursive: true });
    }
  });

  it.skipIf(isWindows)(
    "returns resolved symlink even if it escapes (parent check passes)",
    async () => {
      const root = await makeWorkspace();
      const outside = await makeWorkspace();
      try {
        await fs.writeFile(path.join(outside, "secret.txt"), "x");
        // Symlink directly in root; its parent (root) is in the workspace, so the
        // parent check passes and the symlink branch returns early.
        await fs.symlink(
          path.join(outside, "secret.txt"),
          path.join(root, "link.txt"),
        );
        const result = await resolveAddressedPathEntryInWorkspace(
          root,
          "link.txt",
        );
        expect(result).toBe(path.join(root, "link.txt"));
      } finally {
        await fs.rm(root, { recursive: true });
        await fs.rm(outside, { recursive: true });
      }
    },
  );
});

describe("resolveWritablePathInWorkspace", () => {
  it("resolves a non-existent path under an existing dir", async () => {
    const root = await makeWorkspace();
    try {
      const result = await resolveWritablePathInWorkspace(
        root,
        "newdir/newfile.txt",
      );
      expect(result).toBe(path.join(root, "newdir", "newfile.txt"));
    } finally {
      await fs.rm(root, { recursive: true });
    }
  });

  it("resolves an existing file path", async () => {
    const root = await makeWorkspace();
    try {
      await fs.writeFile(path.join(root, "exists.txt"), "x");
      const result = await resolveWritablePathInWorkspace(root, "exists.txt");
      expect(result).toBe(path.join(root, "exists.txt"));
    } finally {
      await fs.rm(root, { recursive: true });
    }
  });

  it.skipIf(isWindows)(
    "follows a symlinked parent dir to an existing location inside workspace",
    async () => {
      const root = await makeWorkspace();
      try {
        await fs.mkdir(path.join(root, "actual"));
        await fs.symlink(path.join(root, "actual"), path.join(root, "linkdir"));
        const result = await resolveWritablePathInWorkspace(
          root,
          "linkdir/file.txt",
        );
        // Nearest existing path is the symlink's real target, then file.txt.
        expect(result).toBe(path.join(root, "actual", "file.txt"));
      } finally {
        await fs.rm(root, { recursive: true });
      }
    },
  );

  it.skipIf(isWindows)(
    "throws when the nearest existing ancestor escapes the workspace",
    async () => {
      const root = await makeWorkspace();
      const outside = await makeWorkspace();
      try {
        await fs.symlink(outside, path.join(root, "escape"), "dir");
        await expect(
          resolveWritablePathInWorkspace(root, "escape/child.txt"),
        ).rejects.toThrow("Path escapes workspace root");
      } finally {
        await fs.rm(root, { recursive: true });
        await fs.rm(outside, { recursive: true });
      }
    },
  );

  it.skipIf(isWindows)(
    "rethrows non-ENOENT errors from realpath (ELOOP cycle)",
    async () => {
      const root = await makeWorkspace();
      try {
        // a -> b, b -> a: realpath fails with ELOOP, which is not ENOENT, so
        // findNearestExistingPath rethrows it (covers the non-ENOENT branch).
        await fs.symlink(path.join(root, "b"), path.join(root, "a"));
        await fs.symlink(path.join(root, "a"), path.join(root, "b"));
        await expect(
          resolveWritablePathInWorkspace(root, "a/child.txt"),
        ).rejects.toThrow(/ELOOP|Symlink cycle|escapes workspace/);
      } finally {
        await fs.rm(root, { recursive: true });
      }
    },
  );

  it("resolves a path whose ancestor chain walks up to the workspace root", async () => {
    const root = await makeWorkspace();
    try {
      // Deeply nested non-existent path; findNearestExistingPath unwinds
      // relativeParts up to the existing root.
      const result = await resolveWritablePathInWorkspace(
        root,
        "x/y/z/deep.txt",
      );
      expect(result).toBe(path.join(root, "x", "y", "z", "deep.txt"));
    } finally {
      await fs.rm(root, { recursive: true });
    }
  });
});
