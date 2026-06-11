import { describe, it, expect } from "vitest";
import { sanitizeTerminalText } from "./terminal-text.js";

// ─── sanitizeTerminalText ────────────────────────────────────────────────────

describe("sanitizeTerminalText", () => {
  it("strips ANSI color codes", () => {
    const input = "[31mred text[0m";
    expect(sanitizeTerminalText(input)).toBe("red text");
  });

  it("strips CSI cursor movement sequences", () => {
    const input = "hello[2Aworld";
    expect(sanitizeTerminalText(input)).toBe("helloworld");
  });

  it("strips OSC title sequences (BEL terminated)", () => {
    const input = "before]0;window-titleafter";
    expect(sanitizeTerminalText(input)).toBe("beforeafter");
  });

  it("strips OSC sequences (ST terminated)", () => {
    const input = "before]2;title\\after";
    expect(sanitizeTerminalText(input)).toBe("beforeafter");
  });

  it("strips DCS / SOS / PM / APC sequences (0x50/0x58/0x5e/0x5f)", () => {
    // DCS (0x50)
    expect(sanitizeTerminalText("aPdata\\b")).toBe("ab");
    // SOS (0x58)
    expect(sanitizeTerminalText("aXdata\\b")).toBe("ab");
    // PM (0x5e)
    expect(sanitizeTerminalText("a^data\\b")).toBe("ab");
    // APC (0x5f)
    expect(sanitizeTerminalText("a_data\\b")).toBe("ab");
  });

  it("strips SS2/SS3 two-byte sequences (0x4f/0x4e)", () => {
    // SS3 followed by a final byte
    expect(sanitizeTerminalText("aOAb")).toBe("ab");
    expect(sanitizeTerminalText("aNBb")).toBe("ab");
  });

  it("strips bare ESC followed by intermediate byte", () => {
    // ESC + byte in 0x30..0x7e range (single-char function)
    expect(sanitizeTerminalText("a\x1bcb")).toBe("ab");
  });

  it("strips carriage return", () => {
    expect(sanitizeTerminalText("hello\rworld")).toBe("helloworld");
  });

  it("strips other control characters (BEL, BS, etc.)", () => {
    expect(sanitizeTerminalText("ab")).toBe("ab"); // BEL
    expect(sanitizeTerminalText("ab")).toBe("ab"); // BS
    expect(sanitizeTerminalText("a\0b")).toBe("ab"); // NUL
    expect(sanitizeTerminalText("ab")).toBe("ab"); // DEL
  });

  it("preserves newlines by default", () => {
    expect(sanitizeTerminalText("hello\nworld")).toBe("hello\nworld");
  });

  it("strips newlines when preserveNewlines is false", () => {
    expect(
      sanitizeTerminalText("hello\nworld", { preserveNewlines: false }),
    ).toBe("helloworld");
  });

  it("preserves tabs by default", () => {
    expect(sanitizeTerminalText("hello\tworld")).toBe("hello\tworld");
  });

  it("strips tabs when preserveTabs is false", () => {
    expect(sanitizeTerminalText("hello\tworld", { preserveTabs: false })).toBe(
      "helloworld",
    );
  });

  it("handles emoji and multi-byte unicode correctly", () => {
    expect(sanitizeTerminalText("hello 🌍 world")).toBe("hello 🌍 world");
    expect(sanitizeTerminalText("[32m✅ ok[0m")).toBe("✅ ok");
  });

  it("returns empty string for empty input", () => {
    expect(sanitizeTerminalText("")).toBe("");
  });

  it("handles lone ESC at end of string", () => {
    expect(sanitizeTerminalText("hello")).toBe("hello");
  });

  it("handles incomplete CSI sequence at end of string", () => {
    expect(sanitizeTerminalText("hello[31")).toBe("hello");
  });

  it("passes through plain text unchanged", () => {
    const plain = "The quick brown fox jumps over the lazy dog.";
    expect(sanitizeTerminalText(plain)).toBe(plain);
  });
});
