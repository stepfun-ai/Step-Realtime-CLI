import { describe, expect, it } from 'vitest';
import {
  PasteStore,
  PASTE_FOLD_CHAR_THRESHOLD,
  PASTE_FOLD_LINE_THRESHOLD,
  formatPlaceholder,
  shouldFoldPaste,
} from '../../src/tui/pasteStore.js';

describe('shouldFoldPaste 阈值判定', () => {
  it('恰好 10 行不折叠，11 行折叠', () => {
    const lines10 = Array.from({ length: PASTE_FOLD_LINE_THRESHOLD }, (_, i) => `line${i}`).join('\n');
    const lines11 = `${lines10}\nextra`;
    expect(shouldFoldPaste(lines10)).toBe(false);
    expect(shouldFoldPaste(lines11)).toBe(true);
  });

  it('恰好 1000 字符不折叠，1001 字符折叠', () => {
    expect(shouldFoldPaste('a'.repeat(PASTE_FOLD_CHAR_THRESHOLD))).toBe(false);
    expect(shouldFoldPaste('a'.repeat(PASTE_FOLD_CHAR_THRESHOLD + 1))).toBe(true);
  });

  it('短文本不折叠', () => {
    expect(shouldFoldPaste('hello\nworld')).toBe(false);
  });
});

describe('formatPlaceholder 占位符格式', () => {
  it('多行折叠用行数格式', () => {
    const content = Array.from({ length: 12 }, (_, i) => `l${i}`).join('\n');
    expect(formatPlaceholder(1, content)).toBe('[paste #1 +12 lines]');
  });

  it('单行长文用字符数格式', () => {
    expect(formatPlaceholder(2, 'x'.repeat(1234))).toBe('[paste #2 1234 chars]');
  });
});

describe('PasteStore', () => {
  it('add 分配自增 id，占位符与原文入表', () => {
    const store = new PasteStore();
    const long = 'x'.repeat(PASTE_FOLD_CHAR_THRESHOLD + 1);
    const e1 = store.add(long);
    const e2 = store.add(Array.from({ length: 20 }, () => 'row').join('\n'));
    expect(e1.id).toBe(1);
    expect(e2.id).toBe(2);
    expect(e1.placeholder).toBe(`[paste #1 ${long.length} chars]`);
    expect(e2.placeholder).toBe('[paste #2 +20 lines]');
    expect(store.size()).toBe(2);
    expect(store.get(1)?.content).toBe(long);
  });

  it('expandPasteMarkers 还原占位符为原文，多块共存按位置展开', () => {
    const store = new PasteStore();
    const long = 'A'.repeat(PASTE_FOLD_CHAR_THRESHOLD + 1);
    const multi = Array.from({ length: 15 }, (_, i) => `r${i}`).join('\n');
    const e1 = store.add(long);
    const e2 = store.add(multi);
    const text = `前缀 ${e1.placeholder} 中段 ${e2.placeholder} 后缀`;
    expect(store.expandPasteMarkers(text)).toBe(`前缀 ${long} 中段 ${multi} 后缀`);
  });

  it('占位符被删掉后不还原（文本里没有可匹配标记）', () => {
    const store = new PasteStore();
    const long = 'B'.repeat(PASTE_FOLD_CHAR_THRESHOLD + 1);
    store.add(long);
    // 用户把占位符删剩一半：只剩无效文本，原样保留
    expect(store.expandPasteMarkers('前缀 [paste #1 后缀')).toBe('前缀 [paste #1 后缀');
    expect(store.expandPasteMarkers('')).toBe('');
  });

  it('陈旧 / 手打的占位符不还原，现存 id 的标记按 id 还原', () => {
    const store = new PasteStore();
    store.add('c'.repeat(PASTE_FOLD_CHAR_THRESHOLD + 1));
    expect(store.expandPasteMarkers('[paste #99 5000 chars]')).toBe('[paste #99 5000 chars]');
    // 计数段不参与校验：只要 id 在 store 里就还原（与图片占位符同语义，计数只是展示）
    expect(store.expandPasteMarkers('[paste #1 +3 lines]')).toBe('c'.repeat(PASTE_FOLD_CHAR_THRESHOLD + 1));
  });

  it('clear 后 id 重置，旧占位符不再还原', () => {
    const store = new PasteStore();
    const long = 'D'.repeat(PASTE_FOLD_CHAR_THRESHOLD + 1);
    const e1 = store.add(long);
    store.clear();
    expect(store.size()).toBe(0);
    expect(store.expandPasteMarkers(e1.placeholder)).toBe(e1.placeholder);
    // id 重新从 1 开始
    expect(store.add('E'.repeat(PASTE_FOLD_CHAR_THRESHOLD + 1)).id).toBe(1);
  });

  it('正则状态跨调用复位（全局正则 lastIndex 不串）', () => {
    const store = new PasteStore();
    const long = 'F'.repeat(PASTE_FOLD_CHAR_THRESHOLD + 1);
    const e = store.add(long);
    expect(store.expandPasteMarkers(e.placeholder)).toBe(long);
    expect(store.expandPasteMarkers(e.placeholder)).toBe(long);
  });
});
