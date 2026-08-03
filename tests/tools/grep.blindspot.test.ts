import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeTool } from '../../src/tools/index.js';

/**
 * grep 的**搜索盲区**必须随结果返回；而能消除的盲区应当消除、不是报告了就算完。
 *
 * 演进的两步：
 * 1. 2026-08-03 早前：grep 静默跳过 >512KB 的文件。危害不是漏搜，而是调用方拿到
 *    `[无匹配]` 后推断「这个符号不存在」——零命中有两种互斥解释，而输出里看不出
 *    有东西被跳过。于是让盲区随结果返回，空结果时必带。
 * 2. 本轮：**大文件改走流式扫描，那个盲区被消除了**。可见的缺口比隐形的安全，
 *    但不跳过比可见更好。`oversize` 类别因此不再存在。
 *
 * 剩下的盲区都是消不掉的：读取失败、撞上限提前结束、超长单行只能部分参与匹配。
 */

let dir: string;
let ctx: { cwd: string };

/** >512KB（越过全量读/流式的策略切换线），但单行 <1MB（不触发超长行截断）。 */
const BIG_PAD = `${'y'.repeat(600 * 1024)}\n`;
/** 单行 >1MB，用于触发超长行盲区。 */
const LONG_LINE = `${'z'.repeat(1200 * 1024)}\n`;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stepcode-grep-blind-'));
  ctx = { cwd: dir };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('大文件不再是盲区', () => {
  it('目标只存在于大文件里时直接命中（此前是「无匹配 + 盲区」）', async () => {
    // 这个用例此前断言的是「必须报告盲区」，现在断言「根本不该有盲区」——
    // 同一个场景，从「让缺口可见」升级到「缺口不存在」。
    writeFileSync(join(dir, 'huge.log'), `${BIG_PAD}NEEDLE_IN_BIG_FILE\n`);
    writeFileSync(join(dir, 'small.txt'), 'nothing interesting here\n');

    const r = await executeTool('grep', { pattern: 'NEEDLE_IN_BIG_FILE' }, ctx);

    expect(r.isError ?? false).toBe(false);
    expect(r.content).toContain('huge.log:2:NEEDLE_IN_BIG_FILE');
    expect(r.content).not.toContain('[无匹配]');
    expect(r.content).not.toContain('[搜索盲区]'); // 没有任何盲区可报
  });

  it('多个大文件全部参与搜索，不产生盲区', async () => {
    for (let i = 1; i <= 7; i++) {
      writeFileSync(join(dir, `big${String(i)}.txt`), `${'z'.repeat((520 + i * 40) * 1024)}\nmark${String(i)}\n`);
    }

    const r = await executeTool('grep', { pattern: 'mark5' }, ctx);

    expect(r.content).toContain('big5.txt:2:mark5');
    expect(r.content).not.toContain('[搜索盲区]');
    expect(r.content).not.toContain('未被搜索'); // 旧措辞不该再出现
  });

  it('阈值两侧语义等价：同样的内容，撑大到走流式后结果一致', async () => {
    // 正确性标准是「流式与全量读语义等价」。构造同一段内容的两个版本，
    // 一个在阈值下（全量读），一个用 padding 撑到阈值上（流式），行号与内容都应一致。
    const body = `${'filler\n'.repeat(4)}THE_NEEDLE\ntail\n`;
    writeFileSync(join(dir, 'small.txt'), body);
    writeFileSync(join(dir, 'big.txt'), `${body}${BIG_PAD}`);

    const r = await executeTool('grep', { pattern: 'THE_NEEDLE' }, ctx);

    // 两个文件都在第 5 行命中，内容相同
    expect(r.content).toContain('small.txt:5:THE_NEEDLE');
    expect(r.content).toContain('big.txt:5:THE_NEEDLE');
    expect(r.content).not.toContain('[搜索盲区]');
  });

  it('大文件里的二进制仍被跳过（按头部采样判定）', async () => {
    const bin = Buffer.concat([
      Buffer.from([0x00, 0x01, 0x02]),
      Buffer.from('NEEDLE_IN_BINARY'),
      Buffer.from('q'.repeat(600 * 1024)),
    ]);
    writeFileSync(join(dir, 'blob.bin'), bin);

    const r = await executeTool('grep', { pattern: 'NEEDLE_IN_BINARY' }, ctx);
    expect(r.content).toBe('[无匹配]'); // 二进制不参与匹配，也不算盲区
  });
});

describe('消不掉的盲区仍要如实报告', () => {
  it('含超长单行的文件：报告真实行体积并给出下一步', async () => {
    writeFileSync(join(dir, 'minified.js'), LONG_LINE);
    writeFileSync(join(dir, 'small.txt'), 'plain\n');

    const r = await executeTool('grep', { pattern: 'ZZZ_NOT_PRESENT' }, ctx);

    expect(r.content).toContain('[无匹配]');
    expect(r.content).toContain('[搜索盲区]');
    expect(r.content).toContain('不等于');
    expect(r.content).toContain('minified.js');
    expect(r.content).toContain('超长单行');
    // 体积要标出来，且是真实行长（1.2MB），不是被截断后的 1MB
    expect(r.content).toMatch(/minified\.js（单行 1\.[0-9] MB）/);
    // 必须给可执行的下一步
    expect(r.content).toContain('grep/rg');
  });

  it('超长单行的前 1MB 仍然参与匹配（不是整个文件被放弃）', async () => {
    writeFileSync(join(dir, 'minified.js'), `HEAD_MARK${'z'.repeat(1200 * 1024)}\n`);

    const r = await executeTool('grep', { pattern: 'HEAD_MARK' }, ctx);
    expect(r.content).toContain('minified.js:1:HEAD_MARK');
    expect(r.content).toContain('[搜索盲区]'); // 命中了，但仍要声明该行未被完整检查
  });

  it('没有盲区时不输出盲区段（不污染正常结果）', async () => {
    writeFileSync(join(dir, 'a.txt'), 'alpha\n');
    writeFileSync(join(dir, 'b.txt'), 'beta\n');

    const hit = await executeTool('grep', { pattern: 'alpha' }, ctx);
    expect(hit.content).toContain('a.txt:1:alpha');
    expect(hit.content).not.toContain('[搜索盲区]');

    const miss = await executeTool('grep', { pattern: 'ZZZ_NOT_PRESENT' }, ctx);
    expect(miss.content).toBe('[无匹配]');
  });

  it('撞匹配数上限时说明盲区统计本身也不完整', async () => {
    writeFileSync(join(dir, 'many.txt'), 'match line\n'.repeat(300));

    const r = await executeTool('grep', { pattern: 'match' }, ctx);

    expect(r.content).toContain('结果已达上限');
    expect(r.content).toContain('[搜索盲区]');
    expect(r.content).toContain('提前结束');
    expect(r.content).toContain('统计本身也不完整');
  });

  it('撞上限时大文件的扫描也会提前停止（早停要真的停）', async () => {
    // 单个大文件里全是匹配行：必须在收满 200 条后停止读取，而不是扫到文件尾
    writeFileSync(join(dir, 'big-hits.txt'), `${'hit here\n'.repeat(200_000)}`);

    const t0 = Date.now();
    const r = await executeTool('grep', { pattern: 'hit' }, ctx);
    const ms = Date.now() - t0;

    expect(r.content).toContain('结果已达上限');
    // 文件约 1.7MB；早停生效时只需读前几十 KB。给足余量，只证伪「扫全文」这种量级差异
    expect(ms).toBeLessThan(2000);
  });
});
