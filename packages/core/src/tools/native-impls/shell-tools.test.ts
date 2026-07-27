import { describe, expect, it } from "vitest";
import { buildBashTool } from "./shell-tools.js";

describe("Bash tool inspection", () => {
  it("exposes the command to the permission policy", () => {
    const tool = buildBashTool();
    const inspection = tool.inspect?.({
      args: { command: "rm -rf /" },
      rawArgs: JSON.stringify({ command: "rm -rf /" }),
    });

    expect(inspection?.command).toBe("rm -rf /");
  });
});
