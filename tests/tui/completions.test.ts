import { describe, expect, it } from 'vitest';
import { computeCompletions, matchCommandNames } from '../../src/tui/completions.js';

const ctx = {
  models: {
    'gpt-4o': { model: 'gpt-4o', displayName: 'GPT-4o' },
    'step-flash': { model: 'step-3.7-flash' },
  },
  thinkChoices: ['low', 'medium', 'high'],
  files: ['src/tui/App.tsx', 'src/tui/PromptInput.tsx', 'src/agent/loop.ts', 'package.json'],
};

describe('matchCommandNames（命令名匹配，与 matchSlashCommands 同语义）', () => {
  it('前缀命中优先，2 字符子序列回退', () => {
    expect(matchCommandNames('mo').map((c) => c.name)).toContain('model');
    expect(matchCommandNames('cp').map((c) => c.name)).toContain('compact');
  });
  it('跨度约束：/re 不命中 provider（r→e 跨度超限）', () => {
    expect(matchCommandNames('re').map((c) => c.name)).not.toContain('provider');
  });
});

describe('computeCompletions 三类补全', () => {
  it('/ 无空格 → 命令名补全', () => {
    const items = computeCompletions('/mo', ctx);
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]!.kind).toBe('command');
    expect(items[0]!.insertText).toBe('/model ');
  });

  it('/model <partial> → 参数补全（别名过滤）', () => {
    const items = computeCompletions('/model g', ctx);
    expect(items).toEqual([
      { kind: 'argument', display: 'gpt-4o', insertText: '/model gpt-4o ', description: 'GPT-4o' },
    ]);
  });

  it('/model 空 partial → 全部别名', () => {
    const items = computeCompletions('/model ', ctx);
    expect(items.map((i) => i.value ?? i.display)).toContain('gpt-4o');
    expect(items.map((i) => i.display)).toContain('step-flash');
  });

  it('/think <partial> → 档位前缀过滤', () => {
    const items = computeCompletions('/think h', ctx);
    expect(items).toEqual([{ kind: 'argument', display: 'high', insertText: '/think high ', description: undefined }]);
  });

  it('/noparam <x>（无参数补全的命令）→ 空', () => {
    expect(computeCompletions('/help x', ctx)).toEqual([]);
  });

  it('@<partial> → 文件引用（子串匹配、命中位置优先）', () => {
    const items = computeCompletions('@App', ctx);
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]!.kind).toBe('file');
    expect(items[0]!.insertText).toBe('@src/tui/App.tsx ');
  });

  it('@<partial> 无命中 → 空', () => {
    expect(computeCompletions('@zzznomatch', ctx)).toEqual([]);
  });

  it('@ 含空格 → 不触发文件补全', () => {
    expect(computeCompletions('@foo bar', ctx)).toEqual([]);
  });

  it('无 files 索引 → @ 不补全', () => {
    expect(computeCompletions('@App', {})).toEqual([]);
  });

  it('普通文本 → 空', () => {
    expect(computeCompletions('hello', ctx)).toEqual([]);
  });
});
