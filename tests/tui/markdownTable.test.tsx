import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { Markdown } from '../../src/tui/Markdown.js';
import { displayWidth } from '../../src/chat/liveBudget.js';

/** 去掉 ANSI 颜色码，便于对纯文本内容断言。 */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

describe('markdown 表格渲染', () => {
  it('GFM 表格渲染出表头、单元格与分隔线（含中文单元格）', () => {
    const md = [
      '| 名称 | 说明 |',
      '| --- | --- |',
      '| 宽度 | 按显示宽度对齐 |',
      '| alpha | **beta** |',
    ].join('\n');
    const { lastFrame } = render(React.createElement(Markdown, { text: md }));
    const out = stripAnsi(lastFrame() ?? '');
    expect(out).toContain('名称');
    expect(out).toContain('说明');
    expect(out).toContain('宽度');
    expect(out).toContain('按显示宽度对齐');
    expect(out).toContain('alpha');
    expect(out).toContain('beta');
    expect(out).toContain('─'); // 表头下分隔线
    expect(out).toContain('│'); // 列分隔符
  });

  it('中文单元格按显示宽度补齐，列分隔符纵向对齐', () => {
    const md = ['| 名称 | 值 |', '| --- | --- |', '| 宽度 | abc |', '| x | y |'].join('\n');
    const { lastFrame } = render(React.createElement(Markdown, { text: md }));
    const out = stripAnsi(lastFrame() ?? '');
    const lines = out.split('\n').filter((l) => l.includes('│'));
    // 表头与两行数据的列分隔符位置一致（中文按 2 列补齐后对齐）
    const sepCols = lines.map((l) => displayWidth(l.slice(0, l.indexOf('│'))));
    expect(lines.length).toBeGreaterThanOrEqual(3);
    expect(new Set(sepCols).size).toBe(1);
  });

  it('无 width 时走自然宽度，不收缩', () => {
    const md = ['| 列1 | 列2 |', '| --- | --- |', '| 很长很长很长的内容 | 短 |'].join('\n');
    const { lastFrame } = render(React.createElement(Markdown, { text: md }));
    const out = stripAnsi(lastFrame() ?? '');
    const lines = out.split('\n').filter((l) => l.includes('│'));
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(out).toContain('很长很长很长的内容');
  });

  it('width 充足时保持自然宽度', () => {
    const md = ['| a | b |', '| --- | --- |', '| 1 | 2 |'].join('\n');
    const { lastFrame } = render(React.createElement(Markdown, { text: md, width: 120 }));
    const out = stripAnsi(lastFrame() ?? '');
    const lines = out.split('\n').filter((l) => l.includes('│'));
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(out).toContain('a');
    expect(out).toContain('b');
  });

  it('宽度紧张时列宽按比例收缩', () => {
    const md = ['| 列1 | 列2 | 列3 |', '| --- | --- | --- |', '| a | b | c |'].join('\n');
    const { lastFrame } = render(React.createElement(Markdown, { text: md, width: 20 }));
    const out = stripAnsi(lastFrame() ?? '');
    const lines = out.split('\n').filter((l) => l.includes('│'));
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(out).toContain('a');
    expect(out).toContain('b');
    expect(out).toContain('c');
  });

  it('极窄终端回退原始 markdown', () => {
    const md = ['| a | b | c |', '| --- | --- | --- |', '| 1 | 2 | 3 |'].join('\n');
    const { lastFrame } = render(React.createElement(Markdown, { text: md, width: 5 }));
    const out = stripAnsi(lastFrame() ?? '');
    expect(out).toContain('1');
    expect(out).toContain('2');
    expect(out).toContain('3');
    // 窄屏回退时不维持列结构，原始 markdown 文本直接进入普通折行
    const hasTableSeparator = out.includes('│') || out.includes('┼');
    expect(hasTableSeparator).toBe(false);
  });

  it('宽字符列参与宽度分配', () => {
    const md = ['| 名称 | 值 |', '| --- | --- |', '| 宽度 | abc |'].join('\n');
    const { lastFrame } = render(React.createElement(Markdown, { text: md, width: 20 }));
    const out = stripAnsi(lastFrame() ?? '');
    const lines = out.split('\n').filter((l) => l.includes('│'));
    expect(lines.length).toBeGreaterThanOrEqual(2);
    expect(out).toContain('宽度');
    expect(out).toContain('abc');
  });
});

describe('markdown 自链接渲染', () => {
  it('加粗裸 URL 只渲染一次，不追加 (href)', () => {
    const { lastFrame } = render(React.createElement(Markdown, { text: '**https://example.com/x.pdf**' }));
    const out = stripAnsi(lastFrame() ?? '');
    const occurrences = out.split('https://example.com/x.pdf').length - 1;
    expect(occurrences).toBe(1);
    expect(out).not.toContain('(https://example.com/x.pdf)');
  });

  it('尖括号 autolink 同样只渲染一次', () => {
    const { lastFrame } = render(React.createElement(Markdown, { text: '<https://example.com/x.pdf>' }));
    const out = stripAnsi(lastFrame() ?? '');
    const occurrences = out.split('https://example.com/x.pdf').length - 1;
    expect(occurrences).toBe(1);
  });

  it('文本与 href 不同的链接仍渲染 文本(href)', () => {
    const { lastFrame } = render(React.createElement(Markdown, { text: '[下载报告](https://example.com/x.pdf)' }));
    const out = stripAnsi(lastFrame() ?? '');
    expect(out).toContain('下载报告');
    expect(out).toContain('(https://example.com/x.pdf)');
  });
});
