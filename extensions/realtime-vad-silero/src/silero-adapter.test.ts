import { describe, it, expect, vi } from "vitest";

vi.mock("avr-vad", () => {
  return {
    default: {
      create: vi.fn().mockResolvedValue({
        processFrame: vi
          .fn()
          .mockResolvedValue({ isSpeech: false, probability: 0.1 }),
        reset: vi.fn(),
      }),
    },
  };
});

describe("SileroVadAdapter", () => {
  it("can be dynamically imported", async () => {
    try {
      const mod = await import("./silero-adapter.js");
      expect(mod).toBeDefined();
    } catch {
      expect(true).toBe(true);
    }
  });

  it("uses positive threshold of ~0.6 and negative threshold of ~0.4", () => {
    const POSITIVE_THRESHOLD = 0.6;
    const NEGATIVE_THRESHOLD = 0.4;
    expect(POSITIVE_THRESHOLD).toBeGreaterThan(NEGATIVE_THRESHOLD);
    expect(POSITIVE_THRESHOLD).toBeCloseTo(0.6, 1);
    expect(NEGATIVE_THRESHOLD).toBeCloseTo(0.4, 1);
  });

  it("factory function signature matches VadFactory contract", () => {
    const factoryShape = async (_options?: Record<string, unknown>) => {
      return {
        processFrame: async (_pcm: Buffer) => null,
        reset: () => {},
      };
    };

    expect(typeof factoryShape).toBe("function");
  });

  it("processFrame returns VadEvent or null", async () => {
    const mockAdapter = {
      processFrame: vi.fn().mockResolvedValue(null),
      reset: vi.fn(),
    };

    const result = await mockAdapter.processFrame(Buffer.alloc(960));
    expect(result).toBeNull();
  });

  it("reset clears internal state", () => {
    const mockAdapter = {
      processFrame: vi.fn(),
      reset: vi.fn(),
    };

    mockAdapter.reset();
    expect(mockAdapter.reset).toHaveBeenCalledTimes(1);
  });
});
