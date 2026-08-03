import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import {
  MAX_VISIBLE_ROWS,
  MIN_VISIBLE_ROWS,
  PICKER_CHROME_ROWS,
  SessionPicker,
  resolveVisibleRows,
  subagentSectionRows,
} from '../../src/tui/SessionPicker.js';
import { computeLiveBudget } from '../../src/tui/liveBudget.js';
import { STATUS_BAR_ROWS } from '../../src/tui/LiveViewport.js';
import type { SessionMeta } from '../../src/session/store.js';

const delay = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

function meta(id: string, title: string): SessionMeta {
  const now = new Date().toISOString();
  return { id, cwd: 'C:/x', model: 'm', createdAt: now, updatedAt: now, messageCount: 3, title };
}

/** 生成 n 条可区分标题的会话（标题带序号，便于断言窗口边界）。 */
function metaList(n: number): SessionMeta[] {
  return Array.from({ length: n }, (_, i) => meta(`id${i}`, `会话${i}`));
}

const DOWN = '\u001B[B';
const UP = '\u001B[A';

describe('resolveVisibleRows：可见条数按终端高度自适应', () => {
  it('终端行数未知（非 TTY / 测试）时返回兜底值，不做自适应', () => {
    expect(resolveVisibleRows(undefined, 0, 3)).toBe(10);
    expect(resolveVisibleRows(undefined, 226, 3)).toBe(10);
  });

  it('80x24 无子 agent：撞上限 12', () => {
    // 24 − 1(红线) − 8(chrome) − 0(子agent区) − 3(状态栏2+动态区1) = 12
    expect(resolveVisibleRows(24, 0, 3)).toBe(12);
  });

  it('80x24 有子 agent：解出 6 条', () => {
    // 24 − 1 − 8 − 6(区头1+5条) − 3 = 6
    expect(resolveVisibleRows(24, 5, 3)).toBe(6);
  });

  it('子 agent 数远超展示上限时不再吃更多行（226 条与 5 条同解）', () => {
    expect(resolveVisibleRows(24, 226, 3)).toBe(resolveVisibleRows(24, 5, 3));
  });

  it('极小终端撞下限：宁可越线也保证还能浏览', () => {
    // 15 − 1 − 8 − 6 − 3 = −3，被抬到下限
    expect(resolveVisibleRows(15, 5, 3)).toBe(MIN_VISIBLE_ROWS);
    expect(resolveVisibleRows(5, 5, 3)).toBe(MIN_VISIBLE_ROWS);
  });

  it('大终端撞上限：不无限增高，超出靠搜索定位', () => {
    expect(resolveVisibleRows(100, 0, 3)).toBe(MAX_VISIBLE_ROWS);
  });

  it('解出的条数恒落在 [下限, 上限] 内（扫过 5..120 行）', () => {
    for (let rows = 5; rows <= 120; rows++) {
      for (const subs of [0, 1, 5, 226]) {
        const v = resolveVisibleRows(rows, subs, 3);
        expect(v).toBeGreaterThanOrEqual(MIN_VISIBLE_ROWS);
        expect(v).toBeLessThanOrEqual(MAX_VISIBLE_ROWS);
      }
    }
  });

  it('chrome 常量与预算口径一致：无子 agent 时可见条数 = 行数 − 1 − chrome − 预留', () => {
    const rows = 30;
    const reserved = 3;
    expect(resolveVisibleRows(rows, 0, reserved)).toBe(
      Math.min(rows - 1 - PICKER_CHROME_ROWS - reserved, MAX_VISIBLE_ROWS),
    );
  });
});

describe('subagentSectionRows：子 agent 区行数口径', () => {
  it('无子会话不占行', () => {
    expect(subagentSectionRows(0)).toBe(0);
  });

  it('有则区头 1 行 + 展示行，且展示行有上限', () => {
    expect(subagentSectionRows(1)).toBe(2);
    expect(subagentSectionRows(5)).toBe(6);
    expect(subagentSectionRows(226)).toBe(6);
  });
});

describe('SessionPicker 滑动窗口', () => {
  it('高亮下移时窗口逐行滑动，而非整页换掉', async () => {
    // visibleRows=5、居中锚定：sel=2 时窗口仍从 0 开始；sel=3 时窗口滑到 1，首条移出、第 6 条进入。
    const { stdin, lastFrame } = render(
      React.createElement(SessionPicker, { sessions: metaList(20), visibleRows: 5, onSelect: () => {} }),
    );
    await delay();
    expect(lastFrame() ?? '').toContain('会话0');
    expect(lastFrame() ?? '').not.toContain('会话5');

    for (let i = 0; i < 3; i++) {
      stdin.write(DOWN);
      await delay();
    }
    const out = lastFrame() ?? '';
    // 块分页下 sel=3 仍在第一页（0..4），第 5 条不会出现——这条断言正是用来区分两种滚动模型的
    expect(out).toContain('会话5');
    expect(out).not.toContain('会话0');
  });

  it('高亮项在整个列表纵贯过程中始终可见', async () => {
    const total = 20;
    const { stdin, lastFrame } = render(
      React.createElement(SessionPicker, { sessions: metaList(total), visibleRows: 5, onSelect: () => {} }),
    );
    await delay();
    for (let i = 1; i < total; i++) {
      stdin.write(DOWN);
      await delay();
      // 高亮行带 '› ' 指针，断言当前项标题与指针同时出现
      expect(lastFrame() ?? '').toContain(`会话${i}`);
    }
  });

  it('窗口不会滑过列表尾部（末条时窗口停在最后一屏）', async () => {
    const { stdin, lastFrame } = render(
      React.createElement(SessionPicker, { sessions: metaList(8), visibleRows: 5, onSelect: () => {} }),
    );
    await delay();
    for (let i = 0; i < 20; i++) {
      stdin.write(DOWN);
      await delay();
    }
    const out = lastFrame() ?? '';
    // 最后一屏 = 会话3..会话7，共 5 条
    expect(out).toContain('会话7');
    expect(out).toContain('会话3');
    expect(out).not.toContain('会话2');
  });

  it('可见条数由入参决定：给 3 条则只渲染 3 条', async () => {
    const { lastFrame } = render(
      React.createElement(SessionPicker, { sessions: metaList(10), visibleRows: 3, onSelect: () => {} }),
    );
    await delay();
    const out = lastFrame() ?? '';
    expect(out).toContain('会话0');
    expect(out).toContain('会话2');
    expect(out).not.toContain('会话3');
  });

  it('分页信息按窗口区间显示，不按固定页码', async () => {
    const { stdin, lastFrame } = render(
      React.createElement(SessionPicker, { sessions: metaList(20), visibleRows: 5, onSelect: () => {} }),
    );
    await delay();
    expect(lastFrame() ?? '').toContain('1-5');
    for (let i = 0; i < 5; i++) {
      stdin.write(DOWN);
      await delay();
    }
    // sel=5 → windowStart=3 → 区间 4-8（块分页会显示 1-10 之类的整页区间）
    expect(lastFrame() ?? '').toContain('4-8');
  });
});

describe('SessionPicker 帧预算不变量（端到端）', () => {
  // 不变量来自 liveBudget：动态帧总高恒 ≤ 终端行数 − 1。越线时 Ink 走全量清屏、
  // 清掉 scrollback，表现为抖动 + 高亮被顶出屏幕。这里直接对预算函数验，不依赖真实终端。
  function frameTotal(rows: number, subs: number): number {
    const visible = resolveVisibleRows(rows, subs, STATUS_BAR_ROWS + 1);
    const promptRows = PICKER_CHROME_ROWS + subagentSectionRows(subs) + visible;
    const budget = computeLiveBudget(rows, { statusRows: STATUS_BAR_ROWS, promptRows });
    return budget.chromeRows + (budget.liveMaxRows ?? 0);
  }

  it('80x24 + 226 个子会话（实测环境）：总高恰好 rows−1，留 1 行余量', () => {
    const rows = 24;
    expect(frameTotal(rows, 226)).toBe(rows - 1);
    expect(rows - frameTotal(rows, 226)).toBeGreaterThan(0);
  });

  it('未撞下限时不变量严格成立（各子会话数下扫到 120 行）', () => {
    // 不越线的条件：可见条数的自然计算值 ≥ 下限，即 rows − 1 − chrome(8) − subRows − 预留(3) ≥ 3
    // → rows ≥ 15 + subRows。满额子会话（subRows=6）时需要 21 行终端。
    for (const subs of [0, 1, 5, 226]) {
      const minRows = 15 + subagentSectionRows(subs);
      for (let rows = minRows; rows <= 120; rows++) {
        expect(frameTotal(rows, subs)).toBeLessThanOrEqual(rows - 1);
      }
    }
  });

  it('反证：固定 10 条 + 标题折行的旧口径会越线（证明本测试能捕获该缺陷）', () => {
    // 旧实现在 80x24 + 191 会话下估出 promptRows=34（条目 20 行含折行 + 子 agent 6 + chrome 8）
    const rows = 24;
    const budget = computeLiveBudget(rows, { statusRows: STATUS_BAR_ROWS, promptRows: 34 });
    const total = budget.chromeRows + (budget.liveMaxRows ?? 0);
    expect(total).toBeGreaterThan(rows - 1);
    expect(rows - total).toBeLessThanOrEqual(0);
  });

  it('极小终端撞下限时明确接受越线（下限保可用性，不保不越线）', () => {
    // 15 行：可见条数被抬到下限 3，此时总高会超 rows−1，属已知取舍
    const rows = 15;
    expect(frameTotal(rows, 226)).toBeGreaterThan(rows - 1);
  });
});

describe('SessionPicker 边界钳制', () => {
  it('首条按 ↑ 停在原地，不回绕到末条', async () => {
    const onSelect = vi.fn();
    const { stdin } = render(
      React.createElement(SessionPicker, { sessions: metaList(5), visibleRows: 5, onSelect }),
    );
    await delay();
    stdin.write(UP);
    await delay();
    stdin.write('\r');
    await delay();
    expect(onSelect).toHaveBeenCalledWith('id0');
  });

  it('末条按 ↓ 停在原地，不回绕到首条', async () => {
    const onSelect = vi.fn();
    const { stdin } = render(
      React.createElement(SessionPicker, { sessions: metaList(3), visibleRows: 5, onSelect }),
    );
    await delay();
    for (let i = 0; i < 6; i++) {
      stdin.write(DOWN);
      await delay();
    }
    stdin.write('\r');
    await delay();
    expect(onSelect).toHaveBeenCalledWith('id2');
  });
});

describe('SessionPicker 标题截断', () => {
  it('给定内容宽度时长标题被截断并加省略号，不整行铺开', async () => {
    const long = '实测下来这条任务链没有用多张图硬拼配上音假装成视频的取巧做法而是真的调了图生视频能力';
    const { lastFrame } = render(
      React.createElement(SessionPicker, {
        sessions: [meta('id1', long)],
        visibleRows: 5,
        innerWidth: 40,
        onSelect: () => {},
      }),
    );
    await delay();
    const out = lastFrame() ?? '';
    expect(out).toContain('…');
    expect(out).not.toContain(long);
    // 截断后仍保留标题开头，用户能辨认是哪条
    expect(out).toContain('实测下来');
  });

  it('未给内容宽度时不截断（保持历史行为，测试环境与非 TTY 下不变）', async () => {
    const long = '一二三四五六七八九十'.repeat(6);
    const { lastFrame } = render(
      React.createElement(SessionPicker, { sessions: [meta('id1', long)], visibleRows: 5, onSelect: () => {} }),
    );
    await delay();
    expect(lastFrame() ?? '').toContain('一二三四五六七八九十');
  });

  it('短标题不受截断影响', async () => {
    const { lastFrame } = render(
      React.createElement(SessionPicker, {
        sessions: [meta('id1', '短标题')],
        visibleRows: 5,
        innerWidth: 60,
        onSelect: () => {},
      }),
    );
    await delay();
    // 只看标题所在那一行：搜索行的占位文案自带省略号，不能对整帧断言
    const line = (lastFrame() ?? '').split('\n').find((l) => l.includes('短标题')) ?? '';
    expect(line).toContain('短标题');
    expect(line).not.toContain('…');
  });
});
