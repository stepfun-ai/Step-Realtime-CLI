import { describe, expect, it } from 'vitest';

import { decideCtrlC } from '../../src/tui/ctrlC.js';

describe('decideCtrlC（Ctrl+C 决策）', () => {
  it('busy + 输入框有内容 → 只清空输入框，不中断回合', () => {
    expect(decideCtrlC({ busy: true, exitPrimed: false, inputEmpty: false })).toBe('clear-input');
  });

  it('busy + 输入框为空 → 中断当前回合', () => {
    expect(decideCtrlC({ busy: true, exitPrimed: false, inputEmpty: true })).toBe('abort-turn');
  });

  it('busy 时 primed 不影响判定（中断/清空优先于退出确认）', () => {
    expect(decideCtrlC({ busy: true, exitPrimed: true, inputEmpty: true })).toBe('abort-turn');
    expect(decideCtrlC({ busy: true, exitPrimed: true, inputEmpty: false })).toBe('clear-input');
  });

  it('空闲 + 已 primed → 退出', () => {
    expect(decideCtrlC({ busy: false, exitPrimed: true, inputEmpty: true })).toBe('exit');
    expect(decideCtrlC({ busy: false, exitPrimed: true, inputEmpty: false })).toBe('exit');
  });

  it('空闲 + 未 primed → 进 primed（有无内容都进；有内容时 App 顺带清空）', () => {
    expect(decideCtrlC({ busy: false, exitPrimed: false, inputEmpty: false })).toBe('prime-exit');
    expect(decideCtrlC({ busy: false, exitPrimed: false, inputEmpty: true })).toBe('prime-exit');
  });
});
