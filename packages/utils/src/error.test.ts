import { describe, it, expect } from "vitest";
import { toErrorMessage } from "./error.js";

// ---------------------------------------------------------------------------
// error.ts
// ---------------------------------------------------------------------------

describe("toErrorMessage", () => {
  it("extracts message from Error instance", () => {
    expect(toErrorMessage(new Error("something went wrong"))).toBe(
      "something went wrong",
    );
  });

  it("extracts message from a subclass of Error", () => {
    expect(toErrorMessage(new TypeError("type mismatch"))).toBe(
      "type mismatch",
    );
  });

  it("extracts message from RangeError", () => {
    expect(toErrorMessage(new RangeError("out of range"))).toBe("out of range");
  });

  it("converts string to string", () => {
    expect(toErrorMessage("plain string")).toBe("plain string");
  });

  it("converts number to string", () => {
    expect(toErrorMessage(42)).toBe("42");
  });

  it("converts boolean to string", () => {
    expect(toErrorMessage(true)).toBe("true");
  });

  it("converts null to string", () => {
    expect(toErrorMessage(null)).toBe("null");
  });

  it("converts undefined to string", () => {
    expect(toErrorMessage(undefined)).toBe("undefined");
  });

  it("converts plain object via String()", () => {
    expect(toErrorMessage({ key: "value" })).toBe("[object Object]");
  });

  it("converts array via String()", () => {
    expect(toErrorMessage([1, 2, 3])).toBe("1,2,3");
  });

  it("converts symbol via String()", () => {
    expect(toErrorMessage(Symbol("foo"))).toBe("Symbol(foo)");
  });
});
