import { z } from 'zod';
import { fail, ok, type ToolDef } from './types.js';

const createSchema = z.object({
  cron: z.string().describe('5 字段 cron 表达式（分 时 日 月 周），如 "*/5 * * * *" 每 5 分钟。'),
  prompt: z.string().describe('到点时要注入会话执行的指令。'),
  recurring: z.boolean().optional().describe('true（默认）周期触发；false 一次性，触发后自动删除。'),
});

export const cronCreateTool: ToolDef<z.infer<typeof createSchema>> = {
  name: 'cron_create',
  description:
    '创建定时任务：到点时把 prompt 注入当前会话执行。用于定期检查、提醒、周期任务。recurring=true 周期触发，false 一次性。',
  schema: createSchema,
  async execute(input, ctx) {
    if (ctx.cron === undefined) return fail('当前上下文不支持定时任务。');
    try {
      const job = ctx.cron.create(input.cron, input.prompt, input.recurring ?? true);
      return ok(
        `已创建定时任务 ${job.id}：${job.cron}${job.recurring ? '' : '（一次性）'}，下次触发 ${job.nextFireAt.toLocaleString()}。`,
      );
    } catch (e) {
      return fail((e as Error).message);
    }
  },
};

const listSchema = z.object({});

export const cronListTool: ToolDef<z.infer<typeof listSchema>> = {
  name: 'cron_list',
  description: '列出当前定时任务（id / cron / 下次触发 / 周期或一次性）。',
  schema: listSchema,
  async execute(_input, ctx) {
    if (ctx.cron === undefined) return fail('当前上下文不支持定时任务。');
    const jobs = ctx.cron.list();
    if (jobs.length === 0) return ok('暂无定时任务。');
    return ok(
      jobs
        .map((j) => `${j.id}  ${j.cron}${j.recurring ? '' : '（一次性）'}  下次 ${j.nextFireAt.toLocaleString()}`)
        .join('\n'),
    );
  },
};

const deleteSchema = z.object({
  id: z.string().describe('定时任务 id。'),
});

export const cronDeleteTool: ToolDef<z.infer<typeof deleteSchema>> = {
  name: 'cron_delete',
  description: '删除一个定时任务。',
  schema: deleteSchema,
  async execute(input, ctx) {
    if (ctx.cron === undefined) return fail('当前上下文不支持定时任务。');
    return ctx.cron.delete(input.id)
      ? ok(`已删除定时任务 ${input.id}。`)
      : fail(`未找到定时任务 ${input.id}。`);
  },
};
