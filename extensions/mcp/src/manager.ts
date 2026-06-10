import path from "node:path";
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  StdioClientTransport,
  getDefaultEnvironment,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import {
  CallToolResultSchema,
  type CallToolResult,
  type Tool as McpTool,
} from "@modelcontextprotocol/sdk/types.js";
import { parseJsonObject } from "@step-cli/core/tools/args.js";
import type {
  ToolDependency,
  JsonSchema,
  ToolExecutionResult,
  ToolPermissionMode,
  ToolRiskLevel,
  ToolSpec,
} from "@step-cli/protocol";
import type { StepCliMcpServerConfig } from "./types.js";

const DEFAULT_MCP_TIMEOUT_MS = 30_000;
const MAX_STDERR_TAIL_CHARS = 4_000;

function resolveStepCliVersion(): string {
  if (process.env.STEP_CLI_BUILD_VERSION?.trim()) {
    return process.env.STEP_CLI_BUILD_VERSION.trim();
  }
  // extensions/mcp/src/manager.ts → ../../../package.json is the repo root
  // for both source mode (tsx) and the tsdown-built dist layout.
  try {
    const url = new URL("../../../package.json", import.meta.url);
    const pkg = JSON.parse(readFileSync(url, "utf8")) as { version?: unknown };
    if (typeof pkg.version === "string" && pkg.version.trim() !== "") {
      return pkg.version;
    }
  } catch {
    // fall through
  }
  return "0.0.0-dev";
}

const STEP_CLI_MCP_CLIENT_INFO = {
  name: "step-cli",
  version: resolveStepCliVersion(),
} as const;

interface ConnectedMcpServer {
  name: string;
  config: StepCliMcpServerConfig;
  client: Client;
  transport: StdioClientTransport;
  tools: McpTool[];
  stderr: {
    tail: string;
  };
}

export interface ConnectedMcpServerLike {
  name: string;
  tools: McpTool[];
}

type ConnectedMcpServerResult<
  TServer extends ConnectedMcpServerLike = ConnectedMcpServerLike,
> =
  | {
      index: number;
      server: TServer;
      warning: string | null;
    }
  | {
      index: number;
      error: string;
    };

export interface CreateStepCliMcpManagerResult {
  manager?: StepCliMcpManager;
  warnings: string[];
}

export interface BuildMcpToolSpecsInput {
  servers: Array<{
    name: string;
    config: StepCliMcpServerConfig;
    tools: McpTool[];
  }>;
  invokeTool: (
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ) => Promise<CallToolResult>;
}

export interface StepCliMcpToolResultData {
  serverName: string;
  remoteToolName: string;
  contentTypes: string[];
  structuredContent?: Record<string, unknown>;
}

interface RemoteMcpToolInvocation {
  serverName: string;
  serverUrl: string;
  toolName: string;
  args: Record<string, unknown>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

interface RemoteMcpToolProbeInput {
  serverName: string;
  serverUrl: string;
  toolName: string;
  timeoutMs?: number;
}

type RawMcpCallToolResult = Awaited<ReturnType<Client["callTool"]>>;

export class StepCliMcpManager {
  private readonly serversByName: Map<string, ConnectedMcpServer>;
  private readonly toolSpecs: ToolSpec[];
  private readonly dependencies: ToolDependency[];

  private constructor(servers: ConnectedMcpServer[]) {
    this.serversByName = new Map(
      servers.map((server) => [server.name, server]),
    );
    this.toolSpecs = buildMcpToolSpecs({
      servers,
      invokeTool: (serverName, toolName, args, signal) =>
        this.callTool(serverName, toolName, args, signal),
    });
    this.dependencies = servers.map((server) => ({
      type: "mcp",
      value: server.name,
      description: `stdio:${server.config.command}`,
    }));
  }

  static async create(input: {
    workspaceRoot: string;
    servers?: Record<string, StepCliMcpServerConfig>;
  }): Promise<CreateStepCliMcpManagerResult> {
    const configuredServers = Object.entries(input.servers ?? {})
      .filter(([, config]) => config.enabled !== false)
      .sort(([left], [right]) => left.localeCompare(right));

    if (configuredServers.length === 0) {
      return {
        warnings: [],
      };
    }

    const warnings: string[] = [];
    const connected: ConnectedMcpServer[] = [];
    const results = await connectMcpServersInParallel({
      configuredServers,
      workspaceRoot: input.workspaceRoot,
      connectServer: ({ serverName, config, workspaceRoot }) =>
        connectMcpServer({
          serverName,
          config,
          workspaceRoot,
        }),
    });

    for (const result of results) {
      if ("server" in result) {
        connected.push(result.server);
        if (result.warning) {
          warnings.push(result.warning);
        }
        continue;
      }

      warnings.push(result.error);
    }

    if (connected.length === 0) {
      return { warnings };
    }

    return {
      manager: new StepCliMcpManager(connected),
      warnings,
    };
  }

  getToolSpecs(): ToolSpec[] {
    return [...this.toolSpecs];
  }

  getDependencies(): ToolDependency[] {
    return this.dependencies.map((dependency) => ({ ...dependency }));
  }

  getServerCount(): number {
    return this.serversByName.size;
  }

  getToolCount(): number {
    return this.toolSpecs.length;
  }

  listServerNames(): string[] {
    return [...this.serversByName.keys()];
  }

  async close(): Promise<void> {
    await Promise.all(
      [...this.serversByName.values()].map(async (server) => {
        try {
          await server.client.close();
        } catch {
          try {
            await server.transport.close();
          } catch {
            // Best-effort cleanup only.
          }
        }
      }),
    );
  }

  private async callTool(
    serverName: string,
    toolName: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<CallToolResult> {
    const server = this.serversByName.get(serverName);
    if (!server) {
      throw new Error(`Unknown MCP server: ${serverName}`);
    }

    const result = await server.client.callTool(
      {
        name: toolName,
        arguments: args,
      },
      CallToolResultSchema,
      {
        timeout: server.config.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS,
        resetTimeoutOnProgress: true,
        signal,
      },
    );

    return normalizeMcpCallToolResult(result);
  }
}

export async function invokeRemoteMcpTool(
  input: RemoteMcpToolInvocation,
): Promise<ToolExecutionResult<StepCliMcpToolResultData>> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;
  const transport = new StreamableHTTPClientTransport(new URL(input.serverUrl));
  const client = new Client(STEP_CLI_MCP_CLIENT_INFO, {
    capabilities: {},
  });

  try {
    await client.connect(transport, {
      timeout: timeoutMs,
    });

    const tools = await listAllMcpTools(client, timeoutMs);
    if (!tools.some((tool) => tool.name === input.toolName)) {
      return {
        ok: false,
        summary: `MCP tool ${input.serverName}.${input.toolName} unavailable`,
        error: {
          code: "MCP_TOOL_UNAVAILABLE",
          message: `Remote MCP server '${input.serverName}' does not expose tool '${input.toolName}'.`,
        },
      };
    }

    const result = await client.callTool(
      {
        name: input.toolName,
        arguments: input.args,
      },
      CallToolResultSchema,
      {
        timeout: timeoutMs,
        resetTimeoutOnProgress: true,
        signal: input.signal,
      },
    );

    return renderMcpToolResult({
      serverName: input.serverName,
      remoteToolName: input.toolName,
      result: normalizeMcpCallToolResult(result),
    });
  } catch (error) {
    return {
      ok: false,
      summary: `MCP tool ${input.serverName}.${input.toolName} failed`,
      error: {
        code: "MCP_TOOL_ERROR",
        message: error instanceof Error ? error.message : String(error),
      },
    };
  } finally {
    try {
      await client.close();
    } catch {
      try {
        await transport.close();
      } catch {
        // Best-effort cleanup only.
      }
    }
  }
}

export async function probeRemoteMcpToolAvailability(
  input: RemoteMcpToolProbeInput,
): Promise<{ available: boolean; warning?: string }> {
  const timeoutMs = input.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS;
  const transport = new StreamableHTTPClientTransport(new URL(input.serverUrl));
  const client = new Client(STEP_CLI_MCP_CLIENT_INFO, {
    capabilities: {},
  });

  try {
    await client.connect(transport, {
      timeout: timeoutMs,
    });

    const tools = await listAllMcpTools(client, timeoutMs);
    if (tools.some((tool) => tool.name === input.toolName)) {
      return { available: true };
    }

    return {
      available: false,
      warning:
        `Warning: built-in ${input.toolName} disabled because MCP server ` +
        `'${input.serverName}' does not expose that tool.`,
    };
  } catch (error) {
    return {
      available: false,
      warning:
        `Warning: built-in ${input.toolName} disabled because MCP probe failed ` +
        `for '${input.serverName}': ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    try {
      await client.close();
    } catch {
      try {
        await transport.close();
      } catch {
        // Best-effort cleanup only.
      }
    }
  }
}

export async function connectMcpServersInParallel<
  TServer extends ConnectedMcpServerLike,
>(input: {
  configuredServers: Array<[string, StepCliMcpServerConfig]>;
  workspaceRoot: string;
  connectServer: (input: {
    serverName: string;
    config: StepCliMcpServerConfig;
    workspaceRoot: string;
  }) => Promise<TServer>;
}): Promise<Array<ConnectedMcpServerResult<TServer>>> {
  const results: Array<ConnectedMcpServerResult<TServer>> = await Promise.all(
    input.configuredServers.map(async ([serverName, config], index) => {
      try {
        const server = await input.connectServer({
          serverName,
          config,
          workspaceRoot: input.workspaceRoot,
        });

        return {
          index,
          server,
          warning:
            server.tools.length === 0
              ? `MCP server '${serverName}' connected but exposed no tools.`
              : null,
        };
      } catch (error) {
        return {
          index,
          error: formatMcpConnectionError(serverName, error),
        };
      }
    }),
  );

  return results.sort((left, right) => left.index - right.index);
}

export function buildMcpToolSpecs(input: BuildMcpToolSpecsInput): ToolSpec[] {
  const usedNames = new Set<string>();
  const specs: ToolSpec<Record<string, unknown>, StepCliMcpToolResultData>[] =
    [];

  for (const server of input.servers) {
    const selectedTools = filterMcpTools(server.tools, server.config);

    for (const tool of selectedTools) {
      const localToolName = createUniqueMcpToolName(
        server.config.toolPrefix || server.name,
        tool.name,
        usedNames,
      );
      const security = createMcpSecurityDescriptor(server.config, tool);

      specs.push({
        definition: {
          type: "function",
          function: {
            name: localToolName,
            description: buildMcpToolDescription(server.name, tool),
            parameters: normalizeMcpInputSchema(tool.inputSchema),
          },
        },
        security,
        parseArgs: parseJsonObject,
        async execute(args: Record<string, unknown>, ctx) {
          const result = await input.invokeTool(
            server.name,
            tool.name,
            args,
            ctx.signal,
          );
          return renderMcpToolResult({
            serverName: server.name,
            remoteToolName: tool.name,
            result,
          });
        },
      });
    }
  }

  return specs;
}

export function renderMcpToolResult(input: {
  serverName: string;
  remoteToolName: string;
  result: CallToolResult;
}): ToolExecutionResult<StepCliMcpToolResultData> {
  const contentTypes: string[] = [];
  const segments: string[] = [];

  for (const item of input.result.content ?? []) {
    contentTypes.push(item.type);

    if (item.type === "text") {
      const text = item.text.trim();
      if (text.length > 0) {
        segments.push(text);
      }
      continue;
    }

    if (item.type === "resource") {
      if (
        "text" in item.resource &&
        typeof item.resource.text === "string" &&
        item.resource.text.trim().length > 0
      ) {
        segments.push(item.resource.text.trim());
      } else {
        const mimeType = item.resource.mimeType ?? "application/octet-stream";
        segments.push(
          `[MCP resource omitted: ${mimeType} ${item.resource.uri}]`,
        );
      }
      continue;
    }

    if (item.type === "resource_link") {
      segments.push(`[MCP resource link] ${item.name}: ${item.uri}`);
      continue;
    }

    if (item.type === "image" || item.type === "audio") {
      segments.push(`[MCP ${item.type} content omitted: ${item.mimeType}]`);
    }
  }

  const structuredContent =
    input.result.structuredContent &&
    Object.keys(input.result.structuredContent).length > 0
      ? input.result.structuredContent
      : undefined;

  if (structuredContent) {
    const serialized = safeJsonStringify(structuredContent);
    if (serialized.length > 0) {
      segments.push(serialized);
    }
  }

  const content = segments.join("\n\n").trim() || undefined;
  const ok = input.result.isError !== true;

  return {
    ok,
    summary: ok
      ? `MCP tool ${input.serverName}.${input.remoteToolName} completed`
      : `MCP tool ${input.serverName}.${input.remoteToolName} failed`,
    content,
    data: {
      serverName: input.serverName,
      remoteToolName: input.remoteToolName,
      contentTypes,
      structuredContent,
    },
    error: ok
      ? undefined
      : {
          code: "MCP_TOOL_ERROR",
          message:
            content ??
            `MCP tool ${input.serverName}.${input.remoteToolName} returned isError=true`,
        },
  };
}

export function normalizeMcpInputSchema(schema: unknown): JsonSchema {
  const record = isRecord(schema) ? schema : {};
  const normalized: Record<string, unknown> = {
    ...record,
    type: "object",
    properties: isRecord(record.properties) ? record.properties : {},
  };

  const required = Array.isArray(record.required)
    ? record.required.filter(isNonEmptyString)
    : undefined;
  if (required && required.length > 0) {
    normalized.required = required;
  } else {
    delete normalized.required;
  }

  if (typeof record.additionalProperties === "boolean") {
    normalized.additionalProperties = record.additionalProperties;
  }

  return normalized as JsonSchema;
}

export function sanitizeMcpIdentifier(value: string, fallback: string): string {
  const normalized = value
    .trim()
    .replace(/[^a-zA-Z0-9_]+/g, "_")
    .replace(/_+/g, "_")
    .replace(/^_+|_+$/g, "");

  const base = normalized.length > 0 ? normalized : fallback;
  return /^[0-9]/.test(base) ? `mcp_${base}` : base;
}

function createUniqueMcpToolName(
  serverName: string,
  toolName: string,
  usedNames: Set<string>,
): string {
  const serverPrefix = sanitizeMcpIdentifier(serverName, "mcp");
  const toolSuffix = sanitizeMcpIdentifier(toolName, "tool");
  const baseName = `${serverPrefix}__${toolSuffix}`;

  let candidate = baseName;
  let counter = 2;
  while (usedNames.has(candidate)) {
    candidate = `${baseName}_${counter}`;
    counter += 1;
  }

  usedNames.add(candidate);
  return candidate;
}

function buildMcpToolDescription(serverName: string, tool: McpTool): string {
  const detail =
    tool.description?.trim() ||
    tool.title?.trim() ||
    `Remote MCP tool '${tool.name}'.`;
  return `MCP tool from server '${serverName}' (remote name: '${tool.name}'). ${detail}`;
}

function createMcpSecurityDescriptor(
  config: StepCliMcpServerConfig,
  tool: McpTool,
): {
  risk: ToolRiskLevel;
  defaultMode?: ToolPermissionMode;
} {
  const risk = config.risk ?? inferMcpRiskFromTool(tool);
  return {
    risk,
    defaultMode: config.defaultMode,
  };
}

function inferMcpRiskFromTool(tool: McpTool): ToolRiskLevel {
  if (tool.annotations?.readOnlyHint) {
    return "read";
  }

  if (tool.annotations?.destructiveHint) {
    return "write";
  }

  return "execute";
}

function filterMcpTools(
  tools: McpTool[],
  config: StepCliMcpServerConfig,
): McpTool[] {
  const include = new Set(config.includeTools ?? []);
  const exclude = new Set(config.excludeTools ?? []);

  return tools.filter((tool) => {
    if (exclude.has(tool.name)) {
      return false;
    }
    if (include.size > 0 && !include.has(tool.name)) {
      return false;
    }
    return true;
  });
}

async function connectMcpServer(input: {
  serverName: string;
  config: StepCliMcpServerConfig;
  workspaceRoot: string;
}): Promise<ConnectedMcpServer> {
  const stderr = { tail: "" };
  const transport = new StdioClientTransport({
    command: input.config.command,
    args: input.config.args,
    cwd: resolveMcpServerCwd(input.workspaceRoot, input.config.cwd),
    env: {
      ...getDefaultEnvironment(),
      ...input.config.env,
    },
    stderr: "pipe",
  });

  const stderrStream = transport.stderr;
  stderrStream?.on("data", (chunk) => {
    stderr.tail = trimTail(
      `${stderr.tail}${String(chunk)}`,
      MAX_STDERR_TAIL_CHARS,
    );
  });

  const client = new Client(STEP_CLI_MCP_CLIENT_INFO, {
    capabilities: {},
  });

  try {
    await client.connect(transport, {
      timeout: input.config.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS,
    });
    const tools = await listAllMcpTools(
      client,
      input.config.timeoutMs ?? DEFAULT_MCP_TIMEOUT_MS,
    );

    return {
      name: input.serverName,
      config: input.config,
      client,
      transport,
      tools,
      stderr,
    };
  } catch (error) {
    const stderrText = stderr.tail.trim();
    try {
      await client.close();
    } catch {
      try {
        await transport.close();
      } catch {
        // Best-effort cleanup only.
      }
    }

    if (stderrText.length > 0 && error instanceof Error) {
      error.message = `${error.message} | stderr: ${stderrText}`;
    }
    throw error;
  }
}

async function listAllMcpTools(
  client: Client,
  timeoutMs: number,
): Promise<McpTool[]> {
  const tools: McpTool[] = [];
  let cursor: string | undefined;

  do {
    const result = await client.listTools(cursor ? { cursor } : undefined, {
      timeout: timeoutMs,
    });
    tools.push(...result.tools);
    cursor = result.nextCursor;
  } while (cursor);

  return tools;
}

function resolveMcpServerCwd(
  workspaceRoot: string,
  cwd: string | undefined,
): string | undefined {
  if (!cwd) {
    return undefined;
  }

  return path.isAbsolute(cwd) ? cwd : path.resolve(workspaceRoot, cwd);
}

function formatMcpConnectionError(serverName: string, error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `Failed to connect MCP server '${serverName}': ${message}`;
}

function normalizeMcpCallToolResult(
  result: RawMcpCallToolResult,
): CallToolResult {
  if (hasMcpContent(result)) {
    return CallToolResultSchema.parse(result);
  }

  const legacyPayload =
    isRecord(result) && "toolResult" in result ? result.toolResult : undefined;
  if (hasMcpContent(legacyPayload)) {
    return CallToolResultSchema.parse(legacyPayload);
  }

  const structuredContent = isRecord(legacyPayload) ? legacyPayload : undefined;
  const serialized = safeJsonStringify(legacyPayload).trim();

  return CallToolResultSchema.parse({
    _meta: isRecord(result) ? result._meta : undefined,
    content: serialized.length > 0 ? [{ type: "text", text: serialized }] : [],
    structuredContent,
    isError:
      isRecord(legacyPayload) && typeof legacyPayload.isError === "boolean"
        ? legacyPayload.isError
        : undefined,
  });
}

function safeJsonStringify(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "";
  }
}

function trimTail(value: string, maxChars: number): string {
  if (value.length <= maxChars) {
    return value;
  }
  return value.slice(value.length - maxChars);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function hasMcpContent(value: unknown): value is CallToolResult {
  return isRecord(value) && Array.isArray(value.content);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}
