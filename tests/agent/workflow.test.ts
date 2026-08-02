import { describe, expect, it, vi } from 'vitest';
import { runWorkflow } from '../../src/agent/workflow.js';
import { workflowTool } from '../../src/tools/workflow.js';
import type { BackgroundManager } from '../../src/agent/background/manager.js';
import type { RunSubagentFn } from '../../src/agent/subagent/types.js';

const fakeRunner =
  (map: Record<string, string>): RunSubagentFn =>
  async (req) => ({ summary: map[req.prompt] ?? `结果:${req.prompt}`, isError: false });

describe('runWorkflow', () => {
  it('agent 步骤：结果用 as 命名，后续 {{var}} 引用', async () => {
    const r = await runWorkflow(
      {
        name: 't',
        steps: [
          { kind: 'agent', prompt: '第一步', as: 'a' },
          { kind: 'agent', prompt: '基于 {{a}} 做第二步', as: 'b' },
        ],
      },
      { runSubagent: fakeRunner({}), maxConcurrent: 4, args: {} },
    );
    expect(r.agentsUsed).toBe(2);
    expect(r.report).toContain('结果:基于');
  });

  it('parallel 步骤：多任务并行聚合', async () => {
    const r = await runWorkflow(
      {
        name: 't',
        steps: [
          { kind: 'parallel', tasks: [{ prompt: 'A' }, { prompt: 'B' }], as: 'p' },
        ],
      },
      { runSubagent: fakeRunner({}), maxConcurrent: 4, args: {} },
    );
    expect(r.agentsUsed).toBe(2);
    expect(r.report).toContain('结果:A');
    expect(r.report).toContain('结果:B');
  });

  it('fanout 步骤：对列表每项派 agent，{{item}} 替换', async () => {
    const seen: string[] = [];
    const runner: RunSubagentFn = async (req) => {
      seen.push(req.prompt);
      return { summary: 'ok', isError: false };
    };
    await runWorkflow(
      { name: 't', steps: [{ kind: 'fanout', items: ['f1', 'f2'], prompt: '分析 {{item}}', as: 'x' }] },
      { runSubagent: runner, maxConcurrent: 4, args: {} },
    );
    expect(seen).toContain('分析 f1');
    expect(seen).toContain('分析 f2');
  });

  it('synthesize 步骤：汇总指定变量', async () => {
    const r = await runWorkflow(
      {
        name: 't',
        steps: [
          { kind: 'agent', prompt: '收集', as: 'data' },
          { kind: 'synthesize', from: ['data'], prompt: '综合', as: 'final' },
        ],
      },
      { runSubagent: fakeRunner({}), maxConcurrent: 4, args: {} },
    );
    expect(r.agentsUsed).toBe(2);
  });

  it('max_agents 护栏：超上限后子任务被跳过', async () => {
    const r = await runWorkflow(
      {
        name: 't',
        maxAgents: 1,
        steps: [
          { kind: 'agent', prompt: 'A', as: 'a' },
          { kind: 'agent', prompt: 'B', as: 'b' },
        ],
      },
      { runSubagent: fakeRunner({}), maxConcurrent: 4, args: {} },
    );
    expect(r.agentsUsed).toBe(1);
  });
});

describe('workflow 工具', () => {
  it('执行声明式 workflow 返回报告', async () => {
    const r = await workflowTool.execute(
      {
        name: 'demo',
        steps: [{ kind: 'agent', prompt: '调查', as: 'r' }],
      },
      { cwd: process.cwd(), runSubagent: fakeRunner({}), subagentMaxConcurrent: 4 },
    );
    expect(r.isError).toBe(false);
    expect(r.content).toContain('workflow「demo」完成');
  });

  it('ctx 无 runSubagent 报不支持', async () => {
    const r = await workflowTool.execute({ name: 'x', steps: [] }, { cwd: process.cwd() });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('不支持');
  });

  it('run_in_background：startTask 被调、立即返回 task_id、label 为 workflow·<name>', async () => {
    let captured: Promise<{ output: string; ok: boolean }> | undefined;
    const startTask = vi.fn((_label: string, run: Promise<{ output: string; ok: boolean }>) => {
      captured = run;
      return 'task-w1';
    });
    const background = { startTask } as unknown as BackgroundManager;
    const r = await workflowTool.execute(
      {
        name: 'demo',
        steps: [{ kind: 'agent', prompt: '调查', as: 'r' }],
        run_in_background: true,
      },
      { cwd: process.cwd(), runSubagent: fakeRunner({}), subagentMaxConcurrent: 4, background },
    );
    expect(r.isError).toBe(false);
    expect(r.content).toContain('task-w1');
    expect(startTask).toHaveBeenCalledTimes(1);
    expect(startTask.mock.calls[0]![0]).toBe('workflow·demo');
    // 交出去的 promise 完成后产出 {output, ok}（manager 据此置终态）
    const settled = await captured!;
    expect(settled.ok).toBe(true);
    expect(settled.output).toContain('workflow「demo」完成');
  });

  it('run_in_background 但 ctx 无 background：fail 且不启动编排', async () => {
    const r = await workflowTool.execute(
      { name: 'demo', steps: [{ kind: 'agent', prompt: '调查', as: 'r' }], run_in_background: true },
      { cwd: process.cwd(), runSubagent: fakeRunner({}) },
    );
    expect(r.isError).toBe(true);
    expect(r.content).toContain('不支持后台任务');
  });
});
