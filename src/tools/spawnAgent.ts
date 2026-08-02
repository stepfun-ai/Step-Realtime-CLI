import { z } from 'zod';
import type { SubagentResult } from '../agent/subagent/types.js';
import { fail, ok, type ToolContext, type ToolDef } from './types.js';

const schema = z.object({
  description: z.string().optional().describe('子任务简述（3-5 词）。'),
  prompt: z.string().optional().describe('完整任务描述（背景写全，子 agent 看不到父上下文）。'),
  subagent_type: z
    .string()
    .optional()
    .describe('子 agent 类型：general（全能）或 explore（只读调查），省略默认 general。'),
  run_in_background: z.boolean().optional().describe('后台异步执行，立即返回 task_id。'),
  resume: z
    .string()
    .optional()
    .describe('恢复指定 id 的子会话：从历史断点续跑（prompt 作为新指令追加）。与派生新子 agent 二选一；目标会话正在运行时会被拒绝。'),
});

export const spawnAgentTool: ToolDef<z.infer<typeof schema>> = {
  name: 'spawn_agent',
  description:
    '派生一个子 agent 处理子任务（全新上下文、受限工具、只回摘要）。subagent_type 选 general（全能）或 explore（只读调查）。run_in_background=true 后台异步。返回串会带上子会话 id，需要子 agent 在已有工作上继续时用 resume=<id> 续跑（不新建会话、不占派生配额）。一次要并行几个独立子任务，可在同一轮里发多个 spawn_agent（全为只读 explore 时并行执行）；带依赖的多阶段编排或大批量同构 fan-out 请改用 workflow 工具。',
  schema,
  // 只读 explore 无本地副作用（可并行）；general 可写必须独占（自然串行）
  access: (input) => ((input.subagent_type ?? 'general') === 'explore' ? { kind: 'none' } : { kind: 'all' }),
  async execute(input, ctx) {
    if (ctx.runSubagent === undefined) {
      return fail('当前上下文不支持派生子 agent（子 agent 内不能再派生）。请自己完成该任务。');
    }

    const subagentType = input.subagent_type ?? 'general';
    const prompt = input.prompt ?? '';

    if (input.run_in_background === true) {
      if (ctx.background === undefined) {
        return fail('当前上下文不支持后台任务。');
      }
      const run = ctx
        .runSubagent({
          subagentType,
          prompt,
          depth: ctx.depth ?? 0,
          signal: ctx.signal,
          description: input.description,
          resume: input.resume,
        })
        .then((r) => ({
          output: r.sessionId !== undefined ? `${r.summary}\n（子会话 id：${r.sessionId}）` : r.summary,
          ok: !r.isError,
        }));
      try {
        const id = ctx.background.startTask(`子agent·${input.description ?? '任务'}`, run, undefined, {
          kind: 'subagent',
          agentType: subagentType,
        });
        return ok(`已在后台派生子 agent（task_id=${id}）。用 task_output 查询结果。`);
      } catch (e) {
        return fail((e as Error).message);
      }
    }

    const result = await runForegroundSubagent(input, ctx, subagentType, prompt);
    // cause 透传给调度层：429 限流失败时父侧据此重排队尾（第二道防线）
    if (result.isError) return { ...fail(result.summary), cause: result.cause };
    // 返回串带上子会话 id：模型后续可用 resume 参数在同一子会话上续跑
    return ok(
      result.sessionId !== undefined
        ? `${result.summary}\n\n（子会话 id：${result.sessionId}，需要在其工作基础上继续时用 resume 参数续跑）`
        : result.summary,
    );
  },
};

/**
 * 前台子 agent：上下文支持后台任务时启动即登记为前台任务，运行期间可被 Ctrl+B 转后台。
 * 中断通道独立化：子 agent 拿独立的 AbortController，父回合信号经 propagate 单向传入；
 * detach 后摘除 propagate，此后父回合 Esc 中断不再波及已转后台的子 agent（signal 解绑）。
 * 登记失败（并发上限）或上下文不支持后台任务时，退化为直接前台等待（信号原样透传）。
 */
async function runForegroundSubagent(
  input: { description?: string | undefined; resume?: string | undefined },
  ctx: ToolContext,
  subagentType: string,
  prompt: string,
): Promise<SubagentResult> {
  const background = ctx.background;
  if (background === undefined) {
    return ctx.runSubagent!({
      subagentType,
      prompt,
      depth: ctx.depth ?? 0,
      signal: ctx.signal,
      description: input.description,
      resume: input.resume,
    });
  }

  const subCtrl = new AbortController();
  const propagate = (): void => subCtrl.abort();
  if (ctx.signal !== undefined) {
    if (ctx.signal.aborted) subCtrl.abort();
    else ctx.signal.addEventListener('abort', propagate, { once: true });
  }
  const unbind = (): void => ctx.signal?.removeEventListener('abort', propagate);

  type Tracked = { result: SubagentResult; output: string; ok: boolean };
  const tracked: Promise<Tracked> = ctx
    .runSubagent!({
      subagentType,
      prompt,
      depth: ctx.depth ?? 0,
      signal: subCtrl.signal,
      description: input.description,
      resume: input.resume,
    })
    .then((result) => ({
      result,
      output:
        result.sessionId !== undefined ? `${result.summary}\n（子会话 id：${result.sessionId}）` : result.summary,
      ok: !result.isError,
    }));
  // 运行结束（无论哪条路径）即解除父信号监听，避免监听器挂到后续回合
  void tracked.then(unbind, unbind);

  let taskId: string | undefined;
  try {
    taskId = background.startForegroundTask(
      `子agent·${input.description ?? '任务'}`,
      tracked,
      { kind: 'subagent', agentType: subagentType },
      { onStop: () => subCtrl.abort() },
    );
  } catch {
    taskId = undefined; // 并发上限：退化为不可转后台的前台等待（propagate 仍在，Esc 照常中断）
  }

  if (taskId !== undefined) {
    const released = await Promise.race([
      tracked.then(() => 'finished' as const),
      background.waitForegroundRelease(taskId),
    ]);
    if (released !== 'finished' && released !== 'terminal') {
      // 已转后台：切断父中断通道，工具正常结算；子 agent 继续跑，
      // 终态结果经后台通知链路（drainSettled）回灌会话
      unbind();
      return {
        summary: `子 agent 已转为后台任务 ${taskId} 继续运行，不再阻塞当前回合。任务到达终态时你会收到完成通知；也可用 task_list 查看状态、task_output 看输出、task_stop 终止。`,
        isError: false,
      };
    }
  }
  return (await tracked).result;
}
