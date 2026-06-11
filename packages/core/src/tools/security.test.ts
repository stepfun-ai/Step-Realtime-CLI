import { describe, it, expect } from "vitest";
import { getToolSecurityIssue, validateToolSecurity } from "./security.js";

describe("security", () => {
  // -- getToolSecurityIssue ----------------------------------------------
  describe("getToolSecurityIssue", () => {
    it("returns an issue when security is missing (undefined)", () => {
      const result = getToolSecurityIssue({
        definition: { function: { name: "myTool" } } as any,
        security: undefined,
      });
      expect(result).toMatch(/myTool/);
      expect(result).toContain("missing required security metadata");
    });

    it("returns an issue when security is null", () => {
      const result = getToolSecurityIssue({
        definition: { function: { name: "myTool" } } as any,
        security: null,
      });
      expect(result).toMatch(/myTool/);
      expect(result).toContain("missing required security metadata");
    });

    it("returns an issue when security is an array", () => {
      const result = getToolSecurityIssue({
        definition: { function: { name: "myTool" } } as any,
        security: [{ risk: "read" }],
      });
      expect(result).toContain("missing required security metadata");
    });

    it("returns null for valid security with a valid risk", () => {
      const result = getToolSecurityIssue({
        definition: { function: { name: "myTool" } } as any,
        security: { risk: "read" },
      });
      expect(result).toBeNull();
    });

    it("returns null for valid security with risk and valid defaultMode", () => {
      const result = getToolSecurityIssue({
        definition: { function: { name: "myTool" } } as any,
        security: { risk: "write", defaultMode: "confirm" },
      });
      expect(result).toBeNull();
    });

    it("returns an issue for an invalid risk value", () => {
      const result = getToolSecurityIssue({
        definition: { function: { name: "riskTool" } } as any,
        security: { risk: "invalid" },
      });
      expect(result).toContain("invalid security risk");
      expect(result).toMatch(/riskTool/);
    });

    it("returns an issue for valid risk with invalid defaultMode", () => {
      const result = getToolSecurityIssue({
        definition: { function: { name: "modeTool" } } as any,
        security: { risk: "read", defaultMode: "auto" },
      });
      expect(result).toContain("invalid default security mode");
      expect(result).toMatch(/modeTool/);
    });

    it("includes the tool name in the error message for missing security", () => {
      const result = getToolSecurityIssue({
        definition: { function: { name: "specificTool" } } as any,
      });
      expect(result).toMatch(/specificTool/);
    });

    it("uses <unknown> when definition is not provided", () => {
      const result = getToolSecurityIssue({ security: null });
      expect(result).toContain("<unknown>");
    });

    it("accepts all valid risk levels", () => {
      for (const risk of ["meta", "read", "write", "execute"]) {
        expect(
          getToolSecurityIssue({
            definition: { function: { name: "t" } } as any,
            security: { risk },
          }),
        ).toBeNull();
      }
    });

    it("accepts all valid defaultModes", () => {
      for (const mode of ["allow", "confirm", "deny"]) {
        expect(
          getToolSecurityIssue({
            definition: { function: { name: "t" } } as any,
            security: { risk: "read", defaultMode: mode },
          }),
        ).toBeNull();
      }
    });
  });

  // -- validateToolSecurity ----------------------------------------------
  describe("validateToolSecurity", () => {
    it("does not throw for a valid spec", () => {
      expect(() =>
        validateToolSecurity({
          definition: { function: { name: "okTool" } },
          security: { risk: "read" },
        } as any),
      ).not.toThrow();
    });

    it("throws for an invalid spec", () => {
      expect(() =>
        validateToolSecurity({
          definition: { function: { name: "badTool" } },
          security: "nope",
        } as any),
      ).toThrow(/badTool/);
    });
  });
});
