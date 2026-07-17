import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createInteractiveReadline,
  disposeInteractiveReadline,
  __resetInteractiveReadlineForTests,
  __getInteractiveReadlineInvocationCountForTests,
} from "./interactive-readline.js";

describe("interactive-readline factory", () => {
  beforeEach(() => {
    __resetInteractiveReadlineForTests();
  });

  afterEach(() => {
    __resetInteractiveReadlineForTests();
    delete process.env.LOG_LEVEL;
  });

  it("returns a fresh, independent interface per call", () => {
    const rl1 = createInteractiveReadline();
    const rl2 = createInteractiveReadline();

    expect(rl1).not.toBe(rl2);
    expect(__getInteractiveReadlineInvocationCountForTests()).toBe(2);
  });

  it("uses terminal:false (cooked mode) to avoid Windows raw-mode issues", () => {
    // With terminal:false, readline does NOT attach a keypress listener
    // to stdin. We can't directly read the option from the public API,
    // but we can assert the side effect: no keypress listener growth.
    const before = process.stdin.listenerCount("keypress");

    const rl = createInteractiveReadline();

    expect(process.stdin.listenerCount("keypress")).toBe(before);

    disposeInteractiveReadline(rl);
  });

  it("disposeInteractiveReadline brings keypress listener count back down", () => {
    const before = process.stdin.listenerCount("keypress");

    const rl = createInteractiveReadline();
    disposeInteractiveReadline(rl);

    expect(process.stdin.listenerCount("keypress")).toBeLessThanOrEqual(before);
  });

  it("does not remove keypress listeners that existed before the prompt", () => {
    const existingListener = () => undefined;
    const leakedPromptListener = () => undefined;
    process.stdin.on("keypress", existingListener);

    try {
      const rl = createInteractiveReadline();
      process.stdin.on("keypress", leakedPromptListener);
      disposeInteractiveReadline(rl);

      expect(process.stdin.listeners("keypress")).toContain(existingListener);
      expect(process.stdin.listeners("keypress")).not.toContain(
        leakedPromptListener,
      );
    } finally {
      process.stdin.removeListener("keypress", existingListener);
      process.stdin.removeListener("keypress", leakedPromptListener);
    }
  });

  it("disposeInteractiveReadline is safe to call on an already-closed interface", () => {
    const rl = createInteractiveReadline();
    rl.close();
    expect(() => disposeInteractiveReadline(rl)).not.toThrow();
  });

  it("does not accumulate keypress listeners across create/dispose cycles", () => {
    const before = process.stdin.listenerCount("keypress");

    for (let i = 0; i < 5; i += 1) {
      const rl = createInteractiveReadline();
      disposeInteractiveReadline(rl);
    }

    expect(process.stdin.listenerCount("keypress")).toBeLessThanOrEqual(before);
  });

  it("does not throw when debug logging is enabled", () => {
    process.env.LOG_LEVEL = "debug";
    expect(() => {
      const rl = createInteractiveReadline();
      disposeInteractiveReadline(rl);
    }).not.toThrow();
  });
});
