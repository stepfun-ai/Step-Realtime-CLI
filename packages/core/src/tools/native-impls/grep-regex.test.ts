import { describe, expect, it } from "vitest";
import { createSafeGrepRegex } from "./grep-regex.js";

describe("createSafeGrepRegex", () => {
  it("rejects nested quantifiers with catastrophic-backtracking risk", () => {
    expect(createSafeGrepRegex("(a+)+b")).toBeNull();
  });

  it("accepts a normal grep pattern", () => {
    const regex = createSafeGrepRegex("TODO|FIXME");

    expect(regex?.test("// TODO: add coverage")).toBe(true);
    expect(regex?.test("const value = 1")).toBe(false);
  });
});
