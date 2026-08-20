import { z } from 'zod';
import { searchTools, type DeferredTool } from '../agent/toolSearch.js';
import { ok, type ToolDef } from './types.js';

const schema = z.object({
  query: z.string().describe('要查找的工具能力关键词（如 "搜索图片"、"读取文件"）。'),
  limit: z.number().int().positive().optional().describe('最多返回几个工具，默认 8。'),
});

/**
 * 搜索可用的外部工具（懒加载发现）。
 * 部分外部工具（如未来的 MCP 工具）默认不进初始工具集以节省上下文；
 * 用本工具按关键词检索，命中的工具将被加载、下一轮即可直接调用。
 */
export const toolSearchTool: ToolDef<z.infer<typeof schema>> = {
  name: 'tool_search',
  description:
    '搜索外部 MCP/function 工具（懒加载）。当任务需要的能力不在当前工具集里时，用本工具按关键词检索外部工具（如 MCP 工具）；命中的工具会被加载，下一轮即可直接调用。只搜可直接调用的函数，不搜技能（skill）。需要操作指令（如浏览器操控、数据库操作）时用 skill_search。',
  schema,
  async execute(input, ctx) {
    if (ctx.toolSearch === undefined) {
      return ok('当前没有可搜索的外部工具（外部工具懒加载未配置）。');
    }
    const hits = searchTools(ctx.toolSearch.deferred, input.query, input.limit ?? 8);
    if (hits.length === 0) {
      return ok(`没有找到与「${input.query}」匹配的外部工具。`);
    }
    ctx.toolSearch.load(hits.map((h) => h.name));
    const names = hits.map((h) => `- ${h.name}：${h.description}`).join('\n');
    return ok(`已加载 ${hits.length} 个工具，下一轮即可调用：\n${names}`);
  },
};

/** 供组合根注入 tool_search 的 deferred 工具注册表与加载回调。 */
export interface ToolSearchRegistry {
  deferred: DeferredTool[];
  /** 把命中的工具名标记为已加载（下一轮 tools 数组将包含它们）。 */
  load: (names: string[]) => void;
}
