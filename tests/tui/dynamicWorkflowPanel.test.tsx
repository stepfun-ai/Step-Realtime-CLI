import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import {
  DynamicWorkflowPanel,
  applyDynamicPhaseEvent,
  parseDynamicWorkflowInput,
  type DynamicWorkflowPanelState,
} from '../../src/tui/DynamicWorkflowPanel.js';

describe('dynamic_workflow 动态阶段面板', () => {
  it('parseDynamicWorkflowInput：script 入参装配空动态面板，缺 script 返回 null', () => {
    const wf = parseDynamicWorkflowInput({ name: '调研', script: 'return 1' });
    expect(wf).toEqual({ name: '调研', phases: [] });
    // name 缺省回退到工具名
    expect(parseDynamicWorkflowInput({ script: 'return 1' })?.name).toBe('dynamic_workflow');
    // 无 script / 非对象 / 空 script：不装配
    expect(parseDynamicWorkflowInput({ name: 'x' })).toBeNull();
    expect(parseDynamicWorkflowInput({ script: '' })).toBeNull();
    expect(parseDynamicWorkflowInput(null)).toBeNull();
    expect(parseDynamicWorkflowInput({ steps: [] })).toBeNull();
  });

  it('applyDynamicPhaseEvent：逐个追加阶段，前一 running 阶段标 done', () => {
    let state: DynamicWorkflowPanelState = { name: 'd', phases: [] };
    state = applyDynamicPhaseEvent(state, { index: -1, total: 0, kind: 'phase', status: 'start', title: '侦察' });
    expect(state.phases).toHaveLength(1);
    expect(state.phases[0]).toEqual({ title: '侦察', status: 'running' });

    state = applyDynamicPhaseEvent(state, { index: -1, total: 0, kind: 'phase', status: 'start', title: '汇总' });
    expect(state.phases).toHaveLength(2);
    expect(state.phases[0]?.status).toBe('done');
    expect(state.phases[1]).toEqual({ title: '汇总', status: 'running' });
  });

  it('applyDynamicPhaseEvent：非 phase 事件原样返回（静态步骤事件对动态面板无意义）', () => {
    const state: DynamicWorkflowPanelState = { name: 'd', phases: [{ title: 'a', status: 'running' }] };
    const next = applyDynamicPhaseEvent(state, { index: 0, total: 1, kind: 'agent', status: 'done' });
    expect(next).toBe(state);
  });

  it('动态面板渲染：阶段行显示 ●（当前）/ ✓（已完成）与阶段标题', () => {
    const state: DynamicWorkflowPanelState = {
      name: 'd',
      phases: [
        { title: '侦察', status: 'done' },
        { title: '汇总', status: 'running' },
      ],
    };
    const { lastFrame } = render(React.createElement(DynamicWorkflowPanel, { state }));
    const frame = lastFrame() ?? '';
    expect(frame).toContain('侦察');
    expect(frame).toContain('汇总');
    expect(frame).toContain('✓');
    expect(frame).toContain('●');
  });
});
