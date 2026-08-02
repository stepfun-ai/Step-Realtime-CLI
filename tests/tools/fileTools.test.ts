import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeTool } from '../../src/tools/index.js';

let dir: string;
let ctx: { cwd: string };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stepcode-test-'));
  ctx = { cwd: dir };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('write_file + read_file', () => {
  it('写入后能读回，read_file 带行号与 <system> 状态块', async () => {
    const w = await executeTool('write_file', { path: 'a.txt', content: 'l1\nl2\nl3' }, ctx);
    expect(w.isError).toBe(false);
    expect(readFileSync(join(dir, 'a.txt'), 'utf8')).toBe('l1\nl2\nl3');

    const r = await executeTool('read_file', { path: 'a.txt' }, ctx);
    expect(r.isError).toBe(false);
    expect(r.content).toContain('1\tl1');
    expect(r.content).toContain('3\tl3');
    expect(r.content).toContain('<system>');
    expect(r.content).toContain('共 3 行');
  });

  it('read_file offset/limit 分页并标记截断', async () => {
    writeFileSync(join(dir, 'big.txt'), Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n'));
    const r = await executeTool('read_file', { path: 'big.txt', offset: 2, limit: 3 }, ctx);
    expect(r.content).toContain('2\tline2');
    expect(r.content).toContain('4\tline4');
    expect(r.content).not.toContain('5\tline5');
    expect(r.content).toContain('已截断');
  });

  it('read_file 从 offset 读到文件末尾时不应标记截断', async () => {
    writeFileSync(join(dir, 'big.txt'), Array.from({ length: 5 }, (_, i) => `line${i + 1}`).join('\n'));
    const r = await executeTool('read_file', { path: 'big.txt', offset: 3 }, ctx);
    expect(r.content).toContain('3\tline3');
    expect(r.content).toContain('5\tline5');
    expect(r.content).toContain('完整');
    expect(r.content).not.toContain('已截断');
  });

  it('读不存在的文件返回 isError', async () => {
    const r = await executeTool('read_file', { path: 'nope.txt' }, ctx);
    expect(r.isError).toBe(true);
  });

  it('空文件给出明确提示', async () => {
    writeFileSync(join(dir, 'empty.txt'), '');
    const r = await executeTool('read_file', { path: 'empty.txt' }, ctx);
    expect(r.content).toContain('文件为空');
  });

  it('png 路径 → 引导用 read_media 读取，不落到分页误导文案', async () => {
    // 最小合法 PNG 头（签名 + IHDR 宽高）
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0,
    ]);
    writeFileSync(join(dir, 'a.png'), png);
    const r = await executeTool('read_file', { path: 'a.png' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('read_media');
    expect(r.content).not.toContain('分页');
  });

  it('图片魔数但非图片扩展名 → 同样引导 read_media', async () => {
    const png = Buffer.from([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52,
      0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0,
    ]);
    writeFileSync(join(dir, 'a.dat'), png);
    const r = await executeTool('read_file', { path: 'a.dat' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('read_media');
  });

  it('含 NUL 的非图片二进制 → 明确报二进制，不按文本读', async () => {
    writeFileSync(join(dir, 'a.bin'), Buffer.from([0x01, 0x00, 0x02, 0x03]));
    const r = await executeTool('read_file', { path: 'a.bin' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('二进制文件');
  });
});

describe('edit_file', () => {
  beforeEach(() => {
    writeFileSync(join(dir, 'code.txt'), 'foo bar foo');
  });

  it('唯一匹配替换成功', async () => {
    const r = await executeTool('edit_file', { path: 'code.txt', old_string: 'bar', new_string: 'baz' }, ctx);
    expect(r.isError).toBe(false);
    expect(readFileSync(join(dir, 'code.txt'), 'utf8')).toBe('foo baz foo');
  });

  it('多处匹配且未开 replace_all 时报错', async () => {
    const r = await executeTool('edit_file', { path: 'code.txt', old_string: 'foo', new_string: 'x' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('不唯一');
  });

  it('replace_all 替换全部', async () => {
    const r = await executeTool(
      'edit_file',
      { path: 'code.txt', old_string: 'foo', new_string: 'x', replace_all: true },
      ctx,
    );
    expect(r.isError).toBe(false);
    expect(readFileSync(join(dir, 'code.txt'), 'utf8')).toBe('x bar x');
  });

  it('找不到 old_string 报错', async () => {
    const r = await executeTool('edit_file', { path: 'code.txt', old_string: 'zzz', new_string: 'x' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('未找到');
  });

  it('LF 的 old_string 能匹配 CRLF 文件（换行符归一化 fallback）', async () => {
    writeFileSync(join(dir, 'crlf.txt'), 'line1\r\nline2\r\nline3');
    const r = await executeTool(
      'edit_file',
      { path: 'crlf.txt', old_string: 'line1\nline2', new_string: 'line1\nCHANGED' },
      ctx,
    );
    expect(r.isError).toBe(false);
    // 写回后仍保留 CRLF 风格，不被污染成 LF
    expect(readFileSync(join(dir, 'crlf.txt'), 'utf8')).toBe('line1\r\nCHANGED\r\nline3');
  });

  it('CRLF 文件替换后不产生 \\r\\r\\n 双重换行', async () => {
    writeFileSync(join(dir, 'crlf2.txt'), 'a\r\nb\r\nc');
    const r = await executeTool(
      'edit_file',
      { path: 'crlf2.txt', old_string: 'a\nb\nc', new_string: 'x\ny\nz' },
      ctx,
    );
    expect(r.isError).toBe(false);
    const out = readFileSync(join(dir, 'crlf2.txt'), 'utf8');
    expect(out).toBe('x\r\ny\r\nz');
    expect(out).not.toContain('\r\r');
  });

  it('纯 LF 文件保持 LF，不被转成 CRLF', async () => {
    writeFileSync(join(dir, 'lf.txt'), 'p\nq\nr');
    const r = await executeTool(
      'edit_file',
      { path: 'lf.txt', old_string: 'p\nq', new_string: 'p\nQ' },
      ctx,
    );
    expect(r.isError).toBe(false);
    const out = readFileSync(join(dir, 'lf.txt'), 'utf8');
    expect(out).toBe('p\nQ\nr');
    expect(out).not.toContain('\r');
  });

  it('CRLF 文件的多处匹配 + replace_all', async () => {
    writeFileSync(join(dir, 'crlf3.txt'), 'TODO\r\nkeep\r\nTODO');
    const r = await executeTool(
      'edit_file',
      { path: 'crlf3.txt', old_string: 'TODO', new_string: 'DONE', replace_all: true },
      ctx,
    );
    expect(r.isError).toBe(false);
    expect(readFileSync(join(dir, 'crlf3.txt'), 'utf8')).toBe('DONE\r\nkeep\r\nDONE');
  });
});

describe('list_dir / glob / grep', () => {
  beforeEach(() => {
    writeFileSync(join(dir, 'a.ts'), 'const x = 1; // TODO fix');
    writeFileSync(join(dir, 'b.md'), 'no marker here');
  });

  it('list_dir 列出条目', async () => {
    const r = await executeTool('list_dir', {}, ctx);
    expect(r.isError).toBe(false);
    expect(r.content).toContain('a.ts');
    expect(r.content).toContain('b.md');
  });

  it('glob 按模式匹配', async () => {
    const r = await executeTool('glob', { pattern: '*.ts' }, ctx);
    expect(r.content).toContain('a.ts');
    expect(r.content).not.toContain('b.md');
  });

  it('grep 命中带 path:line: 前缀', async () => {
    const r = await executeTool('grep', { pattern: 'TODO' }, ctx);
    expect(r.isError).toBe(false);
    expect(r.content).toContain('a.ts:1:');
    expect(r.content).not.toContain('b.md');
  });

  it('grep 无匹配返回明确提示', async () => {
    const r = await executeTool('grep', { pattern: 'NOTHING_XYZ' }, ctx);
    expect(r.content).toContain('无匹配');
  });


});

describe('bash', () => {
  it('执行命令返回合并输出', async () => {
    const r = await executeTool('bash', { command: 'echo hello-step' }, ctx);
    expect(r.isError).toBe(false);
    expect(r.content).toContain('hello-step');
  });

  it('非零退出码作为错误回灌', async () => {
    const r = await executeTool('bash', { command: 'exit 3' }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('退出码');
  });
});
