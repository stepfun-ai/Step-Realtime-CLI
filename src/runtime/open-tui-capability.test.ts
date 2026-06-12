import { describe, expect, it, vi } from "vitest";
import {
  formatOpenTuiRuntimeUnavailableReason,
  parseOpenTuiEnabledValue,
  resolveOpenTuiClientAppFactoryAtRuntime,
} from "./open-tui-capability.js";

describe("open-tui capability", () => {
  it("treats false-like values as disabled", () => {
    expect(parseOpenTuiEnabledValue(undefined)).toBe(true);
    expect(parseOpenTuiEnabledValue("")).toBe(true);
    expect(parseOpenTuiEnabledValue("1")).toBe(true);
    expect(parseOpenTuiEnabledValue(" true ")).toBe(true);
    expect(parseOpenTuiEnabledValue("0")).toBe(false);
    expect(parseOpenTuiEnabledValue(" false ")).toBe(false);
    expect(parseOpenTuiEnabledValue("FALSE")).toBe(false);
  });

  it("formats runtime errors with the trimmed message", () => {
    expect(
      formatOpenTuiRuntimeUnavailableReason(new Error("  missing export  ")),
    ).toBe("missing export");
  });

  it("formats non-error failures as strings", () => {
    expect(formatOpenTuiRuntimeUnavailableReason("bun: unsupported")).toBe(
      "bun: unsupported",
    );
    expect(formatOpenTuiRuntimeUnavailableReason(undefined)).toBe("undefined");
  });

  it("returns the loaded app factory when the runtime is available", async () => {
    const createLocalTuiClientApp = vi.fn();

    await expect(
      resolveOpenTuiClientAppFactoryAtRuntime(
        async () => createLocalTuiClientApp,
      ),
    ).resolves.toEqual({
      available: true,
      createLocalTuiClientApp,
    });
  });

  it("returns a fallback reason when the runtime loader throws", async () => {
    await expect(
      resolveOpenTuiClientAppFactoryAtRuntime(async () => {
        throw new Error(
          "Cannot find module 'react-reconciler/constants' imported from @opentui/react/chunk.js",
        );
      }),
    ).resolves.toEqual({
      available: false,
      reason:
        "Cannot find module 'react-reconciler/constants' imported from @opentui/react/chunk.js",
    });
  });
});
