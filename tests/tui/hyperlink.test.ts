import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { link, supportsHyperlinks } from '../../src/tui/hyperlink.js';

describe('supportsHyperlinks', () => {
  const origEnv = process.env;

  beforeEach(() => {
    process.env = { ...origEnv };
  });

  afterEach(() => {
    process.env = origEnv;
  });

  it('Windows Terminal 支持', () => {
    process.env['TERM_PROGRAM'] = 'Windows Terminal';
    expect(supportsHyperlinks()).toBe(true);
  });

  it('WezTerm 支持', () => {
    process.env['TERM_PROGRAM'] = 'WezTerm';
    expect(supportsHyperlinks()).toBe(true);
  });

  it('iTerm2 支持', () => {
    process.env['TERM_PROGRAM'] = 'iTerm.app';
    expect(supportsHyperlinks()).toBe(true);
  });

  it('VSCode 终端支持', () => {
    process.env['TERM_PROGRAM'] = 'vscode';
    expect(supportsHyperlinks()).toBe(true);
  });

  it('kitty 支持', () => {
    process.env['TERM_PROGRAM'] = 'kitty';
    expect(supportsHyperlinks()).toBe(true);
  });

  it('foot 支持', () => {
    process.env['TERM_PROGRAM'] = 'foot';
    expect(supportsHyperlinks()).toBe(true);
  });

  it('未知 TERM_PROGRAM 且 COLORTERM 为 truecolor 时支持', () => {
    process.env['COLORTERM'] = 'truecolor';
    expect(supportsHyperlinks()).toBe(true);
  });

  it('未知 TERM_PROGRAM 且 COLORTERM 为 24bit 时支持', () => {
    process.env['COLORTERM'] = '24bit';
    expect(supportsHyperlinks()).toBe(true);
  });

  it('保守模式：未知终端且无 COLORTERM 时不支持', () => {
    delete process.env['TERM_PROGRAM'];
    delete process.env['COLORTERM'];
    expect(supportsHyperlinks()).toBe(false);
  });

  it('COLORTERM 其他值不支持', () => {
    process.env['COLORTERM'] = 'foo';
    expect(supportsHyperlinks()).toBe(false);
  });
});

describe('link', () => {
  it('生成正确的 OSC 8 序列', () => {
    const result = link('text', 'https://example.com');
    expect(result).toBe('\x1b]8;;https://example.com\x07text\x1b]8;;\x07');
  });

  it('空文本也生成合法序列', () => {
    expect(link('', 'https://x.com')).toBe('\x1b]8;;https://x.com\x07\x1b]8;;\x07');
  });

  it('URL 含特殊字符时原样嵌入', () => {
    const url = 'https://example.com/path?a=1&b=2#frag';
    expect(link('go', url)).toBe(`\x1b]8;;${url}\x07go\x1b]8;;\x07`);
  });
});

describe('link width neutrality', () => {
  it('OSC 8 序列不计入显示宽度（link 返回的字符串 displayWidth 等于纯文本）', () => {
    const text = 'hello';
    const url = 'https://example.com';
    const seq = link(text, url);
    // 用正则剥离转义序列后的纯文本宽度应与原始文本一致
    const stripped = seq.replace(/\x1b\]8;;.*?\x07/g, '').replace(/\x1b\]8;;\x07/g, '');
    // 简易宽度：ASCII 字符数
    expect(stripped.length).toBe(text.length);
  });
});
