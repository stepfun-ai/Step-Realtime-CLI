import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  InputHistoryStore,
  navigateHistory,
  initialNavState,
  MAX_ENTRIES,
} from '../../src/session/inputHistory.js';
import { workdirKey } from '../../src/session/store.js';

describe('InputHistoryStore', () => {
  let baseDir: string;
  const cwd = '/some/project';

  beforeEach(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'sc-hist-'));
  });
  afterEach(() => {
    rmSync(baseDir, { recursive: true, force: true });
  });

  it('record：trim、丢空、相邻去重', () => {
    const s = new InputHistoryStore(cwd, baseDir);
    expect(s.record('  hello  ')).toBe(true);
    expect(s.entries).toEqual(['hello']);
    expect(s.record('')).toBe(false);
    expect(s.record('   ')).toBe(false);
    expect(s.record('hello')).toBe(false);
    expect(s.record('world')).toBe(true);
    expect(s.record('hello')).toBe(true);
    expect(s.entries).toEqual(['hello', 'world', 'hello']);
  });

  it('落盘后新实例能载入（跨会话持久化）', () => {
    const s1 = new InputHistoryStore(cwd, baseDir);
    s1.record('a');
    s1.record('b');
    const s2 = new InputHistoryStore(cwd, baseDir);
    expect(s2.load()).toEqual(['a', 'b']);
  });

  it('按 cwd 隔离：不同工作目录互不可见', () => {
    const s1 = new InputHistoryStore('/proj/one', baseDir);
    s1.record('one-cmd');
    const s2 = new InputHistoryStore('/proj/two', baseDir);
    expect(s2.load()).toEqual([]);
    s2.record('two-cmd');
    expect(new InputHistoryStore('/proj/one', baseDir).load()).toEqual(['one-cmd']);
  });

  it('load：跳过空行与坏行，容忍缺字段', () => {
    const file = join(baseDir, `${workdirKey(cwd)}.jsonl`);
    mkdirSync(baseDir, { recursive: true });
    writeFileSync(
      file,
      ['{"text":"good1"}', '', 'not json', '{"foo":"bar"}', '{"text":""}', '{"text":"good2"}'].join('\n'),
      'utf8',
    );
    expect(new InputHistoryStore(cwd, baseDir).load()).toEqual(['good1', 'good2']);
  });

  it('load：不存在的文件返回空', () => {
    expect(new InputHistoryStore('/never', baseDir).load()).toEqual([]);
  });

  it('内存上限裁剪到最近 MAX_ENTRIES 条', () => {
    const s = new InputHistoryStore(cwd, baseDir);
    for (let i = 0; i < MAX_ENTRIES + 50; i++) s.record(`cmd-${i}`);
    expect(s.entries.length).toBe(MAX_ENTRIES);
    expect(s.entries[0]).toBe('cmd-50');
    expect(s.entries[s.entries.length - 1]).toBe(`cmd-${MAX_ENTRIES + 49}`);
  });

  it('record 触发上限时同步裁剪磁盘文件', () => {
    const s = new InputHistoryStore(cwd, baseDir);
    for (let i = 0; i < MAX_ENTRIES + 50; i++) s.record(`cmd-${i}`);
    const raw = readFileSync(join(baseDir, `${workdirKey(cwd)}.jsonl`), 'utf8');
    const lines = raw.split('\n').filter((line) => line.trim() !== '');
    expect(lines.length).toBe(MAX_ENTRIES);
    expect(JSON.parse(lines[0]).text).toBe('cmd-50');
    expect(JSON.parse(lines[lines.length - 1]).text).toBe(`cmd-${MAX_ENTRIES + 49}`);
  });

  it('load 遇到膨胀文件时压缩磁盘文件到 MAX_ENTRIES 条', () => {
    const file = join(baseDir, `${workdirKey(cwd)}.jsonl`);
    mkdirSync(baseDir, { recursive: true });
    const lines: string[] = [];
    for (let i = 0; i < MAX_ENTRIES + 100; i++) {
      lines.push(JSON.stringify({ text: `legacy-${i}` }));
    }
    writeFileSync(file, lines.join('\n') + '\n', 'utf8');

    const s = new InputHistoryStore(cwd, baseDir);
    expect(s.load().length).toBe(MAX_ENTRIES);
    expect(s.entries[0]).toBe('legacy-100');

    const rewritten = readFileSync(file, 'utf8');
    const rewrittenLines = rewritten.split('\n').filter((line) => line.trim() !== '');
    expect(rewrittenLines.length).toBe(MAX_ENTRIES);
    expect(JSON.parse(rewrittenLines[0]).text).toBe('legacy-100');
  });
});

describe('navigateHistory', () => {
  const entries = ['old', 'mid', 'new'];

  it('空历史不动', () => {
    const r = navigateHistory([], initialNavState(), -1, 'draft');
    expect(r.text).toBeUndefined();
    expect(r.state.index).toBe(-1);
  });

  it('未浏览时按 Down 无效', () => {
    const r = navigateHistory(entries, initialNavState(), 1, 'draft');
    expect(r.text).toBeUndefined();
    expect(r.state.index).toBe(-1);
  });

  it('首次 Up：暂存草稿并跳到最新一条', () => {
    const r = navigateHistory(entries, initialNavState(), -1, 'my draft');
    expect(r.text).toBe('new');
    expect(r.state.index).toBe(2);
    expect(r.state.draft).toBe('my draft');
  });

  it('连续 Up 往更旧翻，到最旧后不动', () => {
    let s = navigateHistory(entries, initialNavState(), -1, 'd').state;
    let r = navigateHistory(entries, s, -1, 'new');
    expect(r.text).toBe('mid');
    s = r.state;
    r = navigateHistory(entries, s, -1, 'mid');
    expect(r.text).toBe('old');
    s = r.state;
    r = navigateHistory(entries, s, -1, 'old');
    expect(r.text).toBeUndefined();
    expect(r.state.index).toBe(0);
  });

  it('Down 翻回底部恢复草稿并退出浏览', () => {
    const s = navigateHistory(entries, initialNavState(), -1, 'half').state;
    expect(s.index).toBe(2);
    const r = navigateHistory(entries, s, 1, 'new');
    expect(r.text).toBe('half');
    expect(r.state.index).toBe(-1);
    expect(r.state.draft).toBe('');
  });

  it('中间来回：Up 到 old 再 Down 回 mid', () => {
    let s = navigateHistory(entries, initialNavState(), -1, '').state;
    s = navigateHistory(entries, s, -1, 'new').state;
    s = navigateHistory(entries, s, -1, 'mid').state;
    const r = navigateHistory(entries, s, 1, 'old');
    expect(r.text).toBe('mid');
    expect(r.state.index).toBe(1);
  });
});
