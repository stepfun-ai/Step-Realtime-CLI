/**
 * Ctrl+C 决策（纯函数 + App 薄壳，同 turnEnd/backtrack 模式）。
 *
 * 语义：busy 时输入框优先——
 * - busy：输入框有内容 → 只清空输入框，不中断回合；输入框为空 → 中断当前回合。
 * - 空闲 + 已 primed → 退出。
 * - 空闲 → 清空输入框（如有）并进入退出确认 primed（再按一次退出）。
 */
export type CtrlCAction = 'abort-turn' | 'clear-input' | 'exit' | 'prime-exit';

export function decideCtrlC(input: { busy: boolean; exitPrimed: boolean; inputEmpty: boolean }): CtrlCAction {
  if (input.busy) return input.inputEmpty ? 'abort-turn' : 'clear-input';
  if (input.exitPrimed) return 'exit';
  return 'prime-exit';
}
