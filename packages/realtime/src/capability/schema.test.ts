import { describe, it, expect } from "vitest";
import {
  renderActionProtocolRules,
  renderToolCatalog,
  renderToolsAsActionProtocol,
} from "./schema.js";
import type { ToolSchema } from "./types.js";

describe("renderActionProtocolRules", () => {
  it("includes ACTION protocol markers", () => {
    const rules = renderActionProtocolRules();
    expect(rules).toContain("[[ACTION]]");
    expect(rules).toContain("[[/ACTION]]");
  });

  it("includes protocol instructions in Chinese", () => {
    const rules = renderActionProtocolRules();
    expect(rules).toContain("工具调用协议");
  });
});

describe("renderToolCatalog", () => {
  it("returns empty string for empty schemas", () => {
    expect(renderToolCatalog([])).toBe("");
  });

  it("renders tool name and description", () => {
    const schemas: ToolSchema[] = [
      {
        name: "search",
        description: "Search the web",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "search query" },
          },
          required: ["query"],
        },
      },
    ];

    const catalog = renderToolCatalog(schemas);
    expect(catalog).toContain("search");
    expect(catalog).toContain("Search the web");
    expect(catalog).toContain("query");
  });

  it("marks required parameters", () => {
    const schemas: ToolSchema[] = [
      {
        name: "read",
        description: "Read a file",
        parameters: {
          type: "object",
          properties: {
            path: { type: "string", description: "file path" },
          },
          required: ["path"],
        },
      },
    ];

    const catalog = renderToolCatalog(schemas);
    expect(catalog).toContain("必填");
  });
});

describe("renderToolsAsActionProtocol", () => {
  it("returns empty string for empty schemas", () => {
    expect(renderToolsAsActionProtocol([])).toBe("");
  });

  it("combines protocol rules and catalog", () => {
    const schemas: ToolSchema[] = [
      {
        name: "echo",
        description: "Echo text",
        parameters: { type: "object", properties: {}, required: [] },
      },
    ];

    const result = renderToolsAsActionProtocol(schemas);
    expect(result).toContain("[[ACTION]]");
    expect(result).toContain("echo");
  });
});
