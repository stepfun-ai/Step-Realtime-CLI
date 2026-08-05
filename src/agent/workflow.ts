import type { RunSubagentFn } from '../agent/subagent/types.js';

/**
 * 声明式 workflow 运行时：结构化步骤模板而非模型现写任意 JS——可控、安全、可复用。
 * workflow = 步骤数组，运行时按序执行；中间结果存运行时状态（不占主上下文），
 * 主会话只收最终报告。护栏：agent 总数上限 + 单步并发上限。
 */

export interface WorkflowStepAgent {
  kind: 'agent';
  /** 子任务 prompt。可用 {{var}} 引用前面步骤的结果或 args。 */
  prompt: string;
  /** 结果存入的变量名，供后续步骤 {{var}} 引用。 */
  as: string;
  subagentType?: string;
  label?: string;
}

export interface WorkflowStepParallel {
  kind: 'parallel';
  /** 并行执行的子任务（各派一个子 agent，复用并发上限）。 */
  tasks: { prompt: string; label?: string; subagentType?: string }[];
  as: string;
}

export interface WorkflowStepFanout {
  kind: 'fanout';
  /** 对列表每项派一个子 agent（数据并行），结果聚合成数组。 */
  items: string[];
  prompt: string; // 可含 {{item}} 占位
  as: string;
  subagentType?: string;
}

export interface WorkflowStepSynthesize {
  kind: 'synthesize';
  /** 汇总：把指定变量的结果交给一个子 agent 综合成报告。 */
  from: string[];
  prompt: string;
  as: string;
  subagentType?: string;
}

export type WorkflowStep =
  | WorkflowStepAgent
  | WorkflowStepParallel
  | WorkflowStepFanout
  | WorkflowStepSynthesize;

export interface WorkflowDef {
  name: string;
  description?: string;
  steps: WorkflowStep[];
  /** agent 总数上限（护栏）。 */
  maxAgents?: number;
}

/** 步骤进度事件（onStep 回调参数，供 UI 步骤面板推进当前步）。
 * workflow（静态）步骤用 index/total 定位（index 从 0 起、total 为步骤总数）；
 * dynamic_workflow 的 phase 事件是哨兵值 `index: -1, total: 0`——阶段在运行时才知道、
 * 无法预先编号，UI 应走「按 title 追加」的动态分支而非按 index 定位。 */
export interface WorkflowStepEvent {
  index: number;
  total: number;
  /** 步骤/事件类型。workflow 为步骤 kind（agent/parallel/fanout/synthesize）；dynamic_workflow 的阶段切换为 'phase'。 */
  kind: string;
  status: 'start' | 'done';
  /** phase 事件的阶段标题（dynamic_workflow 脚本内 phase(title) 发出；其余 kind 无此字段）。 */
  title?: string;
}

export interface WorkflowContext {
  runSubagent: RunSubagentFn;
  /** 并行并发上限。 */
  maxConcurrent: number;
  /** 传入的 args（供 {{args.xxx}} 引用）。 */
  args?: Record<string, string>;
  /** 步骤进度回调（步骤开始/完成时调用，供 UI 展示 phase 进度）。 */
  onStep?: (info: WorkflowStepEvent) => void;
}

const DEFAULT_MAX_AGENTS = 50;

/** 模板替换：{{var}}、{{item}}、{{args.x}}。 */
function render(template: string, vars: Record<string, string>, item?: string): string {
  let out = template;
  for (const [k, v] of Object.entries(vars)) {
    out = out.split(`{{${k}}}`).join(v);
  }
  if (item !== undefined) out = out.split('{{item}}').join(item);
  return out;
}

/** 简易爬坡并发（先起 concurrency 个，完成一个补一个）。fn 第二参数为元素下标。 */
async function withConcurrency<T, R>(items: T[], concurrency: number, fn: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length) as R[];
  let idx = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (idx < items.length) {
        const i = idx++;
        results[i] = await fn(items[i]!, i);
      }
    }),
  );
  return results;
}

/**
 * 执行一个声明式 workflow。返回最终报告（最后一步的结果）。
 * 中间结果存 vars（不占主上下文）；agent 总数受 maxAgents 护栏约束。
 */
export async function runWorkflow(def: WorkflowDef, wctx: WorkflowContext): Promise<{ report: string; steps: number; agentsUsed: number }> {
  const vars: Record<string, string> = { ...(wctx.args ?? {}) };
  const maxAgents = def.maxAgents ?? DEFAULT_MAX_AGENTS;
  let agentsUsed = 0;

  // id 形如 wf-{stepIndex}-{taskIndex}：runner 透传为 sid，UI 据此把子 agent 归属到对应步骤。
  const spawn = async (prompt: string, subagentType = 'general', id?: string): Promise<string> => {
    if (agentsUsed >= maxAgents) {
      return `[已达 workflow agent 上限（${maxAgents}），跳过该子任务]`;
    }
    agentsUsed += 1;
    const r = await wctx.runSubagent({ subagentType, prompt, depth: 0, id });
    return r.summary;
  };

  let lastResult = '';
  for (let si = 0; si < def.steps.length; si++) {
    const step = def.steps[si]!;
    wctx.onStep?.({ index: si, total: def.steps.length, kind: step.kind, status: 'start' });
    switch (step.kind) {
      case 'agent': {
        lastResult = await spawn(render(step.prompt, vars), step.subagentType, `wf-${si}-0`);
        vars[step.as] = lastResult;
        break;
      }
      case 'parallel': {
        const results = await withConcurrency(step.tasks, wctx.maxConcurrent, (t, ti) =>
          spawn(render(t.prompt, vars), t.subagentType, `wf-${si}-${ti}`),
        );
        lastResult = results.filter((s) => s !== '').join('\n\n---\n\n');
        vars[step.as] = lastResult;
        break;
      }
      case 'fanout': {
        const results = await withConcurrency(step.items, wctx.maxConcurrent, (item, ti) =>
          spawn(render(step.prompt, vars, item), step.subagentType, `wf-${si}-${ti}`),
        );
        lastResult = results.filter((s) => s !== '').join('\n\n---\n\n');
        vars[step.as] = lastResult;
        break;
      }
      case 'synthesize': {
        const material = step.from.map((v) => `【${v}】\n${vars[v] ?? ''}`).join('\n\n');
        lastResult = await spawn(`${render(step.prompt, vars)}\n\n待综合的材料：\n${material}`, step.subagentType, `wf-${si}-0`);
        vars[step.as] = lastResult;
        break;
      }
    }
    wctx.onStep?.({ index: si, total: def.steps.length, kind: step.kind, status: 'done' });
  }

  return { report: lastResult, steps: def.steps.length, agentsUsed };
}
