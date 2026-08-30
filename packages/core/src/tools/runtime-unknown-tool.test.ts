import { describe, it, expect } from "vitest";
import { ToolRuntime, formatUnknownToolMessage } from "./runtime.js";
import type { ToolExecutionContext, ToolSpec } from "@step-cli/protocol";

function makeSpec(name: string): ToolSpec {
  return {
    definition: {
      type: "function",
      function: {
        name,
        description: `${name} test tool`,
        parameters: { type: "object", properties: {} },
      },
    },
    security: { risk: "read" },
    parseArgs: () => ({}),
    execute: async () => ({ ok: true, summary: "ok" }),
  };
}

const execContext: ToolExecutionContext = {
  workspaceRoot: "/",
  commandTimeoutMs: 1_000,
  commandOutputLimit: 1_000,
};

describe("ToolRuntime unknown tool errors", () => {
  it("routes a hallucinated top-level call to its nested code-mode binding", async () => {
    const runtime = new ToolRuntime(
      [makeSpec("exec"), makeSpec("wait"), makeSpec("read_file")],
      execContext,
    );
    const result = await runtime.executeTool("read_file", "{}");
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("UNKNOWN_TOOL");
    expect(result.error?.message).toContain("Available tools: exec, wait.");
    expect(result.error?.message).toContain(
      "call exec and use tools.read_file(...) inside it",
    );
  });

  it("reports unknown nested calls with the real nested tool list", async () => {
    const runtime = new ToolRuntime(
      [makeSpec("exec"), makeSpec("wait"), makeSpec("read_file")],
      execContext,
    );
    const result = await runtime.executeNestedTool("readfile", "{}");
    expect(result.ok).toBe(false);
    expect(result.error?.message).toContain(
      "Available nested tools: read_file.",
    );
    expect(result.error?.message).toContain("Did you mean 'read_file'?");
  });
});

describe("formatUnknownToolMessage", () => {
  const codeModeTools = {
    name: "read_file",
    scope: "top-level" as const,
    availableTools: ["exec", "wait"],
    nestedToolBindings: [
      "apply_patch",
      "edit_file",
      "list_directory",
      "read_file",
      "run_command",
    ],
  };

  it("routes a hallucinated top-level call to its nested code-mode binding", () => {
    const message = formatUnknownToolMessage(codeModeTools);
    expect(message).toContain("Tool 'read_file' is not registered.");
    expect(message).toContain("Available tools: exec, wait.");
    expect(message).toContain(
      "call exec and use tools.read_file(...) inside it",
    );
    expect(message).not.toContain("Nested bindings:");
  });

  it("lists all nested bindings when no close match exists", () => {
    const message = formatUnknownToolMessage({
      ...codeModeTools,
      name: "open_browser",
    });
    expect(message).toContain("Tool 'open_browser' is not registered.");
    expect(message).toContain("Nested bindings: apply_patch, edit_file");
    expect(message).toContain("run_command.");
    expect(message).toContain("Do not retry this top-level call.");
  });

  it("suggests the closest direct tool when code mode is off", () => {
    const message = formatUnknownToolMessage({
      name: "raed_file",
      scope: "top-level",
      availableTools: ["read_file", "edit_file", "run_command"],
    });
    expect(message).toContain("Available tools: read_file, edit_file");
    expect(message).toContain("Did you mean 'read_file'?");
    expect(message).not.toContain("Code Mode");
  });

  it("does not suggest garbage names", () => {
    const message = formatUnknownToolMessage({
      name: "xkjzzz",
      scope: "top-level",
      availableTools: ["read_file", "run_command"],
    });
    expect(message).not.toContain("Did you mean");
  });

  it("uses nested-tool phrasing for calls from inside the sandbox", () => {
    const message = formatUnknownToolMessage({
      name: "readfile",
      scope: "nested",
      availableTools: ["read_file", "edit_file"],
    });
    expect(message).toContain("Available nested tools: read_file, edit_file.");
    expect(message).toContain("Did you mean 'read_file'?");
    expect(message).not.toContain("Code Mode:");
  });

  it("handles an empty tool list", () => {
    const message = formatUnknownToolMessage({
      name: "read_file",
      scope: "top-level",
      availableTools: [],
    });
    expect(message).toBe("Tool 'read_file' is not registered.");
  });

  it("caps very long tool lists", () => {
    const many = Array.from({ length: 30 }, (_, index) => `tool_${index}`);
    const message = formatUnknownToolMessage({
      name: "nope",
      scope: "top-level",
      availableTools: many,
    });
    expect(message).toContain("tool_23 (+6 more).");
    expect(message).not.toContain("tool_24");
  });
});
