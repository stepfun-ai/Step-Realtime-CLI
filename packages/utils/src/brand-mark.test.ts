import { describe, it, expect } from "vitest";
import { getBrandMarkRows } from "./brand-mark.js";

describe("getBrandMarkRows", () => {
  it('returns 12 rows for "full" and by default', () => {
    const full = getBrandMarkRows("full");
    const defaultRows = getBrandMarkRows();

    expect(full).toHaveLength(12);
    expect(defaultRows).toHaveLength(12);
    expect(defaultRows).toEqual(full);
  });

  it('returns 10 rows for "compact"', () => {
    const compact = getBrandMarkRows("compact");
    expect(compact).toHaveLength(10);
    expect(compact[0]).toContain("#");
  });
});
