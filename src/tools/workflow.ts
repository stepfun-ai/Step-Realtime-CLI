import { z } from 'zod';
import { runWorkflow, type WorkflowDef } from '../agent/workflow.js';
import { fail, ok, type ToolDef } from './types.js';

const stepSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('agent'),
    prompt: z.string(),
    as: z.string(),
    subagentType: z.string().optional(),
    label: z.string().optional(),
  }),
  z.object({
    kind: z.literal('parallel'),
    tasks: z.array(z.object({ prompt: z.string(), label: z.string().optional(), subagentType: z.string().optional() })),
    as: z.string(),
  }),
  z.object({
    kind: z.literal('fanout'),
    items: z.array(z.string()),
    prompt: z.string(),
    as: z.string(),
    subagentType: z.string().optional(),
  }),
  z.object({
    kind: z.literal('synthesize'),
    from: z.array(z.string()),
    prompt: z.string(),
    as: z.string(),
    subagentType: z.string().optional(),
  }),
]);

const schema = z.object({
  name: z.string().describe('workflow 名称。'),
  description: z.string().optional(),
  steps: z.array(stepSchema).describe('编排步骤：agent（单个子任务）/ parallel（并行多个）/ fanout（对列表每项并行）/ synthesize（汇总）。步骤结果用 as 命名，后续步骤用 {{名}} 引用。'),
  max_agents: z.number().int().positive().optional().describe('agent 总数上限（护栏），默认 50。'),
  run_in_background: z
    .boolean()
    .optional()
    .describe('后台异步执行：立即返回 task_id，终态自动注入通知，不阻塞主会话。v1 限制：后台编排被 task_stop 时只标记 killed，不真正 abort 执行中的子 agent。'),
});

/**
 * 声明式编排：用声明式步骤模板编排多个子 agent。
 * 中间结果存运行时状态（不占主上下文），主会话只收最终报告。
 * 用于复杂多步任务：fan-out 并行调查→synthesize 综合、分阶段处理、loop-until-done 等。
 * 分工：workflow = 填表（声明式编排），dynamic_workflow = 写脚本（动态工作流）。
 */
export const workflowTool: ToolDef<z.infer<typeof schema>> = {
  name: 'workflow',
  description:
    '声明式编排多个子 agent（agent/parallel/fanout/synthesize 步骤模板）。中间结果不占上下文，只回最终报告。适合复杂多步任务：并行调查后综合、分阶段处理、批量分析。比逐个 spawn_agent 更高效。' +
    '需要条件分支、循环、由中间数据动态决定编排时，改用 dynamic_workflow 工具（现写 JS 脚本）。' +
    'run_in_background=true 后台异步（立即返回 task_id，终态自动通知；v1 限制：后台编排被 task_stop 时只标记 killed，不真正 abort 执行中的子 agent）。',
  schema,
  async execute(input, ctx) {
    if (ctx.runSubagent === undefined) {
      return fail('当前上下文不支持 workflow（需要子 agent 能力）。');
    }
    const def: WorkflowDef = {
      name: input.name,
      description: input.description,
      steps: input.steps,
      maxAgents: input.max_agents,
    };
    const run = async (): Promise<{ output: string; ok: boolean }> => {
      const r = await runWorkflow(def, {
        runSubagent: ctx.runSubagent!,
        maxConcurrent: ctx.subagentMaxConcurrent ?? 4,
        args: {},
        onStep: ctx.onWorkflowStep,
      });
      return {
        output: `workflow「${input.name}」完成（${r.steps} 步，用 ${r.agentsUsed} 个子 agent）：\n\n${r.report}`,
        ok: true,
      };
    };

    if (input.run_in_background === true) {
      if (ctx.background === undefined) {
        return fail('当前上下文不支持后台任务。');
      }
      try {
        // 包 {output, ok} promise 交 startTask（同 spawn_agent 后台模式）：失败经 manager 置 failed 并通知
        const id = ctx.background.startTask(`workflow·${input.name}`, run(), undefined, { kind: 'workflow' });
        return ok(
          `已在后台启动 workflow「${input.name}」（task_id=${id}）。终态会自动收到通知，也可用 task_output 查询。` +
            `注意：task_stop 只标记 killed，不会真正中断已在运行的子 agent。`,
        );
      } catch (e) {
        return fail((e as Error).message);
      }
    }

    try {
      const r = await run();
      return ok(r.output);
    } catch (e) {
      return fail(`workflow 执行失败：${(e as Error).message}`);
    }
  },
};
