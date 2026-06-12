import { describe, it, expect } from "vitest";
import { resolveVadAdapter, listAvailableVads } from "./resolver.js";

describe("resolveVadAdapter", () => {
  it("resolves built-in energy adapter by string", async () => {
    const adapter = await resolveVadAdapter("energy");
    expect(adapter).toBeDefined();
    expect(typeof adapter.processFrame).toBe("function");
    expect(typeof adapter.reset).toBe("function");
  });

  it("resolves built-in energy adapter by object config", async () => {
    const adapter = await resolveVadAdapter({ type: "energy", options: {} });
    expect(adapter).toBeDefined();
  });

  it("throws for unknown plugin that is not installed", async () => {
    await expect(resolveVadAdapter("nonexistent-vad-plugin")).rejects.toThrow();
  });

  it("throws helpful message with install hint for known plugins", async () => {
    try {
      await resolveVadAdapter("silero");
    } catch (err: unknown) {
      const message = (err as Error).message;
      expect(
        message.includes("not installed") || message.includes("Cannot find"),
      ).toBe(true);
    }
  });
});

describe("listAvailableVads", () => {
  it("always includes energy as built-in and installed", async () => {
    const vads = await listAvailableVads();
    const energy = vads.find((v) => v.name === "energy");
    expect(energy).toBeDefined();
    expect(energy!.source).toBe("built-in");
    expect(energy!.installed).toBe(true);
  });

  it("lists silero as a known plugin", async () => {
    const vads = await listAvailableVads();
    const silero = vads.find((v) => v.name === "silero");
    expect(silero).toBeDefined();
    expect(silero!.source).toBe("plugin");
    expect(typeof silero!.installed).toBe("boolean");
  });
});
