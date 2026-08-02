import { describe, expect, it } from 'vitest';
import { resolveHooks } from '../src/config/config.js';

describe('resolveHooks', () => {
  it('缺省 / 非数组 → undefined（键不进结果对象）', () => {
    expect(resolveHooks(undefined)).toBeUndefined();
    expect(resolveHooks('not-array')).toBeUndefined();
    expect(resolveHooks(null)).toBeUndefined();
    expect(resolveHooks({ event: 'Stop' })).toBeUndefined();
  });

  it('合法条目：event/matcher/command/timeout 全解析，matcher 编译成 RegExp', () => {
    const out = resolveHooks([
      { event: 'PreToolUse', matcher: '^bash$', command: 'node guard.js', timeout: 10 },
    ]);
    expect(out).toHaveLength(1);
    const entry = out![0]!;
    expect(entry.event).toBe('PreToolUse');
    expect(entry.command).toBe('node guard.js');
    expect(entry.timeout).toBe(10);
    expect(entry.matcher).toBeInstanceOf(RegExp);
    expect(entry.matcher!.test('bash')).toBe(true);
    expect(entry.matcher!.test('write_file')).toBe(false);
  });

  it('matcher 省略 → 键不进条目对象；timeout 省略 → 默认 30', () => {
    const out = resolveHooks([{ event: 'Stop', command: 'node stop.js' }]);
    expect(out).toHaveLength(1);
    expect(out![0]!.timeout).toBe(30);
    expect('matcher' in out![0]!).toBe(false);
  });

  it('五个合法事件名全部接受；非法事件名整条跳过', () => {
    const out = resolveHooks([
      { event: 'PreToolUse', command: 'c' },
      { event: 'PostToolUse', command: 'c' },
      { event: 'UserPromptSubmit', command: 'c' },
      { event: 'Stop', command: 'c' },
      { event: 'SessionStart', command: 'c' },
      { event: 'PreCompact', command: 'c' },
      { event: 'pretooluse', command: 'c' },
      { event: '', command: 'c' },
    ]);
    expect(out!.map((h) => h.event)).toEqual([
      'PreToolUse',
      'PostToolUse',
      'UserPromptSubmit',
      'Stop',
      'SessionStart',
    ]);
  });

  it('matcher 非法正则 → 该条跳过，其余保留', () => {
    const out = resolveHooks([
      { event: 'PreToolUse', matcher: '([', command: 'bad.js' },
      { event: 'PreToolUse', matcher: '^bash$', command: 'good.js' },
    ]);
    expect(out).toHaveLength(1);
    expect(out![0]!.command).toBe('good.js');
  });

  it('timeout clamp 到 [1,600]；非数字 → 默认 30', () => {
    const out = resolveHooks([
      { event: 'Stop', command: 'a', timeout: 0 },
      { event: 'Stop', command: 'b', timeout: -5 },
      { event: 'Stop', command: 'c', timeout: 9999 },
      { event: 'Stop', command: 'd', timeout: '30' },
    ]);
    expect(out!.map((h) => h.timeout)).toEqual([1, 1, 600, 30]);
  });

  it('command 缺失/为空/非字符串 → 该条跳过；非对象元素跳过', () => {
    const out = resolveHooks([
      'junk',
      null,
      { event: 'Stop' },
      { event: 'Stop', command: '' },
      { event: 'Stop', command: 42 },
      { event: 'Stop', command: 'ok.js' },
    ]);
    expect(out).toHaveLength(1);
    expect(out![0]!.command).toBe('ok.js');
  });

  it('全部非法 → undefined（键不进结果对象）', () => {
    expect(resolveHooks([])).toBeUndefined();
    expect(resolveHooks([{ event: 'Nope', command: 'c' }])).toBeUndefined();
    expect(resolveHooks([{ event: 'Stop' }])).toBeUndefined();
  });
});
