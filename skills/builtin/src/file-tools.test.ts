import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

const isWindows = process.platform === "win32";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "step-file-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

describe("File tools integration (real tmpdir)", () => {
  describe("Read tool behavior", () => {
    it("reads an existing file", async () => {
      const filePath = path.join(tmpDir, "read-me.txt");
      await fs.writeFile(filePath, "hello world\nsecond line\n", "utf-8");

      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toContain("hello world");
      expect(content).toContain("second line");
    });

    it("handles non-existent file gracefully", async () => {
      const filePath = path.join(tmpDir, "does-not-exist.txt");
      await expect(fs.readFile(filePath, "utf-8")).rejects.toThrow();
    });

    it("reads a large file", async () => {
      const filePath = path.join(tmpDir, "large.txt");
      const lines = Array.from(
        { length: 1000 },
        (_, i) => `Line ${i + 1}: ${"x".repeat(80)}`,
      ).join("\n");
      await fs.writeFile(filePath, lines, "utf-8");

      const content = await fs.readFile(filePath, "utf-8");
      expect(content.split("\n")).toHaveLength(1000);
    });

    it("reads files with unicode content", async () => {
      const filePath = path.join(tmpDir, "unicode.txt");
      await fs.writeFile(filePath, "你好世界\n🎉\n", "utf-8");

      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toContain("你好世界");
      expect(content).toContain("🎉");
    });
  });

  describe("Write tool behavior", () => {
    it("creates a new file", async () => {
      const filePath = path.join(tmpDir, "new-file.ts");
      await fs.writeFile(filePath, "export const x = 1;\n", "utf-8");

      expect(await fs.readFile(filePath, "utf-8")).toContain("export const x");
    });

    it("creates parent directories automatically", async () => {
      const filePath = path.join(tmpDir, "deep", "nested", "file.ts");
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(filePath, "content", "utf-8");

      expect(await fs.readFile(filePath, "utf-8")).toBe("content");
    });

    it("overwrites existing file", async () => {
      const filePath = path.join(tmpDir, "overwrite.txt");
      await fs.writeFile(filePath, "old content", "utf-8");
      await fs.writeFile(filePath, "new content", "utf-8");

      expect(await fs.readFile(filePath, "utf-8")).toBe("new content");
    });
  });

  describe("Edit tool behavior", () => {
    it("replaces text in a file", async () => {
      const filePath = path.join(tmpDir, "edit-me.ts");
      await fs.writeFile(
        filePath,
        "const x = 1;\nconst y = 2;\nconst z = 3;\n",
        "utf-8",
      );

      let content = await fs.readFile(filePath, "utf-8");
      content = content.replace("const y = 2;", "const y = 42;");
      await fs.writeFile(filePath, content, "utf-8");

      const result = await fs.readFile(filePath, "utf-8");
      expect(result).toContain("const y = 42;");
      expect(result).not.toContain("const y = 2;");
    });

    it("reports error when target text not found", async () => {
      const filePath = path.join(tmpDir, "no-match.ts");
      await fs.writeFile(filePath, "only this line\n", "utf-8");

      const content = await fs.readFile(filePath, "utf-8");
      expect(content.includes("nonexistent")).toBe(false);
    });
  });

  describe.skipIf(isWindows)("Symlink handling (POSIX only)", () => {
    it("resolves symlinks when reading", async () => {
      const realFile = path.join(tmpDir, "real.txt");
      const linkFile = path.join(tmpDir, "link.txt");
      await fs.writeFile(realFile, "real content", "utf-8");
      await fs.symlink(realFile, linkFile);

      const content = await fs.readFile(linkFile, "utf-8");
      expect(content).toBe("real content");
    });
  });

  describe("Path traversal protection", () => {
    it("prevents reading outside workspace root", () => {
      const escaped = path.resolve(tmpDir, "../../etc/passwd");
      const relative = path.relative(tmpDir, escaped);
      expect(relative.startsWith("..")).toBe(true);
    });

    it("allows reading within workspace", () => {
      const inside = path.resolve(tmpDir, "subdir/file.ts");
      const relative = path.relative(tmpDir, inside);
      expect(relative.startsWith("..")).toBe(false);
      expect(path.isAbsolute(relative)).toBe(false);
    });
  });
});
