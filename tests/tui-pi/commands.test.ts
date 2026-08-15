/**
 * M4 命令层的测试：注册表分流 + 纯文本生成。
 *
 * 分两块：
 * 1. `busyRoute`/`parseSlash` 是从 Ink 版共用的纯逻辑，这里只测 pi 版依赖的那几条
 *    语义（别名解析、未知命令、双态命令的 busy 分流），因为 PiChat 的分流正确性
 *    完全建立在它们之上。
 * 2. `commandText.ts` 的文本生成。
 */
import { describe, expect, it } from 'vitest';
import { busyRoute, parseSlash } from '../../src/chat/commands.js';
import { formatTaskList, notWiredText, NOT_WIRED } from '../../src/tui-pi/commandText.js';
import type { BackgroundTask } from '../../src/agent/background/manager.js';

describe('parseSlash（pi 版分发依赖的语义）', () => {
  it('别名解析到主名', () => {
    expect(parseSlash('/q')).toEqual({ name: 'exit', args: '' });
    expect(parseSlash('/quit')).toEqual({ name: 'exit', args: '' });
    expect(parseSlash('/sessions')).toEqual({ name: 'resume', args: '' });
    expect(parseSlash('/?')).toEqual({ name: 'help', args: '' });
    expect(parseSlash('/cron')).toEqual({ name: 'loop', args: '' });
  });

  it('参数保留原样（trim 后），命令名大小写不敏感', () => {
    expect(parseSlash('/MODEL  step35 ')).toEqual({ name: 'model', args: 'step35' });
    expect(parseSlash('/restore src/a b.ts')).toEqual({ name: 'restore', args: 'src/a b.ts' });
  });

  it('未知命令给空 name（调用方据此提示打错了，而不是当消息发出去）', () => {
    expect(parseSlash('/nosuch')).toEqual({ name: '', args: '' });
  });

  it('非斜杠输入返回 null', () => {
    expect(parseSlash('hello')).toBeNull();
    expect(parseSlash('  /help')).toEqual({ name: 'help', args: '' });
  });
});

describe('busyRoute（回合进行中的命令分流）', () => {
  it('只读命令即时执行', () => {
    expect(busyRoute('help', '')).toBe('instant');
    expect(busyRoute('usage', '')).toBe('instant');
    expect(busyRoute('tasks', '')).toBe('instant');
    expect(busyRoute('mcp', '')).toBe('instant');
  });

  it('改动 turn 前提的命令排队', () => {
    expect(busyRoute('new', '')).toBe('queue');
    expect(busyRoute('compact', '')).toBe('queue');
    expect(busyRoute('fork', '')).toBe('queue');
    expect(busyRoute('yolo', '')).toBe('queue');
    expect(busyRoute('plan', '')).toBe('queue');
  });

  it('双态命令：无参只读即时，带参变更排队', () => {
    expect(busyRoute('model', '')).toBe('instant');
    expect(busyRoute('model', 'step35')).toBe('queue');
    expect(busyRoute('think', '')).toBe('instant');
    expect(busyRoute('think', 'high')).toBe('queue');
    expect(busyRoute('resume', '')).toBe('instant');
    expect(busyRoute('resume', '20260814-abc')).toBe('queue');
    // compact-model：无参查询压缩绑定（只读）→ 即时；带参/reset 改绑定 → 排队
    expect(busyRoute('compact-model', '')).toBe('instant');
    expect(busyRoute('compact-model', 'song')).toBe('queue');
    expect(busyRoute('compact-model', 'reset')).toBe('queue');
  });

  it('未知命令即时（立即提示，不用等回合结束）', () => {
    expect(busyRoute('', '')).toBe('instant');
  });
});

describe('formatTaskList', () => {
  const base: BackgroundTask = {
    id: 'bg_1',
    command: 'pnpm test',
    status: 'running',
    startedAt: '2026-08-14T12:00:00Z',
    output: '',
  };
  const now = Date.parse('2026-08-14T12:01:40Z');

  it('空列表给一句话，不给空表头', () => {
    expect(formatTaskList([], now)).toBe('当前没有后台任务');
  });

  it('running 排在终态之前，带已用时', () => {
    const tasks: BackgroundTask[] = [
      { ...base, id: 'done1', status: 'completed', endedAt: '2026-08-14T12:00:30Z' },
      { ...base, id: 'run1', status: 'running' },
    ];
    const text = formatTaskList(tasks, now);
    expect(text.indexOf('run1')).toBeLessThan(text.indexOf('done1'));
    expect(text).toContain('1m 40s'); // running 算到 now
    expect(text).toContain('30s'); // completed 算到 endedAt
  });

  it('failed 带退出码，subagent 标类别，超长命令截断', () => {
    const tasks: BackgroundTask[] = [
      { ...base, id: 'f1', status: 'failed', exitCode: 2, endedAt: '2026-08-14T12:00:05Z' },
      { ...base, id: 's1', kind: 'subagent', command: 'x'.repeat(80) },
    ];
    const text = formatTaskList(tasks, now);
    expect(text).toContain('exit 2');
    expect(text).toContain('· subagent');
    expect(text).toContain('x'.repeat(57) + '...');
    expect(text).not.toContain('x'.repeat(61));
  });
});

describe('NOT_WIRED', () => {
  it('未接线提示指明去 Ink 版执行，且与「未知命令」文案可区分', () => {
    expect(notWiredText('somecmd')).toContain('/somecmd');
    expect(notWiredText('somecmd')).toContain('尚未接线');
  });

  it('M4c 之后注册表里的命令全部接线，未接线清单为空', () => {
    expect([...NOT_WIRED]).toEqual([]);
  });

  it('已实现的命令不在未接线清单里', () => {
    for (const done of [
      'help',
      'model',
      'think',
      'resume',
      'new',
      'fork',
      'compact',
      'usage',
      'tasks',
      'memory',
      'restore',
      'lang',
      'mcp',
      'permission',
      'yolo',
      'auto',
      'plan',
      'exit',
      'export-debug-zip',
      'goal',
      'team',
      'loop',
      'skill',
      'agents',
      'reflect',
      'plugin',
      'provider',
      'reload',
      'history',
    ]) {
      expect(NOT_WIRED.has(done), done).toBe(false);
    }
  });
});
