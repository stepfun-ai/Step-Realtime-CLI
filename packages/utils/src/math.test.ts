import { describe, it, expect } from "vitest";
import { clamp } from "./math.js";

// ---------------------------------------------------------------------------
// math.ts
// ---------------------------------------------------------------------------

describe("clamp", () => {
  it("returns value when within range", () => {
    expect(clamp(5, 0, 10)).toBe(5);
  });

  it("returns min when value is below min", () => {
    expect(clamp(-3, 0, 10)).toBe(0);
  });

  it("returns max when value is above max", () => {
    expect(clamp(15, 0, 10)).toBe(10);
  });

  it("returns value when exactly at min boundary", () => {
    expect(clamp(0, 0, 10)).toBe(0);
  });

  it("returns value when exactly at max boundary", () => {
    expect(clamp(10, 0, 10)).toBe(10);
  });

  it("returns min when min > max (Math.max behavior)", () => {
    // clamp(5, 10, 0) = Math.max(10, Math.min(0, 5)) = Math.max(10, 0) = 10
    expect(clamp(5, 10, 0)).toBe(10);
  });

  it("works with negative ranges", () => {
    expect(clamp(-5, -10, -1)).toBe(-5);
    expect(clamp(-15, -10, -1)).toBe(-10);
    expect(clamp(0, -10, -1)).toBe(-1);
  });

  it("works when min === max", () => {
    expect(clamp(5, 3, 3)).toBe(3);
    expect(clamp(1, 3, 3)).toBe(3);
    expect(clamp(3, 3, 3)).toBe(3);
  });
});
