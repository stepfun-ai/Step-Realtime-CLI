import { describe, it, expect } from "vitest";
import {
  createCommandInspection,
  createReadPathInspection,
  createWritePathInspection,
  createMultiPathWriteInspection,
  normalizeRelativePaths,
} from "./tool-inspection.js";

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
