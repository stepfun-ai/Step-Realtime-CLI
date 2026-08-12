import React from 'react';
import { render } from 'ink-testing-library';
import { Box } from 'ink';
import { describe, expect, it } from 'vitest';
import { Markdown } from '../../src/tui/Markdown.js';
import { MessageItem } from '../../src/tui/MessageList.js';

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/** 与终端一致的显示宽度：CJK/全角按 2 列。 */
function dispWidth(ln: string): number {
  let w = 0;
  for (const ch of ln) w += ch.codePointAt(0)! > 0x2e7f ? 2 : 1;
  return w;
}

// 2026-08-12 实录：CJK 混排长文 + 列表，flexShrink 布局下 Ink 按父行整宽
// 折行再套缩进，续行超宽被终端硬折行，溢出字符顶到第 0 列（「2025」「中AI」
// 「Pexo」顶格碎片）。本文件固化「渲染行永不超终端宽」的契约。
const REAL_EXCERPT = [
  '**1. 现象本身**',
  '过去两年至少有 10 位"剪映系"创业者创办 AI 应用公司，2025 年上半年尤其密集。典型人物包括：',
  '- **陈冕**：前剪映/CapCut 全球商业化负责人，创办演语科技（LibTV），最新估值约 20 亿美元',
  '- **郭列**：脸萌创始人，团队被字节收购后成为剪映早期班底，创办 Flova',
  '- **廖谦**：前剪映 Pippit 负责人、生数科技 Vidu 前负责人，创办 Pexo',
  '',
  '方向集中在 AI 视频 Agent、设计工具、AI Coding、教育、硬件等，其中**AI 视频最拥挤**。',
].join('\n');

describe('折行宽度契约：渲染行永不超终端宽', () => {
  for (const w of [60, 65, 68, 70]) {
    it(`MessageItem assistant 在 termWidth=${w} 下无超宽行`, () => {
      const { lastFrame } = render(
        <Box width={w} flexDirection="column">
          <MessageItem
            item={{ kind: 'assistant', text: REAL_EXCERPT }}
            expanded={false}
            termWidth={w}
            errorPreviewLines={4}
          />
        </Box>,
      );
      const lines = stripAnsi(lastFrame() ?? '').split('\n');
      for (const ln of lines) {
        expect(dispWidth(ln), `超宽行（${dispWidth(ln)} > ${w}）：${ln}`).toBeLessThanOrEqual(w);
      }
    });
  }

  it('列表续行保持悬挂缩进（不对齐 marker、不顶格）', () => {
    const w = 60;
    const { lastFrame } = render(
      <Box width={w} flexDirection="column">
        <MessageItem
          item={{ kind: 'assistant', text: REAL_EXCERPT }}
          expanded={false}
          termWidth={w}
          errorPreviewLines={4}
        />
      </Box>,
    );
    const lines = stripAnsi(lastFrame() ?? '').split('\n');
    const cont = lines.find((ln) => ln.includes('全球商业化负责人'));
    expect(cont).toBeDefined();
    // assistant 缩进 2 + marker '• ' 2 = 续行至少缩进 4
    expect(cont!.match(/^ */)![0].length).toBeGreaterThanOrEqual(4);
  });
});

describe('列表项 inline 解析', () => {
  it('条目内粗体星号不裸露', () => {
    const { lastFrame } = render(<Markdown text={'- **陈冕**：前剪映负责人'} width={60} />);
    const out = stripAnsi(lastFrame() ?? '');
    expect(out).not.toContain('**');
    expect(out).toContain('陈冕');
  });

  it('有序列表条目同样解析 inline', () => {
    const { lastFrame } = render(<Markdown text={'1. **重点**：说明文字'} width={60} />);
    const out = stripAnsi(lastFrame() ?? '');
    expect(out).not.toContain('**');
  });
});
