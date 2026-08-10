import { homedir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it } from 'vitest';
import { StatusBar, shortenPath } from '../../src/tui/StatusBar.js';

const BRAILLE = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/** 去掉 ANSI 颜色码，便于对纯文本内容断言。 */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/** lastFrame 去掉尾部空行后的文本行数组。 */
function frameLines(frame: string): string[] {
  return stripAnsi(frame).replace(/\n+$/, '').split('\n');
}

describe('StatusBar 忙碌态', () => {
  const base = {
    mode: 'manual' as const,
    model: 'test-model',
    cwd: '/tmp/work',
    usedTokens: 100,
    maxContextSize: 1000,
    hints: 'Ctrl+O 展开工具输出 · Esc 中断',
  };

  it('busy=true 显示 busy 且不含任何 braille 转圈帧', () => {
    const { lastFrame } = render(React.createElement(StatusBar, { ...base, busy: true }));
    const out = lastFrame() ?? '';
    expect(out).toContain('busy');
    expect(out).not.toContain('thinking');
    for (const f of BRAILLE) expect(out).not.toContain(f);
  });

  it('busy=false 显示 ready', () => {
    const { lastFrame } = render(React.createElement(StatusBar, { ...base, busy: false }));
    const out = lastFrame() ?? '';
    expect(out).toContain('ready');
    for (const f of BRAILLE) expect(out).not.toContain(f);
  });
});

describe('StatusBar 两行结构', () => {
  const base = {
    mode: 'manual' as const,
    model: 'test-model',
    cwd: '/tmp/work',
    usedTokens: 100,
    maxContextSize: 1000,
    busy: false,
    hints: 'Ctrl+O 展开工具输出 · Esc 中断',
  };

  it('输出恰好两行：第一行 模式/模型/状态/路径，第二行 hints + context', () => {
    const { lastFrame } = render(React.createElement(StatusBar, base));
    const lines = frameLines(lastFrame() ?? '');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('manual');
    expect(lines[0]).toContain('test-model');
    expect(lines[0]).toContain('ready');
    expect(lines[0]).toContain('/tmp/work');
    expect(lines[1]).toContain('Ctrl+O 展开工具输出');
    expect(lines[1]).toContain('context: 10% (100/1k)');
  });

  it('hints 与 context 同在第二行，context 右对齐锚定行尾', () => {
    const { lastFrame } = render(React.createElement(StatusBar, base));
    const line2 = frameLines(lastFrame() ?? '')[1] ?? '';
    const hintsIdx = line2.indexOf('Ctrl+O');
    const ctxIdx = line2.indexOf('context:');
    expect(hintsIdx).toBeGreaterThanOrEqual(0);
    expect(ctxIdx).toBeGreaterThan(hintsIdx);
    // context 贴右：去掉行尾空格后行末即 context 文本
    expect(line2.trimEnd().endsWith('context: 10% (100/1k)')).toBe(true);
  });
});

describe('shortenPath', () => {
  it('home 目录前缀替换为 ~', () => {
    expect(shortenPath(join(homedir(), 'sub', 'dir'))).toMatch(/^~/);
    expect(shortenPath(homedir())).toBe('~');
  });

  it('长 Windows 路径保留尾部 3 段并加 …/ 前缀', () => {
    expect(shortenPath('C:\\Users\\foo\\projects\\very\\deep\\work')).toBe('…/very/deep/work');
  });

  it('短路径原样返回', () => {
    expect(shortenPath('/tmp/work')).toBe('/tmp/work');
  });

  it('段数不超过 3 但总长超限，按字符数兜底保留尾部', () => {
    const p = `/tmp/${'x'.repeat(60)}`;
    const out = shortenPath(p);
    expect(out.startsWith('…')).toBe(true);
    expect(out.length).toBe(48);
  });
});

describe('StatusBar 窄终端防换行', () => {
  // 纯 ASCII 文案，字符数即显示宽度
  const base = {
    mode: 'manual' as const,
    model: 'test-model',
    cwd: 'C:\\Users\\foo\\projects\\very\\deep\\work',
    usedTokens: 100,
    maxContextSize: 1000,
    busy: false,
    hints: 'Ctrl+O expand · Alt+V paste · Esc interrupt · /help commands',
  };

  it('columns=40 时两行各自单行、每行宽度不超过终端宽度', () => {
    const inst = render(React.createElement(StatusBar, base));
    // ink-testing-library 的 stdout.columns 是 getter，改写后 rerender 触发布局重算
    Object.defineProperty(inst.stdout, 'columns', { get: () => 40 });
    inst.rerender(React.createElement(StatusBar, base));
    const lines = frameLines(inst.lastFrame() ?? '');
    expect(lines).toHaveLength(2);
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(40);
    }
    // context 永不截断且始终贴右
    const line2 = lines[1] ?? '';
    expect(line2.trimEnd().endsWith('context: 10% (100/1k)')).toBe(true);
    // 第一行无词中断行：模式/模型/状态完整保留
    expect(lines[0]).toContain('manual');
    expect(lines[0]).toContain('test-model');
    expect(lines[0]).toContain('ready');
  });
});
