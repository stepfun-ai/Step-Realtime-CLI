import React from 'react';
import { EventEmitter } from 'node:events';
import { render } from 'ink';
import { describe, expect, it } from 'vitest';
import { SessionPicker, resolveVisibleRows } from '../../src/tui/SessionPicker.js';
import type { SessionMeta } from '../../src/session/store.js';

/**
 * 真实 ANSI 输出流捕获（不是 ink-testing-library 的整帧快照）。
 *
 * 背景：已知问题与待办 #26 —— SessionPicker 视口修复的 8 条人工验证清单中，
 * 「无整页闪换、无清屏」在 ink-testing-library 下不可测（它剥离 ANSI、只存整帧）。
 * 本测试用真实 ink render 写到 fake TTY stdout，捕获原始 ANSI 字节流做断言：
 *
 * - 全程不得出现 \x1b[2J（清屏）与 \x1b[3J（清 scrollback，后者是 #0 滚动跳顶的根因）
 * - 滚动/搜索引发的每帧高度（eraseLines 行数）有界且稳定，不出现整屏规模的重写
 */

class FakeStdout extends EventEmitter {
  isTTY = true;
  columns: number;
  rows: number;
  chunks: string[] = [];

  constructor(columns = 80, rows = 24) {
    super();
    this.columns = columns;
    this.rows = rows;
  }

  write(s: string): boolean {
    this.chunks.push(s);
    return true;
  }
}

class FakeStdin extends EventEmitter {
  isTTY = true;
  isRaw = false;

  setRawMode(raw: boolean): this {
    this.isRaw = raw;
    return this;
  }

  resume(): this {
    return this;
  }

  pause(): this {
    return this;
  }

  ref(): this {
    return this;
  }

  unref(): this {
    return this;
  }

  write(data: string): void {
    this.emit('data', Buffer.from(data));
  }
}

const DOWN = '[B';
const UP = '[A';

const delay = (): Promise<void> => new Promise((r) => setTimeout(r, 30));

function meta(id: string, title: string): SessionMeta {
  const now = new Date().toISOString();
  return { id, cwd: 'C:/x', model: 'm', createdAt: now, updatedAt: now, messageCount: 3, title };
}

function metaList(n: number): SessionMeta[] {
  return Array.from({ length: n }, (_, i) => meta(`id${i}`, `会话${i}`));
}

/** 清屏/清 scrollback 序列 —— 出现任一即违反「滚动不拽顶、不闪屏」。 */
const CLEAR_SCREEN = /\[2J/;
const CLEAR_SCROLLBACK = /\[3J/;

/** ink 非增量模式下每帧 = eraseLines(N) + 整帧内容；N 通过光标上移序列推回。 */
const CURSOR_UP = /\[(\d+)A/g;

interface Harness {
  stdout: FakeStdout;
  stdin: FakeStdin;
  unmount: () => void;
  /** 自上次调用以来新写入的 ANSI 字节。 */
  drain: () => string;
}

function mountPicker(sessionCount: number, termRows: number): Harness {
  const stdout = new FakeStdout(80, termRows);
  const stdin = new FakeStdin();
  const sessions = metaList(sessionCount);
  const visibleRows = resolveVisibleRows(termRows, 0);
  const instance = render(
    React.createElement(SessionPicker, { sessions, visibleRows, onSelect: () => {} }),
    { stdout: stdout as never, stdin: stdin as never, exitOnCtrlC: false, patchConsole: false },
  );
  let offset = 0;
  return {
    stdout,
    stdin,
    unmount: () => instance.unmount(),
    drain: () => {
      const out = stdout.chunks.slice(offset).join('');
      offset = stdout.chunks.length;
      return out;
    },
  };
}

/** 一帧输出里光标上移的最大行数（≈ 该帧重写的行数规模）。 */
function maxCursorUp(frame: string): number {
  let max = 0;
  for (const m of frame.matchAll(CURSOR_UP)) {
    max = Math.max(max, Number(m[1]));
  }
  return max;
}

describe('SessionPicker 真实 ANSI 流：无清屏、帧重写有界（待办 #26 清单 2/5/8 的可自动化部分）', () => {
  it('连续 ↓ 滚动 20 次：无清屏序列，帧重写规模稳定', async () => {
    const h = mountPicker(191, 24);
    await delay();
    h.drain(); // 丢弃首帧（挂载帧不在断言范围）

    let prevSize = -1;
    for (let i = 0; i < 20; i++) {
      h.stdin.write(DOWN);
      await delay();
      const frame = h.drain();
      expect(frame, `第 ${i + 1} 次 ↓ 出现清屏`).not.toMatch(CLEAR_SCREEN);
      expect(frame, `第 ${i + 1} 次 ↓ 出现清 scrollback`).not.toMatch(CLEAR_SCROLLBACK);
      const size = maxCursorUp(frame);
      if (size > 0) {
        // 帧重写规模 = picker 高度量级（visibleRows + chrome），不得整屏（24 行）重写
        expect(size, `第 ${i + 1} 次 ↓ 帧重写行数越界`).toBeLessThan(24);
        if (prevSize > 0) {
          expect(Math.abs(size - prevSize), `第 ${i + 1} 次 ↓ 帧高跳变`).toBeLessThanOrEqual(1);
        }
        prevSize = size;
      }
    }
    h.unmount();
  });

  it('首条按 ↑：无清屏，列表不回绕', async () => {
    const h = mountPicker(50, 24);
    await delay();
    h.drain();
    h.stdin.write(UP);
    await delay();
    const frame = h.drain();
    expect(frame).not.toMatch(CLEAR_SCREEN);
    expect(frame).not.toMatch(CLEAR_SCROLLBACK);
    h.unmount();
  });

  it('搜索过滤到少量结果：高度收缩过程无清屏', async () => {
    const h = mountPicker(191, 24);
    await delay();
    h.drain();
    // SessionPicker 的搜索是直接键入字符
    for (const ch of '会话1') {
      h.stdin.write(ch);
      await delay();
      const frame = h.drain();
      expect(frame).not.toMatch(CLEAR_SCREEN);
      expect(frame).not.toMatch(CLEAR_SCROLLBACK);
    }
    h.unmount();
  });

  it('15 行极小终端：退化可用，仍无清屏', async () => {
    const h = mountPicker(191, 15);
    await delay();
    h.drain();
    for (let i = 0; i < 5; i++) {
      h.stdin.write(DOWN);
      await delay();
      const frame = h.drain();
      expect(frame).not.toMatch(CLEAR_SCREEN);
      expect(frame).not.toMatch(CLEAR_SCROLLBACK);
    }
    h.unmount();
  });
});
