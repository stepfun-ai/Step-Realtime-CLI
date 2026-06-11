import { describe, it, expect } from "vitest";
import { createMutableRef } from "./mutable-ref.js";

// ---------------------------------------------------------------------------
// mutable-ref.ts
// ---------------------------------------------------------------------------

describe("createMutableRef", () => {
  it("throws when get is called before set", () => {
    const ref = createMutableRef<string>("myLabel");
    expect(() => ref.get()).toThrow("myLabel is not initialized");
  });

  it("isSet returns false before set is called", () => {
    const ref = createMutableRef<number>("count");
    expect(ref.isSet()).toBe(false);
  });

  it("returns the value from get after set is called", () => {
    const ref = createMutableRef<string>("name");
    ref.set("Alice");
    expect(ref.get()).toBe("Alice");
  });

  it("isSet returns true after set is called", () => {
    const ref = createMutableRef<number>("count");
    ref.set(42);
    expect(ref.isSet()).toBe(true);
  });

  it("allows multiple set calls and returns the latest value", () => {
    const ref = createMutableRef<number>("counter");
    ref.set(1);
    expect(ref.get()).toBe(1);
    ref.set(2);
    expect(ref.get()).toBe(2);
    ref.set(3);
    expect(ref.get()).toBe(3);
  });

  it("stays initialized after multiple set calls", () => {
    const ref = createMutableRef<string>("val");
    ref.set("first");
    ref.set("second");
    expect(ref.isSet()).toBe(true);
  });

  it("works with object values", () => {
    const ref = createMutableRef<{ name: string }>("obj");
    const obj = { name: "test" };
    ref.set(obj);
    expect(ref.get()).toBe(obj);
  });

  it("works with null values after set", () => {
    const ref = createMutableRef<string | null>("nullable");
    ref.set(null);
    // After set(null), value is null which is !== undefined, so isSet returns true
    expect(ref.isSet()).toBe(true);
    expect(ref.get()).toBeNull();
  });

  it("uses the label in the error message", () => {
    const ref = createMutableRef<boolean>("CustomLabel");
    expect(() => ref.get()).toThrow("CustomLabel is not initialized");
  });
});
