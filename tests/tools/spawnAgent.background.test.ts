import { describe, expect, it, vi } from 'vitest';
import { spawnAgentTool } from '../../src/tools/spawnAgent.js';
import type { ToolContext } from '../../src/tools/types.js';

/**
 * 后台派生子 agent 的生命周期契约。
 *
 * 核心不变量：`run_in_background: true` 承诺「脱离当前回合独立存活」，因此父回合的
 * AbortSignal **不得**贯穿后台子 agent 全程——否则父回合一结束或被 Esc 中断，
 * 后台子 agent 立即被连带杀死，承诺当场失效（实际症状：派出去的后台任务全部返回
 * 「子 agent 已被中断」）。
 *
 * 对照：前台派生走 runForegroundSubagent，用独立 subCtrl + 转后台时 unbind() 切断父信号；
 * 后台派生此前直接传 ctx.signal，两条路径行为相反，反而是「后台」的那条活不下来。
 */

/** 造一个最小可用的 ToolContext：只提供后台派生路径实际用到的字段。 */
function makeCtx(opts: {
  signal?: AbortSignal;
  runSubagent: ToolContext['runSubagent'];
  onStopCapture?: (fn: (() => void) | undefined) => void;
}): ToolContext {
  return {
    cwd: process.cwd(),
    signal: opts.signal,
    depth: 0,
    runSubagent: opts.runSubagent,
    background: {
      startTask: (
        _label: string,
        _run: Promise<{ output: string; ok: boolean }>,
        _onDone?: unknown,
        _meta?: unknown,
        taskOpts?: { onStop?: () => void },
      ) => {
        opts.onStopCapture?.(taskOpts?.onStop);
        return 'task-1';
      },
    },
  } as unknown as ToolContext;
}

describe('spawn_agent 后台派生的生命周期', () => {
  it('父 signal 中断后，后台子 agent 不被连带杀死', async () => {
    const parent = new AbortController();
    let childSignal: AbortSignal | undefined;
    // 子 agent 长跑：解析前先让父信号 abort，检验子是否受影响
    const runSubagent = vi.fn(async (req: { signal?: AbortSignal }) => {
      childSignal = req.signal;
      parent.abort(); // 模拟父回合结束 / 用户 Esc
      await new Promise((r) => setTimeout(r, 10));
      return { summary: '后台跑完了', isError: false, sessionId: 's1' };
    });

    const ctx = makeCtx({ signal: parent.signal, runSubagent: runSubagent as never });
    const res = await spawnAgentTool.execute(
      { prompt: 'x', run_in_background: true, description: 'bg' },
      ctx,
    );

    expect(res.isError ?? false).toBe(false);
    expect(childSignal).toBeDefined();
    // 关键断言：子 agent 拿到的不是父 signal，父 abort 不传导
    expect(childSignal).not.toBe(parent.signal);
    expect(parent.signal.aborted).toBe(true);
    expect(childSignal!.aborted).toBe(false);
  });

  it('task_stop 经 onStop 能真正中断后台子 agent（不只是改状态）', async () => {
    let onStop: (() => void) | undefined;
    let childSignal: AbortSignal | undefined;
    const runSubagent = vi.fn(async (req: { signal?: AbortSignal }) => {
      childSignal = req.signal;
      return { summary: 'ok', isError: false };
    });

    const ctx = makeCtx({
      runSubagent: runSubagent as never,
      onStopCapture: (fn) => {
        onStop = fn;
      },
    });
    await spawnAgentTool.execute({ prompt: 'x', run_in_background: true }, ctx);

    // 后台 async 任务没有进程可杀，中止只能靠 onStop 钩子传达
    expect(onStop).toBeTypeOf('function');
    expect(childSignal!.aborted).toBe(false);
    onStop!();
    expect(childSignal!.aborted).toBe(true);
  });

  it('派生前父信号已中断则不开工（回合已结束，无人取结果）', async () => {
    const parent = new AbortController();
    parent.abort();
    const runSubagent = vi.fn();

    const ctx = makeCtx({ signal: parent.signal, runSubagent: runSubagent as never });
    const res = await spawnAgentTool.execute({ prompt: 'x', run_in_background: true }, ctx);

    expect(res.isError).toBe(true);
    expect(runSubagent).not.toHaveBeenCalled();
  });
});
