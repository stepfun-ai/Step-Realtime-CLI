import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { looksBinaryByHead, scanLinesStreaming } from '../../src/tools/grepScan.js';

/**
 * 流式逐行扫描的正确性标准只有一条：**与 `content.split('\n')` 语义等价**。
 *
 * grep 原本是「全量读入 + split + 逐行匹配」，改造后大文件走流式。只要流式交出的行
 * 序列与 split 完全一致，匹配结果就必然一致——所以这里不测匹配，只测分行。
 *
 * 分行的坑集中在两处，都用极小 chunk（4~7 字节）强制暴露：
 * 1. **末尾残段**：`split` 对 `'a\n'` 给 `['a', '']`（2 项），对 `''` 给 `['']`（1 项）。
 *    漏掉最后那次产出，就会在「以换行结尾」的文件上少一行——而那是最常见的文件形态。
 * 2. **多字节跨块**：UTF-8 字符可能横跨两个 chunk，按块解码会在接缝产生替换字符。
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stepcode-grepscan-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 写入内容并用流式扫描收集全部行。chunkBytes 故意可调到极小以强制跨块。 */
function scanAll(content: string, chunkBytes?: number): string[] {
  const f = join(dir, 'f.txt');
  writeFileSync(f, content);
  const lines: string[] = [];
  scanLinesStreaming(
    f,
    (line) => {
      lines.push(line);
      return true;
    },
    chunkBytes === undefined ? {} : { chunkBytes },
  );
  return lines;
}

describe('与 split(\\n) 的等价性', () => {
  const cases: { name: string; content: string }[] = [
    { name: '普通两行不带尾换行', content: 'alpha\nbeta' },
    { name: '以换行结尾（split 会给出末尾空串）', content: 'alpha\nbeta\n' },
    { name: '空文件（split 给出 1 个空串，不是 0 行）', content: '' },
    { name: '只有一个换行', content: '\n' },
    { name: '连续空行', content: 'a\n\n\nb\n' },
    { name: '单行无换行', content: 'only-one-line' },
    { name: 'CRLF：\\r 必须保留（split 不去 \\r）', content: 'a\r\nb\r\n' },
    { name: '多字节中文', content: '中文一行\n第二行内容\n' },
    { name: '混合多字节与空行', content: '中\n\n文\n' },
    { name: 'emoji（4 字节字符）', content: 'ok\n' },
  ];

  for (const { name, content } of cases) {
    it(`${name}`, () => {
      const expected = content.split('\n');
      // 默认块大小
      expect(scanAll(content)).toEqual(expected);
      // 极小块强制跨块：真正会暴露边界问题的是这一路
      expect(scanAll(content, 4)).toEqual(expected);
      expect(scanAll(content, 7)).toEqual(expected);
    });
  }

  it('跨块的长行拼回后逐字节一致（不在块边界丢字符）', () => {
    const content = `${'x'.repeat(1000)}\n${'y'.repeat(999)}\n`;
    expect(scanAll(content, 8)).toEqual(content.split('\n'));
  });

  it('多字节字符横跨块边界时不产生替换字符', () => {
    // 每个中文 3 字节，用 chunk=4 保证必然切开某个字符
    const content = `${'中'.repeat(50)}\n${'文'.repeat(50)}\n`;
    const got = scanAll(content, 4);
    expect(got).toEqual(content.split('\n'));
    expect(got.join('')).not.toContain('\uFFFD');
  });
});

describe('早停', () => {
  it('onLine 返回 false 时立即停止，不再读后续内容', () => {
    const f = join(dir, 'many.txt');
    writeFileSync(f, 'line\n'.repeat(1000));
    const seen: string[] = [];
    const res = scanLinesStreaming(f, (line) => {
      seen.push(line);
      return seen.length < 3; // 收满 3 行就停
    });
    expect(seen.length).toBe(3);
    expect(res.stopped).toBe(true);
    // 关键：行计数不应等于文件总行数，否则说明"停"没生效、只是没往下收
    expect(res.lines).toBe(3);
  });

  it('不早停时行数与 split 一致', () => {
    const f = join(dir, 'few.txt');
    writeFileSync(f, 'a\nb\nc\n');
    const res = scanLinesStreaming(f, () => true);
    expect(res.stopped).toBe(false);
    expect(res.lines).toBe('a\nb\nc\n'.split('\n').length); // 4（末尾空串）
  });
});

describe('超长单行截断', () => {
  it('只保留前 maxLineBytes 参与匹配，并上报该行的真实字节数', () => {
    const f = join(dir, 'long.txt');
    writeFileSync(f, `${'a'.repeat(5000)}\nshort\n`);
    const lines: string[] = [];
    const res = scanLinesStreaming(
      f,
      (line) => {
        lines.push(line);
        return true;
      },
      { maxLineBytes: 1000, chunkBytes: 256 },
    );

    expect(lines[0]!.length).toBe(1000); // 截断到上限
    expect(lines[1]).toBe('short'); // 后续行不受影响
    // 报的是真实长度 5000，不是截断后的 1000——报残值会让调用方误判损失大小
    expect(res.truncatedLineBytes).toBe(5000);
  });

  it('没有超长行时 truncatedLineBytes 为 0（不误报）', () => {
    const f = join(dir, 'ok.txt');
    writeFileSync(f, 'aaa\nbbb\n');
    const res = scanLinesStreaming(f, () => true, { maxLineBytes: 1000 });
    expect(res.truncatedLineBytes).toBe(0);
  });

  it('取最长那一行的字节数（多行超限时不只报第一个）', () => {
    const f = join(dir, 'multi.txt');
    writeFileSync(f, `${'a'.repeat(2000)}\n${'b'.repeat(9000)}\n${'c'.repeat(3000)}\n`);
    const res = scanLinesStreaming(f, () => true, { maxLineBytes: 1000, chunkBytes: 512 });
    expect(res.truncatedLineBytes).toBe(9000);
  });

  it('内存与超长行长度解耦：单行远超上限也只保留上限那么多', () => {
    const f = join(dir, 'huge-line.txt');
    writeFileSync(f, 'z'.repeat(3 * 1024 * 1024)); // 3MB 单行
    let maxLen = 0;
    const res = scanLinesStreaming(
      f,
      (line) => {
        maxLen = Math.max(maxLen, line.length);
        return true;
      },
      { maxLineBytes: 64 * 1024 },
    );
    expect(maxLen).toBe(64 * 1024);
    expect(res.truncatedLineBytes).toBe(3 * 1024 * 1024);
  });
});

describe('二进制头部嗅探', () => {
  it('头部含 NUL 判为二进制', () => {
    const f = join(dir, 'bin');
    writeFileSync(f, Buffer.from([0x41, 0x42, 0x00, 0x43]));
    expect(looksBinaryByHead(f)).toBe(true);
  });

  it('纯文本不误判', () => {
    const f = join(dir, 'txt');
    writeFileSync(f, 'hello world\n中文也算文本\n');
    expect(looksBinaryByHead(f)).toBe(false);
  });

  it('NUL 出现在嗅探范围之后会漏判（已知代价，如实登记）', () => {
    // 采样是流式路径的必然妥协：没有整文件就查不了全文。
    // 后果是这类文件被当文本搜索，最坏结果是若干乱码行进入结果，不影响其它文件。
    const f = join(dir, 'late-nul');
    writeFileSync(f, Buffer.concat([Buffer.from('A'.repeat(200)), Buffer.from([0x00])]));
    expect(looksBinaryByHead(f, 100)).toBe(false); // 只嗅前 100 字节 → 漏判
    expect(looksBinaryByHead(f, 300)).toBe(true); // 范围够大就能发现
  });
});
