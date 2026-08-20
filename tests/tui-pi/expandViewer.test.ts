/**
 * 全屏查看器（Ctrl+O）：收集口径 + overlay 渲染与键位。
 *
 * 收集逻辑是纯函数（chat/expandable.ts），这里连带测 overlay 的滚动与轮间跳转——
 * 后者依赖 pi-tui ScrollView 的真实行为，用 FakeTerminal 起一个 TUI 来跑。
 */
import { describe, expect, it } from 'vitest';
import { visibleWidth } from '@earendil-works/pi-tui';
import { collectExpandable, THINKING_FOLD_LINES } from '../../src/chat/expandable.js';
import { ExpandOverlay } from '../../src/tui-pi/ExpandOverlay.js';
import { ItemBlock } from '../../src/tui-pi/blocks.js';
import type { DisplayItem } from '../../src/chat/types.js';

function plain(lines: readonly string[]): string[] {
  // eslint-disable-next-line no-control-regex
  return lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
}

const tool = (over: Partial<Extract<DisplayItem, { kind: 'tool' }>> = {}): DisplayItem => ({
  kind: 'tool',
  id: over.id ?? 't1',
  name: over.name ?? 'bash',
  input: over.input ?? { command: 'ls' },
  status: over.status ?? 'ok',
  result: over.result ?? 'line1\nline2\nline3',
  ...over,
});

describe('collectExpandable 收集口径', () => {
  it('折叠的工具输出进查看器，running 与空结果不进', () => {
    const items: DisplayItem[] = [
      tool({ id: 'a', result: 'out' }),
      tool({ id: 'b', status: 'running', result: undefined }),
      tool({ id: 'c', result: '' }),
    ];
    const groups = collectExpandable(items);
    const ids = groups.flatMap((g) => g.entries.map((e) => (e.item as { id?: string }).id));
    expect(ids).toEqual(['a']);
  });

  it('长 thinking 进查看器，短的不进', () => {
    const long = 'a\nb\nc\nd\ne';
    const short = 'only one line';
    const items: DisplayItem[] = [
      { kind: 'thinking', text: short },
      { kind: 'thinking', text: long },
    ];
    const groups = collectExpandable(items);
    const texts = groups.flatMap((g) => g.entries.map((e) => (e.item as { text?: string }).text));
    expect(texts).toEqual([long]);
    expect(long.split('\n').length).toBeGreaterThan(THINKING_FOLD_LINES);
  });

  it('assistant / user / note 一律不进', () => {
    const items: DisplayItem[] = [
      { kind: 'user', text: 'hi' },
      { kind: 'assistant', text: 'hello' },
      { kind: 'note', text: 'n' },
      { kind: 'error', text: 'e' },
    ];
    expect(collectExpandable(items)).toEqual([]);
  });

  it('按 user 条目分组成轮，首个 user 之前归「会话开始」组', () => {
    const items: DisplayItem[] = [
      tool({ id: 'pre', result: 'x' }),
      { kind: 'user', text: '第一个问题' },
      tool({ id: 'a', result: 'x' }),
      { kind: 'user', text: '第二个问题' },
      tool({ id: 'b', result: 'x' }),
    ];
    const groups = collectExpandable(items);
    expect(groups.map((g) => g.userText)).toEqual([null, '第一个问题', '第二个问题']);
    expect(groups[2]!.entries.map((e) => (e.item as { id?: string }).id)).toEqual(['b']);
  });

  it('从最新向前保留最多 max 条', () => {
    const items: DisplayItem[] = Array.from({ length: 15 }, (_, i) => tool({ id: `t${i}`, result: 'x' }));
    const groups = collectExpandable(items, 10);
    const ids = groups.flatMap((g) => g.entries.map((e) => (e.item as { id?: string }).id));
    expect(ids).toHaveLength(10);
    expect(ids[0]).toBe('t5'); // 保最新 10 条（t5..t14）
    expect(ids[9]).toBe('t14');
  });

  it('diff 结果在主界面已展示 200 行，未超时不占查看器名额', () => {
    const shortDiff = '--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b';
    const longDiff = ['--- a/x', '+++ b/x', ...Array.from({ length: 250 }, (_, i) => `+line${i}`)].join('\n');
    expect(collectExpandable([tool({ id: 'short', result: shortDiff })])).toEqual([]);
    expect(collectExpandable([tool({ id: 'long', result: longDiff })])).toHaveLength(1);
  });
});

describe('ExpandOverlay 渲染与键位', () => {
  function mk(itemsCount = 3): { overlay: ExpandOverlay; closed: number[] } {
    const items: DisplayItem[] = [];
    for (let i = 0; i < itemsCount; i++) {
      items.push({ kind: 'user', text: `问题 ${i}` });
      items.push(tool({ id: `t${i}`, result: Array.from({ length: 20 }, (_, j) => `out-${i}-${j}`).join('\n') }));
    }
    const closed: number[] = [];
    const overlay = new ExpandOverlay({
      groups: collectExpandable(items),
      width: 60,
      viewportRows: 10,
      entryRenderer: (item, width) => ItemBlock.renderExpanded(item, width),
      requestRender: () => {},
      onClose: () => closed.push(1),
    });
    return { overlay, closed };
  }

  it('标题栏给轮数/条数/总行数，底栏给键位与行位置', () => {
    const { overlay } = mk();
    const lines = plain(overlay.render(60));
    expect(lines[0]).toMatch(/查看器 · 3 轮 · 3 条 · 共 \d+ 行/);
    // width=60 放不下完整键位（69 列），降级短版仍保住关闭提示与位置指示
    expect(lines[lines.length - 1]).toContain('Esc/q/Ctrl+O 关闭');
    expect(lines[lines.length - 1]).toMatch(/\d+-\d+\/\d+$/);
  });

  it('宽度足够时底栏用完整键位', () => {
    const { overlay } = mk();
    const lines = plain(overlay.render(90));
    expect(lines[lines.length - 1]).toContain('PgUp/PgDn 翻页');
  });

  it('内容含轮标题与工具输出全文（不折叠）', () => {
    const { overlay } = mk(1);
    const text = plain(overlay.render(60)).join('\n');
    expect(text).toContain('── 问题 0 ──');
    expect(text).toContain('out-0-0');
    // 折叠提示不该出现在查看器里
    expect(text).not.toContain('Ctrl+O 查看');
  });

  it('Esc / q / Ctrl+O 都关闭', () => {
    for (const key of ['\x1b', 'q', '\x0f']) {
      const { overlay, closed } = mk();
      overlay.handleInput(key);
      expect(closed, `key=${JSON.stringify(key)}`).toEqual([1]);
    }
  });

  it('↓/j 行滚、G 跳尾、g 跳首', () => {
    const { overlay } = mk();
    const first = plain(overlay.render(60))[1];
    overlay.handleInput('j');
    const afterDown = plain(overlay.render(60))[1];
    expect(afterDown).not.toBe(first);
    overlay.handleInput('G');
    const atEnd = plain(overlay.render(60))[1];
    overlay.handleInput('g');
    expect(plain(overlay.render(60))[1]).toBe(first);
    expect(atEnd).not.toBe(first);
  });

  it('→ 跳下一轮，← 回本轮起始再跳上一轮', () => {
    const { overlay } = mk(3);
    const head = (): string => plain(overlay.render(60))[1] ?? '';
    expect(head()).toContain('问题 0');
    overlay.handleInput('\x1b[C'); // →
    expect(head()).toContain('问题 1');
    overlay.handleInput('\x1b[C');
    expect(head()).toContain('问题 2');
    overlay.handleInput('\x1b[D'); // ← 已在轮起始 → 上一轮
    expect(head()).toContain('问题 1');
  });

  /**
   * resize 回归：正文在构造时按 width=60 折行，终端变窄到 40 后 render(40)
   * 不得输出超宽行——pi-tui doRender 对超宽行直接 throw 崩溃。
   * 锁死 render 出口的逐行 truncateToWidth。
   */
  it('终端变窄后 render 出口逐行截断，无任何行超宽', () => {
    const { overlay } = mk();
    for (const l of overlay.render(40)) {
      expect(visibleWidth(l), `行超宽: ${JSON.stringify(plain([l])[0])}`).toBeLessThanOrEqual(40);
    }
  });
});

describe('thinking 主界面折叠（与查看器配对）', () => {
  it('超过阈值折叠为前 N 行 + 计数提示，短的全文显示', () => {
    const long = new ItemBlock({ kind: 'thinking', text: Array.from({ length: 12 }, (_, i) => `思考第 ${i} 行`).join('\n\n') });
    const lines = plain(long.render(60));
    const isBody = (l: string): boolean => l.startsWith('  ');
    const bodyLines = lines.filter(isBody);
    expect(bodyLines.length).toBe(THINKING_FOLD_LINES + 1); // N 行正文 + 1 行折叠提示
    expect(bodyLines[bodyLines.length - 1]).toMatch(/… 还有 \d+ 行（Ctrl\+O 查看）/);

    const short = new ItemBlock({ kind: 'thinking', text: '一行思考' });
    const shortLines = plain(short.render(60)).filter((l) => l.startsWith('  '));
    expect(shortLines.length).toBe(1);
    expect(shortLines[0]).not.toContain('还有');
  });

  it('查看器里 thinking 全文铺开，不带折叠提示', () => {
    const text = Array.from({ length: 12 }, (_, i) => `思考第 ${i} 行`).join('\n\n');
    const expanded = plain(ItemBlock.renderExpanded({ kind: 'thinking', text }, 60));
    expect(expanded.join('\n')).toContain('思考第 11 行');
    expect(expanded.join('\n')).not.toContain('还有');
  });
});
