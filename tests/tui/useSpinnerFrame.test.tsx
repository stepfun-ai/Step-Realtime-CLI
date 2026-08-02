import React from 'react';
import { Text } from 'ink';
import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSpinnerFrame, BRAILLE_FRAMES } from '../../src/tui/useSpinnerFrame.js';

function Probe({ active, intervalMs }: { active: boolean; intervalMs?: number }): React.ReactElement {
  const f = useSpinnerFrame(active, BRAILLE_FRAMES, intervalMs);
  return React.createElement(Text, null, `[${f}]`);
}

describe('useSpinnerFrame', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('active=false 返回静止首帧，且不随时间变化', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { lastFrame, rerender } = render(React.createElement(Probe, { active: false }));
    expect(lastFrame()).toContain(`[${BRAILLE_FRAMES[0]}]`);
    // 时间前进也不应改变帧（active=false 不派生帧、也不起定时器）
    vi.setSystemTime(80 * 3);
    rerender(React.createElement(Probe, { active: false }));
    expect(lastFrame()).toContain(`[${BRAILLE_FRAMES[0]}]`);
  });

  it('active=true 时帧由时间派生并按序循环', () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const { lastFrame, rerender } = render(React.createElement(Probe, { active: true }));
    expect(lastFrame()).toContain(`[${BRAILLE_FRAMES[0]}]`);
    // Date.now()/80 floored -> 索引 1
    vi.setSystemTime(80);
    rerender(React.createElement(Probe, { active: true }));
    expect(lastFrame()).toContain(`[${BRAILLE_FRAMES[1]}]`);
    // 索引 10 % 10 = 0，回到首帧（验证循环）
    vi.setSystemTime(80 * 10);
    rerender(React.createElement(Probe, { active: true }));
    expect(lastFrame()).toContain(`[${BRAILLE_FRAMES[0]}]`);
  });
});
