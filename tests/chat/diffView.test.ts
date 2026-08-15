import { describe, expect, it } from 'vitest';
import { computeDiffLines, renderDiffClustered } from '../../src/chat/diffView.js';

describe('computeDiffLines', () => {
  it('纯新增', () => {
    const d = computeDiffLines('a\nb', 'a\nb\nc');
    expect(d).toEqual([
      { kind: 'context', lineNum: 1, code: 'a' },
      { kind: 'context', lineNum: 2, code: 'b' },
      { kind: 'add', lineNum: 3, code: 'c' },
    ]);
  });

  it('纯删除', () => {
    const d = computeDiffLines('a\nb\nc', 'a\nc');
    expect(d).toEqual([
      { kind: 'context', lineNum: 1, code: 'a' },
      { kind: 'delete', lineNum: 2, code: 'b' },
      { kind: 'context', lineNum: 2, code: 'c' },
    ]);
  });

  it('修改一行 = 删除 + 新增', () => {
    const d = computeDiffLines('x\nold\ny', 'x\nnew\ny');
    const kinds = d.map((l) => l.kind);
    expect(kinds).toContain('delete');
    expect(kinds).toContain('add');
    expect(d.find((l) => l.kind === 'delete')!.code).toBe('old');
    expect(d.find((l) => l.kind === 'add')!.code).toBe('new');
  });
});

describe('renderDiffClustered', () => {
  it('首行是 +N -M path 摘要', () => {
    const out = renderDiffClustered('a\nold\nb', 'a\nnew\nb', 'f.ts');
    expect(out[0]).toBe('+1 -1 f.ts');
  });

  it('改动行带行号与 +/- 标记', () => {
    const out = renderDiffClustered('a\nold\nb', 'a\nnew\nb', 'f.ts');
    const joined = out.join('\n');
    expect(joined).toMatch(/\+ new/);
    expect(joined).toMatch(/- old/);
  });

  it('分散改动之间用「… N unchanged lines …」省略', () => {
    // 首行改、末行改，中间 10 行不变 → 两簇之间省略
    const oldLines = ['A', ...Array.from({ length: 10 }, (_, i) => `mid${i}`), 'Z'];
    const newLines = ['A2', ...Array.from({ length: 10 }, (_, i) => `mid${i}`), 'Z2'];
    const out = renderDiffClustered(oldLines.join('\n'), newLines.join('\n'), 'f.ts', {
      contextLines: 1,
    });
    expect(out.join('\n')).toMatch(/… \d+ unchanged lines? …/);
  });

  it('超过 maxLines 时截断并附 more changes hidden', () => {
    const oldText = Array.from({ length: 30 }, (_, i) => `line${i}`).join('\n');
    const newText = Array.from({ length: 30 }, (_, i) => `LINE${i}`).join('\n'); // 全改
    const out = renderDiffClustered(oldText, newText, 'f.ts', { maxLines: 6 });
    expect(out.join('\n')).toMatch(/more changes hidden \(Ctrl\+O to expand\)/);
  });

  it('无改动时只返回摘要头', () => {
    const out = renderDiffClustered('a\nb', 'a\nb', 'f.ts');
    expect(out).toEqual(['f.ts']);
  });
});
