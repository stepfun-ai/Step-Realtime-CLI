import type {
  JsonSchema,
  OpenAIToolDefinition,
  ToolExecutionContext,
  ToolExecutionResult,
  ToolRuntimeApi,
  ToolSecurityDescriptor,
  ToolSpec,
} from "@step-cli/protocol";
import { cloneJsonSchema } from "@step-cli/utils/json-schema.js";
import { safeParseJson } from "@step-cli/utils/json.js";
import type {
  McpServerInstance,
  SdkMcpTool,
  SdkMcpToolHandlerResult,
} from "./types.js";

const DEFAULT_MCP_SECURITY: ToolSecurityDescriptor = {
  risk: "write",
  defaultMode: "confirm",
};

export function tool<S>(
  name: string,
  description: string,
  schema: S,
  handler: (
    args: unknown,
    extra: unknown,
  ) => Promise<SdkMcpToolHandlerResult> | SdkMcpToolHandlerResult,
  security?: ToolSecurityDescriptor,
): SdkMcpTool {
  return {
    name,
    description,
    inputSchema: schema,
    handler,
    security,
  };
}

export function createSdkMcpServer(config: {
  name: string;
  version?: string;
  tools: SdkMcpTool[];
}): McpServerInstance {
  return {
    name: config.name,
    version: config.version,
    tools: config.tools,
  };
}

/**
 * Wrap an in-process MCP server's tools as native ToolSpecs the AgentLoop's
 * ToolRuntime can dispatch directly. Tool names follow the
 * `mcp__<server>__<tool>` convention shared with the host's allowedTools field.
 */
export function toolSpecsFromMcpServer(
  serverName: string,
  server: McpServerInstance,
): ToolSpec[] {
  return server.tools.map((mcpTool) => buildToolSpec(serverName, mcpTool));
}

function buildToolSpec(serverName: string, mcpTool: SdkMcpTool): ToolSpec {
  const internalName = `mcp__${serverName}__${mcpTool.name}`;
  const definition: OpenAIToolDefinition = {
    type: "function",
    function: {
      name: internalName,
      description: mcpTool.description,
      parameters: schemaForMcpTool(mcpTool.inputSchema),
    },
  };

  return {
    definition,
    security: mcpTool.security ?? DEFAULT_MCP_SECURITY,
    parseArgs: (rawArgs: string): unknown => {
      return safeParseJson<Record<string, unknown>>(rawArgs, {});
    },
    execute: async (
      args: unknown,
      _ctx: ToolExecutionContext,
      _runtime: ToolRuntimeApi,
    ): Promise<ToolExecutionResult> => {
      try {
        const handlerResult = await mcpTool.handler(args, {
          serverName,
          toolName: mcpTool.name,
        });
        const summary = formatHandlerResult(handlerResult);
        return {
          ok: !handlerResult.isError,
          summary,
        };
      } catch (error) {
        return {
          ok: false,
          summary: error instanceof Error ? error.message : String(error),
          error: {
            code: "MCP_TOOL_FAILED",
            message: error instanceof Error ? error.message : String(error),
          },
        };
      }
    },
  };
}

function formatHandlerResult(result: SdkMcpToolHandlerResult): string {
  if (!Array.isArray(result.content) || result.content.length === 0) {
    return "";
  }
  const parts: string[] = [];
  for (const block of result.content) {
    if (block && block.type === "text") parts.push(block.text);
  }
  return parts.join("\n");
}

/**
 * Convert the SdkMcpTool.inputSchema into a JsonSchema the AgentLoop can
 * present to the model. Plain JSON schemas pass through cloneJsonSchema for
 * field-order normalization and defensive copy; anything else falls back to
 * an open object (zod adapter ships later behind a peer dep).
 */
function schemaForMcpTool(schema: unknown): JsonSchema {
  if (looksLikeJsonSchema(schema)) {
    return cloneJsonSchema(schema as JsonSchema);
  }
  return { type: "object" };
}

function looksLikeJsonSchema(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  return "type" in (value as Record<string, unknown>);
}
