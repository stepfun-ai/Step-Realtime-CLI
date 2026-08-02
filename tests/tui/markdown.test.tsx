import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { Markdown } from '../../src/tui/Markdown.js';

describe('Markdown 渲染', () => {
  it('渲染标题与加粗', () => {
    const { lastFrame } = render(React.createElement(Markdown, { text: '# 标题\n\n这是**加粗**文本。' }));
    const out = lastFrame() ?? '';
    expect(out).toContain('标题');
    expect(out).toContain('加粗');
  });

  it('渲染代码块（带边框）', () => {
    const { lastFrame } = render(React.createElement(Markdown, { text: '```js\nconst x = 1;\n```' }));
    const out = lastFrame() ?? '';
    expect(out).toContain('const x = 1;');
  });

  it('渲染列表与行内代码', () => {
    const { lastFrame } = render(React.createElement(Markdown, { text: '- 第一项\n- 第二项 `code`' }));
    const out = lastFrame() ?? '';
    expect(out).toContain('第一项');
    expect(out).toContain('code');
  });

  it('transient 模式不抛错（关高亮）', () => {
    const { lastFrame } = render(React.createElement(Markdown, { text: '```py\nprint(1)\n```', transient: true }));
    expect(lastFrame() ?? '').toContain('print(1)');
  });

  it('纯文本原样渲染', () => {
    const { lastFrame } = render(React.createElement(Markdown, { text: '普通回复，没有 markdown。' }));
    expect(lastFrame() ?? '').toContain('普通回复');
  });
});
