import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { ThinkPicker, type ThinkPickerItem } from '../../src/tui/ThinkPicker.js';

const delay = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

// 终端控制序列：↓ ↑ Esc（fromCharCode 构造，避免源文件内嵌裸控制字符）
const DOWN = String.fromCharCode(27) + '[B';
const UP = String.fromCharCode(27) + '[A';
const ESC = String.fromCharCode(27);

function thinkItem(name: string, detail = '说明', current = false): ThinkPickerItem {
  return { name, detail, current };
}

const defaultItems = (): ThinkPickerItem[] => [
  thinkItem('low', '低强度 · 轻量推理', false),
  thinkItem('medium', '中强度 · 平衡速度', true),
  thinkItem('high', '高强度 · 深度推理', false),
  thinkItem('off', '关闭思考', false),
];

function renderPicker(items: ThinkPickerItem[], onSelect = () => {}, hasHistory = false, visibleRows?: number) {
  return render(React.createElement(ThinkPicker, { items, hasHistory, onSelect, visibleRows }));
}

describe('ThinkPicker', () => {
  it('渲染档位名与 budget 说明、标题与键位提示', () => {
    const { lastFrame } = renderPicker(defaultItems());
    const out = lastFrame() ?? '';
    expect(out).toContain('low');
    expect(out).toContain('medium');
    expect(out).toContain('high');
    expect(out).toContain('off');
    expect(out).toContain('选择思考深度');
    expect(out).toContain('Enter 切换');
  });

  it('当前项显示 ← 当前 后缀，且整个列表只出现一次', () => {
    const { lastFrame } = renderPicker(defaultItems());
    const out = lastFrame() ?? '';
    expect(out.match(/← 当前/g)).toHaveLength(1);
    expect(out).toMatch(/medium\s+中强度.*← 当前/);
  });

  it('会话已有历史时顶部显示 prompt cache 警告，无历史不显示', () => {
    const withHistory = renderPicker(defaultItems(), () => {}, true);
    expect(withHistory.lastFrame() ?? '').toContain('prompt cache');
    withHistory.unmount();
    const noHistory = renderPicker(defaultItems(), () => {}, false);
    expect(noHistory.lastFrame() ?? '').not.toContain('prompt cache');
  });

  it('↓ 移动 + Enter 选中第二项，onSelect 带正确档位名', async () => {
    const onSelect = vi.fn();
    const { stdin } = renderPicker(defaultItems(), onSelect);
    await delay();
    stdin.write(DOWN);
    await delay();
    stdin.write('\r');
    await delay();
    expect(onSelect).toHaveBeenCalledWith('medium');
  });

  it('↑ 在顶部 clamp 不循环：按 ↑ 后 Enter 仍选中第一项', async () => {
    const onSelect = vi.fn();
    const { stdin } = renderPicker(defaultItems(), onSelect);
    await delay();
    stdin.write(UP);
    await delay();
    stdin.write('\r');
    await delay();
    expect(onSelect).toHaveBeenCalledWith('low');
  });

  it('↓ 在底部 clamp 不循环：连按多次后 Enter 仍选中末项', async () => {
    const onSelect = vi.fn();
    const { stdin } = renderPicker(defaultItems(), onSelect);
    await delay();
    for (let i = 0; i < 10; i++) stdin.write(DOWN);
    await delay();
    stdin.write('\r');
    await delay();
    expect(onSelect).toHaveBeenCalledWith('off');
  });

  it('Esc 取消，onSelect(null)', async () => {
    const onSelect = vi.fn();
    const { stdin } = renderPicker(defaultItems(), onSelect);
    await delay();
    stdin.write(ESC);
    await delay();
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it('空列表显示空态提示', () => {
    const { lastFrame } = renderPicker([]);
    expect(lastFrame() ?? '').toContain('无可用档位');
  });
});

describe('ThinkPicker 小终端可见条数截断', () => {
  // ThinkPicker 列表短（4 项），visibleRows 主要防小终端越线。
  // 传入 visibleRows=2 时应只渲染前 2 项，帧总高相应降低。

  it('传入 visibleRows=2 只渲染前 2 条，其余隐藏', () => {
    const { lastFrame } = renderPicker(defaultItems(), () => {}, false, 2);
    const out = lastFrame() ?? '';
    expect(out).toContain('low');
    expect(out).toContain('medium');
    expect(out).not.toContain('high');
    expect(out).not.toContain('off');
  });

  it('传入 visibleRows 等于总条数时全部渲染', () => {
    const { lastFrame } = renderPicker(defaultItems(), () => {}, false, 4);
    const out = lastFrame() ?? '';
    expect(out).toContain('low');
    expect(out).toContain('medium');
    expect(out).toContain('high');
    expect(out).toContain('off');
  });

  it('省略 visibleRows 时渲染全部 4 条（历史行为）', () => {
    const { lastFrame } = renderPicker(defaultItems());
    const out = lastFrame() ?? '';
    expect(out).toContain('low');
    expect(out).toContain('off');
  });

  it('小终端 visibleRows=1 时只渲染 1 条，游标 clamp 不越界', async () => {
    const onSelect = vi.fn();
    const { stdin } = renderPicker(defaultItems(), onSelect, false, 1);
    await delay();
    // 只有 1 条可见，↓ 应停在原地
    stdin.write(DOWN);
    await delay();
    stdin.write('\r');
    await delay();
    // 可见的第一项是 low（off 项被截断不在 shown 里）
    expect(onSelect).toHaveBeenCalledWith('low');
  });

  it('CJK 档位名按 displayWidth 对齐，不折行', () => {
    const cjkItems: ThinkPickerItem[] = [
      thinkItem('低强度', '轻量推理', false),
      thinkItem('高强度深度思考', '深度推理模式', true),
      thinkItem('off', '关闭', false),
    ];
    const { lastFrame } = renderPicker(cjkItems, () => {}, false, 3);
    const out = lastFrame() ?? '';
    // 两列均可见，无折行
    expect(out).toContain('低强度');
    expect(out).toContain('高强度深度思考');
    expect(out).toContain('深度推理模式');
  });
});
