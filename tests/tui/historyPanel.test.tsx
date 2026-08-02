import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import type { MessageOriginKind, StoredMessage } from '../../src/agent/message.js';
import { HistoryPanel, collectHistoryItems, type HistoryPanelItem } from '../../src/tui/HistoryPanel.js';

const delay = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

// 终端控制序列：↓ ↑ Esc Tab（fromCharCode 构造，避免源文件内嵌裸控制字符）
const DOWN = String.fromCharCode(27) + '[B';
const UP = String.fromCharCode(27) + '[A';
const ESC = String.fromCharCode(27);
const TAB = String.fromCharCode(9);

const three = (): HistoryPanelItem[] => [
  { count: 1, label: '最近的问题', detail: '5 分钟前', text: '最近的问题全文', undoable: true },
  { count: 2, label: '倒数第二轮', detail: '10 分钟前', text: '倒数第二轮全文', undoable: true },
  { count: 0, label: '压缩前原话', detail: '1 小时前', text: '压缩前原话全文', undoable: false },
];

function renderPanel(items: HistoryPanelItem[], onSelect: Parameters<typeof HistoryPanel>[0]['onSelect'] = () => {}) {
  return render(React.createElement(HistoryPanel, { items, onSelect }));
}

describe('collectHistoryItems', () => {
  function msg(role: 'user' | 'assistant', origin: MessageOriginKind, text: string, id: string): StoredMessage {
    return { message: { role, content: text }, origin: { kind: origin }, id, ts: new Date().toISOString() };
  }

  it('只收真人用户输入（user + user_verbatim），排除注入/摘要/助手/工具轮', () => {
    const items = collectHistoryItems([
      msg('user', 'user', '第一轮', 'u1'),
      msg('assistant', 'assistant', '回复', 'a1'),
      msg('user', 'tool', '工具结果', 't1'),
      msg('user', 'injection', 'hook 注入', 'i1'),
      msg('user', 'user_verbatim', '压缩保真原话', 'uv1'),
      msg('user', 'compaction_summary', '摘要', 'cs1'),
      msg('user', 'user', '第二轮', 'u2'),
    ]);
    expect(items.map((m) => m.text)).toEqual(['第二轮', '压缩保真原话', '第一轮']);
  });

  it('逆序（最近在上），count 只按可回退的 user 轮编号，user_verbatim 不可回退', () => {
    const items = collectHistoryItems([
      msg('user', 'user_verbatim', '压缩前', 'uv1'),
      msg('user', 'compaction_summary', '摘要', 'cs1'),
      msg('user', 'user', '第一轮', 'u1'),
      msg('assistant', 'assistant', '回复', 'a1'),
      msg('user', 'user', '第二轮', 'u2'),
    ]);
    expect(items).toHaveLength(3);
    // 最近在上：第二轮 count=1，第一轮 count=2，压缩前的保真原话不可回退
    expect(items[0]).toMatchObject({ text: '第二轮', count: 1, undoable: true });
    expect(items[1]).toMatchObject({ text: '第一轮', count: 2, undoable: true });
    expect(items[2]).toMatchObject({ text: '压缩前', count: 0, undoable: false });
  });

  it('多行输入摘要压单行并截断，text 保留原文', () => {
    const long = `第一行\n第二行${'很长的内容'.repeat(20)}`;
    const items = collectHistoryItems([msg('user', 'user', long, 'u1')]);
    expect(items[0]!.label).not.toContain('\n');
    expect(items[0]!.label.length).toBeLessThanOrEqual(41); // 40 + 省略号
    expect(items[0]!.text).toBe(long);
  });
});

describe('HistoryPanel', () => {
  it('渲染显示各条输入摘要与时间、标题与键位提示', () => {
    const { lastFrame } = renderPanel(three());
    const out = lastFrame() ?? '';
    expect(out).toContain('最近的问题');
    expect(out).toContain('倒数第二轮');
    expect(out).toContain('5 分钟前');
    expect(out).toContain('本会话输入回顾与回退');
    expect(out).toContain('Tab 仅取回输入');
  });

  it('不可回退项（压缩前）带「仅可取回」标记', () => {
    const { lastFrame } = renderPanel(three());
    expect(lastFrame() ?? '').toContain('仅可取回');
  });

  it('空列表显示空态提示', () => {
    const { lastFrame } = renderPanel([]);
    expect(lastFrame() ?? '').toContain('本会话还没有可回顾的输入');
  });

  it('默认选中第一条（最近一轮），Enter 回传 backtrack（count + 完整文本）', async () => {
    const onSelect = vi.fn();
    const { stdin } = renderPanel(three(), onSelect);
    await delay();
    stdin.write('\r');
    await delay();
    expect(onSelect).toHaveBeenCalledWith({ kind: 'backtrack', count: 1, text: '最近的问题全文' });
  });

  it('↓ 移动 + Enter 选中第二条，回传其 count 与文本', async () => {
    const onSelect = vi.fn();
    const { stdin } = renderPanel(three(), onSelect);
    await delay();
    stdin.write(DOWN);
    await delay();
    stdin.write('\r');
    await delay();
    expect(onSelect).toHaveBeenCalledWith({ kind: 'backtrack', count: 2, text: '倒数第二轮全文' });
  });

  it('↑ 在顶部 clamp 不循环：按 ↑ 后 Enter 仍选中第一条', async () => {
    const onSelect = vi.fn();
    const { stdin } = renderPanel(three(), onSelect);
    await delay();
    stdin.write(UP);
    await delay();
    stdin.write('\r');
    await delay();
    expect(onSelect).toHaveBeenCalledWith({ kind: 'backtrack', count: 1, text: '最近的问题全文' });
  });

  it('Tab 仅取回文本不回退', async () => {
    const onSelect = vi.fn();
    const { stdin } = renderPanel(three(), onSelect);
    await delay();
    stdin.write(DOWN);
    await delay();
    stdin.write(TAB);
    await delay();
    expect(onSelect).toHaveBeenCalledWith({ kind: 'recall', text: '倒数第二轮全文' });
  });

  it('不可回退项上 Enter 退化为仅取回文本', async () => {
    const onSelect = vi.fn();
    const { stdin } = renderPanel(three(), onSelect);
    await delay();
    stdin.write(DOWN);
    stdin.write(DOWN); // 移到「压缩前原话」
    await delay();
    stdin.write('\r');
    await delay();
    expect(onSelect).toHaveBeenCalledWith({ kind: 'recall', text: '压缩前原话全文' });
  });

  it('Esc 关闭，回传 null', async () => {
    const onSelect = vi.fn();
    const { stdin } = renderPanel(three(), onSelect);
    await delay();
    stdin.write(ESC);
    await delay();
    expect(onSelect).toHaveBeenCalledWith(null);
  });
});
