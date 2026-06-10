import { describe, it, expect } from "vitest";
import {
  parseApplyPatchDocument,
  applyUpdateChunks,
  listTouchedPaths,
} from "../apply-patch.js";
import { renderCommandOutput, enforceOutputLimit } from "../command-output.js";
import {
  createCommandInspection,
  createReadPathInspection,
  createWritePathInspection,
  createMultiPathWriteInspection,
  normalizeRelativePaths,
} from "../tool-inspection.js";
import { applyToolResultTruncationHint } from "../tool-result-truncation.js";

// ---------------------------------------------------------------------------
// apply-patch.ts
// ---------------------------------------------------------------------------

describe("parseApplyPatchDocument", () => {
  // ---- valid documents ----

  it("parses a valid patch with add, delete, and update operations", () => {
    const source = `\
*** Begin Patch
*** Add File: foo.txt
+line 1
+line 2
*** Delete File: bar.txt
*** Update File: baz.txt
@@ some context
-old line
+new line
*** End Patch`;

    const doc = parseApplyPatchDocument(source);
    expect(doc.operations).toHaveLength(3);

    expect(doc.operations[0]).toEqual({
      kind: "add",
      path: "foo.txt",
      lines: ["line 1", "line 2"],
    });

    expect(doc.operations[1]).toEqual({
      kind: "delete",
      path: "bar.txt",
    });

    const updateOp = doc.operations[2] as Extract<
      (typeof doc.operations)[number],
      { kind: "update" }
    >;
    expect(updateOp.kind).toBe("update");
    expect(updateOp.path).toBe("baz.txt");
    expect(updateOp.chunks).toHaveLength(1);
    expect(updateOp.chunks[0].changeContext).toBe("some context");
    expect(updateOp.chunks[0].oldLines).toEqual(["old line"]);
    expect(updateOp.chunks[0].newLines).toEqual(["new line"]);
    expect(updateOp.chunks[0].isEndOfFile).toBe(false);
  });

  // ---- missing markers ----

  it("throws when *** Begin Patch marker is missing", () => {
    expect(() => parseApplyPatchDocument("*** End Patch")).toThrow(
      "Patch must start with '*** Begin Patch'",
    );
  });

  it("throws when *** End Patch marker is missing", () => {
    expect(() => parseApplyPatchDocument("*** Begin Patch")).toThrow(
      "Patch must end with '*** End Patch'",
    );
  });

  it("throws when patch has no hunks", () => {
    const source = `\
*** Begin Patch
*** End Patch`;
    expect(() => parseApplyPatchDocument(source)).toThrow(
      "Patch does not contain any hunks",
    );
  });

  // ---- Move To directive ----

  it("parses *** Move to: directive on update operations", () => {
    const source = `\
*** Begin Patch
*** Update File: old/path.txt
*** Move to: new/path.txt
@@
-old
+new
*** End Patch`;

    const doc = parseApplyPatchDocument(source);
    const op = doc.operations[0] as Extract<
      (typeof doc.operations)[number],
      { kind: "update" }
    >;
    expect(op.moveTo).toBe("new/path.txt");
  });

  // ---- End of File marker ----
  // NOTE: The EOF_MARKER ("*** End of File") starts with "*** " which causes
  // the inner update-file loop to break before reaching the EOF check.
  // The isEndOfFile field is effectively unreachable in the parser but can
  // be set when constructing chunks directly (tested in applyUpdateChunks).

  // ---- @@ context markers ----

  it("sets changeContext from @@ markers", () => {
    const source = `\
*** Begin Patch
*** Update File: app.ts
@@ function foo
 line1
-old line2
+new line2
@@
 line3
-old line4
+new line4
*** End Patch`;

    const doc = parseApplyPatchDocument(source);
    const op = doc.operations[0] as Extract<
      (typeof doc.operations)[number],
      { kind: "update" }
    >;
    expect(op.chunks).toHaveLength(2);
    expect(op.chunks[0].changeContext).toBe("function foo");
    expect(op.chunks[1].changeContext).toBeUndefined();
  });

  it("sets changeContext to undefined for bare @@ marker", () => {
    const source = `\
*** Begin Patch
*** Update File: app.ts
@@
-old
+new
*** End Patch`;

    const doc = parseApplyPatchDocument(source);
    const op = doc.operations[0] as Extract<
      (typeof doc.operations)[number],
      { kind: "update" }
    >;
    expect(op.chunks[0].changeContext).toBeUndefined();
  });

  // ---- invalid line prefix ----

  it("throws on invalid line prefix in update hunk", () => {
    const source = `\
*** Begin Patch
*** Update File: test.txt
~bad line
*** End Patch`;

    expect(() => parseApplyPatchDocument(source)).toThrow(
      /Invalid update hunk line/,
    );
  });

  // ---- empty target path ----

  it("throws on empty target path for add operation", () => {
    // ADD_FILE_MARKER is "*** Add File: " (with trailing space).
    // Without the space, the line does not match the marker and falls through
    // to the unrecognized-marker error.
    const source = `\
*** Begin Patch
*** Add File:
+line
*** End Patch`;

    expect(() => parseApplyPatchDocument(source)).toThrow(
      /Unrecognized patch marker/,
    );
  });

  it("throws on empty target path for delete operation", () => {
    const source = `\
*** Begin Patch
*** Delete File:
*** End Patch`;

    expect(() => parseApplyPatchDocument(source)).toThrow(
      /Unrecognized patch marker/,
    );
  });

  it("throws on empty target path for update operation", () => {
    const source = `\
*** Begin Patch
*** Update File:
@@
-old
+new
*** End Patch`;

    expect(() => parseApplyPatchDocument(source)).toThrow(
      /Unrecognized patch marker/,
    );
  });

  // ---- CRLF normalization ----

  it("normalizes \\r\\n line endings", () => {
    const source =
      "*** Begin Patch\r\n*** Update File: a.txt\r\n@@\r\n-old\r\n+new\r\n*** End Patch";

    const doc = parseApplyPatchDocument(source);
    expect(doc.operations).toHaveLength(1);
    expect(doc.operations[0].kind).toBe("update");
  });

  // ---- heredoc unwrapping ----

  it("unwraps heredoc-wrapped input (<<EOF ... EOF)", () => {
    const patchBody =
      "*** Begin Patch\n*** Add File: hello.txt\n+hello\n*** End Patch";
    const source = `<<EOF\n${patchBody}\nEOF`;

    const doc = parseApplyPatchDocument(source);
    expect(doc.operations).toHaveLength(1);
    expect(doc.operations[0].kind).toBe("add");
  });

  it("unwraps heredoc with quoted EOF markers", () => {
    const patchBody =
      "*** Begin Patch\n*** Add File: hello.txt\n+hello\n*** End Patch";
    const source = `<<'EOF'\n${patchBody}\nEOF`;

    const doc = parseApplyPatchDocument(source);
    expect(doc.operations).toHaveLength(1);
  });

  it("does not unwrap if heredoc format is not matched", () => {
    const source = `<<MARKER\n*** Begin Patch\n*** Add File: x.txt\n+line\n*** End Patch\nMARKER`;
    expect(() => parseApplyPatchDocument(source)).toThrow();
  });

  // ---- add file only supports + prefix ----

  it("throws on non-plus line in add-file hunk", () => {
    const source = `\
*** Begin Patch
*** Add File: test.txt
-not a plus line
*** End Patch`;

    expect(() => parseApplyPatchDocument(source)).toThrow();
  });

  // ---- empty add file hunk ----

  it("throws on empty add-file hunk", () => {
    const source = `\
*** Begin Patch
*** Add File: test.txt
*** End Patch`;

    expect(() => parseApplyPatchDocument(source)).toThrow(
      "Add-file hunk for 'test.txt' is empty",
    );
  });

  // ---- empty update hunk ----

  it("throws on empty update-file hunk", () => {
    const source = `\
*** Begin Patch
*** Update File: test.txt
*** End Patch`;

    expect(() => parseApplyPatchDocument(source)).toThrow(
      "Update-file hunk for 'test.txt' is empty",
    );
  });

  // ---- missing move-to destination ----

  it("throws on empty move-to destination", () => {
    // MOVE_TO_MARKER is "*** Move to: " (with trailing space).
    // Without the space after colon, the line does not match MOVE_TO_MARKER
    // at all, so it is treated as a regular update line and the hunk ends
    // up empty.
    const source = `\
*** Begin Patch
*** Update File: a.txt
*** Move to:
@@
-old
+new
*** End Patch`;

    expect(() => parseApplyPatchDocument(source)).toThrow(
      /Update-file hunk for 'a.txt' is empty/,
    );
  });

  // ---- context line in update ----

  it("parses context lines (space prefix) alongside add/remove", () => {
    const source = `\
*** Begin Patch
*** Update File: f.ts
 context line 1
-old line
+new line
 context line 2
*** End Patch`;

    const doc = parseApplyPatchDocument(source);
    const op = doc.operations[0] as Extract<
      (typeof doc.operations)[number],
      { kind: "update" }
    >;
    expect(op.chunks).toHaveLength(1);
    expect(op.chunks[0].oldLines).toEqual([
      "context line 1",
      "old line",
      "context line 2",
    ]);
    expect(op.chunks[0].newLines).toEqual([
      "context line 1",
      "new line",
      "context line 2",
    ]);
  });

  // ---- unrecognized marker ----

  it("throws on unrecognized *** marker", () => {
    const source = `\
*** Begin Patch
*** Unknown Marker: foo
*** End Patch`;

    expect(() => parseApplyPatchDocument(source)).toThrow(
      /Unrecognized patch marker/,
    );
  });

  // ---- blank lines between operations ----

  it("handles consecutive operations without blank lines", () => {
    // Operations directly following each other (no blank lines between hunks)
    const source = `\
*** Begin Patch
*** Delete File: a.txt
*** Update File: b.txt
@@
-old
+new
*** End Patch`;

    const doc = parseApplyPatchDocument(source);
    expect(doc.operations).toHaveLength(2);
    expect(doc.operations[0].kind).toBe("delete");
    expect(doc.operations[1].kind).toBe("update");
  });

  // ---- multiple update chunks in a single operation ----

  it("parses multiple @@ chunks in a single update operation", () => {
    const source = `\
*** Begin Patch
*** Update File: f.ts
@@ ctx1
-a
+b
@@ ctx2
-c
+d
*** End Patch`;

    const doc = parseApplyPatchDocument(source);
    const op = doc.operations[0] as Extract<
      (typeof doc.operations)[number],
      { kind: "update" }
    >;
    expect(op.chunks).toHaveLength(2);
    expect(op.chunks[0].changeContext).toBe("ctx1");
    expect(op.chunks[1].changeContext).toBe("ctx2");
  });
});

describe("applyUpdateChunks", () => {
  it("applies a single chunk to matching source", () => {
    const source = "line1\nline2\nline3\n";
    const chunks = [
      {
        oldLines: ["line2"],
        newLines: ["replaced"],
        isEndOfFile: false,
      },
    ];

    const result = applyUpdateChunks(source, chunks);
    expect(result).toBe("line1\nreplaced\nline3\n");
  });

  it("applies multiple sequential chunks", () => {
    const source = "a\nb\nc\nd\ne\n";
    const chunks = [
      {
        oldLines: ["b"],
        newLines: ["B"],
        isEndOfFile: false,
      },
      {
        oldLines: ["d"],
        newLines: ["D"],
        isEndOfFile: false,
      },
    ];

    const result = applyUpdateChunks(source, chunks);
    expect(result).toBe("a\nB\nc\nD\ne\n");
  });

  it("inserts new lines when chunk has empty oldLines", () => {
    const source = "a\nb\nc\n";
    const chunks = [
      {
        oldLines: [] as string[],
        newLines: ["inserted"],
        isEndOfFile: false,
      },
    ];

    const result = applyUpdateChunks(source, chunks);
    expect(result).toBe("inserted\na\nb\nc\n");
  });

  it("appends at end when chunk has isEndOfFile", () => {
    const source = "a\nb\n";
    const chunks = [
      {
        oldLines: [] as string[],
        newLines: ["appended"],
        isEndOfFile: true,
      },
    ];

    const result = applyUpdateChunks(source, chunks);
    expect(result).toBe("a\nb\nappended\n");
  });

  it("throws when chunk does not match source", () => {
    const source = "a\nb\nc\n";
    const chunks = [
      {
        oldLines: ["not-found"],
        newLines: ["x"],
        isEndOfFile: false,
      },
    ];

    expect(() => applyUpdateChunks(source, chunks)).toThrow(
      "Could not apply patch chunk",
    );
  });

  it("preserves trailing newline in source", () => {
    const source = "a\nb\n";
    const chunks = [
      {
        oldLines: ["b"],
        newLines: ["c"],
        isEndOfFile: false,
      },
    ];

    const result = applyUpdateChunks(source, chunks);
    expect(result).toBe("a\nc\n");
  });

  it("preserves lack of trailing newline in source", () => {
    const source = "a\nb";
    const chunks = [
      {
        oldLines: ["b"],
        newLines: ["c"],
        isEndOfFile: false,
      },
    ];

    const result = applyUpdateChunks(source, chunks);
    expect(result).toBe("a\nc");
  });

  it("normalizes CRLF in source", () => {
    const source = "a\r\nb\r\nc\r\n";
    const chunks = [
      {
        oldLines: ["b"],
        newLines: ["B"],
        isEndOfFile: false,
      },
    ];

    const result = applyUpdateChunks(source, chunks);
    expect(result).toBe("a\nB\nc\n");
  });

  it("uses changeContext to locate chunk position", () => {
    const source = "a\nsome context\nb\nc\n";
    const chunks = [
      {
        changeContext: "some context",
        oldLines: ["b"],
        newLines: ["B"],
        isEndOfFile: false,
      },
    ];

    const result = applyUpdateChunks(source, chunks);
    expect(result).toBe("a\nsome context\nB\nc\n");
  });

  it("inserts at context+1 position when oldLines is empty and changeContext is set", () => {
    const source = "a\nmarker\nb\n";
    const chunks = [
      {
        changeContext: "marker",
        oldLines: [] as string[],
        newLines: ["inserted"],
        isEndOfFile: false,
      },
    ];

    const result = applyUpdateChunks(source, chunks);
    expect(result).toBe("a\nmarker\ninserted\nb\n");
  });

  it("handles deletion-only chunk (no new lines)", () => {
    const source = "a\nb\nc\n";
    const chunks = [
      {
        oldLines: ["b"],
        newLines: [] as string[],
        isEndOfFile: false,
      },
    ];

    const result = applyUpdateChunks(source, chunks);
    expect(result).toBe("a\nc\n");
  });

  it("handles empty source with insertion chunk", () => {
    const source = "";
    const chunks = [
      {
        oldLines: [] as string[],
        newLines: ["new line"],
        isEndOfFile: false,
      },
    ];

    const result = applyUpdateChunks(source, chunks);
    expect(result).toBe("new line");
  });
});

describe("listTouchedPaths", () => {
  it("returns unique sorted paths", () => {
    const doc = parseApplyPatchDocument(`\
*** Begin Patch
*** Add File: z.txt
+z line
*** Update File: a.txt
@@
-old
+new
*** End Patch`);

    const paths = listTouchedPaths(doc);
    expect(paths).toEqual(["a.txt", "z.txt"]);
  });

  it("includes moveTo path for move operations", () => {
    const doc = parseApplyPatchDocument(`\
*** Begin Patch
*** Update File: old.txt
*** Move to: new.txt
@@
-old
+new
*** End Patch`);

    const paths = listTouchedPaths(doc);
    expect(paths).toContain("old.txt");
    expect(paths).toContain("new.txt");
    expect(paths).toEqual(["new.txt", "old.txt"]);
  });

  it("deduplicates paths", () => {
    const doc = parseApplyPatchDocument(`\
*** Begin Patch
*** Update File: a.txt
*** Move to: a.txt
@@
-old
+new
*** End Patch`);

    const paths = listTouchedPaths(doc);
    expect(paths).toEqual(["a.txt"]);
  });

  it("returns paths from all operation types", () => {
    const doc = parseApplyPatchDocument(`\
*** Begin Patch
*** Add File: b.txt
+line
*** Delete File: a.txt
*** Update File: c.txt
@@
-old
+new
*** End Patch`);

    const paths = listTouchedPaths(doc);
    expect(paths).toEqual(["a.txt", "b.txt", "c.txt"]);
  });
});

// ---------------------------------------------------------------------------
// command-output.ts
// ---------------------------------------------------------------------------

describe("renderCommandOutput", () => {
  it("renders full output with stdout and stderr", () => {
    const result = renderCommandOutput({
      exitCode: 0,
      timedOut: false,
      stdout: "hello",
      stderr: "warning",
    });

    expect(result).toContain("exit_code: 0");
    expect(result).toContain("timed_out: false");
    expect(result).toContain("stdout:");
    expect(result).toContain("hello");
    expect(result).toContain("stderr:");
    expect(result).toContain("warning");
  });

  it("renders stdout-only output", () => {
    const result = renderCommandOutput({
      exitCode: 0,
      timedOut: false,
      stdout: "output",
      stderr: "",
    });

    expect(result).toContain("stdout:");
    expect(result).toContain("output");
    expect(result).not.toContain("stderr:");
  });

  it("renders stderr-only output", () => {
    const result = renderCommandOutput({
      exitCode: 1,
      timedOut: false,
      stdout: "",
      stderr: "error",
    });

    expect(result).toContain("stderr:");
    expect(result).toContain("error");
    expect(result).not.toContain("stdout:");
  });

  it("renders both-empty output with no stdout/stderr sections", () => {
    const result = renderCommandOutput({
      exitCode: 0,
      timedOut: false,
      stdout: "",
      stderr: "",
    });

    expect(result).not.toContain("stdout:");
    expect(result).not.toContain("stderr:");
    expect(result).toContain("exit_code: 0");
    expect(result).toContain("timed_out: false");
  });

  it("includes timeout note when timedOut is true and timeoutMs is provided", () => {
    const result = renderCommandOutput({
      exitCode: 1,
      timedOut: true,
      stdout: "",
      stderr: "",
      timeoutMs: 5000,
    });

    expect(result).toContain("note: Process killed after timeout (5000ms).");
  });

  it("does not include timeout note when timedOut is false", () => {
    const result = renderCommandOutput({
      exitCode: 0,
      timedOut: false,
      stdout: "",
      stderr: "",
      timeoutMs: 5000,
    });

    expect(result).not.toContain("note:");
  });

  it("does not include timeout note when timedOut is true but no timeoutMs", () => {
    const result = renderCommandOutput({
      exitCode: 1,
      timedOut: true,
      stdout: "",
      stderr: "",
    });

    expect(result).not.toContain("note:");
  });

  it("omits stdout when it contains only whitespace", () => {
    const result = renderCommandOutput({
      exitCode: 0,
      timedOut: false,
      stdout: "   \n\t  ",
      stderr: "actual error",
    });

    expect(result).not.toContain("stdout:");
    expect(result).toContain("stderr:");
  });

  it("renders non-zero exit code", () => {
    const result = renderCommandOutput({
      exitCode: 127,
      timedOut: false,
      stdout: "",
      stderr: "not found",
    });

    expect(result).toContain("exit_code: 127");
  });
});

describe("enforceOutputLimit", () => {
  it("returns value unchanged when under limit", () => {
    const value = "short";
    expect(enforceOutputLimit(value, 100)).toBe("short");
  });

  it("returns value unchanged when exactly at limit", () => {
    const value = "a".repeat(50);
    expect(enforceOutputLimit(value, 50)).toBe(value);
  });

  it("truncates and includes truncation indicator when over limit", () => {
    const value = "abcdefghij".repeat(10); // 100 chars
    const limit = 40;
    const result = enforceOutputLimit(value, limit);

    expect(result).toContain("[truncated");
    const tail = Math.floor(limit * 0.6); // 24
    const head = Math.max(0, limit - tail); // 16
    expect(result).toContain(value.slice(0, head));
    expect(result).toContain(value.slice(value.length - tail));
  });

  it("handles limit of 0", () => {
    const value = "some text";
    const result = enforceOutputLimit(value, 0);
    expect(result).toContain("[truncated");
  });

  it("produces output that includes the truncation count", () => {
    const value = "a".repeat(100);
    const limit = 40;
    const result = enforceOutputLimit(value, limit);
    expect(result).toContain("60 chars");
  });
});

// ---------------------------------------------------------------------------
// tool-inspection.ts
// ---------------------------------------------------------------------------

describe("createCommandInspection", () => {
  it("returns inspection for non-empty command", () => {
    const result = createCommandInspection("git status", "run command");
    expect(result.command).toBe("git status");
    expect(result.inputHint).toBe("git status");
    expect(result.externalEffects).toEqual([
      { kind: "external-unsafe", label: "run command" },
    ]);
  });

  it("returns empty object fields for empty command", () => {
    const result = createCommandInspection("", "run command");
    expect(result.command).toBeUndefined();
    expect(result.inputHint).toBeUndefined();
    expect(result.externalEffects).toHaveLength(1);
  });

  it("returns empty object fields for whitespace-only command", () => {
    const result = createCommandInspection("   \t  ", "run command");
    expect(result.command).toBeUndefined();
    expect(result.inputHint).toBeUndefined();
  });

  it("caps inputHint at 96 characters via shortenLine", () => {
    const longCommand = "a".repeat(200);
    const result = createCommandInspection(longCommand, "run");
    expect(result.inputHint!.length).toBeLessThanOrEqual(96);
  });

  it("normalizes whitespace in command", () => {
    const result = createCommandInspection("  git   status  ", "label");
    expect(result.command).toBe("git status");
  });
});

describe("createReadPathInspection", () => {
  it("returns inspection for valid path", () => {
    const result = createReadPathInspection("src/index.ts");
    expect(result).toBeDefined();
    expect(result!.inputHint).toBe("src/index.ts");
    expect(result!.touchedPaths).toEqual(["src/index.ts"]);
  });

  it("returns undefined for undefined path", () => {
    expect(createReadPathInspection(undefined)).toBeUndefined();
  });

  it("returns undefined for empty string path", () => {
    expect(createReadPathInspection("")).toBeUndefined();
  });

  it("returns undefined for whitespace-only path", () => {
    expect(createReadPathInspection("   ")).toBeUndefined();
  });

  it("trims the path", () => {
    const result = createReadPathInspection("  foo.ts  ");
    expect(result!.inputHint).toBe("foo.ts");
  });
});

describe("createWritePathInspection", () => {
  it("returns inspection for valid path and operation", () => {
    const result = createWritePathInspection("src/index.ts", "edit");
    expect(result).toBeDefined();
    expect(result!.touchedPaths).toEqual(["src/index.ts"]);
    expect(result!.fileOperations).toEqual(["edit src/index.ts"]);
    expect(result!.externalEffects).toBeDefined();
  });

  it("returns undefined for undefined path", () => {
    expect(createWritePathInspection(undefined, "edit")).toBeUndefined();
  });

  it("returns undefined for empty path", () => {
    expect(createWritePathInspection("", "edit")).toBeUndefined();
  });

  it("caps fileOperations line at 96 characters", () => {
    const longPath = "a".repeat(200);
    const result = createWritePathInspection(longPath, "edit");
    for (const op of result!.fileOperations!) {
      expect(op.length).toBeLessThanOrEqual(96);
    }
  });
});

describe("createMultiPathWriteInspection", () => {
  it("returns undefined for empty paths", () => {
    expect(createMultiPathWriteInspection([])).toBeUndefined();
  });

  it("returns undefined for paths that normalize to empty", () => {
    expect(createMultiPathWriteInspection(["", "  "])).toBeUndefined();
  });

  it("normalizes, deduplicates, and sorts paths", () => {
    const result = createMultiPathWriteInspection(["  z.ts  ", "a.ts", "a.ts"]);
    expect(result).toBeDefined();
    expect(result!.touchedPaths).toEqual(["a.ts", "z.ts"]);
  });

  it("includes externalEffects with file-write kind", () => {
    const result = createMultiPathWriteInspection(["a.ts"]);
    expect(result!.externalEffects).toEqual([
      {
        kind: "file-write",
        relativePaths: ["a.ts"],
      },
    ]);
  });

  it("includes fileOperations when provided", () => {
    const result = createMultiPathWriteInspection(["a.ts"], {
      fileOperations: ["create a.ts"],
    });
    expect(result!.fileOperations).toEqual(["create a.ts"]);
  });

  it("omits fileOperations when empty array is provided", () => {
    const result = createMultiPathWriteInspection(["a.ts"], {
      fileOperations: [],
    });
    expect(result!.fileOperations).toBeUndefined();
  });

  it("includes approvalFingerprint when provided", () => {
    const result = createMultiPathWriteInspection(["a.ts"], {
      approvalFingerprint: "fp123",
    });
    expect(result!.approvalFingerprint).toBe("fp123");
  });

  it("omits approvalFingerprint when not provided", () => {
    const result = createMultiPathWriteInspection(["a.ts"]);
    expect(result!.approvalFingerprint).toBeUndefined();
  });

  it("includes shortened inputHint when provided", () => {
    const result = createMultiPathWriteInspection(["a.ts"], {
      inputHint: "hint",
    });
    expect(result!.inputHint).toBe("hint");
  });

  it("shortens long inputHint to 96 chars", () => {
    const longHint = "b".repeat(200);
    const result = createMultiPathWriteInspection(["a.ts"], {
      inputHint: longHint,
    });
    expect(result!.inputHint!.length).toBeLessThanOrEqual(96);
  });
});

describe("normalizeRelativePaths", () => {
  it("deduplicates paths", () => {
    expect(normalizeRelativePaths(["a.ts", "a.ts"])).toEqual(["a.ts"]);
  });

  it("trims whitespace from paths", () => {
    expect(normalizeRelativePaths(["  a.ts  "])).toEqual(["a.ts"]);
  });

  it("filters out empty strings", () => {
    expect(normalizeRelativePaths(["a.ts", "", "b.ts"])).toEqual([
      "a.ts",
      "b.ts",
    ]);
  });

  it("filters out whitespace-only strings", () => {
    expect(normalizeRelativePaths(["a.ts", "   ", "b.ts"])).toEqual([
      "a.ts",
      "b.ts",
    ]);
  });

  it("sorts paths alphabetically", () => {
    expect(normalizeRelativePaths(["z.ts", "a.ts", "m.ts"])).toEqual([
      "a.ts",
      "m.ts",
      "z.ts",
    ]);
  });

  it("returns empty array for all-empty input", () => {
    expect(normalizeRelativePaths(["", "  ", undefined as any])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// tool-result-truncation.ts
// ---------------------------------------------------------------------------

describe("applyToolResultTruncationHint", () => {
  it("returns content unchanged when within maxChars", () => {
    const result = applyToolResultTruncationHint({
      toolName: "read_file",
      summary: "file content",
      content: "hello world",
      maxChars: 100,
    });

    expect(result.summary).toBe("file content");
    expect(result.content).toBe("hello world");
    expect(result.truncation).toBeUndefined();
  });

  it("truncates content exceeding maxChars and includes banner for read_file", () => {
    const content = "a".repeat(2000);
    const result = applyToolResultTruncationHint({
      toolName: "read_file",
      summary: "file content",
      content,
      maxChars: 500,
    });

    expect(result.summary).toBe("file content (truncated)");
    expect(result.content).toContain("read_file output is truncated");
    expect(result.content).toContain(
      "narrow start_line/end_line or increase max_chars",
    );
    expect(result.truncation).toBeDefined();
  });

  it("truncates content exceeding maxChars and includes banner for run_command", () => {
    const content = "a".repeat(2000);
    const result = applyToolResultTruncationHint({
      toolName: "run_command",
      summary: "command output",
      content,
      maxChars: 500,
    });

    expect(result.summary).toBe("command output (truncated)");
    expect(result.content).toContain("run_command output is truncated");
    expect(result.content).toContain(
      "narrow the command output or increase max_output_chars",
    );
    expect(result.truncation).toBeDefined();
  });

  it("does not double-append (truncated) to summary", () => {
    const content = "a".repeat(200);
    const result = applyToolResultTruncationHint({
      toolName: "read_file",
      summary: "file content (truncated)",
      content,
      maxChars: 50,
    });

    expect(result.summary).toBe("file content (truncated)");
  });

  it("produces content no longer than maxChars when prefix is too large", () => {
    const content = "a".repeat(200);
    const result = applyToolResultTruncationHint({
      toolName: "read_file",
      summary: "summary",
      content,
      maxChars: 5,
    });

    expect(result.content!.length).toBeLessThanOrEqual(5);
  });

  it("returns content unchanged when exactly at maxChars", () => {
    const content = "a".repeat(100);
    const result = applyToolResultTruncationHint({
      toolName: "read_file",
      summary: "summary",
      content,
      maxChars: 100,
    });

    expect(result.content).toBe(content);
    expect(result.truncation).toBeUndefined();
  });
});
