import { mkdtempSync, readFileSync, readSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { executeTool } from '../../src/tools/index.js';

/**
 * 大文件分页读取的内存契约。
 *
 * read_file 对超过 MAX_BYTES(256KB) 的整文件读会拒绝，并提示「请用 offset/limit 分页读取」。
 * 但分页分支此前仍走 readFileSync 全量载入，**照着提示做反而触发 OOM**
 * （实测 114MB 文件读 5 行，堆增长 119MB）。修复后分页走流式逐行窗口，
 * 内存与文件大小解耦。
 */

// 保留真实实现，只为「哪个 API 被调用了」留下可断言的痕迹。
// 全量载入的唯一入口是 readFileSync，分块读的唯一入口是 readSync，两者都在此可观测。
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    default: actual,
    readFileSync: vi.fn(actual.readFileSync),
    readSync: vi.fn(actual.readSync),
  };
});

let dir: string;
let ctx: { cwd: string };

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stepcode-bigread-'));
  ctx = { cwd: dir };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 造一个超过 MAX_BYTES 的文件：每行 999 字符，共 n 行。 */
function makeBig(file: string, lines: number): void {
  const chunk = `${'x'.repeat(999)}\n`.repeat(1000);
  writeFileSync(file, '');
  for (let i = 0; i < Math.ceil(lines / 1000); i++) writeFileSync(file, chunk, { flag: 'a' });
}

describe('read_file 大文件分页', () => {
  it('不带分页参数时拒绝并给出分页提示', async () => {
    const f = join(dir, 'big.txt');
    makeBig(f, 2000);
    expect(statSync(f).size).toBeGreaterThan(256 * 1024);

    const r = await executeTool('read_file', { path: f }, ctx);
    expect(r.isError).toBe(true);
    expect(r.content).toContain('offset/limit');
  });

  it('带分页参数时能读到指定窗口，行号与总行数正确', async () => {
    const f = join(dir, 'big.txt');
    makeBig(f, 3000);

    const r = await executeTool('read_file', { path: f, offset: 10, limit: 3 }, ctx);
    expect(r.isError ?? false).toBe(false);
    const lines = r.content.split('\n');
    // 前 3 行是内容（行号 10/11/12），最后一行是 <system> 状态块
    expect(lines[0]!.startsWith('10\t')).toBe(true);
    expect(lines[2]!.startsWith('12\t')).toBe(true);
    expect(r.content).toContain('已读取第 10-12 行');
    expect(r.content).toContain('共 3001 行');
  });

  it('分页读取不把整个文件载入内存（不走 readFileSync，逐块读且块大小有上限）', async () => {
    const f = join(dir, 'huge.txt');
    makeBig(f, 40000); // ~38MB
    const size = statSync(f).size;
    expect(size).toBeGreaterThan(20 * 1024 * 1024);

    // 判据是**行为**，不是内存读数。理由见文件末尾「为什么不用 rss / heapUsed 做判据」。
    vi.mocked(readFileSync).mockClear();
    vi.mocked(readSync).mockClear();

    const r = await executeTool('read_file', { path: f, offset: 1, limit: 5 }, ctx);
    expect(r.isError ?? false).toBe(false);
    expect(r.content).toContain('共 40001 行');

    // ① 全量载入的唯一入口是 readFileSync（src/tools/readFile.ts 的全量分支）。
    //    分页路径一旦退化成全量，这条立刻红——这是本用例要守的核心性质。
    expect(readFileSync).not.toHaveBeenCalled();

    // ② 必须是分块读：38MB / 64KB ≈ 600 次，另加一次 8KB 二进制嗅探。
    const calls = vi.mocked(readSync).mock.calls;
    expect(calls.length).toBeGreaterThan(100);

    // ③ 每块都有上限，且与文件大小无关——「内存与文件大小解耦」的直接表达。
    const maxLen = Math.max(...calls.map((c) => Number(c[3])));
    expect(maxLen).toBeLessThanOrEqual(64 * 1024);
  });

  it('流式路径与全量路径的输出格式一致（含多字节字符、无尾换行）', async () => {
    const body = ['第一行中文', 'second', '第三行🎉表情', 'tail-no-newline'];
    const small = join(dir, 'small.txt');
    writeFileSync(small, body.join('\n'), 'utf8'); // 故意不以 \n 结尾

    // 小文件走全量路径
    const viaFull = await executeTool('read_file', { path: small, offset: 2, limit: 2 }, ctx);
    expect(viaFull.content).toContain('2\tsecond');
    expect(viaFull.content).toContain('3\t第三行🎉表情');
    expect(viaFull.content).toContain('共 4 行');

    // 同样内容垫大后走流式路径，窗口内容应逐字符一致
    const big = join(dir, 'padded.txt');
    const pad = `${'y'.repeat(999)}\n`.repeat(1000);
    writeFileSync(big, `${body.join('\n')}\n${pad}`, 'utf8');
    const viaStream = await executeTool('read_file', { path: big, offset: 2, limit: 2 }, ctx);
    expect(viaStream.content).toContain('2\tsecond');
    expect(viaStream.content).toContain('3\t第三行🎉表情');
  });

  it('多字节字符跨读取块边界不被切坏', async () => {
    const f = join(dir, 'cjk.txt');
    // 每行足够长，保证中文行会横跨 64KB 读取块边界
    const line = '中文内容测试'.repeat(200); // ~1200 字符 = ~3600 字节
    const lines = Array.from({ length: 200 }, (_, i) => `${i}:${line}`);
    writeFileSync(f, lines.join('\n'), 'utf8');
    expect(statSync(f).size).toBeGreaterThan(256 * 1024);

    const r = await executeTool('read_file', { path: f, offset: 150, limit: 2 }, ctx);
    expect(r.isError ?? false).toBe(false);
    // 出现替换字符 U+FFFD 说明解码被切坏
    expect(r.content).not.toContain('\uFFFD');
    expect(r.content).toContain(`149:${line}`);
  });
});

/*
 * ## 为什么不用 rss / heapUsed 做判据（2026-08-03，判据换成行为断言的依据）
 *
 * 本用例原先断言「3 次调用中 rss 涨幅的最大值 < 24MB」，理由是「V8 为容纳 38MB 字符串
 * 必须真实占用物理内存，回收只会让某一次偏小，取最大值仍反映真实峰值」。
 * 这个推理有一个错误前提：**它假设「程序占了多少」与「进程向 OS 要了多少」同向变化。**
 *
 * 独立进程实测（38MB / 40000 行，读 5 行，同一份实现连测两轮，3 次取 rss 峰值最大）：
 *
 * | 实现 | 第一轮 rss 峰值涨幅 | 第二轮 |
 * |---|---|---|
 * | 全程解码（旧） | 7.21 MB | **0.13 MB** |
 * | 字节数行（新） | 0.08 MB | 0.13 MB |
 *
 * 同一份旧实现两轮差 55 倍。原因是 rss 涨幅只反映「V8 这次要不要向 OS 多要页」：
 * 堆一经扩容，后续同量垃圾在已有堆内周转，rss 不再增长。于是该判据两个方向都会骗人——
 * 既会因 GC 时机假失败（本用例在全量套件里约 1/3 概率红，实测 25.4 / 26.6 / 26.7 MB
 * 越过 24MB 阈值），也会在堆已被别的测试撑大时让真正的全量载入假通过。
 *
 * heapTotal 更糟：vitest 把多个测试文件跑在同一 worker 进程里，别人的分配会一起算进来。
 *
 * 现判据改为断言**行为**：分页路径不得调用 readFileSync（全量载入的唯一入口），
 * 且必须分块读、块大小有与文件体积无关的上限。这三条是确定性的，不依赖 GC 调度，
 * 且鉴别力更强——分页分支一旦退化回全量载入，第一条立刻红。
 *
 * 对照数据由 step-code-labs/readfile-linecount-fastpath/probe.mjs 产出，可复跑。
 */
