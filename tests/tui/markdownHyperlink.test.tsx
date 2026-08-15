import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';

// mock hyperlink 模块：supportsHyperlinks 默认返回 false
vi.mock('../../src/chat/hyperlink.js', () => ({
  link: (text: string, url: string) => `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`,
  supportsHyperlinks: () => false,
}));

import { Markdown } from '../../src/tui/Markdown.js';

describe('Markdown 行内链接 OSC 8', () => {
  it('不支持 OSC 8 时保留下划线 + gray (url) 后缀', () => {
    const { lastFrame } = render(
      React.createElement(Markdown, { text: '[pi-tui](https://github.com/xxx/pi-tui)', width: 80 }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('pi-tui');
    expect(frame).toContain('(https://github.com/xxx/pi-tui)');
  });

  it('支持 OSC 8 时渲染蓝色下划线文本，不含灰色 (url) 后缀', async () => {
    const mod = await import('../../src/chat/hyperlink.js');
    vi.spyOn(mod, 'supportsHyperlinks').mockReturnValue(true);
    const { lastFrame } = render(
      React.createElement(Markdown, { text: '[pi-tui](https://github.com/xxx/pi-tui)', width: 80 }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).toContain('pi-tui');
    expect(frame).not.toContain('(https://github.com/xxx/pi-tui)');
    vi.restoreAllMocks();
  });

  it('自链接（文本等于 URL）始终不追加 (url) 后缀', () => {
    const { lastFrame } = render(
      React.createElement(Markdown, { text: '[https://example.com](https://example.com)', width: 80 }),
    );
    const frame = lastFrame() ?? '';
    expect(frame).not.toContain('(https://example.com)');
  });
});
