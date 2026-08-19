/**
 * Ctrl+S 主动插队的纯决策逻辑。
 *
 * 从待发队列与输入框文本算出：哪些该立刻插队（steer）、队列里该留下什么（rest）、
 * 输入框该不该清空。抽成纯函数的原因与 commandText 相同：PiChat 本体无法在测试里
 * 实例化（构造函数摸真实 tty，见 wiring.test.ts 头注），决策逻辑必须能脱离它单测。
 *
 * 分流规则：notifyPrepared 里的系统注入（后台通知信封等）不插队——它们是给模型看的
 * 结构化正文，走原队列机制等回合边界；用户自己排的草稿和输入框文本才是「插话」。
 */
export function computeCtrlSSteer(
  queue: readonly string[],
  notifyPrepared: { has(key: string): boolean },
  editorText: string,
): { steer: string[]; rest: string[]; clearEditor: boolean } {
  const drafts = queue.filter((s) => !notifyPrepared.has(s));
  const rest = queue.filter((s) => notifyPrepared.has(s));
  const text = editorText.trim();
  return {
    steer: text !== '' ? [...drafts, text] : [...drafts],
    rest,
    clearEditor: text !== '',
  };
}
