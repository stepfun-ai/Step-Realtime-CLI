import { z } from 'zod';
import { fail, ok, type ToolDef } from './types.js';

const listSchema = z.object({});

export const taskListTool: ToolDef<z.infer<typeof listSchema>> = {
  name: 'task_list',
  description: '列出后台任务及其状态（id / 状态 / 命令 / 起止时间）。',
  schema: listSchema,
  async execute(_input, ctx) {
    if (ctx.background === undefined) return fail('当前上下文不支持后台任务。');
    const tasks = ctx.background.list();
    if (tasks.length === 0) return ok('暂无后台任务。');
    const lines = tasks.map(
      (t) => `${t.id}  [${t.status}]  ${t.command}${t.exitCode !== undefined ? `  (exit ${t.exitCode})` : ''}`,
    );
    return ok(lines.join('\n'));
  },
};

const outputSchema = z.object({
  task_id: z.string().describe('后台任务 id。'),
});

export const taskOutputTool: ToolDef<z.infer<typeof outputSchema>> = {
  name: 'task_output',
  description:
    '查看某个后台任务的输出（内存中保留的尾部）。后台任务到达终态时系统会自动注入完成通知，不要在启动后台任务后立刻用它等待或反复轮询。',
  schema: outputSchema,
  async execute(input, ctx) {
    if (ctx.background === undefined) return fail('当前上下文不支持后台任务。');
    const t = ctx.background.get(input.task_id);
    if (t === undefined) return fail(`未找到后台任务 ${input.task_id}。`);
    return ok(`[${t.status}] ${t.command}\n\n${t.output === '' ? '（暂无输出）' : t.output}`);
  },
};

export const taskStopTool: ToolDef<z.infer<typeof outputSchema>> = {
  name: 'task_stop',
  description: '终止某个运行中的后台任务。',
  schema: outputSchema,
  async execute(input, ctx) {
    if (ctx.background === undefined) return fail('当前上下文不支持后台任务。');
    // 模型亲手杀的任务抑制终态通知（结果已在本工具返回里，再发「killed」通知是噪音）
    ctx.background.suppressNotification(input.task_id);
    const stopped = ctx.background.stop(input.task_id);
    return stopped
      ? ok(`已终止后台任务 ${input.task_id}。`)
      : fail(`无法终止 ${input.task_id}（不存在或已结束）。`);
  },
};
