import { describe, expect, it } from 'vitest';
import { formatCount, formatDuration } from '../../src/chat/duration.js';

describe('formatDuration（子 agent 卡片时长口径）', () => {
  it('秒级：<60s → "45s"', () => {
    expect(formatDuration(0)).toBe('0s');
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(59_000)).toBe('59s');
    expect(formatDuration(59_999)).toBe('59s');
  });

  it('分钟级带秒：<60m → "2m 28s"', () => {
    expect(formatDuration(60_000)).toBe('1m 0s');
    expect(formatDuration(148_000)).toBe('2m 28s');
    expect(formatDuration(3_599_000)).toBe('59m 59s');
  });

  it('小时级：→ "1h 3m"（不带秒）', () => {
    expect(formatDuration(3_600_000)).toBe('1h 0m');
    expect(formatDuration(3_780_000)).toBe('1h 3m');
    expect(formatDuration(90_000_000)).toBe('25h 0m');
  });

  it('负值兜底为 0s', () => {
    expect(formatDuration(-1000)).toBe('0s');
  });
});

describe('formatCount（千进制紧凑计数）', () => {
  it('1000 进制：999 原样、107000 → 107k、百万级 M', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(999)).toBe('999');
    expect(formatCount(1000)).toBe('1k');
    expect(formatCount(1500)).toBe('1.5k');
    expect(formatCount(107_000)).toBe('107k');
    expect(formatCount(1_000_000)).toBe('1M');
    expect(formatCount(2_500_000)).toBe('2.5M');
  });
});
