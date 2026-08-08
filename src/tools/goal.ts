import { z } from 'zod';
import { fail, ok, type ToolDef } from './types.js';

const createSchema = z.object({
  objective: z.string().describe('要完成的目标（自然语言描述）。'),
  completion_criterion: z.string().optional().describe('完成标准（可选，如何判断目标达成）。'),
  replace: z.boolean().optional().describe('已有进行中 goal 时是否覆盖。'),
});

export const createGoalTool: ToolDef<z.infer<typeof createSchema>> = {
  name: 'create_goal',
  description:
    '设定一个自主目标：agent 会持续朝该目标推进，每轮自动续跑，直到目标达成（你调 update_goal 标 complete）或遇阻塞（标 blocked）。用于需要多轮自主推进的长任务。预算默认不设上限——目标就是跑到完成；不要顺手调 set_goal_budget，仅当用户明确给出硬限制时才设。',
  schema: createSchema,
  async execute(input, ctx) {
    if (ctx.goal === undefined) return fail('当前上下文不支持 goal。');
    try {
      const g = ctx.goal.create(input.objective, input.completion_criterion, input.replace ?? false);
      return ok(`已创建 goal：${g.objective}。将自主推进，达成或受阻时用 update_goal 报告。`);
    } catch (e) {
      return fail((e as Error).message);
    }
  },
};

const updateSchema = z.object({
  status: z.enum(['active', 'paused', 'blocked', 'complete']).describe('新的 goal 状态。'),
  reason: z.string().optional().describe('状态原因（如 blocked 的阻塞说明）。'),
});

export const updateGoalTool: ToolDef<z.infer<typeof updateSchema>> = {
  name: 'update_goal',
  description:
    '更新当前 goal 状态。目标达成标 complete，遇到无法自行解决的阻塞标 blocked，暂停标 paused，恢复标 active。',
  schema: updateSchema,
  async execute(input, ctx) {
    if (ctx.goal === undefined) return fail('当前上下文不支持 goal。');
    try {
      ctx.goal.update(input.status, input.reason);
      return ok(`goal 状态已更新为 ${input.status}${input.reason !== undefined ? `（${input.reason}）` : ''}。`);
    } catch (e) {
      return fail((e as Error).message);
    }
  },
};

const budgetSchema = z.object({
  turns: z.number().int().positive().optional().describe('轮次预算（最多自主推进多少轮）。'),
  tokens: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('token 预算（计费口径累计上限：input - cache_read + output）。'),
});

export const setGoalBudgetTool: ToolDef<z.infer<typeof budgetSchema>> = {
  name: 'set_goal_budget',
  description:
    '为当前 goal 设定预算（轮次和/或 token，任一超支则标 blocked）。goal 默认无预算上限，这是有意设计——默认心智是把任务做完，不是跑固定额度。仅当用户明确给出硬限制（如「最多 10 轮」「别超 5 万 token」）时才设置；用户没提就不要调本工具。',
  schema: budgetSchema,
  async execute(input, ctx) {
    if (ctx.goal === undefined) return fail('当前上下文不支持 goal。');
    if (input.turns === undefined && input.tokens === undefined) {
      return fail('至少要给一个预算参数（turns 或 tokens）。');
    }
    try {
      const parts: string[] = [];
      if (input.turns !== undefined) {
        ctx.goal.setTurnBudget(input.turns);
        parts.push(`轮次预算 ${input.turns}`);
      }
      if (input.tokens !== undefined) {
        ctx.goal.setTokenBudget(input.tokens);
        parts.push(`token 预算 ${input.tokens}`);
      }
      return ok(`goal 预算已设定：${parts.join('，')}。`);
    } catch (e) {
      return fail((e as Error).message);
    }
  },
};

const getSchema = z.object({});

export const getGoalTool: ToolDef<z.infer<typeof getSchema>> = {
  name: 'get_goal',
  description: '查看当前 goal 的目标、状态、已用轮次/token 与预算。',
  schema: getSchema,
  async execute(_input, ctx) {
    if (ctx.goal === undefined) return fail('当前上下文不支持 goal。');
    const g = ctx.goal.get();
    if (g === null) return ok('当前没有 goal。');
    return ok(
      `goal：${g.objective}\n状态：${g.status}\n已用轮次：${g.turnsUsed}${g.turnBudget !== undefined ? ` / 预算 ${g.turnBudget}` : ''}\n已用 token：${g.tokensUsed}${g.tokenBudget !== undefined ? ` / 预算 ${g.tokenBudget}` : ''}${g.terminalReason !== undefined ? `\n原因：${g.terminalReason}` : ''}`,
    );
  },
};
