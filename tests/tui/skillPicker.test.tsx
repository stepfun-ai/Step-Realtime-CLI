import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { SkillPicker, type SkillPickerItem } from '../../src/tui/SkillPicker.js';

const delay = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

// 终端控制序列：↓ ↑ Esc Backspace（fromCharCode 构造，避免源文件内嵌裸控制字符）
const DOWN = String.fromCharCode(27) + '[B';
const UP = String.fromCharCode(27) + '[A';
const ESC = String.fromCharCode(27);
const BACKSPACE = String.fromCharCode(127);

function item(name: string, description: string): SkillPickerItem {
  return { name, description };
}

const three = (): SkillPickerItem[] => [
  item('kb-root', '知识库主入口，路由到各主题目录'),
  item('ai-output-guide', 'AI 输出格式与对话规范指南'),
  item('user-profile', '用户画像、协作偏好、认知风格'),
];

describe('SkillPicker', () => {
  it('渲染显示各技能名与描述、标题与键位提示', () => {
    const { lastFrame } = render(
      React.createElement(SkillPicker, { items: three(), onSelect: () => {} }),
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('kb-root');
    expect(out).toContain('ai-output-guide');
    expect(out).toContain('user-profile');
    expect(out).toContain('知识库主入口');
    expect(out).toContain('AI 输出格式与对话规范指南');
    expect(out).toContain('选择要激活的技能');
    expect(out).toContain('Enter 激活');
  });

  it('空列表显示"无匹配的技能"提示', () => {
    const { lastFrame } = render(
      React.createElement(SkillPicker, { items: [], onSelect: () => {} }),
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('无匹配的技能');
  });

  it('回车（不移动）选中第一条', async () => {
    const onSelect = vi.fn();
    const { stdin } = render(
      React.createElement(SkillPicker, { items: three(), onSelect }),
    );
    await delay();
    stdin.write('\r');
    await delay();
    expect(onSelect).toHaveBeenCalledWith('kb-root');
  });

  it('下箭头 + 回车选中第二条，onSelect 带正确技能名', async () => {
    const onSelect = vi.fn();
    const { stdin } = render(
      React.createElement(SkillPicker, { items: three(), onSelect }),
    );
    await delay();
    stdin.write(DOWN);
    await delay();
    stdin.write('\r');
    await delay();
    expect(onSelect).toHaveBeenCalledWith('ai-output-guide');
  });

  it('上箭头 + 回车选中第一条（越界 clamp）', async () => {
    const onSelect = vi.fn();
    const { stdin } = render(
      React.createElement(SkillPicker, { items: three(), onSelect }),
    );
    await delay();
    stdin.write(UP);
    await delay();
    stdin.write('\r');
    await delay();
    expect(onSelect).toHaveBeenCalledWith('kb-root');
  });

  it('连续下箭头越界 clamp 不循环', async () => {
    const onSelect = vi.fn();
    const { stdin } = render(
      React.createElement(SkillPicker, { items: three(), onSelect }),
    );
    await delay();
    stdin.write(DOWN);
    await delay();
    stdin.write(DOWN);
    await delay();
    stdin.write(DOWN); // 越界
    await delay();
    stdin.write('\r');
    await delay();
    expect(onSelect).toHaveBeenCalledWith('user-profile');
  });

  it('Esc 触发 onSelect(null)', async () => {
    const onSelect = vi.fn();
    const { stdin } = render(
      React.createElement(SkillPicker, { items: three(), onSelect }),
    );
    await delay();
    stdin.write(ESC);
    await delay();
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it('有过滤词时 Esc 先清词，不触发 onSelect', async () => {
    const onSelect = vi.fn();
    const { stdin, lastFrame } = render(
      React.createElement(SkillPicker, { items: three(), onSelect }),
    );
    await delay();
    stdin.write('kb');
    await delay();
    stdin.write(ESC);
    await delay();
    const out = lastFrame() ?? '';
    expect(out).toContain('kb-root');
    expect(out).toContain('ai-output-guide');
    expect(out).toContain('user-profile');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('输入过滤技能名：只显示匹配项', async () => {
    const { lastFrame, stdin } = render(
      React.createElement(SkillPicker, { items: three(), onSelect: () => {} }),
    );
    await delay();
    stdin.write('kb');
    await delay();
    const out = lastFrame() ?? '';
    expect(out).toContain('kb-root');
    expect(out).not.toContain('ai-output-guide');
    expect(out).not.toContain('user-profile');
  });

  it('输入过滤描述：只显示匹配项', async () => {
    const { lastFrame, stdin } = render(
      React.createElement(SkillPicker, { items: three(), onSelect: () => {} }),
    );
    await delay();
    stdin.write('输出格式');
    await delay();
    const out = lastFrame() ?? '';
    expect(out).toContain('ai-output-guide');
    expect(out).not.toContain('kb-root');
    expect(out).not.toContain('user-profile');
  });

  it('Backspace 删过滤字恢复列表', async () => {
    const { lastFrame, stdin } = render(
      React.createElement(SkillPicker, { items: three(), onSelect: () => {} }),
    );
    await delay();
    stdin.write('kb');
    await delay();
    stdin.write(BACKSPACE);
    await delay();
    stdin.write(BACKSPACE);
    await delay();
    stdin.write(BACKSPACE);
    await delay();
    const out = lastFrame() ?? '';
    expect(out).toContain('kb-root');
    expect(out).toContain('ai-output-guide');
    expect(out).toContain('user-profile');
  });

  it('过滤后选择位置重置为 0', async () => {
    const onSelect = vi.fn();
    const { stdin } = render(
      React.createElement(SkillPicker, { items: three(), onSelect }),
    );
    await delay();
    stdin.write(DOWN);
    await delay();
    stdin.write(DOWN);
    await delay();
    stdin.write('user'); // 过滤只剩 user-profile
    await delay();
    stdin.write('\r');
    await delay();
    expect(onSelect).toHaveBeenCalledWith('user-profile');
  });

  it('空格分词 AND 过滤', async () => {
    const { lastFrame, stdin } = render(
      React.createElement(SkillPicker, { items: three(), onSelect: () => {} }),
    );
    await delay();
    stdin.write('输出 格式');
    await delay();
    const out = lastFrame() ?? '';
    expect(out).toContain('ai-output-guide');
    expect(out).not.toContain('kb-root');
    expect(out).not.toContain('user-profile');
  });

  it('大小写不敏感过滤', async () => {
    const { lastFrame, stdin } = render(
      React.createElement(SkillPicker, { items: three(), onSelect: () => {} }),
    );
    await delay();
    stdin.write('KB');
    await delay();
    const out = lastFrame() ?? '';
    expect(out).toContain('kb-root');
    expect(out).not.toContain('ai-output-guide');
  });

  it('空输入 Enter 触发 onSelect(null)', async () => {
    const onSelect = vi.fn();
    const { stdin } = render(
      React.createElement(SkillPicker, { items: [], onSelect }),
    );
    await delay();
    stdin.write('\r');
    await delay();
    expect(onSelect).toHaveBeenCalledWith(null);
  });
});
