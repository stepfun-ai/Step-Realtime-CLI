import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { WorkingStatus } from '../../src/tui/WorkingStatus.js';

describe('WorkingStatus 忙碌态状态行', () => {
  it('显示 spinner + 状态词… + elapsed，token>0 时带 ↓ token', () => {
    const { lastFrame } = render(
      React.createElement(WorkingStatus, { startedAt: Date.now() - 12000, outputTokens: 585 }),
    );
    const out = lastFrame() ?? '';
    // 状态词后带省略号
    expect(out).toMatch(/…/);
    // elapsed 约 12s（±1s 容差，取整）
    expect(out).toMatch(/1[12]s/);
    // token 段
    expect(out).toContain('↓ 585 tokens');
  });

  it('token=0 时不显示 token 段（只有 elapsed）', () => {
    const { lastFrame } = render(
      React.createElement(WorkingStatus, { startedAt: Date.now() - 3000, outputTokens: 0 }),
    );
    const out = lastFrame() ?? '';
    expect(out).not.toContain('tokens');
    expect(out).toMatch(/[23]s/);
  });

  it('第二行显示 tip（· 提示：前缀）', () => {
    const { lastFrame } = render(
      React.createElement(WorkingStatus, { startedAt: Date.now(), outputTokens: 0 }),
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('提示：');
  });

  it('spinner 帧来自 braille 集（独占行首）', () => {
    const { lastFrame } = render(
      React.createElement(WorkingStatus, { startedAt: Date.now(), outputTokens: 0 }),
    );
    const out = lastFrame() ?? '';
    // 首个可见字符应是 braille spinner 帧之一
    expect(out).toMatch(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏]/);
  });
});
