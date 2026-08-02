import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { StatusBar } from '../../src/tui/StatusBar.js';

/** 去掉 ANSI 颜色码，便于对纯文本内容断言。 */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/** lastFrame 去掉尾部空行后的文本行数组。 */
function frameLines(frame: string): string[] {
  return stripAnsi(frame).replace(/\n+$/, '').split('\n');
}

describe('StatusBar 后台任务徽章', () => {
  const base = {
    mode: 'manual' as const,
    model: 'test-model',
    cwd: '/tmp/work',
    usedTokens: 100,
    maxContextSize: 1000,
    busy: false,
    hints: 'Ctrl+O 展开工具输出 · Esc 中断',
  };

  it('backgroundCount > 0 时在运行状态后显示 bg:N', () => {
    const { lastFrame } = render(React.createElement(StatusBar, { ...base, backgroundCount: 2 }));
    const line1 = frameLines(lastFrame() ?? '')[0] ?? '';
    expect(line1).toContain('bg:2');
    // 位置在运行状态（ready）之后
    expect(line1.indexOf('bg:2')).toBeGreaterThan(line1.indexOf('ready'));
  });

  it('backgroundCount = 0 时不显示徽章', () => {
    const { lastFrame } = render(React.createElement(StatusBar, { ...base, backgroundCount: 0 }));
    expect(lastFrame() ?? '').not.toContain('bg:');
  });

  it('缺省不传 backgroundCount 时不显示徽章', () => {
    const { lastFrame } = render(React.createElement(StatusBar, base));
    expect(lastFrame() ?? '').not.toContain('bg:');
  });

  // 窄终端：徽章不收缩（优先级高于路径），路径被截断，两行各自单行
  it('columns=40 带徽章不挤爆：每行宽度不超限且徽章完整保留', () => {
    const props = {
      ...base,
      cwd: 'C:\\Users\\foo\\projects\\very\\deep\\work',
      hints: 'Ctrl+O expand · Alt+V paste · Esc interrupt · /help commands',
      backgroundCount: 3,
    };
    const inst = render(React.createElement(StatusBar, props));
    // ink-testing-library 的 stdout.columns 是 getter，改写后 rerender 触发布局重算
    Object.defineProperty(inst.stdout, 'columns', { get: () => 40 });
    inst.rerender(React.createElement(StatusBar, props));
    const lines = frameLines(inst.lastFrame() ?? '');
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(40);
    }
    expect(lines[0]).toContain('bg:3');
    expect(lines[0]).toContain('ready');
  });
});

describe('StatusBar goal 徽章', () => {
  const base = {
    mode: 'manual' as const,
    model: 'test-model',
    cwd: '/tmp/work',
    usedTokens: 100,
    maxContextSize: 1000,
    busy: false,
    hints: 'Ctrl+O 展开工具输出 · Esc 中断',
  };

  it('有 goal 时显示 goal ● 用时 · 轮次，位于运行状态之后', () => {
    const goal = { status: 'active' as const, turnsUsed: 3, turnBudget: 20, elapsedMs: 4 * 60_000 };
    const { lastFrame } = render(React.createElement(StatusBar, { ...base, goal }));
    const line1 = frameLines(lastFrame() ?? '')[0] ?? '';
    expect(line1).toContain('goal');
    expect(line1).toContain('●');
    expect(line1).toContain('4m · 3/20');
    expect(line1.indexOf('goal')).toBeGreaterThan(line1.indexOf('ready'));
  });

  it('无预算时只显示已用轮次', () => {
    const goal = { status: 'paused' as const, turnsUsed: 7, elapsedMs: 65_000 };
    const { lastFrame } = render(React.createElement(StatusBar, { ...base, goal }));
    const line1 = frameLines(lastFrame() ?? '')[0] ?? '';
    expect(line1).toContain('1m · 7');
    expect(line1).not.toContain('7/');
  });

  it('缺省不传 goal 时不显示徽章', () => {
    const { lastFrame } = render(React.createElement(StatusBar, base));
    expect(lastFrame() ?? '').not.toContain('●');
  });
});
