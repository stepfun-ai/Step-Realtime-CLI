import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { TodoPanel } from '../../src/tui/TodoPanel.js';
import { QueuePreview } from '../../src/tui/QueuePreview.js';
import { AgentGroup, type SubagentProgress } from '../../src/tui/AgentGroup.js';
import { ThinkingPreview } from '../../src/tui/MessageList.js';

/**
 * 窄终端/长内容截断测试（滚动跳顶修复的折行洞）：
 * chrome 面板的长行必须 wrap=truncate 单行截断，不能折行——
 * 否则动态区高度预算按 1 行/条估算、实际渲染 2+ 行，帧高触线被全清。
 * ink-testing-library 的 mock stdout 固定 100 列。
 */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

function frameLines(out: string): string[] {
  return stripAnsi(out)
    .trimEnd()
    .split('\n')
    .map((l) => l.trimEnd());
}

describe('chrome 面板长行截断（wrap=truncate）', () => {
  it('TodoPanel：超长 title 截断为 1 行，面板行数不变', () => {
    const title = `任务${'x'.repeat(150)}`;
    const { lastFrame } = render(<TodoPanel todos={[{ title, status: 'in_progress' }]} />);
    const out = lastFrame() ?? '';
    const lines = frameLines(out);
    // margin 1 + 边框 2 + 标题 1 + 条目 1 = 5 行；折行会变成 6+
    expect(lines).toHaveLength(5);
    expect(out).not.toContain('x'.repeat(120));
  });

  it('QueuePreview：超长单行条目截断为 1 行', () => {
    const entry = 'a'.repeat(150);
    const { lastFrame } = render(<QueuePreview queue={[entry]} />);
    const out = lastFrame() ?? '';
    const lines = frameLines(out);
    // 标题 1 + 条目 1 + ↑ 取回提示 1 = 3 行
    expect(lines).toHaveLength(3);
    expect(out).not.toContain('a'.repeat(101));
  });

  it('QueuePreview：多行条目仍最多 2 行，且每行独立截断', () => {
    const entry = `${'b'.repeat(150)}\n${'c'.repeat(150)}\nthird`;
    const { lastFrame } = render(<QueuePreview queue={[entry]} />);
    const out = lastFrame() ?? '';
    const lines = frameLines(out);
    // 标题 1 + 条目 2 行（第三行被 previewEntry 折叠为省略号）+ ↑ 取回提示 1
    expect(lines).toHaveLength(4);
    expect(out).toContain('…');
    expect(out).not.toContain('b'.repeat(101));
  });

  it('AgentGroup：超长 description/activity 截断为各 1 行', () => {
    const agent: SubagentProgress = {
      id: 's1',
      type: 'general',
      description: 'd'.repeat(150),
      status: 'running',
      toolCount: 3,
      activity: 'e'.repeat(150),
      startedAt: Date.now(),
    };
    const { lastFrame } = render(<AgentGroup agents={[agent]} />);
    const out = lastFrame() ?? '';
    const lines = frameLines(out);
    // margin 1 + 边框 2 + 头部 1 + 条目 1 + 活动 1 + 转后台提示 1 = 7 行
    expect(lines).toHaveLength(7);
    expect(out).not.toContain('d'.repeat(101));
    expect(out).not.toContain('e'.repeat(101));
  });

  it('ThinkingPreview：长行截断；maxLines 由降级预算收窄', () => {
    const text = `${'f'.repeat(150)}\nsecond\nthird`;
    const wide = render(<ThinkingPreview text={text} />);
    // 默认 ≤3 行正文 + 标题：标题 1 + 3 行 = 4 行（长行不折行）
    expect(frameLines(wide.lastFrame() ?? '')).toHaveLength(4);

    const shrunk = render(<ThinkingPreview text={text} maxLines={1} />);
    const out = shrunk.lastFrame() ?? '';
    // 降级到 1 行正文：标题 1 + 尾部 1 行（third）
    expect(frameLines(out)).toHaveLength(2);
    expect(out).toContain('third');
    expect(out).not.toContain('second');
  });
});
