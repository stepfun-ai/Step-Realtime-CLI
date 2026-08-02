import { z } from 'zod';
import { ok, type ToolDef } from './types.js';

const schema = z.object({
  plan: z
    .string()
    .describe('整理好的执行计划（Markdown）。列清要做的事、改动的文件、顺序与验证方式，供用户审阅确认。'),
});

/**
 * 在计划模式（plan mode）下提交执行计划并请求退出。
 * 触发宿主向用户展示计划并确认（Ready to code?）：批准后退出 plan、按正常权限执行；
 * 拒绝则回灌反馈让模型修订计划。这是退出 plan 模式的唯一途径。
 * 工具本体不做事（计划经授权钩子拦下确认），所以恒为只读、放行。
 */
export const exitPlanModeTool: ToolDef<z.infer<typeof schema>> = {
  name: 'exit_plan_mode',
  description:
    '计划模式下，把写好的执行计划提交给用户审阅并请求退出计划模式。批准后按计划开始执行；被拒会返回反馈。调查完成、计划成型后再调用，别提前调用。',
  schema,
  async execute() {
    return ok('计划已提交。');
  },
};
