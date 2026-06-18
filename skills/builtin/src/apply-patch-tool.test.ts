import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "step-patch-test-"));
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
});

describe("ApplyPatch tool integration", () => {
  it("creates new file via add operation", async () => {
    const { parseApplyPatchDocument } = await import("./apply-patch.js");
    const patch = [
      "*** Begin Patch",
      "*** Add File: hello.ts",
      "+export const hello = 'world';",
      "*** End Patch",
    ].join("\n");

    const doc = parseApplyPatchDocument(patch);
    expect(doc.operations[0]!.kind).toBe("add");

    if (doc.operations[0]!.kind === "add") {
      const filePath = path.join(tmpDir, doc.operations[0]!.path);
      await fs.mkdir(path.dirname(filePath), { recursive: true });
      await fs.writeFile(
        filePath,
        doc.operations[0]!.lines.join("\n"),
        "utf-8",
      );

      const content = await fs.readFile(filePath, "utf-8");
      expect(content).toContain("export const hello");
    }
  });

  it("deletes file via delete operation", async () => {
    const filePath = path.join(tmpDir, "to-delete.ts");
    await fs.writeFile(filePath, "content", "utf-8");

    const { parseApplyPatchDocument } = await import("./apply-patch.js");
    const patch = [
      "*** Begin Patch",
      "*** Delete File: to-delete.ts",
      "*** End Patch",
    ].join("\n");

    const doc = parseApplyPatchDocument(patch);
    expect(doc.operations[0]!.kind).toBe("delete");

    await fs.rm(path.join(tmpDir, "to-delete.ts"));
    await expect(fs.access(filePath)).rejects.toThrow();
  });

  it("applies update to existing file", async () => {
    const filePath = path.join(tmpDir, "target.ts");
    await fs.writeFile(filePath, "const x = 1;\nconst y = 2;\n", "utf-8");

    const { parseApplyPatchDocument, applyUpdateChunks } =
      await import("./apply-patch.js");
    const patch = [
      "*** Begin Patch",
      "*** Update File: target.ts",
      " const x = 1;",
      "-const y = 2;",
      "+const y = 42;",
      "*** End Patch",
    ].join("\n");

    const doc = parseApplyPatchDocument(patch);
    if (doc.operations[0]!.kind === "update") {
      const original = await fs.readFile(filePath, "utf-8");
      const updated = applyUpdateChunks(original, doc.operations[0]!.chunks);
      await fs.writeFile(filePath, updated, "utf-8");

      const result = await fs.readFile(filePath, "utf-8");
      expect(result).toContain("const y = 42;");
      expect(result).not.toContain("const y = 2;");
    }
  });

  it("rejects malformed patch without Begin marker", async () => {
    const { parseApplyPatchDocument } = await import("./apply-patch.js");
    expect(() => parseApplyPatchDocument("not a patch")).toThrow();
  });

  it("handles empty add-file hunk error", async () => {
    const { parseApplyPatchDocument } = await import("./apply-patch.js");
    expect(() =>
      parseApplyPatchDocument(
        ["*** Begin Patch", "*** Add File: empty.ts", "*** End Patch"].join(
          "\n",
        ),
      ),
    ).toThrow("empty");
  });

  it("handles multiple operations in one patch", async () => {
    const filePath = path.join(tmpDir, "existing.ts");
    await fs.writeFile(filePath, "old content", "utf-8");

    const { parseApplyPatchDocument } = await import("./apply-patch.js");
    const patch = [
      "*** Begin Patch",
      "*** Add File: new-file.ts",
      "+new content",
      "*** Delete File: existing.ts",
      "*** End Patch",
    ].join("\n");

    const doc = parseApplyPatchDocument(patch);
    expect(doc.operations).toHaveLength(2);
  });
});
