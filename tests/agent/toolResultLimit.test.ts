import { describe, expect, it } from 'vitest';
import {
  capToolResult,
  truncateMiddle,
  DEFAULT_MAX_TOOL_RESULT_CHARS,
} from '../../src/agent/toolResultLimit.js';

describe('truncateMiddle', () => {
  it('未超限时原样返回同一引用', () => {
    const s = 'hello world';
    expect(truncateMiddle(s, 100)).toBe(s);
    expect(truncateMiddle(s, s.length)).toBe(s);
  });

  it('maxChars 为 0 表示不限制', () => {
    const s = 'x'.repeat(10_000);
    expect(truncateMiddle(s, 0)).toBe(s);
  });

  it('超限时保留头尾、挖掉中间，且结果不长于上限', () => {
    const head = 'HEAD_MARKER_START';
    const tail = 'TAIL_MARKER_END';
    const text = head + 'm'.repeat(5_000) + tail;
    const out = truncateMiddle(text, 1_000);
    expect(out.startsWith(head)).toBe(true);
    expect(out.endsWith(tail)).toBe(true);
    expect(out.length).toBeLessThanOrEqual(1_000);
    expect(out).toContain('characters omitted by the tool-result size cap');
  });

  it('截断标记里报告被省略字符数与原始总长', () => {
    const text = 'a'.repeat(3_000);
    const out = truncateMiddle(text, 500);
    expect(out).toMatch(/\[\.\.\. \d+ characters omitted/);
    expect(out).toContain('total 3000');
  });

  it('上限极小（标记本身超预算）时退化为头部截断，不产出比上限更长的结果', () => {
    const text = 'b'.repeat(1_000);
    const out = truncateMiddle(text, 10);
    expect(out.length).toBe(10);
    expect(out).toBe('b'.repeat(10));
  });

  it('中间被真正挖掉：原文中段的内容不出现在结果里', () => {
    const text = 'A'.repeat(1_000) + 'NEEDLE_IN_THE_MIDDLE' + 'Z'.repeat(1_000);
    const out = truncateMiddle(text, 600);
    expect(out).not.toContain('NEEDLE_IN_THE_MIDDLE');
  });
});

describe('capToolResult', () => {
  it('未超限时返回原对象（同一引用，不复制）', () => {
    const r = { content: 'short', isError: false };
    expect(capToolResult(r)).toBe(r);
  });

  it('超限时返回浅拷贝并截断 content，保留 isError 与 images', () => {
    const images = [{ mediaType: 'image/png', base64: 'AAAA' }];
    const r = { content: 'c'.repeat(2_000), isError: true, images };
    const out = capToolResult(r, 500);
    expect(out).not.toBe(r);
    expect(out.content.length).toBeLessThanOrEqual(500);
    expect(out.isError).toBe(true);
    expect(out.images).toBe(images);
    // 原对象不被就地修改
    expect(r.content.length).toBe(2_000);
  });

  it('默认上限为 400k 字符：略低于上限不截断，略高于上限截断', () => {
    expect(DEFAULT_MAX_TOOL_RESULT_CHARS).toBe(400_000);
    const under = { content: 'u'.repeat(DEFAULT_MAX_TOOL_RESULT_CHARS), isError: false };
    expect(capToolResult(under).content.length).toBe(DEFAULT_MAX_TOOL_RESULT_CHARS);
    const over = { content: 'o'.repeat(DEFAULT_MAX_TOOL_RESULT_CHARS + 1), isError: false };
    expect(capToolResult(over).content.length).toBeLessThanOrEqual(DEFAULT_MAX_TOOL_RESULT_CHARS);
  });

  it('maxChars 为 0 时不限制（配置侧可关闭本层）', () => {
    const r = { content: 'z'.repeat(1_000_000), isError: false };
    expect(capToolResult(r, 0)).toBe(r);
  });
});
