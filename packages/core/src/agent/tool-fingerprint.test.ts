import { describe, it, expect } from "vitest";
import {
  createToolCallFingerprint,
  normalizeToolArguments,
} from "./tool-fingerprint.js";

describe("createToolCallFingerprint", () => {
  it("collapses runaway numeric escalation into the same fingerprint", () => {
    const base = { command: "cat missing.txt", timeout_ms: 20_000_000_000 };
    const second = {
      command: "cat missing.txt",
      timeout_ms: 2.4e37,
    };
    const third = { timeout_ms: 3.6e76, command: "cat missing.txt" };
    expect(createToolCallFingerprint("exec", JSON.stringify(base))).toBe(
      createToolCallFingerprint("exec", JSON.stringify(second)),
    );
    expect(createToolCallFingerprint("exec", JSON.stringify(base))).toBe(
      createToolCallFingerprint("exec", JSON.stringify(third)),
    );
  });

  it("keeps distinct legitimate calls distinct", () => {
    const first = { path: "a.txt", offset: 600_000 };
    const second = { path: "a.txt", offset: 900_000 };
    expect(
      createToolCallFingerprint("read_file", JSON.stringify(first)),
    ).not.toBe(createToolCallFingerprint("read_file", JSON.stringify(second)));
  });

  it("still distinguishes different commands with identical huge timeouts", () => {
    const first = { command: "ls", timeout_ms: 2e10 };
    const second = { command: "pwd", timeout_ms: 5e11 };
    expect(createToolCallFingerprint("exec", JSON.stringify(first))).not.toBe(
      createToolCallFingerprint("exec", JSON.stringify(second)),
    );
  });

  it("includes the tool name in the fingerprint", () => {
    const args = JSON.stringify({ path: "a.txt" });
    expect(createToolCallFingerprint("read_file", args)).not.toBe(
      createToolCallFingerprint("edit_file", args),
    );
  });
});

describe("normalizeToolArguments", () => {
  it("replaces huge finite numbers with a placeholder, key order independent", () => {
    expect(normalizeToolArguments('{"b":2.4e37,"a":1}')).toBe(
      normalizeToolArguments('{"a":1,"b":9.9e50}'),
    );
    expect(normalizeToolArguments('{"timeout_ms":2e10}')).toContain(
      "__HUGE_NUMBER__",
    );
  });

  it("keeps small and boundary numbers intact", () => {
    expect(normalizeToolArguments('{"timeout_ms":600000,"n":-1.5}')).toBe(
      '{"n":-1.5,"timeout_ms":600000}',
    );
    expect(normalizeToolArguments('{"v":1000000000}')).toBe('{"v":1000000000}');
    expect(normalizeToolArguments('{"v":1000000001}')).toContain(
      "__HUGE_NUMBER__",
    );
  });

  it("normalizes numbers nested in arrays and objects", () => {
    const normalized = normalizeToolArguments(
      '{"rows":[{"offset":1e12,"limit":10}]}',
    );
    expect(normalized).toContain("__HUGE_NUMBER__");
    expect(normalized).toContain('"limit":10');
  });

  it("falls back to whitespace collapsing for non-JSON arguments", () => {
    expect(normalizeToolArguments("  run   tests  ")).toBe("run tests");
  });
});
