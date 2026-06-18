import { describe, it, expect } from "vitest";
import { mintSessionId, mintUuid } from "./session-id.js";

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("mintSessionId", () => {
  it("returns a UUID v4 string", () => {
    expect(mintSessionId()).toMatch(UUID_RE);
  });

  it("generates unique values across calls", () => {
    const ids = new Set(Array.from({ length: 20 }, () => mintSessionId()));
    expect(ids.size).toBe(20);
  });
});

describe("mintUuid", () => {
  it("returns a UUID v4 string", () => {
    expect(mintUuid()).toMatch(UUID_RE);
  });

  it("generates unique values across calls", () => {
    const ids = new Set(Array.from({ length: 20 }, () => mintUuid()));
    expect(ids.size).toBe(20);
  });
});
