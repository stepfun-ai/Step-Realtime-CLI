import { describe, it, expect, vi } from "vitest";
import {
  tool,
  toolSpecsFromMcpServer,
  createSdkMcpServer,
} from "./mcp-inproc.js";

describe("mcp-inproc", () => {
  describe("tool()", () => {
    it("returns object with name, description, inputSchema, handler, optional security", () => {
      const handler = vi.fn(async () => ({
        content: [{ type: "text" as const, text: "ok" }],
      }));
      const schema = {
        type: "object" as const,
        properties: { x: { type: "string" } },
      };
      const security = { risk: "read" as const, defaultMode: "allow" as const };
      const t = tool("myTool", "desc", schema, handler, security);
      expect(t.name).toBe("myTool");
      expect(t.description).toBe("desc");
      expect(t.inputSchema).toBe(schema);
      expect(t.handler).toBe(handler);
      expect(t.security).toEqual(security);
    });

    it("security is undefined when not provided", () => {
      const t = tool("t", "d", {}, async () => ({
        content: [{ type: "text" as const, text: "" }],
      }));
      expect(t.security).toBeUndefined();
    });
  });

  describe("toolSpecsFromMcpServer()", () => {
    it("produces one ToolSpec per tool with names prefixed as mcp__<server>__<tool>", () => {
      const server = createSdkMcpServer({
        name: "myserver",
        tools: [
          tool("read", "read stuff", { type: "object" }, async () => ({
            content: [{ type: "text" as const, text: "r" }],
          })),
          tool("write", "write stuff", { type: "object" }, async () => ({
            content: [{ type: "text" as const, text: "w" }],
          })),
        ],
      });
      const specs = toolSpecsFromMcpServer("myserver", server);
      expect(specs).toHaveLength(2);
      expect(specs[0].definition.function.name).toBe("mcp__myserver__read");
      expect(specs[1].definition.function.name).toBe("mcp__myserver__write");
    });

    it("security defaults to { risk: 'write', defaultMode: 'confirm' } when undefined", () => {
      const server = createSdkMcpServer({
        name: "srv",
        tools: [
          tool("t", "d", { type: "object" }, async () => ({
            content: [{ type: "text" as const, text: "x" }],
          })),
        ],
      });
      const specs = toolSpecsFromMcpServer("srv", server);
      expect(specs[0].security).toEqual({
        risk: "write",
        defaultMode: "confirm",
      });
    });

    it("handler returning text content produces ok: true result", async () => {
      const server = createSdkMcpServer({
        name: "srv",
        tools: [
          tool("echo", "echoes", { type: "object" }, async () => ({
            content: [{ type: "text" as const, text: "hello" }],
          })),
        ],
      });
      const specs = toolSpecsFromMcpServer("srv", server);
      const result = await specs[0].execute({}, {} as never, {} as never);
      expect(result.ok).toBe(true);
      expect(result.summary).toBe("hello");
    });

    it("handler throwing produces ok: false with MCP_TOOL_FAILED code", async () => {
      const server = createSdkMcpServer({
        name: "srv",
        tools: [
          tool("boom", "explodes", { type: "object" }, async () => {
            throw new Error("kaboom");
          }),
        ],
      });
      const specs = toolSpecsFromMcpServer("srv", server);
      const result = await specs[0].execute({}, {} as never, {} as never);
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("MCP_TOOL_FAILED");
      expect(result.error?.message).toBe("kaboom");
    });

    it("parseArgs with valid JSON returns parsed object, invalid returns {}", () => {
      const server = createSdkMcpServer({
        name: "srv",
        tools: [
          tool("t", "d", { type: "object" }, async () => ({
            content: [{ type: "text" as const, text: "" }],
          })),
        ],
      });
      const specs = toolSpecsFromMcpServer("srv", server);
      const parsed = specs[0].parseArgs('{"key":"val"}');
      expect(parsed).toEqual({ key: "val" });
      const fallback = specs[0].parseArgs("not-json");
      expect(fallback).toEqual({});
    });
  });
});
