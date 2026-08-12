import { describe, expect, it } from 'vitest';
import { wrapStyledSegments } from '../../src/tui/Markdown.js';

const seg = (text: string) => ({ text });

describe('wrapStyledSegments URL 折行保护', () => {
  it('短 URL 放不下时整体挪到下一行，不折断', () => {
    const lines = wrapStyledSegments(
      [seg('详见 https://example.com/docs 的说明')],
      20,
    );
    const flat = lines.map((l) => l.map((s) => s.text).join(''));
    // URL 必须作为完整子串出现在某一行
    expect(flat.some((l) => l.includes('https://example.com/docs'))).toBe(true);
  });

  it('超宽 URL（超过整行宽度）独占一行整体溢出，不做字符级拆分', () => {
    const url = `https://example.com/${'a'.repeat(60)}`;
    const lines = wrapStyledSegments([seg(`前缀 ${url} 后缀`)], 20);
    const flat = lines.map((l) => l.map((s) => s.text).join(''));
    // URL 完整出现在单独一行
    expect(flat).toContain(url);
    // 前后内容不被吞进 URL 行
    expect(flat.join('\n')).toContain('前缀');
    expect(flat.join('\n')).toContain('后缀');
  });

  it('非 URL 的超长拉丁单词仍拆到字符级（原行为回归钉住）', () => {
    const word = 'x'.repeat(50);
    const lines = wrapStyledSegments([seg(word)], 20);
    // 拆成多行，每行不超过 20 宽
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) {
      const w = line.reduce((x, s) => x + s.text.length, 0);
      expect(w).toBeLessThanOrEqual(20);
    }
  });

  it('localhost 与 www. 形式同样受保护', () => {
    const url = `localhost:3000/${'p'.repeat(40)}`;
    const lines = wrapStyledSegments([seg(url)], 15);
    expect(lines.map((l) => l.map((s) => s.text).join(''))).toContain(url);
  });
});
