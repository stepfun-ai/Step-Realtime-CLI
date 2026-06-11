import { describe, it, expect } from "vitest";
import { canonicalizeJsonSchema, cloneJsonSchema } from "./json-schema.js";

// ---------------------------------------------------------------------------
// json-schema.ts
// ---------------------------------------------------------------------------
describe("canonicalizeJsonSchema / cloneJsonSchema", () => {
  it("returns an empty object for an empty schema", () => {
    const result = canonicalizeJsonSchema({});
    expect(result).toEqual({});
  });

  it("preserves all known fields", () => {
    const schema = {
      type: "object" as const,
      description: "test schema",
      required: ["name"],
      properties: { name: { type: "string" as const } },
      items: { type: "string" as const },
      enum: ["a", "b"],
      additionalProperties: false,
      minimum: 0,
      maximum: 100,
      minLength: 1,
      maxLength: 50,
      minItems: 0,
      maxItems: 10,
    };
    const result = canonicalizeJsonSchema(schema);
    expect(result).toEqual(schema);
  });

  it("clones arrays so mutations to the original do not affect the clone", () => {
    const original = { type: "object" as const, required: ["a", "b"] };
    const cloned = cloneJsonSchema(original);
    original.required!.push("c");
    expect(cloned.required).toEqual(["a", "b"]);
  });

  it("sorts extra unknown fields alphabetically", () => {
    const schema = {
      type: "object" as const,
      zebraField: "z",
      alphaField: "a",
    };
    const result = canonicalizeJsonSchema(schema);
    const keys = Object.keys(result);
    // known fields come first, then extras sorted
    const extraStart = keys.indexOf("alphaField");
    expect(extraStart).toBeLessThan(keys.indexOf("zebraField"));
  });

  it("handles type as an array", () => {
    const schema = { type: ["string", "null"] } as any;
    const result = canonicalizeJsonSchema(schema);
    expect(result.type).toEqual(["string", "null"]);
  });

  it("handles items as an array of schemas", () => {
    const schema = {
      type: "array" as const,
      items: [{ type: "string" as const }, { type: "number" as const }],
    };
    const result = canonicalizeJsonSchema(schema);
    expect(result.items).toEqual([{ type: "string" }, { type: "number" }]);
  });

  it("handles items as a single schema object", () => {
    const schema = {
      type: "array" as const,
      items: { type: "string" as const },
    };
    const result = canonicalizeJsonSchema(schema);
    expect(result.items).toEqual({ type: "string" });
  });

  it("deeply clones nested properties", () => {
    const original = {
      type: "object" as const,
      properties: {
        address: {
          type: "object" as const,
          properties: {
            city: { type: "string" as const },
          },
        },
      },
    };
    const cloned = cloneJsonSchema(original);
    // Mutating original should not affect clone
    (original.properties!.address.properties as Record<string, unknown>).city =
      {
        type: "number" as const,
      };
    expect(
      (cloned.properties!.address as Record<string, unknown>).properties,
    ).toEqual({
      city: { type: "string" },
    });
  });

  it("does not mutate the original schema", () => {
    const original = { type: "string" as const, description: "desc" };
    const copy = JSON.parse(JSON.stringify(original));
    canonicalizeJsonSchema(original);
    expect(original).toEqual(copy);
  });

  it("handles additionalProperties as a boolean", () => {
    const schema = { additionalProperties: true };
    const result = canonicalizeJsonSchema(schema);
    expect(result.additionalProperties).toBe(true);
  });

  it("handles additionalProperties as a schema object", () => {
    const schema = { additionalProperties: { type: "string" as const } };
    const result = canonicalizeJsonSchema(schema);
    expect(result.additionalProperties).toEqual({ type: "string" });
  });

  it("structuredClones unknown extra fields", () => {
    const schema = { type: "string" as const, default: { nested: true } };
    const result = canonicalizeJsonSchema(schema);
    expect((result as Record<string, unknown>).default).toEqual({
      nested: true,
    });
    // Ensure it is a clone, not the same reference
    expect((result as Record<string, unknown>).default).not.toBe(
      (schema as Record<string, unknown>).default,
    );
  });
});
