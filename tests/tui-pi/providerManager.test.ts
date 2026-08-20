/**
 * `/provider` 渠道管理：列表项构造。
 *
 * 弹层交互（删除确认、向导多步问答）依赖真实 TUI 与文件写入，不在单测覆盖范围；
 * 这里测的是列表怎么组织——它决定用户看到什么、能对什么按 d。
 */
import { describe, expect, it } from 'vitest';
import { providerItems } from '../../src/tui-pi/ProviderManager.js';
import { PROVIDER_PRESETS, type StepCodeConfig } from '../../src/config/config.js';

const config = {
  provider: 'mine',
  providers: {
    mine: { type: 'openai', baseUrl: 'https://api.example.com/v1' },
    other: { type: 'anthropic' },
  },
  models: {
    a1: { model: 'm1', provider: 'mine' },
    a2: { model: 'm2', provider: 'mine' },
    b1: { model: 'm3', provider: 'other' },
  },
} as unknown as StepCodeConfig;

describe('providerItems', () => {
  const items = providerItems(config);

  it('自定义渠道在前，带协议/地址/别名数', () => {
    expect(items[0]!.value).toBe('custom:mine');
    expect(items[0]!.label).toContain('●'); // 当前生效渠道标点
    expect(items[0]!.description).toBe('openai · https://api.example.com/v1 · 2 个别名');
    expect(items[1]!.description).toContain('默认地址');
    expect(items[1]!.description).toContain('1 个别名');
  });

  it('内置预设列在后面并标不可删（避免对着预设按 d）', () => {
    const presets = items.filter((i) => i.value.startsWith('preset:'));
    expect(presets.length).toBe(Object.keys(PROVIDER_PRESETS).length);
    for (const p of presets) expect(p.description).toContain('不可删除');
  });

  it('末项是新增入口', () => {
    expect(items[items.length - 1]!.value).toBe('__add__');
    expect(items[items.length - 1]!.label).toContain('新增渠道');
  });

  it('无自定义渠道时只有预设与新增入口', () => {
    const bare = providerItems({} as StepCodeConfig);
    expect(bare.some((i) => i.value.startsWith('custom:'))).toBe(false);
    expect(bare[bare.length - 1]!.value).toBe('__add__');
  });
});
