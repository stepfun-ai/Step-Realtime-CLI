import React from 'react';
import chalk from 'chalk';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { ExpandViewer, collectExpandable } from '../../src/tui/ExpandViewer.js';
import { hasCollapsedBody } from '../../src/tui/ToolCall.js';
import type { DisplayItem } from '../../src/tui/types.js';

const delay = (): Promise<void> => new Promise((r) => setTimeout(r, 20));
/** 等测量 effect 落盘（组高/自然高在 commit 后量，标题与位置指示晚一拍刷新）。 */
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));
const settle = async (): Promise<void> => {
  await tick();
  await tick();
};

/** 去掉 ANSI 颜色/斜体码，便于对纯文本内容断言。 */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

type ToolItem = Extract<DisplayItem, { kind: 'tool' }>;

const tool = (over: Partial<ToolItem>): ToolItem => ({
  kind: 'tool',
  id: 't1',
  name: 'bash',
  input: { command: 'ls' },
  status: 'ok',
  ...over,
});

const foldedThinking = (lines: number): DisplayItem => ({
  kind: 'thinking',
  text: Array.from({ length: lines }, (_, i) => `th-${i + 1}`).join('\n'),
});

describe('hasCollapsedBody（折叠态是否藏了内容）', () => {
  it('成功 + 普通输出：整段折叠成一行提示 → true', () => {
    expect(hasCollapsedBody(tool({ result: 'line1\nline2' }))).toBe(true);
  });

  it('成功 + diff 结果（首行 +N/-M 摘要）：折叠态已显示主体 → false', () => {
    expect(hasCollapsedBody(tool({ result: '+3 -1 src/a.ts\n  10 +added' }))).toBe(false);
  });

  it('成功 + edit 真实形态（summary 行在前、diff 头在第二行）：折叠态已显示主体 → false', () => {
    expect(hasCollapsedBody(tool({ result: '已编辑 src/a.ts（替换 1 处）。\n+2 -1 src/a.ts\n  10 +added' }))).toBe(false);
  });

  it('错误 + 输出 ≤ 4 行：折叠态已完整显示 → false', () => {
    expect(hasCollapsedBody(tool({ status: 'error', result: 'e1\ne2\ne3\ne4' }))).toBe(false);
  });

  it('错误 + 输出 > 4 行：预览被截断 → true', () => {
    expect(hasCollapsedBody(tool({ status: 'error', result: 'e1\ne2\ne3\ne4\ne5' }))).toBe(true);
  });

  it('running / 无结果体 → false', () => {
    expect(hasCollapsedBody(tool({ status: 'running' }))).toBe(false);
    expect(hasCollapsedBody(tool({ result: '' }))).toBe(false);
    expect(hasCollapsedBody(tool({}))).toBe(false);
  });
});

describe('collectExpandable（按轮分组收集，App 侧空组不开查看器的口径）', () => {
  it('多轮混合条目按 user 边界分组，组与组内顺序均时间正序', () => {
    const items: DisplayItem[] = [
      { kind: 'user', text: 'u1' },
      tool({ id: 'a', result: 'ra' }),
      foldedThinking(6),
      { kind: 'assistant', text: 'a' },
      { kind: 'user', text: 'u2' },
      tool({ id: 'b', result: 'rb' }),
    ];
    const groups = collectExpandable(items);
    expect(groups.length).toBe(2);
    expect(groups[0]!.userText).toBe('u1');
    expect(groups[0]!.entries.map((e) => (e.kind === 'tool' ? e.id : 'thinking'))).toEqual(['a', 'thinking']);
    expect(groups[1]!.userText).toBe('u2');
    expect(groups[1]!.entries.map((e) => (e.kind === 'tool' ? e.id : 'thinking'))).toEqual(['b']);
  });

  it('第一个 user 之前的条目归 userText=null 组（会话开始）', () => {
    const items: DisplayItem[] = [
      tool({ id: 'x', result: 'rx' }),
      { kind: 'user', text: 'u1' },
      tool({ id: 'a', result: 'ra' }),
    ];
    const groups = collectExpandable(items);
    expect(groups.map((g) => g.userText)).toEqual([null, 'u1']);
    expect((groups[0]!.entries[0] as ToolItem).id).toBe('x');
  });

  it('连续 user 之间无可展开条目：空轮不产生组，条目归最近一个 user', () => {
    const items: DisplayItem[] = [
      { kind: 'user', text: 'u1' },
      { kind: 'user', text: 'u2' },
      tool({ id: 'a', result: 'ra' }),
    ];
    const groups = collectExpandable(items);
    expect(groups.length).toBe(1);
    expect(groups[0]!.userText).toBe('u2');
  });

  it('短 thinking（≤5 行、折叠态已全文可见）不收', () => {
    const items: DisplayItem[] = [{ kind: 'thinking', text: 't1\nt2\nt3' }];
    expect(collectExpandable(items)).toEqual([]);
  });

  it('无可展开条目 → 空数组（App 据此不开查看器）', () => {
    expect(collectExpandable([{ kind: 'user', text: 'u' }])).toEqual([]);
  });

  it('从最新往回最多收 max 条（保最新，分组只套在入选条目上）', () => {
    const items: DisplayItem[] = Array.from({ length: 15 }, (_, i) =>
      tool({ id: `t${i}`, result: `r${i}` }),
    );
    const groups = collectExpandable(items, 3);
    expect(groups.length).toBe(1);
    expect(groups[0]!.entries.map((g) => (g.kind === 'tool' ? g.id : 'thinking'))).toEqual(['t12', 't13', 't14']);
  });
});

describe('ExpandViewer 全屏查看器 v2', () => {
  const longResult = Array.from({ length: 20 }, (_, i) => `L${String(i + 1).padStart(2, '0')}`).join('\n');
  // 单组：分隔行 1 + 条目（margin 1 + 头 1 + 输出 20）= 自然高 23；maxRows 6 → 窗口 4 行
  const renderViewer = (onClose: () => void = () => {}) =>
    render(
      React.createElement(ExpandViewer, {
        items: [tool({ result: longResult })],
        maxRows: 6,
        onClose,
      }),
    );

  it('初始窗口锚定顶部：标题（含轮数）+ 轮分隔行 + 原生条目头，无「已隐藏 N 行」折叠', async () => {
    const { lastFrame } = renderViewer();
    await settle();
    const out = lastFrame() ?? '';
    const plain = stripAnsi(out);
    expect(plain).toContain('输出查看器（1 轮 · 1 条 · 23 行）');
    expect(plain).toContain('── 第 1 轮 · 会话开始 ──');
    // 原生渲染：MessageItem 工具头（✓ + 名 + 入参摘要），不是 v1 的拍平标题行
    expect(plain).toContain('✓ bash');
    expect(plain).toContain('ls');
    expect(plain).toContain('L01');
    expect(plain).not.toContain('L02');
    expect(plain).not.toContain('已隐藏');
    expect(plain).toContain('Esc/Ctrl+O 关闭');
    expect(plain).toContain('←→ 轮次');
    expect(plain).toContain('行 1-4/23');
  });

  it('diff 行保留原生上色（+ 绿 - 红），thinking 斜体全文展开', async () => {
    // vitest worker 非 TTY，chalk 默认 level 0 不输出 ANSI；临时开启 16 色再断言（同 messageList.test.tsx 配色用例）
    const prevLevel = chalk.level;
    chalk.level = 1;
    try {
      // diff 摘要头在第三行（躲过 hasDiffHeader 的前两行口径），条目才可展开且含 diff 数据行
      const result = ['intro-a', 'intro-b', '+2 -1 src/a.ts', '  10 + added line', '  11 - removed line'].join('\n');
      const items: DisplayItem[] = [tool({ result }), foldedThinking(8)];
      const { lastFrame } = render(React.createElement(ExpandViewer, { items, maxRows: 40, onClose: () => {} }));
      await settle();
      const out = lastFrame() ?? '';
      // + 行绿（\x1b[32m）、- 行红（\x1b[31m）：v1 纯文本拍平丢掉的 diff 上色已恢复
      expect(out).toContain('\x1b[32m  10 + added line');
      expect(out).toContain('\x1b[31m  11 - removed line');
      const plain = stripAnsi(out);
      // thinking 被折叠块（8 行 > 5）在查看器里全文展开，斜体（\x1b[3m）保留
      expect(plain).toContain('th-1');
      expect(plain).toContain('th-8');
      expect(plain).not.toContain('共 8 行');
      expect(out).toContain('\x1b[3m');
    } finally {
      chalk.level = prevLevel;
    }
  });

  it('↓/j 逐行滚动，窗口随 offset 下移', async () => {
    const { stdin, lastFrame } = renderViewer();
    await delay();
    stdin.write('j');
    await delay();
    expect(stripAnsi(lastFrame() ?? '')).toContain('行 2-5/23');
    expect(stripAnsi(lastFrame() ?? '')).toContain('L02');
    stdin.write('\x1b[B'); // 下箭头
    await delay();
    expect(stripAnsi(lastFrame() ?? '')).toContain('行 3-6/23');
  });

  it('PgDn 翻页（步长 = 窗口行数）', async () => {
    const { stdin, lastFrame } = renderViewer();
    await delay();
    stdin.write('\x1b[6~'); // PageDown
    await delay();
    expect(stripAnsi(lastFrame() ?? '')).toContain('行 5-8/23');
  });

  it('End/G 直达底部并 clamp，继续 ↓ 不再越界', async () => {
    const { stdin, lastFrame } = renderViewer();
    await delay();
    stdin.write('G');
    await delay();
    // maxOffset = 23 - 4 = 19 → 窗口显示第 20-23 行
    expect(stripAnsi(lastFrame() ?? '')).toContain('行 20-23/23');
    expect(stripAnsi(lastFrame() ?? '')).toContain('L20');
    stdin.write('j');
    await delay();
    expect(stripAnsi(lastFrame() ?? '')).toContain('行 20-23/23');
    stdin.write('\x1b[6~'); // PageDown 越界同样 clamp
    await delay();
    expect(stripAnsi(lastFrame() ?? '')).toContain('行 20-23/23');
  });

  it('Home/g 回到顶部', async () => {
    const { stdin, lastFrame } = renderViewer();
    await delay();
    stdin.write('G');
    await delay();
    stdin.write('g');
    await delay();
    expect(stripAnsi(lastFrame() ?? '')).toContain('行 1-4/23');
  });

  it('多轮分组渲染：每轮分隔行带 userText（多行取首行），→ 跳次轮起始行，← 回前轮', async () => {
    const items: DisplayItem[] = [
      { kind: 'user', text: 'u1 first\nu1 second' },
      tool({ id: 'a', result: longResult }),
      { kind: 'user', text: 'u2' },
      tool({ id: 'b', name: 'read', input: { path: '/x' }, result: 'tail-line' }),
    ];
    // 组 1：分隔 1 + 22 = 23 行（起始行 0）；组 2：margin 1 + 分隔 1 + 3 = 5 行（起始行 23）
    // 自然高 28；maxRows 6 → 窗口 4，maxOffset 24
    const { stdin, lastFrame } = render(React.createElement(ExpandViewer, { items, maxRows: 6, onClose: () => {} }));
    await settle();
    let plain = stripAnsi(lastFrame() ?? '');
    expect(plain).toContain('输出查看器（2 轮 · 2 条 · 28 行）');
    expect(plain).toContain('── 第 1 轮 · u1 first ──');
    expect(plain).not.toContain('u1 second');
    await delay();
    stdin.write('\x1b[C'); // 右箭头 → 第 2 轮起始行 23
    await delay();
    plain = stripAnsi(lastFrame() ?? '');
    expect(plain).toContain('行 24-27/28');
    expect(plain).toContain('── 第 2 轮 · u2 ──');
    expect(plain).not.toContain('── 第 1 轮');
    // 已在最后一轮，再按 → 原地不动（clamp）
    stdin.write('\x1b[C');
    await delay();
    expect(stripAnsi(lastFrame() ?? '')).toContain('行 24-27/28');
    // ← 在轮起始行 → 回前一轮起始行 0
    stdin.write('\x1b[D');
    await delay();
    plain = stripAnsi(lastFrame() ?? '');
    expect(plain).toContain('行 1-4/28');
    expect(plain).toContain('── 第 1 轮 · u1 first ──');
  });

  it('← 在轮内部先回本轮起始行，再按才去前轮', async () => {
    const items: DisplayItem[] = [
      { kind: 'user', text: 'u1' },
      tool({ id: 'a', result: longResult }),
      { kind: 'user', text: 'u2' },
      tool({ id: 'b', name: 'read', input: { path: '/x' }, result: 'tail-line' }),
    ];
    const { stdin, lastFrame } = render(React.createElement(ExpandViewer, { items, maxRows: 6, onClose: () => {} }));
    await settle();
    await delay();
    stdin.write('j'); // offset 1：第 1 轮内部
    await delay();
    stdin.write('\x1b[D'); // ← → 回本轮起始行 0
    await delay();
    expect(stripAnsi(lastFrame() ?? '')).toContain('行 1-4/28');
    stdin.write('\x1b[D'); // 已在起始行 → 保持 0（无前轮）
    await delay();
    expect(stripAnsi(lastFrame() ?? '')).toContain('行 1-4/28');
  });

  it('多条目长输出全文可达：滚动到底部能看到最后一轮的末行', async () => {
    const items: DisplayItem[] = [
      { kind: 'user', text: 'u1' },
      tool({ id: 'a', result: longResult }),
      { kind: 'user', text: 'u2' },
      tool({ id: 'b', name: 'read', input: { path: '/x' }, result: 'tail-line' }),
    ];
    const { stdin, lastFrame } = render(React.createElement(ExpandViewer, { items, maxRows: 6, onClose: () => {} }));
    await settle();
    await delay();
    stdin.write('G');
    await delay();
    const plain = stripAnsi(lastFrame() ?? '');
    expect(plain).toContain('行 25-28/28');
    expect(plain).toContain('tail-line');
  });

  it('不传 maxRows：不窗口化，全部内容原样铺出（非 TTY 回归保护）', async () => {
    const items: DisplayItem[] = [tool({ result: longResult })];
    const { lastFrame } = render(React.createElement(ExpandViewer, { items, onClose: () => {} }));
    await settle();
    const plain = stripAnsi(lastFrame() ?? '');
    expect(plain).toContain('L01');
    expect(plain).toContain('L20');
  });

  it('Esc 触发 onClose', async () => {
    const onClose = vi.fn();
    const { stdin } = renderViewer(onClose);
    await delay();
    stdin.write('\x1b'); // Esc
    await delay();
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('Ctrl+O 触发 onClose', async () => {
    const onClose = vi.fn();
    const { stdin } = renderViewer(onClose);
    await delay();
    stdin.write('\x0f'); // Ctrl+O
    await delay();
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
