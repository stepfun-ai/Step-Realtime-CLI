import { describe, expect, it } from 'vitest';
import { formatElapsed } from '../../src/tui/elapsed.js';

describe('formatElapsed', () => {
  it('60 秒内显示秒', () => {
    expect(formatElapsed(0)).toBe('0s');
    expect(formatElapsed(45_000)).toBe('45s');
    expect(formatElapsed(59_999)).toBe('59s');
  });

  it('60 分钟内显示分钟', () => {
    expect(formatElapsed(60_000)).toBe('1m');
    expect(formatElapsed(4 * 60_000 + 30_000)).toBe('4m');
  });

  it('24 小时内显示小时（零头分钟带上，整点省略）', () => {
    expect(formatElapsed(3_600_000)).toBe('1h');
    expect(formatElapsed(3_600_000 + 23 * 60_000)).toBe('1h23m');
  });

  it('超过 24 小时显示天（零头小时带上，整天省略）', () => {
    expect(formatElapsed(24 * 3_600_000)).toBe('1d');
    expect(formatElapsed(2 * 24 * 3_600_000 + 3 * 3_600_000)).toBe('2d3h');
  });

  it('负值按 0 处理', () => {
    expect(formatElapsed(-1000)).toBe('0s');
  });
});
