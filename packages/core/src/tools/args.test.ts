import { describe, it, expect } from "vitest";
import {
  parseJsonObject,
  readStringField,
  readRequiredStringField,
  readIntegerField,
  readBooleanField,
  readObjectField,
} from "./args.js";

describe("args", () => {
  // -- parseJsonObject ---------------------------------------------------
  describe("parseJsonObject", () => {
    it("returns a parsed valid JSON object", () => {
      const result = parseJsonObject('{"foo":1,"bar":"baz"}');
      expect(result).toEqual({ foo: 1, bar: "baz" });
    });

    it("throws when the input is a JSON array", () => {
      expect(() => parseJsonObject("[1,2,3]")).toThrow(
        "Tool arguments must be a JSON object",
      );
    });

    it("throws when the input is a JSON primitive", () => {
      expect(() => parseJsonObject("42")).toThrow(
        "Tool arguments must be a JSON object",
      );
    });

    it("throws when the input is a JSON string primitive", () => {
      expect(() => parseJsonObject('"hello"')).toThrow(
        "Tool arguments must be a JSON object",
      );
    });

    it("throws for malformed JSON and includes the raw string in the message", () => {
      const raw = "{not valid json!!!";
      expect(() => parseJsonObject(raw)).toThrow(
        `Tool arguments must be a JSON object: ${raw}`,
      );
    });

    it("throws for the JSON literal null", () => {
      expect(() => parseJsonObject("null")).toThrow(
        "Tool arguments must be a JSON object",
      );
    });
  });

  // -- readStringField ---------------------------------------------------
  describe("readStringField", () => {
    it("returns the string value when input is a string", () => {
      expect(readStringField("hello")).toBe("hello");
    });

    it("returns undefined for a number", () => {
      expect(readStringField(42)).toBeUndefined();
    });

    it("returns undefined for undefined", () => {
      expect(readStringField(undefined)).toBeUndefined();
    });

    it("returns undefined for null", () => {
      expect(readStringField(null)).toBeUndefined();
    });

    it("returns undefined for a boolean", () => {
      expect(readStringField(true)).toBeUndefined();
    });
  });

  // -- readRequiredStringField -------------------------------------------
  describe("readRequiredStringField", () => {
    it("returns the string value when input is a string", () => {
      expect(readRequiredStringField("value", "myField")).toBe("value");
    });

    it("throws when input is a number, including the field name", () => {
      expect(() => readRequiredStringField(42, "myField")).toThrow(
        "myField must be a string",
      );
    });

    it("throws when input is null, including the field name", () => {
      expect(() => readRequiredStringField(null, "anotherField")).toThrow(
        "anotherField must be a string",
      );
    });

    it("throws when input is undefined", () => {
      expect(() => readRequiredStringField(undefined, "f")).toThrow(
        "f must be a string",
      );
    });
  });

  // -- readIntegerField --------------------------------------------------
  describe("readIntegerField", () => {
    it("returns the integer value when input is an integer", () => {
      expect(readIntegerField(7, "count")).toBe(7);
    });

    it("returns undefined when input is undefined", () => {
      expect(readIntegerField(undefined, "count")).toBeUndefined();
    });

    it("throws when input is a float", () => {
      expect(() => readIntegerField(3.14, "count")).toThrow(
        "count must be an integer",
      );
    });

    it("throws when input is a string", () => {
      expect(() => readIntegerField("5", "count")).toThrow(
        "count must be an integer",
      );
    });

    it("throws when input is null", () => {
      expect(() => readIntegerField(null, "count")).toThrow(
        "count must be an integer",
      );
    });

    it("accepts zero as a valid integer", () => {
      expect(readIntegerField(0, "count")).toBe(0);
    });

    it("accepts negative integers", () => {
      expect(readIntegerField(-10, "count")).toBe(-10);
    });
  });

  // -- readBooleanField --------------------------------------------------
  describe("readBooleanField", () => {
    it("returns true when input is true", () => {
      expect(readBooleanField(true, "flag")).toBe(true);
    });

    it("returns false when input is false", () => {
      expect(readBooleanField(false, "flag")).toBe(false);
    });

    it("returns undefined when input is undefined", () => {
      expect(readBooleanField(undefined, "flag")).toBeUndefined();
    });

    it("throws for a truthy non-boolean (string)", () => {
      expect(() => readBooleanField("true", "flag")).toThrow(
        "flag must be a boolean",
      );
    });

    it("throws for a truthy non-boolean (number 1)", () => {
      expect(() => readBooleanField(1, "flag")).toThrow(
        "flag must be a boolean",
      );
    });

    it("throws for a falsy non-boolean (empty string)", () => {
      expect(() => readBooleanField("", "flag")).toThrow(
        "flag must be a boolean",
      );
    });

    it("throws for a falsy non-boolean (number 0)", () => {
      expect(() => readBooleanField(0, "flag")).toThrow(
        "flag must be a boolean",
      );
    });

    it("throws for null", () => {
      expect(() => readBooleanField(null, "flag")).toThrow(
        "flag must be a boolean",
      );
    });
  });

  // -- readObjectField ---------------------------------------------------
  describe("readObjectField", () => {
    it("returns a plain object", () => {
      const obj = { a: 1, b: "two" };
      expect(readObjectField(obj, "data")).toBe(obj);
    });

    it("returns undefined when input is undefined", () => {
      expect(readObjectField(undefined, "data")).toBeUndefined();
    });

    it("throws when input is an array", () => {
      expect(() => readObjectField([1, 2], "data")).toThrow(
        "data must be an object",
      );
    });

    it("throws when input is null", () => {
      expect(() => readObjectField(null, "data")).toThrow(
        "data must be an object",
      );
    });

    it("throws when input is a string", () => {
      expect(() => readObjectField("hello", "data")).toThrow(
        "data must be an object",
      );
    });
  });
});
