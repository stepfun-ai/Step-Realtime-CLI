import { describe, it, expect } from "vitest";
import {
  parseApplyPatchDocument,
  applyUpdateChunks,
  listTouchedPaths,
} from "./apply-patch.js";

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
