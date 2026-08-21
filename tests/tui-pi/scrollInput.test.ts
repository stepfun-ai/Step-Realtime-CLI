/**
 * renderScrolledInput 的单元测试：钉住「长文本横向滚动、光标始终在可视区、绝不截断成省略号」。
 *
 * 背景：ask_user 的 Other 输入与审批反馈附言曾把整段输入拼一行后 truncateToWidth，
 * 长文本末尾被砍成 …、光标第一个被吃掉。该函数是两处共用的横向滚动渲染，单独测最精确。
 */
import { describe, expect, it } from 'vitest';
import { visibleWidth } from '@earendil-works/pi-tui';
import { renderScrolledInput } from '../../src/tui-pi/scrollInput.js';

// 去掉 ANSI 转义，只看可见文本
const plain = (s: string): string => s.replace(/\x1b\[[0-9;]*m/g, '');

describe('renderScrolledInput', () => {
  it('短文本全部可见，光标在末尾时反显空格，宽度不超', () => {
    const out = renderScrolledInput('abc', 3, 20);
    expect(plain(out)).toBe('abc '); // 光标在末尾 → 反显一个空格
    expect(visibleWidth(out)).toBeLessThanOrEqual(20);
  });

  it('长文本不超宽、末尾光标让末尾字符可见（不截断成省略号）', () => {
    const value = 'x'.repeat(49) + 'Z'; // 末尾是 Z，便于断言滚动到了末尾
    const out = renderScrolledInput(value, value.length, 12);
    expect(visibleWidth(out)).toBeLessThanOrEqual(12);
    expect(plain(out)).not.toContain('...'); // 绝不出现省略号截断
    expect(plain(out)).toContain('Z'); // 末尾字符可见，证明是滚动而非截断
  });

  it('光标在中间时，光标处字符可见（光标跟随滚动）', () => {
    const value = 'abcdefghijklmnopqrstuvwxyz';
    const out = renderScrolledInput(value, 13, 10); // 光标在 'n'（index 13）
    expect(visibleWidth(out)).toBeLessThanOrEqual(10);
    expect(plain(out)).toContain('n'); // 光标处字符在可视区
  });

  it('光标在文本开头时，开头字符可见', () => {
    const value = 'A'.repeat(30) + '末尾';
    const out = renderScrolledInput(value, 0, 10);
    expect(visibleWidth(out)).toBeLessThanOrEqual(10);
    expect(plain(out)).toContain('A'); // 开头可见
  });
});
