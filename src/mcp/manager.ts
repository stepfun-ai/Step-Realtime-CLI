import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { VERSION } from '../version.js';

/** 把 MCP 工具的 JSON inputSchema 转成带类型强转的 zod schema（模型常给字符串数字/布尔）。 */
export function mcpInputSchemaToZod(inputSchema: unknown): z.ZodTypeAny {
  const props = (inputSchema as { properties?: Record<string, unknown> } | undefined)?.properties;
  if (props === undefined || typeof props !== 'object') {
    return z.record(z.string(), z.unknown());
  }
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, rawProp] of Object.entries(props)) {
    const prop = rawProp as { type?: string; description?: string };
    let field: z.ZodTypeAny;
    switch (prop?.type) {
      case 'number':
      case 'integer':
        field = z.coerce.number();
        break;
      case 'boolean':
        field = z.coerce.boolean();
        break;
      case 'string':
        field = z.string();
        break;
      case 'array':
        field = z.array(z.unknown());
        break;
      case 'object':
        field = z.record(z.string(), z.unknown());
        break;
      default:
        field = z.unknown();
    }
    if (typeof prop?.description === 'string') field = field.describe(prop.description);
    shape[key] = field;
  }
  // MCP 工具的 required 数组决定可选性
  const required = new Set(
    ((inputSchema as { required?: string[] } | undefined)?.required ?? []) as string[],
  );
  const finalShape: Record<string, z.ZodTypeAny> = {};
  for (const [key, field] of Object.entries(shape)) {
    finalShape[key] = required.has(key) ? field : field.optional();
  }
  return z.object(finalShape).passthrough();
}

/**
 * MCP（Model Context Protocol）接入：连接管理 + list_tools 注册 + call_tool。
 * 配置来源 ~/.step-code/mcp.json 的 mcpServers 表（stdio transport）。
 */

export interface McpServerConfig {
  command: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  enabled?: boolean;
  /** 单个 server 的启动超时（毫秒），缺省 30000。 */
  startupTimeoutMs?: number;
}

/** server 连接状态（供 /mcp 面板展示）。 */
export type McpServerStatus = 'pending' | 'connected' | 'failed' | 'disabled';

export interface McpServerState {
  name: string;
  status: McpServerStatus;
  /** 已连接时为发现的工具数，其余为 0。 */
  toolCount: number;
  /** 失败时的单行错误摘要。 */
  error?: string;
}

export interface McpToolInfo {
  /** 规范化工具名 mcp__server__tool。 */
  qualifiedName: string;
  serverName: string;
  toolName: string;
  description: string;
  inputSchema: Anthropic.Tool['input_schema'];
}

function sanitize(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_+/g, '_');
}

/** 生成 mcp__server__tool 命名（超 64 字符时截断并追加 8 字符 FNV-1a 哈希后缀）。 */
export function qualifyMcpToolName(serverName: string, toolName: string): string {
  const full = `mcp__${sanitize(serverName)}__${sanitize(toolName)}`;
  if (full.length <= MAX_TOOL_NAME_LEN) return full;
  // 截断保留前 55 字符 + '_' + 8 字符哈希（哈希取自截断前的完整名，保证稳定性与区分度）
  return `${full.slice(0, MAX_TOOL_NAME_LEN - 9)}_${fnv1aHex(full)}`;
}

/** 工具名最大长度（64 字符上限）。 */
export const MAX_TOOL_NAME_LEN = 64;

/** FNV-1a 32 位哈希的 8 位十六进制串（自实现，不引依赖；用于命名截断方案）。 */
export function fnv1aHex(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

interface ConnectedServer {
  name: string;
  client: Client;
  tools: McpToolInfo[];
}

/** 单个 server 的默认启动超时（可用 mcp.json 的 startupTimeoutMs 覆盖）。 */
export const DEFAULT_STARTUP_TIMEOUT_MS = 30_000;

/** 带超时的 promise 包装：超时即拒，原 promise 挂 catch 防止 unhandled rejection。 */
async function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`启动超时（超过 ${ms}ms）`)), ms);
  });
  try {
    return await Promise.race([p, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    p.catch(() => {});
  }
}

/** 错误信息压成单行（/mcp 面板逐行展示用）。 */
function oneLine(message: string): string {
  return message.replace(/\s+/g, ' ').trim();
}

/** MCP 连接管理器：并行连接配置的 stdio server，发现工具，统一调用，暴露 per-server 状态。 */
export class McpManager {
  private readonly servers = new Map<string, ConnectedServer>();
  private readonly states = new Map<string, McpServerState>();

  /**
   * 连接一个 stdio MCP server 并发现工具。
   * 失败不抛出：状态（failed + 单行错误摘要）记入状态表，返回 false；成功返回 true。
   */
  async connect(name: string, config: McpServerConfig): Promise<boolean> {
    if (config.enabled === false) {
      this.states.set(name, { name, status: 'disabled', toolCount: 0 });
      return false;
    }
    this.states.set(name, { name, status: 'pending', toolCount: 0 });
    const client = new Client({ name: 'step-code', version: VERSION });
    try {
      const tools = await withTimeout(
        this.connectAndListTools(client, config),
        config.startupTimeoutMs ?? DEFAULT_STARTUP_TIMEOUT_MS,
      );
      const infos: McpToolInfo[] = tools.map((tool) => ({
        qualifiedName: qualifyMcpToolName(name, tool.name),
        serverName: name,
        toolName: tool.name,
        description: tool.description ?? '',
        inputSchema: (tool.inputSchema ?? { type: 'object' }) as Anthropic.Tool['input_schema'],
      }));
      this.servers.set(name, { name, client, tools: infos });
      this.states.set(name, { name, status: 'connected', toolCount: infos.length });
      return true;
    } catch (e) {
      // 失败/超时后尽力关闭 client（会 kill stdio 子进程），避免进程泄漏
      try {
        await client.close();
      } catch {
        // client 可能从未连上，close 报错属预期
      }
      this.states.set(name, { name, status: 'failed', toolCount: 0, error: oneLine((e as Error).message) });
      return false;
    }
  }

  /**
   * 并行连接全部配置的 server（Promise.allSettled，单点失败互不影响）。
   * 每个 server 连接成功即触发 onConnected（供工具增量补登 deferred）。
   */
  async connectAll(
    configs: Record<string, McpServerConfig>,
    onConnected?: (name: string) => void,
  ): Promise<void> {
    await Promise.allSettled(
      Object.entries(configs).map(async ([name, config]) => {
        if (await this.connect(name, config)) onConnected?.(name);
      }),
    );
  }

  /** 与 server 握手并发现工具（默认 stdio transport；测试可覆盖为假实现）。 */
  protected async connectAndListTools(
    client: Client,
    config: McpServerConfig,
  ): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>> {
    const transport = new StdioClientTransport({
      command: config.command,
      args: config.args ?? [],
      env: { ...process.env, ...(config.env ?? {}) } as Record<string, string>,
      cwd: config.cwd,
      stderr: 'pipe',
    });
    await client.connect(transport);
    const { tools } = await client.listTools();
    return tools;
  }

  /** 各 server 的当前状态（pending/connected/failed/disabled + 错误摘要 + 工具数），供 /mcp 展示。 */
  statuses(): McpServerState[] {
    return [...this.states.values()];
  }

  /**
   * 关闭全部已连接 server（逐个尽力 client.close()，会 kill stdio 子进程），并清空登记。
   * 非交互模式（-p / --reflect）跑完必须调用：stdio 子进程挂着会让事件循环永不排空、进程不退出。
   */
  async closeAll(): Promise<void> {
    for (const s of this.servers.values()) {
      try {
        await s.client.close();
      } catch {
        // 已断开或从未连上，close 报错属预期
      }
    }
    this.servers.clear();
  }

  /** 指定 server 已发现的工具（未连接返回空）。 */
  toolsOf(name: string): McpToolInfo[] {
    return this.servers.get(name)?.tools ?? [];
  }

  /** 所有已发现工具。 */
  allTools(): McpToolInfo[] {
    return [...this.servers.values()].flatMap((s) => s.tools);
  }

  /** 按规范化名查工具（含所属 client）。 */
  find(qualifiedName: string): { client: Client; info: McpToolInfo } | undefined {
    for (const s of this.servers.values()) {
      const info = s.tools.find((t) => t.qualifiedName === qualifiedName);
      if (info !== undefined) return { client: s.client, info };
    }
    return undefined;
  }

  /** 调用一个 MCP 工具，返回文本结果。 */
  async callTool(qualifiedName: string, args: Record<string, unknown>): Promise<{ content: string; isError: boolean }> {
    const found = this.find(qualifiedName);
    if (found === undefined) {
      return { content: `未找到 MCP 工具 ${qualifiedName}`, isError: true };
    }
    try {
      const result = await found.client.callTool({ name: found.info.toolName, arguments: args });
      // 归一结果：取 text 内容
      const blocks = (result as { content?: Array<{ type: string; text?: string }> }).content ?? [];
      const text = blocks
        .map((b) => (b.type === 'text' ? (b.text ?? '') : `[${b.type}]`))
        .join('\n');
      const isError = (result as { isError?: boolean }).isError === true;
      return { content: text === '' ? '[无输出]' : text, isError };
    } catch (e) {
      return { content: `MCP 工具调用失败：${(e as Error).message}`, isError: true };
    }
  }
}
