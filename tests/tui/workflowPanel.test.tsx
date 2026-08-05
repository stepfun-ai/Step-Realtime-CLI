import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import {
  WorkflowPanel,
  applyStepEvent,
  applySubagentEvent,
  parseDynamicWorkflowInput,
  parseWorkflowInput,
  parseWfSid,
  type WorkflowPanelState,
} from '../../src/tui/WorkflowPanel.js';
import { ToolCall } from '../../src/tui/ToolCall.js';
import type { DisplayItem } from '../../src/tui/types.js';
import { workflowTool } from '../../src/tools/workflow.js';
import type { RunSubagentFn } from '../../src/agent/subagent/types.js';
import type { WorkflowStepEvent } from '../../src/agent/workflow.js';

/** 调研 workflow 的 tool_start input（与模型实际传给 workflow 工具的同构）。 */
const demoInput = {
  name: '调研',
  steps: [
    {
      kind: 'parallel',
      tasks: [{ prompt: '查 Rust', label: 'Rust 特点' }, { prompt: '查 Go', label: 'Go 特点' }, { prompt: '查 Python' }],
      as: 'langs',
    },
    { kind: 'agent', prompt: '推导适用场景', as: 'scene', label: '适用场景推导' },
    { kind: 'synthesize', from: ['langs', 'scene'], prompt: '综合', as: 'final' },
  ],
};

/** 造一个全 pending 的面板状态。 */
function pendingState(): WorkflowPanelState {
  const s = parseWorkflowInput(demoInput);
  if (s === null) throw new Error('parseWorkflowInput 应能解析 demoInput');
  return s;
}

function toolItem(over: Partial<Extract<DisplayItem, { kind: 'tool' }>>): Extract<DisplayItem, { kind: 'tool' }> {
  return { kind: 'tool', id: 'wf1', name: 'workflow', input: demoInput, status: 'running', ...over };
}

describe('WorkflowPanel 三态渲染', () => {
  it('未开始：全部步骤 ○', () => {
    const { lastFrame } = render(React.createElement(WorkflowPanel, { state: pendingState() }));
    const out = lastFrame() ?? '';
    expect(out).toContain('○ 1. parallel');
    expect(out).toContain('○ 2. agent');
    expect(out).toContain('○ 3. synthesize');
    expect(out).not.toContain('●');
  });

  it('中间步运行中：前步 ✓、当前步 ●、后步 ○', () => {
    let s = pendingState();
    s = applyStepEvent(s, { index: 0, total: 3, kind: 'parallel', status: 'start' });
    s = applyStepEvent(s, { index: 0, total: 3, kind: 'parallel', status: 'done' });
    s = applyStepEvent(s, { index: 1, total: 3, kind: 'agent', status: 'start' });
    const { lastFrame } = render(React.createElement(WorkflowPanel, { state: s }));
    const out = lastFrame() ?? '';
    expect(out).toContain('✓ 1. parallel');
    expect(out).toContain('● 2. agent · 适用场景推导');
    expect(out).toContain('○ 3. synthesize');
  });

  it('运行中 ToolCall 渲染 workflow 标题行 + 步骤面板', () => {
    let s = pendingState();
    s = applyStepEvent(s, { index: 0, total: 3, kind: 'parallel', status: 'start' });
    const { lastFrame } = render(
      React.createElement(ToolCall, {
        item: toolItem({ startedAt: Date.now(), workflow: s }),
        expanded: false,
      }),
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('workflow「调研」');
    expect(out).toContain('已运行');
    expect(out).toContain('● 1. parallel');
    expect(out).toContain('○ 2. agent');
  });

  it('完成后 ToolCall 坍缩为一行摘要，不再渲染步骤列表', () => {
    let s = pendingState();
    for (let i = 0; i < 3; i++) {
      s = applyStepEvent(s, { index: i, total: 3, kind: s.steps[i]!.kind, status: 'start' });
      s = applyStepEvent(s, { index: i, total: 3, kind: s.steps[i]!.kind, status: 'done' });
    }
    const { lastFrame } = render(
      React.createElement(ToolCall, {
        item: toolItem({ status: 'ok', result: '最终报告', workflow: s }),
        expanded: false,
      }),
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('workflow「调研」 3 步 · 0 个子 agent');
    expect(out).not.toContain('●');
    expect(out).not.toContain('○');
  });
});

describe('WorkflowPanel 成员归属', () => {
  it('parallel 步骤的 wf-0-0 / wf-0-1 进度事件进对应步骤下，计数 k/N 正确', () => {
    let s = pendingState();
    s = applyStepEvent(s, { index: 0, total: 3, kind: 'parallel', status: 'start' });
    s = applySubagentEvent(s, { stepIndex: 0, taskIndex: 0 }, 'wf-0-0', {
      kind: 'start',
      subagentType: 'explore',
      description: '查 Rust',
    });
    s = applySubagentEvent(s, { stepIndex: 0, taskIndex: 1 }, 'wf-0-1', {
      kind: 'start',
      subagentType: 'explore',
      description: '查 Go',
    });
    s = applySubagentEvent(s, { stepIndex: 0, taskIndex: 0 }, 'wf-0-0', { kind: 'tool', name: 'grep' });
    s = applySubagentEvent(s, { stepIndex: 0, taskIndex: 0 }, 'wf-0-0', { kind: 'end', isError: false });
    const { lastFrame } = render(React.createElement(WorkflowPanel, { state: s }));
    const out = lastFrame() ?? '';
    // 成员显示在步骤下：task label 作描述，tool 计数与状态
    expect(out).toContain('Rust 特点 · 1 tools');
    expect(out).toContain('Go 特点');
    // 3 个任务完成 1 个
    expect(out).toContain('1/3');
    // 未收到 start 的第三个任务不生成成员行
    expect(out).not.toContain('查 Python');
  });

  it('agent 步骤运行中显示其成员的 tool 数', () => {
    let s = pendingState();
    s = applyStepEvent(s, { index: 1, total: 3, kind: 'agent', status: 'start' });
    s = applySubagentEvent(s, { stepIndex: 1, taskIndex: 0 }, 'wf-1-0', {
      kind: 'start',
      subagentType: 'general',
      description: '推导适用场景',
    });
    s = applySubagentEvent(s, { stepIndex: 1, taskIndex: 0 }, 'wf-1-0', { kind: 'tool', name: 'grep' });
    const { lastFrame } = render(React.createElement(WorkflowPanel, { state: s }));
    expect(lastFrame() ?? '').toContain('运行中 · 1 tools');
  });
});

describe('sid 路由', () => {
  it('wf-{stepIndex}-{taskIndex} 可解析，普通 sid 返回 null（照旧进 AgentGroup）', () => {
    expect(parseWfSid('wf-1-0')).toEqual({ stepIndex: 1, taskIndex: 0 });
    expect(parseWfSid('wf-12-3')).toEqual({ stepIndex: 12, taskIndex: 3 });
    expect(parseWfSid('1')).toBeNull();
    expect(parseWfSid('main')).toBeNull();
    expect(parseWfSid('wf-1')).toBeNull();
    expect(parseWfSid('wf-x-0')).toBeNull();
  });
});

describe('onStep 接线', () => {
  it('workflow 工具把 onStep 透传到 ctx.onWorkflowStep，spawn 带 wf-{si}-{ti} id', async () => {
    const events: WorkflowStepEvent[] = [];
    const ids: (string | undefined)[] = [];
    const runner: RunSubagentFn = async (req) => {
      ids.push(req.id);
      return { summary: 'ok', isError: false };
    };
    const r = await workflowTool.execute(
      {
        name: 'demo',
        steps: [
          { kind: 'agent', prompt: '第一步', as: 'a' },
          { kind: 'agent', prompt: '第二步', as: 'b' },
        ],
      },
      {
        cwd: process.cwd(),
        runSubagent: runner,
        subagentMaxConcurrent: 4,
        onWorkflowStep: (info) => events.push(info),
      },
    );
    expect(r.isError).toBe(false);
    // 两步 workflow 的 start/done 序列
    expect(events).toEqual([
      { index: 0, total: 2, kind: 'agent', status: 'start' },
      { index: 0, total: 2, kind: 'agent', status: 'done' },
      { index: 1, total: 2, kind: 'agent', status: 'start' },
      { index: 1, total: 2, kind: 'agent', status: 'done' },
    ]);
    // 子 agent 归属 id：agent 步骤 taskIndex 固定 0
    expect(ids).toEqual(['wf-0-0', 'wf-1-0']);
  });

  it('parallel / fanout 步骤的子 agent id 带 taskIndex', async () => {
    const ids: (string | undefined)[] = [];
    const runner: RunSubagentFn = async (req) => {
      ids.push(req.id);
      return { summary: 'ok', isError: false };
    };
    await workflowTool.execute(
      {
        name: 'demo',
        steps: [
          { kind: 'parallel', tasks: [{ prompt: 'A' }, { prompt: 'B' }], as: 'p' },
          { kind: 'fanout', items: ['x', 'y'], prompt: '分析 {{item}}', as: 'f' },
        ],
      },
      {
        cwd: process.cwd(),
        runSubagent: runner,
        subagentMaxConcurrent: 4,
        onWorkflowStep: () => {},
      },
    );
    expect(ids).toEqual(['wf-0-0', 'wf-0-1', 'wf-1-0', 'wf-1-1']);
  });
});

describe('dynamic_workflow 动态阶段面板（phase）', () => {
  it('parseDynamicWorkflowInput：script 入参装配空动态面板，缺 script 返回 null', () => {
    const wf = parseDynamicWorkflowInput({ name: '调研', script: 'return 1' });
    expect(wf).toEqual({ name: '调研', steps: [], dynamic: true });
    // name 缺省回退到工具名
    expect(parseDynamicWorkflowInput({ script: 'return 1' })?.name).toBe('dynamic_workflow');
    // 无 script / 非对象 / 空 script：不装配
    expect(parseDynamicWorkflowInput({ name: 'x' })).toBeNull();
    expect(parseDynamicWorkflowInput({ script: '' })).toBeNull();
    expect(parseDynamicWorkflowInput(null)).toBeNull();
    expect(parseDynamicWorkflowInput({ steps: [] })).toBeNull();
  });

  it('applyStepEvent phase 分支：逐个追加阶段，前一 running 阶段标 done', () => {
    let state: WorkflowPanelState = { name: 'd', steps: [], dynamic: true };
    state = applyStepEvent(state, { index: -1, total: 0, kind: 'phase', status: 'start', title: '侦察' });
    expect(state.steps).toHaveLength(1);
    expect(state.steps[0]).toMatchObject({ kind: 'phase', label: '侦察', status: 'running' });

    state = applyStepEvent(state, { index: -1, total: 0, kind: 'phase', status: 'start', title: '汇总' });
    expect(state.steps).toHaveLength(2);
    // 第一阶段被标 done，第二阶段 running
    expect(state.steps[0]?.status).toBe('done');
    expect(state.steps[1]).toMatchObject({ kind: 'phase', label: '汇总', status: 'running' });
  });

  it('applyStepEvent 非 phase 事件仍按 index 定位（不影响 workflow 静态路径）', () => {
    let state: WorkflowPanelState = {
      name: 'w',
      steps: [
        { kind: 'agent', as: 'a', status: 'pending', members: [] },
        { kind: 'agent', as: 'b', status: 'pending', members: [] },
      ],
    };
    state = applyStepEvent(state, { index: 1, total: 2, kind: 'agent', status: 'start' });
    expect(state.steps[0]?.status).toBe('pending');
    expect(state.steps[1]?.status).toBe('running');
  });

  it('动态面板渲染：phase 阶段行显示 ○/●/✓ 与阶段标题', () => {
    const state: WorkflowPanelState = {
      name: 'd',
      dynamic: true,
      steps: [
        { kind: 'phase', label: '侦察', status: 'done', members: [] },
        { kind: 'phase', label: '汇总', status: 'running', members: [] },
      ],
    };
    const { lastFrame } = render(React.createElement(WorkflowPanel, { state }));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('侦察');
    expect(frame).toContain('汇总');
    expect(frame).toContain('✓'); // done
    expect(frame).toContain('●'); // running
  });
});
