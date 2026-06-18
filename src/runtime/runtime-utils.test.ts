import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  resolveValue,
  resolveOptionalValue,
  readSystemPromptFile,
  resolveModelsProxyDefaultModel,
  maskSecretForDisplay,
} from "./runtime-utils.js";

describe("resolveValue", () => {
  it("returns the first candidate with a defined value", () => {
    const result = resolveValue(
      [
        { value: undefined, source: "cli" },
        { value: "env-val", source: "env" },
        { value: "config-val", source: "config" },
      ],
      { value: "fallback-val", source: "fallback" },
    );
    expect(result).toEqual({ value: "env-val", source: "env" });
  });

  it("skips undefined candidate entries", () => {
    const result = resolveValue(
      [undefined, { value: "config-val", source: "config" }],
      { value: "fallback-val", source: "fallback" },
    );
    expect(result).toEqual({ value: "config-val", source: "config" });
  });

  it("returns the fallback when no candidate has a value", () => {
    const result = resolveValue(
      [undefined, { value: undefined, source: "cli" }],
      { value: 42, source: "fallback" },
    );
    expect(result).toEqual({ value: 42, source: "fallback" });
  });

  it("treats falsy-but-defined values as resolved", () => {
    const result = resolveValue([{ value: 0, source: "cli" }], {
      value: 99,
      source: "fallback",
    });
    expect(result).toEqual({ value: 0, source: "cli" });
  });
});

describe("resolveOptionalValue", () => {
  it("returns the first defined candidate", () => {
    const result = resolveOptionalValue([
      { value: undefined, source: "cli" },
      { value: "x", source: "config" },
    ]);
    expect(result).toEqual({ value: "x", source: "config" });
  });

  it("returns undefined with computed source when nothing resolves", () => {
    const result = resolveOptionalValue([
      undefined,
      { value: undefined, source: "env" },
    ]);
    expect(result).toEqual({ value: undefined, source: "computed" });
  });
});

describe("readSystemPromptFile", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "runtime-utils-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("reads non-empty file content", async () => {
    const file = path.join(tempDir, "prompt.txt");
    await fs.writeFile(file, "You are a helpful agent.");
    expect(await readSystemPromptFile(file)).toBe("You are a helpful agent.");
  });

  it("throws for an empty (whitespace-only) file", async () => {
    const file = path.join(tempDir, "empty.txt");
    await fs.writeFile(file, "   \n\t  ");
    await expect(readSystemPromptFile(file)).rejects.toThrow(
      "System prompt file is empty",
    );
  });

  it("rejects when the file does not exist", async () => {
    await expect(
      readSystemPromptFile(path.join(tempDir, "missing.txt")),
    ).rejects.toThrow();
  });
});

describe("resolveModelsProxyDefaultModel", () => {
  it("returns undefined for undefined or empty model lists", () => {
    expect(resolveModelsProxyDefaultModel(undefined)).toBeUndefined();
    expect(resolveModelsProxyDefaultModel([])).toBeUndefined();
  });

  it("prefers the exact default model", () => {
    expect(
      resolveModelsProxyDefaultModel(["other", "step/native", "step/foo"]),
    ).toBe("step/native");
  });

  it("falls back to the first step/ model that is not ccr/", () => {
    expect(resolveModelsProxyDefaultModel(["ccr/foo", "step/foo"])).toBe(
      "step/foo",
    );
  });

  it("falls back to the ccr-prefixed default model", () => {
    expect(resolveModelsProxyDefaultModel(["ccr/step/native", "alpha"])).toBe(
      "ccr/step/native",
    );
  });

  it("falls back to any ccr/step/ model", () => {
    expect(resolveModelsProxyDefaultModel(["ccr/step/foo"])).toBe(
      "ccr/step/foo",
    );
  });

  it("falls back to the first model when nothing else matches", () => {
    expect(resolveModelsProxyDefaultModel(["alpha", "beta"])).toBe("alpha");
  });
});

describe("maskSecretForDisplay", () => {
  it("returns undefined for undefined input", () => {
    expect(maskSecretForDisplay(undefined)).toBeUndefined();
  });

  it("returns an empty string for whitespace-only input", () => {
    expect(maskSecretForDisplay("   ")).toBe("");
    expect(maskSecretForDisplay("")).toBe("");
  });

  it("redacts a real secret value", () => {
    expect(maskSecretForDisplay("super-secret-key")).toBe("<redacted>");
  });
});
