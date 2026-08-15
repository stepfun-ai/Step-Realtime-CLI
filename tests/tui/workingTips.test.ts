import { afterEach, describe, expect, it } from 'vitest';
import { WORKING_TIPS, pickRandomTip } from '../../src/chat/workingTips.js';

// 保存原始内容，每个用例后还原（pickRandomTip 直接读模块级 WORKING_TIPS）。
const ORIGINAL = [...WORKING_TIPS];
afterEach(() => {
  WORKING_TIPS.length = 0;
  WORKING_TIPS.push(...ORIGINAL);
});

describe('pickRandomTip', () => {
  it('传 exclude 时多次抽取都不等于 exclude（池 > 1）', () => {
    const exclude = WORKING_TIPS[0]!;
    for (let i = 0; i < 300; i++) {
      expect(pickRandomTip(exclude)).not.toBe(exclude);
    }
  });

  it('无 exclude 时返回池内的某一条', () => {
    for (let i = 0; i < 50; i++) {
      expect(WORKING_TIPS).toContain(pickRandomTip());
    }
  });

  it('池仅一条 + exclude 命中它：排除后为空，回退整池直接返回该条', () => {
    WORKING_TIPS.length = 0;
    WORKING_TIPS.push('唯一一条');
    expect(pickRandomTip('唯一一条')).toBe('唯一一条');
  });

  it('空池返回空字符串（防御）', () => {
    WORKING_TIPS.length = 0;
    expect(pickRandomTip()).toBe('');
    expect(pickRandomTip('任意')).toBe('');
  });
});
