import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { GoalPanel, type GoalPanelData } from '../../src/tui/GoalPanel.js';
import { CronCard, type CronCardData } from '../../src/tui/CronCard.js';

/** 去掉 ANSI 颜色码，便于对纯文本内容断言。 */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

const baseGoal: GoalPanelData = {
  objective: '实现登录功能',
  status: 'active',
  turnsUsed: 3,
  elapsedMs: 4 * 60_000,
};

describe('GoalPanel', () => {
  it('渲染标题、目标与状态/用时/轮次摘要行', () => {
    const { lastFrame } = render(React.createElement(GoalPanel, { data: baseGoal }));
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('Goal ·');
    expect(frame).toContain('实现登录功能');
    expect(frame).toContain('4m');
    expect(frame).toContain('3');
  });

  it('有预算时轮次显示 used/budget，有完成标准与原因时一并显示', () => {
    const data: GoalPanelData = {
      ...baseGoal,
      status: 'blocked',
      turnBudget: 20,
      completionCriterion: '全部测试通过',
      terminalReason: '缺少凭证',
    };
    const { lastFrame } = render(React.createElement(GoalPanel, { data }));
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('3/20');
    expect(frame).toContain('全部测试通过');
    expect(frame).toContain('缺少凭证');
  });

  it('无预算、无完成标准、无原因时不渲染对应行', () => {
    const { lastFrame } = render(React.createElement(GoalPanel, { data: baseGoal }));
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).not.toContain('3/');
    expect(frame).not.toContain('完成标准');
    expect(frame).not.toContain('原因');
  });
});

const baseCron: CronCardData = {
  id: 'a1b2c3d4',
  cron: '0 17 * * *',
  prompt: '提醒我检查构建状态',
  recurring: true,
  coalesced: 1,
};

describe('CronCard', () => {
  it('渲染标题、cron 表达式、job id 与 prompt 正文', () => {
    const { lastFrame } = render(React.createElement(CronCard, { data: baseCron }));
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('●');
    expect(frame).toContain('0 17 * * *');
    expect(frame).toContain('job a1b2c3d4');
    expect(frame).toContain('提醒我检查构建状态');
  });

  it('一次性任务与合并触发在详情行标注', () => {
    const { lastFrame } = render(
      React.createElement(CronCard, { data: { ...baseCron, recurring: false, coalesced: 3 } }),
    );
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).toContain('一次性');
    expect(frame).toContain('合并 3 次');
  });

  it('循环任务单次触发不显示一次性与合并标注', () => {
    const { lastFrame } = render(React.createElement(CronCard, { data: baseCron }));
    const frame = stripAnsi(lastFrame() ?? '');
    expect(frame).not.toContain('一次性');
    expect(frame).not.toContain('合并');
  });
});
