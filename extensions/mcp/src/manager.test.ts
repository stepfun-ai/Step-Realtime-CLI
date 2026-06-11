import { describe, it, expect, vi } from "vitest";

// ---------------------------------------------------------------------------
// manager.ts  -- pure exported functions
// ---------------------------------------------------------------------------
import {
  sanitizeMcpIdentifier,
  normalizeMcpInputSchema,
  renderMcpToolResult,
  buildMcpToolSpecs,
  connectMcpServersInParallel,
} from "./manager.js";

import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { StepCliMcpServerConfig } from "./types.js";

// ===========================================================================
// sanitizeMcpIdentifier
// ===========================================================================
describe("sanitizeMcpIdentifier", () => {
  it("trims whitespace", () => {
    expect(sanitizeMcpIdentifier("  hello  ", "fallback")).toBe("hello");
  });

  it("replaces non-alphanumeric characters with _", () => {
    expect(sanitizeMcpIdentifier("my-server.name", "fallback")).toBe(
      "my_server_name",
    );
  });

  it("collapses multiple underscores into one", () => {
    expect(sanitizeMcpIdentifier("a---b", "fallback")).toBe("a_b");
  });

  it("strips leading and trailing underscores", () => {
    expect(sanitizeMcpIdentifier("_hello_", "fallback")).toBe("hello");
  });

  it("prepends mcp_ when result starts with a digit", () => {
    expect(sanitizeMcpIdentifier("123server", "fallback")).toBe(
      "mcp_123server",
    );
  });

  it("does not prepend mcp_ when result starts with a letter", () => {
    expect(sanitizeMcpIdentifier("server1", "fallback")).toBe("server1");
  });

  it("uses fallback when input produces empty string after sanitization", () => {
    expect(sanitizeMcpIdentifier("!!!", "myfallback")).toBe("myfallback");
  });

  it("uses fallback and prepends mcp_ when fallback starts with a digit", () => {
    expect(sanitizeMcpIdentifier("!!!", "9fallback")).toBe("mcp_9fallback");
  });

  it("handles an empty string input", () => {
    expect(sanitizeMcpIdentifier("", "fallback")).toBe("fallback");
  });

  it("preserves underscores that are already present", () => {
    expect(sanitizeMcpIdentifier("my_server", "fallback")).toBe("my_server");
  });

  it("handles a typical server name with hyphens", () => {
    expect(sanitizeMcpIdentifier("my-mcp-server", "fallback")).toBe(
      "my_mcp_server",
    );
  });

  it("handles mixed special characters", () => {
    expect(sanitizeMcpIdentifier("a@b#c$d", "fallback")).toBe("a_b_c_d");
  });

  it("returns fallback as-is when it starts with a letter and input is empty-ish", () => {
    expect(sanitizeMcpIdentifier("   ", "valid")).toBe("valid");
  });
});

// ===========================================================================
// normalizeMcpInputSchema
// ===========================================================================
describe("normalizeMcpInputSchema", () => {
  it("ensures type is object", () => {
    const result = normalizeMcpInputSchema({ type: "string" });
    expect(result.type).toBe("object");
  });

  it("defaults properties to empty object when missing", () => {
    const result = normalizeMcpInputSchema({});
    expect(result.properties).toEqual({});
  });

  it("preserves existing properties", () => {
    const props = { name: { type: "string" } };
    const result = normalizeMcpInputSchema({ properties: props });
    expect(result.properties).toEqual(props);
  });

  it("filters required to non-empty strings", () => {
    const result = normalizeMcpInputSchema({
      required: ["name", "", "  ", "age"],
    });
    expect(result.required).toEqual(["name", "age"]);
  });

  it("removes required when array is empty after filtering", () => {
    const result = normalizeMcpInputSchema({ required: ["", "  "] });
    expect(result).not.toHaveProperty("required");
  });

  it("removes required when it is an empty array", () => {
    const result = normalizeMcpInputSchema({ required: [] });
    expect(result).not.toHaveProperty("required");
  });

  it("removes required when it is not an array", () => {
    const result = normalizeMcpInputSchema({ required: "bad" });
    expect(result).not.toHaveProperty("required");
  });

  it("preserves additionalProperties when boolean true", () => {
    const result = normalizeMcpInputSchema({ additionalProperties: true });
    expect(result.additionalProperties).toBe(true);
  });

  it("preserves additionalProperties when boolean false", () => {
    const result = normalizeMcpInputSchema({ additionalProperties: false });
    expect(result.additionalProperties).toBe(false);
  });

  it("preserves additionalProperties only when boolean (non-boolean passes through from spread)", () => {
    const result = normalizeMcpInputSchema({ additionalProperties: "yes" });
    // The function only explicitly copies boolean values; non-boolean values
    // survive via the initial spread of the input record.
    expect(result.additionalProperties).toBe("yes");
  });

  it("handles null input by defaulting to empty object with type object", () => {
    const result = normalizeMcpInputSchema(null);
    expect(result.type).toBe("object");
    expect(result.properties).toEqual({});
  });

  it("handles undefined input by defaulting to empty object", () => {
    const result = normalizeMcpInputSchema(undefined);
    expect(result.type).toBe("object");
    expect(result.properties).toEqual({});
  });

  it("handles non-object input (number)", () => {
    const result = normalizeMcpInputSchema(42);
    expect(result.type).toBe("object");
    expect(result.properties).toEqual({});
  });

  it("handles non-object input (string)", () => {
    const result = normalizeMcpInputSchema("schema");
    expect(result.type).toBe("object");
    expect(result.properties).toEqual({});
  });

  it("handles non-object properties by defaulting to empty object", () => {
    const result = normalizeMcpInputSchema({ properties: "bad" });
    expect(result.properties).toEqual({});
  });

  it("handles array properties by defaulting to empty object", () => {
    const result = normalizeMcpInputSchema({ properties: [1, 2, 3] });
    expect(result.properties).toEqual({});
  });

  it("passes through a full valid schema with all fields", () => {
    const schema = {
      type: "object",
      properties: { x: { type: "number" } },
      required: ["x"],
      additionalProperties: false,
    };
    const result = normalizeMcpInputSchema(schema);
    expect(result).toEqual(schema);
  });
});

// ===========================================================================
// renderMcpToolResult
// ===========================================================================
describe("renderMcpToolResult", () => {
  const baseInput = {
    serverName: "testserver",
    remoteToolName: "myTool",
  };

  it("renders text content with ok=true", () => {
    const input = {
      ...baseInput,
      result: {
        content: [{ type: "text" as const, text: "hello world" }],
      } satisfies CallToolResult,
    };
    const output = renderMcpToolResult(input);
    expect(output.ok).toBe(true);
    expect(output.content).toBe("hello world");
    expect(output.summary).toContain("completed");
    expect(output.data?.contentTypes).toEqual(["text"]);
    expect(output.error).toBeUndefined();
  });

  it("renders error result with ok=false", () => {
    const input = {
      ...baseInput,
      result: {
        content: [{ type: "text" as const, text: "something went wrong" }],
        isError: true,
      } satisfies CallToolResult,
    };
    const output = renderMcpToolResult(input);
    expect(output.ok).toBe(false);
    expect(output.content).toBe("something went wrong");
    expect(output.summary).toContain("failed");
    expect(output.error?.code).toBe("MCP_TOOL_ERROR");
    expect(output.error?.message).toBe("something went wrong");
    expect(output.data?.contentTypes).toEqual(["text"]);
  });

  it("renders image content as placeholder", () => {
    const input = {
      ...baseInput,
      result: {
        content: [
          { type: "image" as const, data: "base64...", mimeType: "image/png" },
        ],
      } satisfies CallToolResult,
    };
    const output = renderMcpToolResult(input);
    expect(output.content).toBe("[MCP image content omitted: image/png]");
    expect(output.data?.contentTypes).toEqual(["image"]);
  });

  it("renders audio content as placeholder", () => {
    const input = {
      ...baseInput,
      result: {
        content: [
          { type: "audio" as const, data: "base64...", mimeType: "audio/wav" },
        ],
      } satisfies CallToolResult,
    };
    const output = renderMcpToolResult(input);
    expect(output.content).toBe("[MCP audio content omitted: audio/wav]");
    expect(output.data?.contentTypes).toEqual(["audio"]);
  });

  it("renders resource with text", () => {
    const input = {
      ...baseInput,
      result: {
        content: [
          {
            type: "resource" as const,
            resource: {
              uri: "file:///test.txt",
              mimeType: "text/plain",
              text: "file contents here",
            },
          },
        ],
      } satisfies CallToolResult,
    };
    const output = renderMcpToolResult(input);
    expect(output.content).toBe("file contents here");
    expect(output.data?.contentTypes).toEqual(["resource"]);
  });

  it("renders resource without text as omitted placeholder", () => {
    const input = {
      ...baseInput,
      result: {
        content: [
          {
            type: "resource" as const,
            resource: {
              uri: "file:///image.png",
              mimeType: "image/png",
              text: "",
            },
          },
        ],
      } satisfies CallToolResult,
    };
    const output = renderMcpToolResult(input);
    expect(output.content).toBe(
      "[MCP resource omitted: image/png file:///image.png]",
    );
  });

  it("renders resource without mimeType using default octet-stream", () => {
    const input = {
      ...baseInput,
      result: {
        content: [
          {
            type: "resource" as const,
            resource: {
              uri: "file:///data.bin",
              text: "",
            },
          },
        ],
      } satisfies CallToolResult,
    };
    const output = renderMcpToolResult(input);
    expect(output.content).toBe(
      "[MCP resource omitted: application/octet-stream file:///data.bin]",
    );
  });

  it("renders resource_link content", () => {
    const input = {
      ...baseInput,
      result: {
        content: [
          {
            type: "resource_link" as const,
            name: "doc",
            uri: "file:///doc.md",
          },
        ],
      } satisfies CallToolResult,
    };
    const output = renderMcpToolResult(input);
    expect(output.content).toBe("[MCP resource link] doc: file:///doc.md");
    expect(output.data?.contentTypes).toEqual(["resource_link"]);
  });

  it("joins multiple content segments with double newlines", () => {
    const input = {
      ...baseInput,
      result: {
        content: [
          { type: "text" as const, text: "part one" },
          { type: "text" as const, text: "part two" },
        ],
      } satisfies CallToolResult,
    };
    const output = renderMcpToolResult(input);
    expect(output.content).toBe("part one\n\npart two");
  });

  it("omits text content that is only whitespace", () => {
    const input = {
      ...baseInput,
      result: {
        content: [
          { type: "text" as const, text: "   " },
          { type: "text" as const, text: "actual content" },
        ],
      } satisfies CallToolResult,
    };
    const output = renderMcpToolResult(input);
    expect(output.content).toBe("actual content");
  });

  it("handles empty content array", () => {
    const input = {
      ...baseInput,
      result: { content: [] } satisfies CallToolResult,
    };
    const output = renderMcpToolResult(input);
    expect(output.ok).toBe(true);
    expect(output.content).toBeUndefined();
    expect(output.data?.contentTypes).toEqual([]);
  });

  it("handles missing content field", () => {
    const input = {
      ...baseInput,
      result: {} as CallToolResult,
    };
    const output = renderMcpToolResult(input);
    expect(output.ok).toBe(true);
    expect(output.content).toBeUndefined();
  });

  it("includes structuredContent when present and non-empty", () => {
    const structured = { foo: "bar", count: 42 };
    const input = {
      ...baseInput,
      result: {
        content: [{ type: "text" as const, text: "result" }],
        structuredContent: structured,
      } satisfies CallToolResult,
    };
    const output = renderMcpToolResult(input);
    expect(output.data?.structuredContent).toEqual(structured);
    expect(output.content).toContain("result");
    expect(output.content).toContain('"foo"');
  });

  it("omits structuredContent when empty object", () => {
    const input = {
      ...baseInput,
      result: {
        content: [{ type: "text" as const, text: "hello" }],
        structuredContent: {},
      } satisfies CallToolResult,
    };
    const output = renderMcpToolResult(input);
    expect(output.data?.structuredContent).toBeUndefined();
  });

  it("populates data fields correctly", () => {
    const input = {
      serverName: "myserver",
      remoteToolName: "mytool",
      result: {
        content: [{ type: "text" as const, text: "ok" }],
      } satisfies CallToolResult,
    };
    const output = renderMcpToolResult(input);
    expect(output.data?.serverName).toBe("myserver");
    expect(output.data?.remoteToolName).toBe("mytool");
    expect(output.data?.contentTypes).toEqual(["text"]);
  });

  it("uses default error message when isError=true and content is empty", () => {
    const input = {
      ...baseInput,
      result: {
        content: [],
        isError: true,
      } satisfies CallToolResult,
    };
    const output = renderMcpToolResult(input);
    expect(output.error?.message).toContain("returned isError=true");
  });
});

// ===========================================================================
// buildMcpToolSpecs
// ===========================================================================
describe("buildMcpToolSpecs", () => {
  const mockInvoke = vi.fn();

  function makeServer(
    name: string,
    tools: Array<{ name: string; description?: string }>,
    config?: Partial<StepCliMcpServerConfig>,
  ) {
    return {
      name,
      config: {
        command: "test",
        ...config,
      } satisfies StepCliMcpServerConfig,
      tools: tools.map((t) => ({
        name: t.name,
        description: t.description ?? `Description for ${t.name}`,
        inputSchema: { type: "object" as const, properties: {} },
      })),
    } as any;
  }

  it("produces specs with prefixed tool names (server__tool format)", () => {
    const specs = buildMcpToolSpecs({
      servers: [makeServer("myserver", [{ name: "mytool" }])],
      invokeTool: mockInvoke,
    });
    expect(specs).toHaveLength(1);
    expect(specs[0].definition.function.name).toBe("myserver__mytool");
  });

  it("produces unique names when tool names collide across servers", () => {
    const specs = buildMcpToolSpecs({
      servers: [
        makeServer("svrA", [{ name: "search" }]),
        makeServer("svrB", [{ name: "search" }]),
      ],
      invokeTool: mockInvoke,
    });
    expect(specs).toHaveLength(2);
    const names = specs.map((s) => s.definition.function.name);
    // The second occurrence should get a _2 suffix
    expect(new Set(names).size).toBe(2);
    expect(names[0]).not.toBe(names[1]);
  });

  it("includes tool description in the spec", () => {
    const specs = buildMcpToolSpecs({
      servers: [makeServer("svr", [{ name: "tool", description: "Do stuff" }])],
      invokeTool: mockInvoke,
    });
    const desc = specs[0].definition.function.description;
    expect(desc).toContain("Do stuff");
    expect(desc).toContain("svr");
    expect(desc).toContain("tool");
  });

  it("uses tool title when description is missing", () => {
    const specs = buildMcpToolSpecs({
      servers: [
        {
          name: "svr",
          config: { command: "test" } satisfies StepCliMcpServerConfig,
          tools: [
            {
              name: "tool1",
              inputSchema: { type: "object" as const, properties: {} },
            },
          ],
        } as any,
      ],
      invokeTool: mockInvoke,
    });
    const desc = specs[0].definition.function.description;
    // Falls back to "Remote MCP tool 'tool1'."
    expect(desc).toContain("Remote MCP tool");
  });

  it("sets security risk based on config", () => {
    const specs = buildMcpToolSpecs({
      servers: [makeServer("svr", [{ name: "t" }], { risk: "read" })],
      invokeTool: mockInvoke,
    });
    expect(specs[0].security.risk).toBe("read");
  });

  it("sets security risk based on tool annotations when config has no risk", () => {
    const specs = buildMcpToolSpecs({
      servers: [
        {
          name: "svr",
          config: { command: "test" } satisfies StepCliMcpServerConfig,
          tools: [
            {
              name: "readonly_tool",
              description: "A read-only tool",
              inputSchema: { type: "object" as const, properties: {} },
              annotations: { readOnlyHint: true },
            },
          ],
        } as any,
      ],
      invokeTool: mockInvoke,
    });
    expect(specs[0].security.risk).toBe("read");
  });

  it("infers write risk from destructiveHint annotation", () => {
    const specs = buildMcpToolSpecs({
      servers: [
        {
          name: "svr",
          config: { command: "test" } satisfies StepCliMcpServerConfig,
          tools: [
            {
              name: "danger_tool",
              description: "Dangerous",
              inputSchema: { type: "object" as const, properties: {} },
              annotations: { destructiveHint: true },
            },
          ],
        } as any,
      ],
      invokeTool: mockInvoke,
    });
    expect(specs[0].security.risk).toBe("write");
  });

  it("defaults risk to execute when no hints", () => {
    const specs = buildMcpToolSpecs({
      servers: [makeServer("svr", [{ name: "t" }])],
      invokeTool: mockInvoke,
    });
    expect(specs[0].security.risk).toBe("execute");
  });

  it("sets defaultMode from config", () => {
    const specs = buildMcpToolSpecs({
      servers: [
        makeServer("svr", [{ name: "t" }], { defaultMode: "auto" as any }),
      ],
      invokeTool: mockInvoke,
    });
    expect(specs[0].security.defaultMode).toBe("auto");
  });

  it("uses parseJsonObject for parseArgs", () => {
    const specs = buildMcpToolSpecs({
      servers: [makeServer("svr", [{ name: "t" }])],
      invokeTool: mockInvoke,
    });
    // parseArgs should be the parseJsonObject function
    expect(typeof specs[0].parseArgs).toBe("function");
    expect(specs[0].parseArgs('{"key":"val"}')).toEqual({ key: "val" });
  });

  it("uses custom toolPrefix from config", () => {
    const specs = buildMcpToolSpecs({
      servers: [
        makeServer("myserver", [{ name: "search" }], { toolPrefix: "custom" }),
      ],
      invokeTool: mockInvoke,
    });
    expect(specs[0].definition.function.name).toBe("custom__search");
  });

  it("normalizes inputSchema in the spec", () => {
    const specs = buildMcpToolSpecs({
      servers: [
        {
          name: "svr",
          config: { command: "test" } satisfies StepCliMcpServerConfig,
          tools: [
            {
              name: "t",
              description: "Tool",
              inputSchema: null as any,
            },
          ],
        } as any,
      ],
      invokeTool: mockInvoke,
    });
    const params = specs[0].definition.function.parameters;
    expect(params.type).toBe("object");
    expect(params.properties).toEqual({});
  });

  it("filters tools by includeTools", () => {
    const specs = buildMcpToolSpecs({
      servers: [
        makeServer("svr", [{ name: "a" }, { name: "b" }, { name: "c" }], {
          includeTools: ["a", "c"],
        }),
      ],
      invokeTool: mockInvoke,
    });
    const names = specs.map((s) => s.definition.function.name);
    expect(names).toHaveLength(2);
    expect(names.map((n) => n.split("__")[1])).toEqual(["a", "c"]);
  });

  it("filters tools by excludeTools", () => {
    const specs = buildMcpToolSpecs({
      servers: [
        makeServer("svr", [{ name: "a" }, { name: "b" }, { name: "c" }], {
          excludeTools: ["b"],
        }),
      ],
      invokeTool: mockInvoke,
    });
    const names = specs.map((s) => s.definition.function.name);
    expect(names).toHaveLength(2);
    expect(names.map((n) => n.split("__")[1])).toEqual(["a", "c"]);
  });

  it("returns empty array for servers with no tools", () => {
    const specs = buildMcpToolSpecs({
      servers: [makeServer("svr", [])],
      invokeTool: mockInvoke,
    });
    expect(specs).toEqual([]);
  });

  it("handles multiple servers and tools", () => {
    const specs = buildMcpToolSpecs({
      servers: [
        makeServer("svr1", [{ name: "a" }, { name: "b" }]),
        makeServer("svr2", [{ name: "c" }]),
      ],
      invokeTool: mockInvoke,
    });
    expect(specs).toHaveLength(3);
  });
});

// ===========================================================================
// connectMcpServersInParallel
// ===========================================================================
describe("connectMcpServersInParallel", () => {
  it("returns results sorted by original index", async () => {
    // Make the second server resolve faster to verify sorting
    const connectServer = vi
      .fn()
      .mockImplementation(async ({ serverName }: { serverName: string }) => {
        if (serverName === "slow") {
          await new Promise((r) => setTimeout(r, 20));
        }
        return { name: serverName, tools: [{ name: "tool1" }] };
      });

    const results = await connectMcpServersInParallel({
      configuredServers: [
        ["slow", { command: "test" }],
        ["fast", { command: "test" }],
      ] as Array<[string, StepCliMcpServerConfig]>,
      workspaceRoot: "/tmp",
      connectServer,
    });

    expect(results[0].index).toBe(0);
    expect(results[1].index).toBe(1);
  });

  it("returns warning when server has no tools", async () => {
    const results = await connectMcpServersInParallel({
      configuredServers: [["empty", { command: "test" }]] as Array<
        [string, StepCliMcpServerConfig]
      >,
      workspaceRoot: "/tmp",
      connectServer: async ({ serverName }) => ({
        name: serverName,
        tools: [],
      }),
    });

    expect(results).toHaveLength(1);
    expect("server" in results[0] && results[0].warning).toContain(
      "exposed no tools",
    );
  });

  it("returns error when connectServer throws", async () => {
    const results = await connectMcpServersInParallel({
      configuredServers: [["bad", { command: "test" }]] as Array<
        [string, StepCliMcpServerConfig]
      >,
      workspaceRoot: "/tmp",
      connectServer: async () => {
        throw new Error("connection refused");
      },
    });

    expect(results).toHaveLength(1);
    expect("error" in results[0] && results[0].error).toContain(
      "connection refused",
    );
  });

  it("returns null warning for a server with tools", async () => {
    const results = await connectMcpServersInParallel({
      configuredServers: [["good", { command: "test" }]] as Array<
        [string, StepCliMcpServerConfig]
      >,
      workspaceRoot: "/tmp",
      connectServer: async ({ serverName }) =>
        ({
          name: serverName,
          tools: [{ name: "tool1" }],
        }) as any,
    });

    expect(results).toHaveLength(1);
    expect("server" in results[0] && results[0].warning).toBeNull();
  });
});
