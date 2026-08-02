/**
 * 输入框编辑动作（纯函数，无副作用，便于单测）。
 * 模型：text + cursorOffset 单行编辑，cursor 以 code point 计（Array.from 切分，
 * 不按 UTF-16 单元），词 = 连续非空白字符（readline 语义，不引入 Unicode 分词库）。
 *
 * 实证结论（2026-07-25，探针：ink-testing-library 向 stdin 写 raw 序列，打印 useInput 实参）：
 * Ink 7.1.1 的 parse-keypress 已把 Home/End 的全部兼容序列
 * （\x1b[H、\x1bOH、\x1b[1~、\x1b[7~，End 对称 \x1b[F、\x1bOF、\x1b[4~、\x1b[8~）
 * 映射为 key.home / key.end，此时 input 为空串；Ctrl+字母到达为 input=字母 + key.ctrl；
 * Alt+字母到达为 input=字母 + key.meta；Ctrl+←/→ 到达为 key.leftArrow/rightArrow + key.ctrl。
 * 因此编辑键分发直接消费 key 标志位即可，不需要在 stdin 数据层拦截或匹配 raw 序列。
 * Home/End 此前无效的根因是 ink-text-input 不处理 key.home/key.end，而非 Ink 未解析。
 */

/** 单行编辑状态：text 为内容，cursor 为光标位置（code point 索引，0..len）。 */
export interface PromptEditState {
  text: string;
  cursor: number;
}

/** useInput 实参中与编辑动作相关的键标志（结构子集，便于脱离 Ink 单测）。 */
export interface EditKeyInfo {
  home?: boolean;
  end?: boolean;
  ctrl?: boolean;
  meta?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  backspace?: boolean;
  delete?: boolean;
}

/** 编辑动作：输入旧状态，返回新状态。 */
export type EditAction = (s: PromptEditState) => PromptEditState;

const toChars = (text: string): string[] => Array.from(text);

const isSpace = (ch: string): boolean => /\s/.test(ch);

/** 光标钳制到 [0, len]，外部状态可能来自不受控路径。 */
const clamp = (s: PromptEditState): number => Math.max(0, Math.min(s.cursor, toChars(s.text).length));

/** Home / Ctrl+A：光标到行首。 */
export function moveHome(s: PromptEditState): PromptEditState {
  return { ...s, cursor: 0 };
}

/** End / Ctrl+E：光标到行尾。 */
export function moveEnd(s: PromptEditState): PromptEditState {
  return { ...s, cursor: toChars(s.text).length };
}

export function moveLeft(s: PromptEditState): PromptEditState {
  return { ...s, cursor: Math.max(0, clamp(s) - 1) };
}

export function moveRight(s: PromptEditState): PromptEditState {
  return { ...s, cursor: Math.min(toChars(s.text).length, clamp(s) + 1) };
}

/** Ctrl+← / Alt+B：按词左移（先跨过左侧空白，再跨过词本体）。 */
export function wordLeft(s: PromptEditState): PromptEditState {
  const chars = toChars(s.text);
  let i = clamp(s);
  while (i > 0 && isSpace(chars[i - 1] as string)) i -= 1;
  while (i > 0 && !isSpace(chars[i - 1] as string)) i -= 1;
  return { ...s, cursor: i };
}

/** Ctrl+→ / Alt+F：按词右移（先跨过右侧空白，再跨过词本体）。 */
export function wordRight(s: PromptEditState): PromptEditState {
  const chars = toChars(s.text);
  const n = chars.length;
  let i = clamp(s);
  while (i < n && isSpace(chars[i] as string)) i += 1;
  while (i < n && !isSpace(chars[i] as string)) i += 1;
  return { ...s, cursor: i };
}

/** Ctrl+W：删前一个词（连同桌前空白一起吃掉，bash unix-word-rubout 语义）。 */
export function deletePrevWord(s: PromptEditState): PromptEditState {
  const chars = toChars(s.text);
  const i = clamp(s);
  let j = i;
  while (j > 0 && isSpace(chars[j - 1] as string)) j -= 1;
  while (j > 0 && !isSpace(chars[j - 1] as string)) j -= 1;
  return { text: chars.slice(0, j).concat(chars.slice(i)).join(''), cursor: j };
}

/** Ctrl+U：删到行首。 */
export function deleteToHome(s: PromptEditState): PromptEditState {
  const chars = toChars(s.text);
  return { text: chars.slice(clamp(s)).join(''), cursor: 0 };
}

/** Ctrl+K：删到行尾。 */
export function deleteToEnd(s: PromptEditState): PromptEditState {
  const chars = toChars(s.text);
  return { text: chars.slice(0, clamp(s)).join(''), cursor: clamp(s) };
}

export function backspace(s: PromptEditState): PromptEditState {
  const chars = toChars(s.text);
  const i = clamp(s);
  if (i === 0) return { text: s.text, cursor: 0 };
  return { text: chars.slice(0, i - 1).concat(chars.slice(i)).join(''), cursor: i - 1 };
}

export function deleteForward(s: PromptEditState): PromptEditState {
  const chars = toChars(s.text);
  const i = clamp(s);
  if (i >= chars.length) return { text: s.text, cursor: chars.length };
  return { text: chars.slice(0, i).concat(chars.slice(i + 1)).join(''), cursor: i };
}

/** 在光标处插入文本（粘贴时 input 可能是多字符，整体插入）。 */
export function insertText(s: PromptEditState, input: string): PromptEditState {
  const chars = toChars(s.text);
  const i = clamp(s);
  const ins = toChars(input);
  return {
    text: chars.slice(0, i).concat(ins, chars.slice(i)).join(''),
    cursor: i + ins.length,
  };
}

/**
 * 粘贴文本归一：CRLF / 裸 CR 统一为 LF。
 * 终端粘贴的 Windows 换行含 \r，原样进值后 \r 按回车语义渲染——后续字符被写到
 * 行首覆盖已有内容（实测：'abc\r\ndef' 的 \r 把行尾 padding 甩回行首，视觉上
 * 换行后的内容出现在上一行最前面）；\r 还会随消息原样发给模型。
 * 无 \r 时原样返回（常见路径零分配）。
 */
export function normalizePastedText(input: string): string {
  return input.includes('\r') ? input.replace(/\r\n/g, '\n').replace(/\r/g, '\n') : input;
}

/**
 * 按键 → 编辑动作映射（纯函数解析层）。
 * 返回 null 表示不是编辑键，交给后续可打印字符插入分支。
 * 注意次序：Ctrl+←/→ 须在裸 ←/→ 之前判定（ctrl 标志更具体）。
 */
export function resolveEditAction(input: string, key: EditKeyInfo): EditAction | null {
  if (key.home || (key.ctrl && input === 'a')) return moveHome;
  if (key.end || (key.ctrl && input === 'e')) return moveEnd;
  if (key.leftArrow && key.ctrl) return wordLeft;
  if (key.rightArrow && key.ctrl) return wordRight;
  if (key.meta && input === 'b') return wordLeft;
  if (key.meta && input === 'f') return wordRight;
  if (key.ctrl && input === 'w') return deletePrevWord;
  if (key.ctrl && input === 'u') return deleteToHome;
  if (key.ctrl && input === 'k') return deleteToEnd;
  if (key.leftArrow) return moveLeft;
  if (key.rightArrow) return moveRight;
  if (key.backspace) return backspace;
  if (key.delete) return deleteForward;
  return null;
}
