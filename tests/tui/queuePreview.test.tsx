import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { QueuePreview, previewEntry } from '../../src/tui/QueuePreview.js';

describe('previewEntry 单条裁剪', () => {
  it('两行及以内原样返回', () => {
    expect(previewEntry('一行')).toBe('一行');
    expect(previewEntry('第一行\n第二行')).toBe('第一行\n第二行');
  });

  it('超过两行裁到前两行并加省略号', () => {
    expect(previewEntry('a\nb\nc\nd')).toBe('a\nb …');
  });
});

describe('QueuePreview 面板', () => {
  it('空队列不渲染', () => {
    const { lastFrame } = render(React.createElement(QueuePreview, { queue: [] }));
    expect(lastFrame() ?? '').toBe('');
  });

  it('标题行显示总条数与消费时机说明', () => {
    const { lastFrame } = render(React.createElement(QueuePreview, { queue: ['写测试', '跑构建'] }));
    const out = lastFrame() ?? '';
    expect(out).toContain('发送队列 2 条');
    expect(out).toContain('回合结束后按序发送');
    expect(out).toContain('Esc 中断后立即发送');
    // 逐条 ↳ 预览
    expect(out).toContain('↳ 写测试');
    expect(out).toContain('↳ 跑构建');
  });

  it('超过 3 条只显示前 3 条并折叠计数', () => {
    const { lastFrame } = render(
      React.createElement(QueuePreview, { queue: ['一', '二', '三', '四', '五'] }),
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('↳ 一');
    expect(out).toContain('↳ 三');
    expect(out).not.toContain('↳ 四');
    expect(out).toContain('还有 2 条');
  });

  it('底部显示 ↑ 取回末条编辑的可发现性提示', () => {
    const { lastFrame } = render(React.createElement(QueuePreview, { queue: ['写测试'] }));
    expect(lastFrame() ?? '').toContain('↑ 取回末条编辑');
  });

  it('多行条目预览截断到两行加省略号', () => {
    const { lastFrame } = render(
      React.createElement(QueuePreview, { queue: ['第一行\n第二行\n第三行'] }),
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('第一行');
    expect(out).toContain('第二行');
    expect(out).not.toContain('第三行');
    expect(out).toContain('…');
  });

  it('系统注入条目显示人读占位，不外泄 XML 信封正文', () => {
    const envelope =
      '<notification id="task:abc:completed" category="task" type="task.completed">\n状态：已完成\n</notification>';
    const { lastFrame } = render(
      React.createElement(QueuePreview, {
        queue: [envelope, '真人输入'],
        isSystemInjected: (s: string) => s === envelope,
      }),
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('系统注入');
    expect(out).not.toContain('notification');
    expect(out).not.toContain('task:abc');
    // 真人条目不受影响，仍显示原文
    expect(out).toContain('↳ 真人输入');
  });

  it('不传 isSystemInjected 时行为不变（全部按原文预览）', () => {
    const { lastFrame } = render(React.createElement(QueuePreview, { queue: ['原文条目'] }));
    expect(lastFrame() ?? '').toContain('↳ 原文条目');
  });
});
