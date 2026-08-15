import { describe, expect, it } from 'vitest';
import {
  NO_TERMINAL_TITLE_ENV,
  buildTitleSequence,
  canSetTerminalTitle,
  sanitizeTitleText,
  TerminalTitleWriter,
  withTitlePrefix,
} from '../../src/chat/terminalTitle.js';

const empty: Record<string, string | undefined> = {};

describe('canSetTerminalTitle', () => {
  it('TTY 且 TERM 正常时允许', () => {
    expect(canSetTerminalTitle({ TERM: 'xterm-256color' }, true)).toBe(true);
  });

  it('非 TTY（管道/重定向）时禁止，避免序列当正文打印', () => {
    expect(canSetTerminalTitle({ TERM: 'xterm-256color' }, false)).toBe(false);
    expect(canSetTerminalTitle({ TERM: 'xterm-256color' }, undefined)).toBe(false);
  });

  it('逃生舱环境变量优先级最高', () => {
    expect(canSetTerminalTitle({ [NO_TERMINAL_TITLE_ENV]: '1', TERM: 'xterm-256color' }, true)).toBe(false);
  });

  it('dumb 终端禁止', () => {
    expect(canSetTerminalTitle({ TERM: 'dumb' }, true)).toBe(false);
    expect(canSetTerminalTitle({ TERM: 'unknown' }, true)).toBe(false);
  });

  it('CI 环境禁止（日志里出现转义序列纯属噪声）', () => {
    expect(canSetTerminalTitle({ TERM: 'xterm', CI: 'true' }, true)).toBe(false);
    expect(canSetTerminalTitle({ TERM: 'xterm', GITHUB_ACTIONS: 'true' }, true)).toBe(false);
  });
});

describe('sanitizeTitleText', () => {
  it('删 ESC 与 BEL（注入/提前终止）', () => {
    const out = sanitizeTitleText('a\x1b]0;evil\x07b');
    expect(out).not.toContain('\x1b');
    expect(out).not.toContain('\x07');
    expect(out).toContain('a');
    expect(out).toContain('b');
  });

  it('分号换成全角冒号（OSC 参数分隔符）', () => {
    expect(sanitizeTitleText('a;b;c')).toBe('a：b：c');
  });

  it('换行与多空格折叠成单空格', () => {
    expect(sanitizeTitleText('line1\n  line2\r\n\tline3')).toBe('line1 line2 line3');
  });

  it('中文按显示宽度截断并加省略号', () => {
    // 每个中文宽 2，上限 60 宽 → 30 个汉字 + …
    const out = sanitizeTitleText('查'.repeat(50));
    expect(out).toHaveLength(31); // 30 个「查」+ 1 个省略号
    expect(out.endsWith('…')).toBe(true);
  });
});

describe('buildTitleSequence', () => {
  it('普通环境发 OSC 0 + BEL', () => {
    expect(buildTitleSequence(withTitlePrefix('hello'), empty)).toBe('\x1b]0;step · hello\x07');
  });

  it('空标题是清空语义（不加前缀）', () => {
    expect(buildTitleSequence('', empty)).toBe('\x1b]0;\x07');
  });

  it('tmux 内走 DCS passthrough 且内部 ESC 双写', () => {
    const seq = buildTitleSequence(withTitlePrefix('t'), { TMUX: '/tmp/tmux-1000/default' });
    expect(seq).toBe('\x1bPtmux;\x1b\x1b]0;step · t\x07\x1b\\');
  });

  it('screen（TERM=screen-256color）同样走 DCS passthrough', () => {
    const seq = buildTitleSequence(withTitlePrefix('t'), { TERM: 'screen-256color' });
    expect(seq.startsWith('\x1bPtmux;')).toBe(true);
  });
});

describe('withTitlePrefix', () => {
  it('非空标题加统一前缀', () => {
    expect(withTitlePrefix('任务')).toBe('step · 任务');
  });
  it('空标题不加前缀（清空语义）', () => {
    expect(withTitlePrefix('')).toBe('');
  });
});

describe('TerminalTitleWriter', () => {
  it('未启用时 set/reset 都是零输出空操作', () => {
    const written: string[] = [];
    const w = new TerminalTitleWriter({ TERM: 'dumb' }, true, true, (s) => written.push(s));
    w.set('任务');
    w.reset();
    expect(written).toEqual([]);
  });

  it('config 关闭时即使 TTY 正常也不写', () => {
    const written: string[] = [];
    const w = new TerminalTitleWriter({ TERM: 'xterm-256color' }, true, false, (s) => written.push(s));
    w.set('任务');
    expect(written).toEqual([]);
  });

  it('启用时 set 写序列、reset 写清空序列', () => {
    const written: string[] = [];
    const w = new TerminalTitleWriter({ TERM: 'xterm-256color' }, true, true, (s) => written.push(s));
    w.set('查看存储占用');
    w.reset();
    expect(written).toEqual(['\x1b]0;step · 查看存储占用\x07', '\x1b]0;\x07']);
  });
});
