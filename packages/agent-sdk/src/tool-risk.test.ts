import { describe, it, expect } from "vitest";
import { riskForToolName, isAcceptEditsTool, TOOL_RISK } from "./tool-risk.js";

describe("tool-risk", () => {
  describe("riskForToolName", () => {
    it("known tools return correct risk levels", () => {
      expect(riskForToolName("Read")).toBe("read");
      expect(riskForToolName("Glob")).toBe("read");
      expect(riskForToolName("Grep")).toBe("read");
      expect(riskForToolName("Edit")).toBe("write");
      expect(riskForToolName("Write")).toBe("write");
      expect(riskForToolName("MultiEdit")).toBe("write");
      expect(riskForToolName("Bash")).toBe("execute");
      expect(riskForToolName("BashOutput")).toBe("execute");
    });

    it("mcp__ prefix returns 'write'", () => {
      expect(riskForToolName("mcp__server__tool")).toBe("write");
      expect(riskForToolName("mcp__x__y__z")).toBe("write");
    });

    it("unknown tool returns 'read'", () => {
      expect(riskForToolName("TotallyUnknown")).toBe("read");
      expect(riskForToolName("")).toBe("read");
    });
  });

  describe("isAcceptEditsTool", () => {
    it("returns true for Edit, Write, MultiEdit, NotebookEdit", () => {
      expect(isAcceptEditsTool("Edit")).toBe(true);
      expect(isAcceptEditsTool("Write")).toBe(true);
      expect(isAcceptEditsTool("MultiEdit")).toBe(true);
      expect(isAcceptEditsTool("NotebookEdit")).toBe(true);
    });

    it("returns false for other tools", () => {
      expect(isAcceptEditsTool("Read")).toBe(false);
      expect(isAcceptEditsTool("Bash")).toBe(false);
      expect(isAcceptEditsTool("Grep")).toBe(false);
      expect(isAcceptEditsTool("Unknown")).toBe(false);
    });
  });

  it("TOOL_RISK maps are consistent with isAcceptEditsTool", () => {
    // All accept-edit tools should be in TOOL_RISK
    expect(TOOL_RISK["Edit"]).toBe("write");
    expect(TOOL_RISK["Write"]).toBe("write");
    expect(TOOL_RISK["MultiEdit"]).toBe("write");
    expect(TOOL_RISK["NotebookEdit"]).toBe("write");
  });
});
