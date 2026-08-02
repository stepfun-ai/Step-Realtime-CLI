import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { ProviderManager, type ProviderManagerRow } from '../../src/tui/ProviderManager.js';

const delay = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

// 终端控制序列：↓ ↑ Esc（fromCharCode 构造，避免源文件内嵌裸控制字符）
const DOWN = String.fromCharCode(27) + '[B';
const UP = String.fromCharCode(27) + '[A';
const ESC = String.fromCharCode(27);

function row(id: string, overrides: Partial<ProviderManagerRow> = {}): ProviderManagerRow {
  return { id, type: 'openai', baseUrl: `https://${id}.test/v1`, aliasCount: 1, builtin: false, current: false, ...overrides };
}

/** 两条自定义渠道 + 一条内置预设独有行的标准夹具。 */
const three = (): ProviderManagerRow[] => [
  row('gw', { aliasCount: 2 }),
  row('kimi', { type: 'anthropic', aliasCount: 0, current: true }),
  row('stepfun', { builtin: true }),
];

function renderPanel(rows: ProviderManagerRow[], handlers: Partial<Parameters<typeof ProviderManager>[0]> = {}) {
  const props = {
    rows,
    onSwitch: vi.fn(),
    onAdd: vi.fn(),
    onDelete: vi.fn(),
    onClose: vi.fn(),
    ...handlers,
  };
  return { ...render(React.createElement(ProviderManager, props)), props };
}

describe('ProviderManager', () => {
  it('渲染渠道行（id/type/base_url/别名数）、内置标记、当前标记与末尾 CTA', () => {
    const { lastFrame } = renderPanel(three());
    const out = lastFrame() ?? '';
    expect(out).toContain('gw');
    expect(out).toContain('type=openai');
    expect(out).toContain('https://gw.test/v1');
    expect(out).toContain('别名 2 个');
    expect(out).toContain('内置');
    expect(out.match(/← 当前/g)).toHaveLength(1);
    expect(out).toContain('[+ 新增渠道]');
    expect(out).toContain('Enter 切换');
  });

  it('base_url 缺省时显示回落提示', () => {
    const { lastFrame } = renderPanel([row('gw', { baseUrl: undefined })]);
    expect(lastFrame() ?? '').toContain('未配（回落协议默认）');
  });

  it('↓ 移动 + Enter 命中自定义渠道行：onSwitch 带 id 与 builtin=false', async () => {
    const { stdin, props } = renderPanel(three());
    await delay();
    stdin.write(DOWN);
    await delay();
    stdin.write('\r');
    await delay();
    expect(props.onSwitch).toHaveBeenCalledWith('kimi', false);
  });

  it('Enter 命中内置预设行：onSwitch 带 builtin=true', async () => {
    const { stdin, props } = renderPanel(three());
    await delay();
    stdin.write(DOWN);
    stdin.write(DOWN);
    await delay();
    stdin.write('\r');
    await delay();
    expect(props.onSwitch).toHaveBeenCalledWith('stepfun', true);
  });

  it('↓ 到末尾 CTA 行后 Enter 触发 onAdd；A 键同效', async () => {
    const { stdin, props } = renderPanel(three());
    await delay();
    for (let i = 0; i < 5; i++) stdin.write(DOWN); // clamp 停在 CTA 行
    await delay();
    stdin.write('\r');
    await delay();
    expect(props.onAdd).toHaveBeenCalledTimes(1);
    stdin.write('a');
    await delay();
    expect(props.onAdd).toHaveBeenCalledTimes(2);
    expect(props.onSwitch).not.toHaveBeenCalled();
  });

  it('↑ 在顶部 clamp 不循环：按 ↑ 后 Enter 仍命中第一行', async () => {
    const { stdin, props } = renderPanel(three());
    await delay();
    stdin.write(UP);
    await delay();
    stdin.write('\r');
    await delay();
    expect(props.onSwitch).toHaveBeenCalledWith('gw', false);
  });

  it('D 删除自定义渠道：进入 [y/N] 确认子状态，y 触发 onDelete', async () => {
    const { stdin, lastFrame, props } = renderPanel(three());
    await delay();
    stdin.write('d');
    await delay();
    const out = lastFrame() ?? '';
    expect(out).toContain('删除渠道 gw（含 2 个模型别名）？此操作不可恢复 [y/N]');
    expect(out).not.toContain('Enter 切换'); // 确认期间提示语替换 footer
    stdin.write('y');
    await delay();
    expect(props.onDelete).toHaveBeenCalledWith('gw');
  });

  it('删除确认中按 n：退出确认不删除，footer 恢复键位提示', async () => {
    const { stdin, lastFrame, props } = renderPanel(three());
    await delay();
    stdin.write('d');
    await delay();
    stdin.write('n');
    await delay();
    expect(props.onDelete).not.toHaveBeenCalled();
    expect(lastFrame() ?? '').toContain('Enter 切换');
  });

  it('删除确认中按 Esc：先退出确认（不关面板），再按 Esc 才关闭', async () => {
    const { stdin, lastFrame, props } = renderPanel(three());
    await delay();
    stdin.write('d');
    await delay();
    stdin.write(ESC); // 退出确认子状态
    await delay();
    expect(props.onDelete).not.toHaveBeenCalled();
    expect(props.onClose).not.toHaveBeenCalled();
    expect(lastFrame() ?? '').toContain('Enter 切换');
    stdin.write(ESC); // 关闭面板
    await delay();
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('删除确认期间其他按键被忽略（不移动光标、不触发动作）', async () => {
    const { stdin, props } = renderPanel(three());
    await delay();
    stdin.write('d');
    await delay();
    stdin.write(DOWN);
    stdin.write('a');
    stdin.write('\r');
    await delay();
    expect(props.onDelete).not.toHaveBeenCalled();
    expect(props.onAdd).not.toHaveBeenCalled();
    expect(props.onSwitch).not.toHaveBeenCalled();
  });

  it('D 在内置预设行：给不可删提示，不进入确认、不触发 onDelete', async () => {
    const { stdin, lastFrame, props } = renderPanel(three());
    await delay();
    stdin.write(DOWN);
    stdin.write(DOWN); // stepfun 内置行
    await delay();
    stdin.write('d');
    await delay();
    expect(lastFrame() ?? '').toContain('内置预设不可删除');
    expect(props.onDelete).not.toHaveBeenCalled();
  });

  it('D 在 CTA 行：无删除对象，静默忽略', async () => {
    const { stdin, lastFrame, props } = renderPanel(three());
    await delay();
    for (let i = 0; i < 5; i++) stdin.write(DOWN);
    await delay();
    stdin.write('d');
    await delay();
    expect(props.onDelete).not.toHaveBeenCalled();
    expect(lastFrame() ?? '').not.toContain('此操作不可恢复');
  });

  it('Esc 直接关闭面板', async () => {
    const { stdin, props } = renderPanel(three());
    await delay();
    stdin.write(ESC);
    await delay();
    expect(props.onClose).toHaveBeenCalledTimes(1);
  });

  it('行数超一页时显示分页信息，↓ 跨页后 CTA 仍可到达', async () => {
    const many: ProviderManagerRow[] = Array.from({ length: 12 }, (_, i) => row(`ch-${i}`));
    const { stdin, lastFrame, props } = renderPanel(many);
    await delay();
    expect(lastFrame() ?? '').toContain('1-10 / 共 13 个');
    for (let i = 0; i < 12; i++) stdin.write(DOWN); // 到 CTA 行（下标 12）
    await delay();
    expect(lastFrame() ?? '').toContain('11-13 / 共 13 个');
    stdin.write('\r');
    await delay();
    expect(props.onAdd).toHaveBeenCalledTimes(1);
  });
});
