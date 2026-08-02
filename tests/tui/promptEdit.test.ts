import { describe, expect, it } from 'vitest';
import {
  backspace,
  deleteForward,
  deletePrevWord,
  deleteToEnd,
  deleteToHome,
  insertText,
  moveEnd,
  moveHome,
  moveLeft,
  moveRight,
  normalizePastedText,
  resolveEditAction,
  wordLeft,
  wordRight,
  type PromptEditState,
} from '../../src/tui/promptEdit.js';

const s = (text: string, cursor?: number): PromptEditState => ({ text, cursor: cursor ?? Array.from(text).length });

describe('promptEdit 光标移动', () => {
  it('moveHome / moveEnd 到行首行尾', () => {
    expect(moveHome(s('abc', 2)).cursor).toBe(0);
    expect(moveEnd(s('abc', 1)).cursor).toBe(3);
    // 空串与已在两端：幂等不动
    expect(moveHome(s('')).cursor).toBe(0);
    expect(moveEnd(s('')).cursor).toBe(0);
    expect(moveHome(s('abc', 0)).cursor).toBe(0);
    expect(moveEnd(s('abc', 3)).cursor).toBe(3);
  });

  it('moveLeft / moveRight 单步移动并钳制边界', () => {
    expect(moveLeft(s('abc', 2)).cursor).toBe(1);
    expect(moveRight(s('abc', 2)).cursor).toBe(3);
    expect(moveLeft(s('abc', 0)).cursor).toBe(0);
    expect(moveRight(s('abc', 3)).cursor).toBe(3);
    expect(moveLeft(s('', 0)).cursor).toBe(0);
  });

  it('光标按 code point 移动（emoji 不按 UTF-16 拆）', () => {
    const text = 'a😀b'; // 3 个 code point
    expect(moveLeft(s(text, 2)).cursor).toBe(1);
    expect(moveRight(s(text, 1)).cursor).toBe(2);
    // 光标越过 emoji 插入，文本结构不被破坏
    expect(insertText(s(text, 2), 'X').text).toBe('a😀Xb');
    expect(backspace(s(text, 2)).text).toBe('ab');
  });
});

describe('promptEdit 按词移动', () => {
  it('wordLeft 跨过左侧空白再跨词', () => {
    expect(wordLeft(s('foo bar baz', 11)).cursor).toBe(8);
    expect(wordLeft(s('foo bar baz', 7)).cursor).toBe(4);
    // 光标在连续空白之后：连同桌前空白一起跨过
    expect(wordLeft(s('foo   bar', 9)).cursor).toBe(6);
    expect(wordLeft(s('foo   bar', 6)).cursor).toBe(0);
    // 光标在词中间：回到词首
    expect(wordLeft(s('foo bar', 6)).cursor).toBe(4);
  });

  it('wordRight 跨过右侧空白再跨词', () => {
    expect(wordRight(s('foo bar baz', 0)).cursor).toBe(3);
    expect(wordRight(s('foo bar baz', 3)).cursor).toBe(7);
    // 连续空白：跨过空白与下一词
    expect(wordRight(s('foo   bar', 3)).cursor).toBe(9);
    // 光标在词中间：到词尾
    expect(wordRight(s('foo bar', 1)).cursor).toBe(3);
  });

  it('边界：空串与首尾不动', () => {
    expect(wordLeft(s('', 0)).cursor).toBe(0);
    expect(wordRight(s('', 0)).cursor).toBe(0);
    expect(wordLeft(s('foo', 0)).cursor).toBe(0);
    expect(wordRight(s('foo', 3)).cursor).toBe(3);
    // 全空白串
    expect(wordLeft(s('   ', 3)).cursor).toBe(0);
    expect(wordRight(s('   ', 0)).cursor).toBe(3);
  });
});

describe('promptEdit 删除动作', () => {
  it('deletePrevWord 删前词并吃掉桌前空白', () => {
    expect(deletePrevWord(s('foo bar', 7))).toEqual({ text: 'foo ', cursor: 4 });
    expect(deletePrevWord(s('foo   bar', 9))).toEqual({ text: 'foo   ', cursor: 6 });
    // 光标后随空白：空白与前词一起删
    expect(deletePrevWord(s('foo bar   ', 10))).toEqual({ text: 'foo ', cursor: 4 });
    // 光标在词中间：只删光标前的部分
    expect(deletePrevWord(s('foo bar', 6))).toEqual({ text: 'foo r', cursor: 4 });
    // 边界：空串、光标在行首
    expect(deletePrevWord(s('', 0))).toEqual({ text: '', cursor: 0 });
    expect(deletePrevWord(s('foo', 0))).toEqual({ text: 'foo', cursor: 0 });
    // 行首就是词首再按：无前词可删
    expect(deletePrevWord(s('foo', 3))).toEqual({ text: '', cursor: 0 });
  });

  it('deleteToHome 删到行首', () => {
    expect(deleteToHome(s('foo bar', 4))).toEqual({ text: 'bar', cursor: 0 });
    expect(deleteToHome(s('foo bar', 7))).toEqual({ text: '', cursor: 0 });
    // 边界：空串、光标在行首
    expect(deleteToHome(s('', 0))).toEqual({ text: '', cursor: 0 });
    expect(deleteToHome(s('foo', 0))).toEqual({ text: 'foo', cursor: 0 });
  });

  it('deleteToEnd 删到行尾', () => {
    expect(deleteToEnd(s('foo bar', 3))).toEqual({ text: 'foo', cursor: 3 });
    expect(deleteToEnd(s('foo bar', 0))).toEqual({ text: '', cursor: 0 });
    // 边界：空串、光标在行尾
    expect(deleteToEnd(s('', 0))).toEqual({ text: '', cursor: 0 });
    expect(deleteToEnd(s('foo', 3))).toEqual({ text: 'foo', cursor: 3 });
  });

  it('backspace / deleteForward 边界', () => {
    expect(backspace(s('abc', 2))).toEqual({ text: 'ac', cursor: 1 });
    expect(backspace(s('abc', 0))).toEqual({ text: 'abc', cursor: 0 });
    expect(backspace(s('', 0))).toEqual({ text: '', cursor: 0 });
    expect(deleteForward(s('abc', 1))).toEqual({ text: 'ac', cursor: 1 });
    expect(deleteForward(s('abc', 3))).toEqual({ text: 'abc', cursor: 3 });
    expect(deleteForward(s('', 0))).toEqual({ text: '', cursor: 0 });
  });

  it('insertText 在光标处插入（含多字符粘贴）', () => {
    expect(insertText(s('ac', 1), 'b')).toEqual({ text: 'abc', cursor: 2 });
    expect(insertText(s('', 0), 'hello')).toEqual({ text: 'hello', cursor: 5 });
    expect(insertText(s('ab', 0), 'XY')).toEqual({ text: 'XYab', cursor: 2 });
    expect(insertText(s('ab', 2), 'XY')).toEqual({ text: 'abXY', cursor: 4 });
  });
});

describe('promptEdit 按键 → 编辑动作映射', () => {
  it('Home/End 键与 Ctrl+A/E 映射行首行尾', () => {
    const st = s('abc', 1);
    expect(resolveEditAction('', { home: true })?.(st).cursor).toBe(0);
    expect(resolveEditAction('a', { ctrl: true })?.(st).cursor).toBe(0);
    expect(resolveEditAction('', { end: true })?.(st).cursor).toBe(3);
    expect(resolveEditAction('e', { ctrl: true })?.(st).cursor).toBe(3);
  });

  it('Ctrl+←/→ 与 Alt+B/F 映射按词移动', () => {
    const st = s('foo bar', 7);
    expect(resolveEditAction('', { leftArrow: true, ctrl: true })?.(st).cursor).toBe(4);
    expect(resolveEditAction('b', { meta: true })?.(st).cursor).toBe(4);
    expect(resolveEditAction('', { rightArrow: true, ctrl: true })?.(s('foo bar', 0)).cursor).toBe(3);
    expect(resolveEditAction('f', { meta: true })?.(s('foo bar', 0)).cursor).toBe(3);
  });

  it('Ctrl+W/U/K 映射删除动作', () => {
    const st = s('foo bar', 7);
    expect(resolveEditAction('w', { ctrl: true })?.(st).text).toBe('foo ');
    expect(resolveEditAction('u', { ctrl: true })?.(st).text).toBe('');
    expect(resolveEditAction('k', { ctrl: true })?.(s('foo bar', 3)).text).toBe('foo');
  });

  it('裸方向键与 Backspace/Delete 映射单步动作', () => {
    const st = s('abc', 2);
    expect(resolveEditAction('', { leftArrow: true })?.(st).cursor).toBe(1);
    expect(resolveEditAction('', { rightArrow: true })?.(st).cursor).toBe(3);
    expect(resolveEditAction('', { backspace: true })?.(st).text).toBe('ac');
    expect(resolveEditAction('', { delete: true })?.(st).text).toBe('ab');
  });

  it('非编辑键返回 null（交给可打印字符插入）', () => {
    expect(resolveEditAction('a', {})).toBeNull(); // 裸字母
    expect(resolveEditAction('b', { meta: false })).toBeNull();
    expect(resolveEditAction('x', { ctrl: true })).toBeNull(); // 未定义的 Ctrl 组合
    expect(resolveEditAction('', {})).toBeNull();
  });
});


describe('normalizePastedText 粘贴换行归一', () => {
  it('CRLF 与裸 CR 统一为 LF', () => {
    expect(normalizePastedText('abc\r\ndef')).toBe('abc\ndef');
    expect(normalizePastedText('abc\rdef')).toBe('abc\ndef');
    expect(normalizePastedText('a\r\nb\rc\nd')).toBe('a\nb\nc\nd');
  });

  it('无 CR 时原样返回（含纯 LF 与无换行）', () => {
    expect(normalizePastedText('abc\ndef')).toBe('abc\ndef');
    expect(normalizePastedText('abc')).toBe('abc');
    expect(normalizePastedText('')).toBe('');
  });

  it('归一后经 insertText 插入的值不含 \r', () => {
    const next = insertText(s('xy', 1), normalizePastedText('a\r\nb'));
    expect(next.text).toBe('xa\nby');
    expect(next.text).not.toContain('\r');
    expect(next.cursor).toBe(4);
  });
});
