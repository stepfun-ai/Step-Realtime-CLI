import { describe, it, expect } from "vitest";
import {
  parseToolPresentationProfile,
  normalizeToolPresentationProfile,
  describeToolPresentationProfileOptions,
  describeToolPresentationProfileInputs,
} from "./presentation-profile.js";

describe("presentation-profile", () => {
  // -- parseToolPresentationProfile --------------------------------------
  describe("parseToolPresentationProfile", () => {
    it('maps "grouped" to "grouped"', () => {
      expect(parseToolPresentationProfile("grouped")).toBe("grouped");
    });

    it('maps "compact" to "grouped" (legacy alias)', () => {
      expect(parseToolPresentationProfile("compact")).toBe("grouped");
    });

    it('maps "raw" to "raw"', () => {
      expect(parseToolPresentationProfile("raw")).toBe("raw");
    });

    it('maps "canonical" to "raw" (legacy alias)', () => {
      expect(parseToolPresentationProfile("canonical")).toBe("raw");
    });

    it('maps "obfuscated" to "obfuscated"', () => {
      expect(parseToolPresentationProfile("obfuscated")).toBe("obfuscated");
    });

    it("returns undefined for null", () => {
      expect(parseToolPresentationProfile(null)).toBeUndefined();
    });

    it("returns undefined for undefined", () => {
      expect(parseToolPresentationProfile(undefined)).toBeUndefined();
    });

    it("returns undefined for empty string", () => {
      expect(parseToolPresentationProfile("")).toBeUndefined();
    });

    it("returns undefined for unknown value", () => {
      expect(parseToolPresentationProfile("fancy")).toBeUndefined();
    });
  });

  // -- normalizeToolPresentationProfile ----------------------------------
  describe("normalizeToolPresentationProfile", () => {
    it("passes through parseable values", () => {
      expect(normalizeToolPresentationProfile("grouped")).toBe("grouped");
      expect(normalizeToolPresentationProfile("raw")).toBe("raw");
      expect(normalizeToolPresentationProfile("obfuscated")).toBe("obfuscated");
      expect(normalizeToolPresentationProfile("compact")).toBe("grouped");
      expect(normalizeToolPresentationProfile("canonical")).toBe("raw");
    });

    it('defaults null to "grouped"', () => {
      expect(normalizeToolPresentationProfile(null)).toBe("grouped");
    });

    it('defaults undefined to "grouped"', () => {
      expect(normalizeToolPresentationProfile(undefined)).toBe("grouped");
    });

    it('defaults empty string to "grouped"', () => {
      expect(normalizeToolPresentationProfile("")).toBe("grouped");
    });

    it('defaults unknown values to "grouped"', () => {
      expect(normalizeToolPresentationProfile("unknown")).toBe("grouped");
    });
  });

  // -- describeToolPresentationProfileOptions ----------------------------
  describe("describeToolPresentationProfileOptions", () => {
    it('returns "grouped, raw, or obfuscated"', () => {
      expect(describeToolPresentationProfileOptions()).toBe(
        "grouped, raw, or obfuscated",
      );
    });
  });

  // -- describeToolPresentationProfileInputs -----------------------------
  describe("describeToolPresentationProfileInputs", () => {
    it("returns a string that includes legacy aliases", () => {
      const result = describeToolPresentationProfileInputs();
      expect(result).toContain("compact");
      expect(result).toContain("canonical");
      expect(result).toContain("grouped");
      expect(result).toContain("raw");
      expect(result).toContain("obfuscated");
    });
  });
});
