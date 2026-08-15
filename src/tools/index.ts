import { z } from 'zod';
import type Anthropic from '@anthropic-ai/sdk';
import { askUserTool } from './askUser.js';
import { bashTool } from './bash.js';
import { cronCreateTool, cronDeleteTool, cronListTool } from './cron.js';
import { dynamicWorkflowTool } from './dynamicWorkflow.js';
import { editFileTool } from './edit.js';
import { exitPlanModeTool } from './exitPlanMode.js';
import { globTool } from './glob.js';
import { createGoalTool, getGoalTool, setGoalBudgetTool, updateGoalTool } from './goal.js';
import {
  teamInboxTool,
  teamInitTool,
  teamMergeTool,
  teamPlanTool,
  teamSendTool,
  teamSpawnTool,
  teamStatusTool,
  teamTeardownTool,
} from './team.js';
import { grepTool } from './grep.js';
import { imageSearchTool } from './imageSearch.js';
import { listDirTool } from './listDir.js';
import { readFileTool } from './readFile.js';
import { readMediaTool } from './readMedia.js';
import { spawnAgentTool } from './spawnAgent.js';
import { skillTool } from './skill.js';
import { skillSearchTool } from './skillSearch.js';
import { taskListTool, taskOutputTool, taskStopTool } from './task.js';
import { todoListTool } from './todoList.js';
import { toolSearchTool } from './toolSearch.js';
import { fail, type ToolContext, type ToolDef, type ToolResult } from './types.js';
import type { ToolAccess } from './access.js';
import { webFetchTool } from './webFetch.js';
import { webSearchTool } from './webSearch.js';
import { writeFileTool } from './write.js';

/** 全部工具，按注册顺序。 */
const ALL_TOOLS: ToolDef<any>[] = [
  readFileTool,
  readMediaTool,
  writeFileTool,
  editFileTool,
  listDirTool,
  globTool,
  grepTool,
  bashTool,
  webSearchTool,
  webFetchTool,
  imageSearchTool,
  spawnAgentTool,
  exitPlanModeTool,
  askUserTool,
  todoListTool,
  taskListTool,
  taskOutputTool,
  taskStopTool,
  skillTool,
  skillSearchTool,
  createGoalTool,
  updateGoalTool,
  setGoalBudgetTool,
  getGoalTool,
  teamInitTool,
  teamPlanTool,
  teamSpawnTool,
  teamSendTool,
  teamInboxTool,
  teamStatusTool,
  teamMergeTool,
  teamTeardownTool,
  cronCreateTool,
  cronListTool,
  cronDeleteTool,
  toolSearchTool,
  dynamicWorkflowTool,
];

const TOOL_MAP = new Map<string, ToolDef<any>>(ALL_TOOLS.map((t) => [t.name, t]));

/** 动态注册的工具（如 MCP 懒加载命中的工具），运行期追加。 */
const DYNAMIC_TOOLS = new Map<string, ToolDef<any>>();

/** 动态注册一个工具（如 MCP 工具命中后加载）。同名覆盖。 */
export function registerDynamicTool(tool: ToolDef<any>): void {
  DYNAMIC_TOOLS.set(tool.name, tool);
}

/** 清空动态注册的工具（会话切换时）。 */
export function clearDynamicTools(): void {
  DYNAMIC_TOOLS.clear();
}

/**
 * 把工具返回的任意值规整为合法 ToolResult（信任边界）。
 * 工具若返回 undefined / 原始值 / 畸形对象，一律转成合成的 isError 结果，
 * 保证 agent 循环总能给每个 tool_use 配上一个 tool_result，绝不出现孤立 tool_use。
 */
export function coerceToolResult(value: unknown): ToolResult {
  if (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ToolResult).content === 'string' &&
    typeof (value as ToolResult).isError === 'boolean'
  ) {
    return value as ToolResult;
  }
  if (typeof value === 'string') {
    return { content: value, isError: false };
  }
  return fail(`工具返回了非法结果（${typeof value}），已按错误处理。`);
}

/** 生成 Anthropic Messages API 的 tools 数组。传入 names 则只取白名单内的工具（供子 agent 收窄工具集）。 */
export function toAnthropicTools(names?: readonly string[]): Anthropic.Tool[] {
  const set = names === undefined ? undefined : new Set(names);
  // 动态工具并入，但若与静态工具同名（如覆盖注册）则不重复，以静态定义为准
  const dynamic = [...DYNAMIC_TOOLS.values()].filter((t) => !TOOL_MAP.has(t.name));
  const all = [...ALL_TOOLS, ...dynamic];
  return all.filter((t) => set === undefined || set.has(t.name)).map((tool) => {
    const jsonSchema = z.toJSONSchema(tool.schema) as Record<string, unknown>;
    delete jsonSchema['$schema'];
    return {
      name: tool.name,
      description: tool.description,
      input_schema: jsonSchema as Anthropic.Tool.InputSchema,
    };
  });
}

/** 全部已注册工具名（含动态注册）。 */
export function allToolNames(): string[] {
  return [...ALL_TOOLS.map((t) => t.name), ...DYNAMIC_TOOLS.keys()];
}

/**
 * 取一次工具调用的资源访问声明（供 runTurn 并行调度冲突判定）。
 * 未知工具 / 未声明 / 入参非法一律按 all（独占串行，安全退化）。
 */
export function toolAccessOf(name: string, rawInput: unknown, ctx: ToolContext): ToolAccess {
  const tool = TOOL_MAP.get(name) ?? DYNAMIC_TOOLS.get(name);
  if (tool?.access === undefined) return { kind: 'all' };
  const parsed = tool.schema.safeParse(rawInput);
  if (!parsed.success) return { kind: 'all' };
  return tool.access(parsed.data, ctx);
}

/**
 * 执行一次工具调用：校验入参 → 调用 execute。校验失败、未知工具、执行抛异常、
 * 返回畸形值——全部转为 ToolResult（错误以 isError 回灌），绝不抛出，
 * 以便 agent 循环把错误交还给模型自我纠正。
 */
export async function executeTool(
  name: string,
  rawInput: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const tool = TOOL_MAP.get(name) ?? DYNAMIC_TOOLS.get(name);
  if (tool === undefined) {
    return fail(`未知工具：${name}`);
  }
  const parsed = tool.schema.safeParse(rawInput);
  if (!parsed.success) {
    return fail(`工具 ${name} 入参校验失败：${parsed.error.message}`);
  }
  try {
    return coerceToolResult(await tool.execute(parsed.data, ctx));
  } catch (e) {
    return fail(`工具 ${name} 执行异常：${(e as Error).message}`);
  }
}
