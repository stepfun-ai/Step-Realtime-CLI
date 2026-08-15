import { describe, expect, it } from 'vitest';
import { computeCompletions, matchCommandNames } from '../../src/chat/completions.js';

const baseCtx = {
  models: {
    'gpt-4o': { model: 'gpt-4o', displayName: 'GPT-4o' },
    'step-flash': { model: 'step-3.7-flash' },
  },
  thinkChoices: ['low', 'medium', 'high'],
  files: ['src/chat/history.ts', 'src/chat/prompt.ts', 'src/agent/loop.ts', 'package.json'],
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
    const items = computeCompletions('/mo', baseCtx);
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]!.kind).toBe('command');
    expect(items[0]!.insertText).toBe('/model ');
  });

  it('/model <partial> → 参数补全（别名过滤）', () => {
    const items = computeCompletions('/model g', baseCtx);
    expect(items).toEqual([
      { kind: 'argument', display: 'gpt-4o', insertText: '/model gpt-4o ', description: 'GPT-4o' },
    ]);
  });

  it('/model 空 partial → 全部别名', () => {
    const items = computeCompletions('/model ', baseCtx);
    expect(items.map((i) => i.value ?? i.display)).toContain('gpt-4o');
    expect(items.map((i) => i.display)).toContain('step-flash');
  });

  it('/think <partial> → 档位前缀过滤', () => {
    const items = computeCompletions('/think h', baseCtx);
    expect(items).toEqual([{ kind: 'argument', display: 'high', insertText: '/think high ', description: undefined }]);
  });

  it('/noparam <x>（无参数补全的命令）→ 空', () => {
    expect(computeCompletions('/help x', baseCtx)).toEqual([]);
  });

  it('@<partial> → 文件引用（子串匹配、命中位置优先）', () => {
    const items = computeCompletions('@hist', baseCtx);
    expect(items.length).toBeGreaterThan(0);
    expect(items[0]!.kind).toBe('file');
    expect(items[0]!.insertText).toBe('@src/chat/history.ts ');
  });

  it('@<partial> 无命中 → 空', () => {
    expect(computeCompletions('@zzznomatch', baseCtx)).toEqual([]);
  });

  it('@ 含空格 → 不触发文件补全', () => {
    expect(computeCompletions('@foo bar', baseCtx)).toEqual([]);
  });

  it('无 files 索引 → @ 不补全', () => {
    expect(computeCompletions('@hist', {})).toEqual([]);
  });

  it('普通文本 → 空', () => {
    expect(computeCompletions('hello', baseCtx)).toEqual([]);
  });
});

describe('/goal 参数补全', () => {
  it('/goal 空格后 Tab → 给出全部子命令', () => {
    const items = computeCompletions('/goal ', baseCtx);
    const values = items.map((i) => i.display);
    expect(values).toEqual(['status', 'pause', 'resume', 'cancel']);
    expect(items[0]).toMatchObject({ kind: 'argument' });
  });

  it('/goal p 前缀过滤 → pause', () => {
    const items = computeCompletions('/goal p', baseCtx);
    expect(items).toEqual([{ kind: 'argument', display: 'pause', insertText: '/goal pause ', description: expect.any(String) }]);
  });

  it('/goal ca 前缀过滤 → cancel', () => {
    const items = computeCompletions('/goal ca', baseCtx);
    expect(items).toEqual([{ kind: 'argument', display: 'cancel', insertText: '/goal cancel ', description: expect.any(String) }]);
  });
});

describe('/permission 参数补全', () => {
  it('/permission 空格后 Tab → 给出三个模式', () => {
    const items = computeCompletions('/permission ', baseCtx);
    const values = items.map((i) => i.display);
    expect(values).toEqual(['manual', 'auto', 'yolo']);
  });

  it('/permission a 前缀过滤 → auto', () => {
    const items = computeCompletions('/permission a', baseCtx);
    expect(items.map((i) => i.display)).toEqual(['auto']);
  });

  it('/permission y 前缀过滤 → yolo', () => {
    const items = computeCompletions('/permission y', baseCtx);
    expect(items.map((i) => i.display)).toEqual(['yolo']);
  });
});

describe('/provider 参数补全', () => {
  const ctx = { ...baseCtx, providers: ['stepfun', 'anthropic', 'openai', 'my-custom.channel'] };

  it('/provider 空格后 Tab → 含 add / list 和内置预设', () => {
    const items = computeCompletions('/provider ', ctx);
    const values = items.map((i) => i.display);
    expect(values).toContain('add');
    expect(values).toContain('list');
    expect(values).toContain('stepfun');
    expect(values).toContain('anthropic');
    expect(values).toContain('openai');
    // 自定义渠道含点，也出现在候选
    expect(values).toContain('my-custom.channel');
  });

  it('/provider a 前缀过滤 → add + anthropic（均以 a 开头）', () => {
    const items = computeCompletions('/provider a', ctx);
    expect(items.map((i) => i.display)).toEqual(['add', 'anthropic']);
  });

  it('/provider l 前缀过滤 → list', () => {
    const items = computeCompletions('/provider l', ctx);
    expect(items.map((i) => i.display)).toEqual(['list']);
  });

  it('/provider st 前缀过滤 → stepfun', () => {
    const items = computeCompletions('/provider st', ctx);
    expect(items.map((i) => i.display)).toEqual(['stepfun']);
  });

  it('无 providers 上下文 → 仅静态 add/list', () => {
    const items = computeCompletions('/provider ', baseCtx);
    const values = items.map((i) => i.display);
    expect(values).toEqual(['add', 'list']);
  });
});

describe('/lang 参数补全', () => {
  it('/lang 空格后 Tab → zh / en', () => {
    const items = computeCompletions('/lang ', baseCtx);
    expect(items.map((i) => i.display)).toEqual(['zh', 'en']);
  });

  it('/lang z → zh', () => {
    const items = computeCompletions('/lang z', baseCtx);
    expect(items.map((i) => i.display)).toEqual(['zh']);
  });

  it('/lang e → en', () => {
    const items = computeCompletions('/lang e', baseCtx);
    expect(items.map((i) => i.display)).toEqual(['en']);
  });
});

describe('/mcp 参数补全', () => {
  it('/mcp 空格后 Tab → 给出无需参数提示', () => {
    const items = computeCompletions('/mcp ', baseCtx);
    expect(items.length).toBe(1);
    expect(items[0]).toMatchObject({ kind: 'argument', display: '' });
    expect(items[0]!.description).toBeTruthy();
  });

  it('/mcp 非空 partial → 无候选（不暗示参数）', () => {
    const items = computeCompletions('/mcp foo', baseCtx);
    expect(items).toEqual([]);
  });
});

describe('/plugin 参数补全', () => {
  const ctx = { ...baseCtx, pluginIds: ['my-plugin', 'data-tool'] };

  it('/plugin 空格后 Tab → 含子命令和动态 plugin id', () => {
    const items = computeCompletions('/plugin ', ctx);
    const values = items.map((i) => i.display);
    expect(values).toContain('list');
    expect(values).toContain('install');
    expect(values).toContain('enable');
    expect(values).toContain('disable');
    expect(values).toContain('remove');
    expect(values).toContain('info');
    expect(values).toContain('my-plugin');
    expect(values).toContain('data-tool');
  });

  it('/plugin l 前缀过滤 → list', () => {
    const items = computeCompletions('/plugin l', ctx);
    expect(items.map((i) => i.display)).toEqual(['list']);
  });

  it('/plugin my 前缀过滤 → my-plugin', () => {
    const items = computeCompletions('/plugin my', ctx);
    expect(items.map((i) => i.display)).toEqual(['my-plugin']);
  });

  it('无 pluginIds 上下文 → 仅静态子命令', () => {
    const items = computeCompletions('/plugin ', baseCtx);
    const values = items.map((i) => i.display);
    expect(values).toEqual(['list', 'install', 'enable', 'disable', 'remove', 'info']);
  });
});

describe('/history 参数补全', () => {
  it('/history 空格后 Tab → 给出 N 提示', () => {
    const items = computeCompletions('/history ', baseCtx);
    expect(items.length).toBe(1);
    expect(items[0]).toMatchObject({ kind: 'argument', display: 'N' });
    expect(items[0]!.description).toBeTruthy();
  });

  it('/history 3 前缀 → 仍给 N 提示（数字前缀保留提示）', () => {
    const items = computeCompletions('/history 3', baseCtx);
    expect(items.length).toBe(1);
    expect(items[0]!.display).toBe('N');
  });

  it('/history foo → 无候选（非数字前缀不提示）', () => {
    const items = computeCompletions('/history foo', baseCtx);
    expect(items).toEqual([]);
  });

  it('/undo N 别名也走 history 补全', () => {
    const items = computeCompletions('/undo ', baseCtx);
    expect(items.length).toBe(1);
    expect(items[0]!.display).toBe('N');
  });
});
