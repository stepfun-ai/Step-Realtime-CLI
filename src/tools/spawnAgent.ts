import { z } from 'zod';
import type { SubagentResult } from '../agent/subagent/types.js';
import { fail, ok, type ToolContext, type ToolDef } from './types.js';

const schema = z.object({
  description: z.string().optional().describe('子任务简述（3-5 词），显示在用户界面的进度卡片上。'),
  prompt: z
    .string()
    .optional()
    .describe('完整任务描述。子 agent 看不到父上下文，所有必要背景都要写进来。'),
  subagent_type: z
    .string()
    .optional()
    .describe(
      '子 agent 角色名。可选角色见 system prompt 的「可派生的子 agent 角色」清单；省略默认 general。',
    ),
  run_in_background: z
    .boolean()
    .optional()
    .describe(
      '后台异步执行，立即返回 task_id，终态自动通知。只在你还有别的活要干、且不需要它的结果就能继续时才用。' +
        '不要后台派生后立刻 task_output 轮询或空等——那样只是白白阻塞回合，这种情况直接用前台。',
    ),
  resume: z
    .string()
    .optional()
    .describe('恢复指定 id 的子会话：从历史断点续跑（prompt 作为新指令追加）。与派生新子 agent 二选一；目标会话正在运行时会被拒绝。'),
});

/**
 * 结构化结果头：让父 agent 能可靠区分「做完了」与「失败但有部分产出」，resume 决策有据可依。
 * 用纯文本 `key: value` 而非 XML 包裹——工具结果是纯文本通道，标签会和正文里的代码块混淆。
 */
function formatSubagentResult(
  subagentType: string,
  status: 'done' | 'error',
  summary: string,
  sessionId: string | undefined,
): string {
  const head =
    sessionId !== undefined
      ? `subagent: ${subagentType} | status: ${status} | session: ${sessionId}`
      : `subagent: ${subagentType} | status: ${status}`;
  const tail =
    status === 'error' && sessionId !== undefined
      ? `\n\n（需要在它已有工作基础上继续时，用 spawn_agent 的 resume="${sessionId}" 续跑）`
      : '';
  return `${head}\n\n${summary}${tail}`;
}

export const spawnAgentTool: ToolDef<z.infer<typeof schema>> = {
  name: 'spawn_agent',
  description:
    '派生一个子 agent 处理子任务（全新上下文、受限工具、只回摘要）。委派同时把大量中间过程（文件原文、搜索结果）挡在你的上下文之外——你拿回的是结论，不是一堆原始输出。\n' +
    '可选角色见 system prompt 的「可派生的子 agent 角色」清单，subagent_type 省略时用 general。\n' +
    '\n' +
    '写 prompt：\n' +
    '- 子 agent 零上下文，没看过这段对话。像给刚进门的同事交接一样写：目标是什么、你已经知道什么、具体要它做什么。\n' +
    '- 查找类任务（读某个文件、跑某条命令）：把准确路径或命令写进 prompt，别让它去搜你已经知道的东西。\n' +
    '- 调查类任务（搞清楚 X、查为什么 Y）：给问题，别给规定步骤——前提一旦不成立，预设步骤就成了累赘。\n' +
    '- 不要委派理解。别写「基于你的调研，把它实现掉」这类句式，那是把本该你做的综合推给了子 agent。任务依赖某个文件路径或行号时，自己先定位好再写进 prompt。\n' +
    '\n' +
    '不要派生的情况：路径已知的单文件读取、2-3 个文件内的定向搜索、一两步就能做完的事——自己做更快。委派有上下文交接成本，任务够重才划算。\n' +
    '\n' +
    '派生之后：那块范围就交给它了。不要并行重做它正在做的搜索和读取，也不要中途放弃自己接管——两者都会抵消委派本身省下的上下文。\n' +
    '\n' +
    '返回串带子会话 id，需要在它已有工作基础上继续时用 resume=<id> 续跑（不新建会话、不占派生配额）。\n' +
    '一次要并行几个独立子任务，在同一轮里发多个 spawn_agent（全为只读 explore 时并行执行）；带依赖的多阶段编排或大批量同构 fan-out 改用 dynamic_workflow 工具。',
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
      // 后台派生的语义是「脱离当前回合独立存活」，因此**不能**把 ctx.signal 直接传下去：
      // 那样父回合一结束或被 Esc 中断，signal abort 会连带杀死后台子 agent，
      // 「已在后台继续」的承诺当场失效（前台转后台路径靠 unbind() 切断父信号，此处等价处理）。
      // 独立 AbortController 只由 task_stop / 后台超时经 onStop 触发。
      // 派生前父信号已 abort 则不必开工——那是回合已经结束，没人会来取结果。
      if (ctx.signal?.aborted === true) {
        return fail('当前回合已中断，未派生后台子 agent。');
      }
      const bgCtrl = new AbortController();
      const run = ctx
        .runSubagent({
          subagentType,
          prompt,
          depth: ctx.depth ?? 0,
          signal: bgCtrl.signal,
          description: input.description,
          resume: input.resume,
        })
        .then((r) => ({
          output: r.sessionId !== undefined ? `${r.summary}\n（子会话 id：${r.sessionId}）` : r.summary,
          ok: !r.isError,
        }));
      try {
        const id = ctx.background.startTask(
          `子agent·${input.description ?? '任务'}`,
          run,
          undefined,
          {
            kind: 'subagent',
            agentType: subagentType,
          },
          // async 任务无进程可杀，stop/超时经 onStop 传达中断（否则 task_stop 只改状态、任务照跑）
          { onStop: () => bgCtrl.abort() },
        );
        return ok(`已在后台派生子 agent（task_id=${id}）。用 task_output 查询结果。`);
      } catch (e) {
        return fail((e as Error).message);
      }
    }

    const result = await runForegroundSubagent(input, ctx, subagentType, prompt);
    // cause 透传给调度层：429 限流失败时父侧据此重排队尾（第二道防线）
    if (result.isError) {
      return {
        ...fail(formatSubagentResult(subagentType, 'error', result.summary, result.sessionId)),
        cause: result.cause,
      };
    }
    return ok(formatSubagentResult(subagentType, 'done', result.summary, result.sessionId));
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
