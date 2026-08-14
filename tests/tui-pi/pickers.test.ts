/**
 * 选择器（M3）的候选项构造与交互测试。
 *
 * 列表交互本身（↑↓/过滤/滚动跟随）是 pi-tui SelectList 的职责，不重复测；
 * 这里测的是我们自己的部分：候选项怎么组织、过滤串怎么收、Esc/Enter 怎么结算。
 */
import { describe, expect, it } from 'vitest';
import { PickerOverlay, modelItems, relativeTime, sessionItems, thinkItems } from '../../src/tui-pi/pickers.js';
import type { SessionMeta } from '../../src/session/store.js';
import type { StepCodeConfig } from '../../src/config/config.js';

function plain(lines: readonly string[]): string[] {
  // eslint-disable-next-line no-control-regex
  return lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ''));
}

const ESC = '\x1b';
const ENTER = '\r';
const DOWN = '\x1b[B';

describe('relativeTime', () => {
  const now = Date.parse('2026-08-14T12:00:00Z');
  it('按秒/分/小时/天分档，超过 30 天给日期', () => {
    expect(relativeTime('2026-08-14T11:59:30Z', now)).toBe('30 秒前');
    expect(relativeTime('2026-08-14T11:30:00Z', now)).toBe('30 分钟前');
    expect(relativeTime('2026-08-14T09:00:00Z', now)).toBe('3 小时前');
    expect(relativeTime('2026-08-10T12:00:00Z', now)).toBe('4 天前');
    expect(relativeTime('2026-01-01T12:00:00Z', now)).toBe('2026-01-01');
    expect(relativeTime('不是时间', now)).toBe('');
  });
});

describe('sessionItems', () => {
  const now = Date.parse('2026-08-14T12:00:00Z');
  const metas: SessionMeta[] = [
    {
      id: 'abcdef1234',
      cwd: '/x',
      model: 'm',
      createdAt: '2026-08-14T10:00:00Z',
      updatedAt: '2026-08-14T11:00:00Z',
      messageCount: 12,
      title: '从标题来的',
    },
    {
      id: 'zzz',
      cwd: '/x',
      model: 'm',
      createdAt: '2026-08-14T10:00:00Z',
      updatedAt: '2026-08-14T11:00:00Z',
      messageCount: 3,
      name: '我改的名字',
      title: '标题',
    },
  ];

  it('展示口径是 name ?? title，描述带相对时间与消息数', () => {
    const items = sessionItems(metas, now);
    expect(items[0]!.label).toBe('从标题来的');
    expect(items[1]!.label).toBe('我改的名字');
    expect(items[0]!.description).toContain('1 小时前');
    expect(items[0]!.description).toContain('12 条');
    expect(items[0]!.description).toContain('abcdef12');
  });
});

describe('modelItems', () => {
  const config = {
    provider: 'stepfun',
    providers: { stepfun: { type: 'openai' }, kimi: { type: 'anthropic' } },
    models: {
      step35: { model: 'step-3.5-flash', provider: 'stepfun', maxContextSize: 262000, displayName: 'Step 3.5' },
      k3: { model: 'k3', provider: 'kimi', maxContextSize: 400000 },
    },
  } as unknown as StepCodeConfig;

  it('按渠道分组，描述带渠道与真实 id 与窗口，当前别名标点', () => {
    const items = modelItems(config, 'k3');
    // kimi 渠道排在 stepfun 之前（字典序）
    expect(items[0]!.value).toBe('k3');
    expect(items[0]!.label).toContain('●');
    expect(items[0]!.description).toBe('kimi · k3 · 400k');
    expect(items[1]!.label).toBe('Step 3.5');
    expect(items[1]!.description).toBe('stepfun · step-3.5-flash · 262k');
  });

  it('没有别名时返回空列表（调用方据此提示直切）', () => {
    expect(modelItems({} as StepCodeConfig)).toEqual([]);
  });
});

describe('thinkItems', () => {
  it('四档 + 跟随默认，当前项标点', () => {
    const items = thinkItems('high');
    expect(items.map((i) => i.value)).toEqual(['high', 'medium', 'low', 'off', '__default__']);
    expect(items[0]!.label).toContain('●');
    const none = thinkItems(undefined);
    expect(none[4]!.label).toContain('●');
  });
});

describe('PickerOverlay', () => {
  function mk(): { overlay: PickerOverlay; picked: string[]; cancelled: number[] } {
    const picked: string[] = [];
    const cancelled: number[] = [];
    const overlay = new PickerOverlay({
      title: '选择模型',
      items: [
        { value: 'alpha', label: 'alpha', description: 'A' },
        { value: 'beta', label: 'beta', description: 'B' },
        { value: 'gamma', label: 'gamma', description: 'C' },
      ],
      requestRender: () => {},
      onSelect: (item) => picked.push(item.value),
      onCancel: () => cancelled.push(1),
    });
    return { overlay, picked, cancelled };
  }

  it('标题与提示行在列表上下，Enter 选中当前项', () => {
    const { overlay, picked } = mk();
    const lines = plain(overlay.render(60));
    expect(lines[0]).toContain('选择模型');
    expect(lines.join('\n')).toContain('alpha');
    expect(lines[lines.length - 1]).toContain('Enter 确认');
    overlay.handleInput(ENTER);
    expect(picked).toEqual(['alpha']);
  });

  it('↓ 移动后 Enter 选中第二项', () => {
    const { overlay, picked } = mk();
    overlay.handleInput(DOWN);
    overlay.handleInput(ENTER);
    expect(picked).toEqual(['beta']);
  });

  it('可打印字符进过滤串并显示在标题行，退格删字', () => {
    const { overlay, picked } = mk();
    overlay.handleInput('g');
    expect(plain(overlay.render(60))[0]).toContain('过滤：g');
    overlay.handleInput(ENTER);
    expect(picked).toEqual(['gamma']);

    const second = mk();
    second.overlay.handleInput('g');
    second.overlay.handleInput('\x7f');
    expect(plain(second.overlay.render(60))[0]).not.toContain('过滤');
    second.overlay.handleInput(ENTER);
    expect(second.picked).toEqual(['alpha']);
  });

  it('Esc 取消', () => {
    const { overlay, cancelled } = mk();
    overlay.handleInput(ESC);
    expect(cancelled).toEqual([1]);
  });
});
