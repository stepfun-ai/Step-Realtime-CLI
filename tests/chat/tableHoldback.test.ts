import { describe, expect, it } from 'vitest';
import { TableHoldback } from '../../src/chat/tableHoldback.js';

describe('TableHoldback 流式表格扣留', () => {
  it('无表格的文本全部透传（含半截行，不打断逐字流）', () => {
    const h = new TableHoldback();
    expect(h.feed('你好')).toBe('你好');
    expect(h.feed('，世界\n第二行半截')).toBe('，世界\n第二行半截');
    expect(h.active).toBe(false);
  });

  it('疑似表格起点之后的内容被扣留，表格结束后连同行一起放出', () => {
    const h = new TableHoldback();
    // 表头到达：从 | 行起扣留
    expect(h.feed('前文\n| 列A | 列B |\n')).toBe('前文\n');
    expect(h.active).toBe(true);
    // 分隔行与数据行：继续扣（哪怕分多次到达）
    expect(h.feed('| --- | --- |\n')).toBe('');
    expect(h.feed('| 1 | 2 ')).toBe(''); // 半截行也扣住
    expect(h.feed('|\n')).toBe('');
    // 结束行未完整（无换行）时仍扣着
    expect(h.feed('表格后的正文')).toBe('');
    // 结束行补全：表格 + 结束行一起放出，后续半截照常透传
    const released = h.feed('\n后续');
    expect(released).toContain('| 列A | 列B |');
    expect(released).toContain('| 1 | 2 |');
    expect(released).toContain('表格后的正文\n后续');
    expect(h.active).toBe(false);
  });

  it('flush 放出全部扣留内容（流被工具调用/中断打断）', () => {
    const h = new TableHoldback();
    h.feed('前文\n| 列A |\n| --- |\n| 1 |\n');
    expect(h.active).toBe(true);
    const rest = h.flush();
    expect(rest).toContain('| 列A |');
    expect(h.active).toBe(false);
    // flush 后恢复正常透传
    expect(h.feed('新文本')).toBe('新文本');
  });

  it('表格结束后紧跟新表格：各自扣留互不影响', () => {
    const h = new TableHoldback();
    // 一次性到达的大块：第一个表格已完整（后面跟了非表格行），正常放出；
    // 末尾的连续 | 行段（第二个表格）扣住
    const first = h.feed('| a |\n| - |\n结束行\n| b |\n| - |\n| x |\n');
    expect(first).toContain('| a |');
    expect(first).toContain('结束行');
    expect(first).not.toContain('| b |');
    expect(h.active).toBe(true);
    // 第二个表格仍未完（尾部无结束行），继续扣
    expect(h.feed('完')).toBe('');
    // flush 放出第二个表格全文
    const rest = h.flush();
    expect(rest).toContain('| b |');
    expect(rest).toContain('| x |');
  });

  it('以 | 开头的普通行（非表格）只延迟到下一行到达', () => {
    const h = new TableHoldback();
    expect(h.feed('| 这不是表格\n')).toBe(''); // 疑似起点，扣留观望
    // 下一行不是表格行 → 立即全部放出
    expect(h.feed('普通行\n')).toBe('| 这不是表格\n普通行\n');
    expect(h.active).toBe(false);
  });
});
