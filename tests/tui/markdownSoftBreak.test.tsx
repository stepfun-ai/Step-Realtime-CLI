import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { Markdown, measureMarkdownRows } from '../../src/tui/Markdown.js';

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

describe('段落内单换行软化（soft break）', () => {
  it('CJK 边界：换行直接删除，不在句中硬断', () => {
    const text = '压缩检查点移到发请求前，\n避免失败时重复烧摘要请求。';
    const { lastFrame } = render(<Markdown text={text} width={200} />);
    const out = stripAnsi(lastFrame() ?? '');
    expect(out).toContain('压缩检查点移到发请求前，避免失败时重复烧摘要请求。');
    expect(out.trim().split('\n')).toHaveLength(1);
  });

  it('拉丁→CJK 边界：英文词后的换行删除（2026-08-12 实录：Seed\\n团队 断行）', () => {
    const text = '张一鸣近期发声在 Seed\n团队内部会议上表态。';
    const { lastFrame } = render(<Markdown text={text} width={200} />);
    const out = stripAnsi(lastFrame() ?? '');
    expect(out).toContain('张一鸣近期发声在 Seed团队内部会议上表态。');
    expect(out.trim().split('\n')).toHaveLength(1);
  });

  it('裸域名被模型断碎时可复原（实录：thepaper.\\ncn）', () => {
    const text = '最原始的是澎湃新闻（thepaper.\ncn）的报道。';
    const { lastFrame } = render(<Markdown text={text} width={200} />);
    expect(stripAnsi(lastFrame() ?? '')).toContain('（thepaper.cn）');
  });

  it('拉丁边界：换行替换为单个空格', () => {
    const text = 'use the config file\nto override defaults';
    const { lastFrame } = render(<Markdown text={text} width={200} />);
    expect(stripAnsi(lastFrame() ?? '')).toContain('use the config file to override defaults');
  });

  it('混合边界：一侧空白不产生双空格', () => {
    const text = 'hello \nworld';
    const { lastFrame } = render(<Markdown text={text} width={200} />);
    const out = stripAnsi(lastFrame() ?? '');
    expect(out).toContain('hello world');
    expect(out).not.toContain('hello  world');
  });

  it('全角标点边界同样删除换行', () => {
    const text = '第一，\n第二。';
    const { lastFrame } = render(<Markdown text={text} width={200} />);
    expect(stripAnsi(lastFrame() ?? '')).toContain('第一，第二。');
  });

  it('测量与渲染一致：含 soft break 的段落在宽终端计 1 行', () => {
    const text = '压缩检查点移到发请求前，\n避免失败时重复烧摘要请求。';
    expect(measureMarkdownRows(text, 200)).toBe(1);
  });
});
