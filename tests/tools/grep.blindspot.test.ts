import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { executeTool } from '../../src/tools/index.js';

/**
 * grep 的**搜索盲区**必须随结果返回。
 *
 * 起因：grep 静默跳过超过 512KB 的文件，输出里没有任何痕迹。危害不是漏搜，而是
 * 调用方（模型）拿到 `[无匹配]` 后会推断「这个符号不存在」——而零命中有两种互斥
 * 解释：真的不存在，或者它在没被搜的文件里。工具描述里写「自动忽略超大文件」
 * 救不了：模型读到空结果的那一刻不会回头重读工具描述。
 *
 * 因此盲区必须出现在**结果正文**里，尤其在空结果时。
 */

let dir: string;
let ctx: { cwd: string };

const OVER_LIMIT = 'y'.repeat(1200 * 1024); // > MAX_FILE_BYTES (512KB)，且 >1MB 以覆盖 MB 档渲染

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stepcode-grep-blind-'));
  ctx = { cwd: dir };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('grep 搜索盲区', () => {
  it('目标只存在于被跳过的大文件里时，空结果必须带盲区而不是干巴巴的「无匹配」', async () => {
    // 这是本组最重要的用例：它复现「据空结果断定不存在」的完整条件。
    writeFileSync(join(dir, 'huge.log'), `${OVER_LIMIT}\nNEEDLE_IN_BIG_FILE\n`);
    writeFileSync(join(dir, 'small.txt'), 'nothing interesting here\n');

    const r = await executeTool('grep', { pattern: 'NEEDLE_IN_BIG_FILE' }, ctx);

    expect(r.isError ?? false).toBe(false);
    // 仍然是无匹配（大文件确实没搜），但必须把盲区一起交回去
    expect(r.content).toContain('[无匹配]');
    expect(r.content).toContain('[搜索盲区]');
    expect(r.content).toContain('不等于');
    expect(r.content).toContain('huge.log');
    // 体积要标出来，调用方才能判断值不值得追
    expect(r.content).toMatch(/huge\.log（[\d.]+ MB）/);
    // 必须给出下一步动作，而不是只报告事实
    expect(r.content).toContain('read_file');
  });

  it('有匹配时盲区同样附在结果末尾，不覆盖匹配内容', async () => {
    writeFileSync(join(dir, 'huge.log'), `${OVER_LIMIT}\n`);
    writeFileSync(join(dir, 'small.txt'), 'hit here\n');

    const r = await executeTool('grep', { pattern: 'hit' }, ctx);

    expect(r.isError ?? false).toBe(false);
    expect(r.content).toContain('small.txt:1:hit here');
    expect(r.content).toContain('[搜索盲区]');
    expect(r.content).toContain('huge.log');
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

  it('多个大文件按体积降序列出，超过 5 个时给出剩余计数', async () => {
    // 造 7 个超限文件，体积递增，最大的应排在最前
    for (let i = 1; i <= 7; i++) {
      writeFileSync(join(dir, `big${i}.bin`), 'z'.repeat((520 + i * 40) * 1024));
    }
    writeFileSync(join(dir, 'small.txt'), 'plain\n');

    const r = await executeTool('grep', { pattern: 'NOPE_NOT_HERE' }, ctx);

    expect(r.content).toContain('7 个文件因超过');
    expect(r.content).toContain('另有 2 个'); // 7 - 展示 5 个
    // 体积最大的 big7 必须出现，最小的 big1 落在省略部分
    // 800KB 档走 KB 渲染（MB 档由上面 1.2MB 的用例覆盖）
    expect(r.content).toMatch(/big7\.bin（\d+ KB）/);
    expect(r.content).not.toContain('big1.bin');
    // 降序：big7 的位置早于 big6
    expect(r.content.indexOf('big7.bin')).toBeLessThan(r.content.indexOf('big6.bin'));
  });

  it('撞匹配数上限时说明盲区统计本身也不完整', async () => {
    // 单文件 300 行全匹配，超过 MAX_MATCHES(200)
    writeFileSync(join(dir, 'many.txt'), `${'match line\n'.repeat(300)}`);
    writeFileSync(join(dir, 'huge.log'), `${OVER_LIMIT}\n`);

    const r = await executeTool('grep', { pattern: 'match' }, ctx);

    expect(r.content).toContain('结果已达上限');
    expect(r.content).toContain('[搜索盲区]');
    expect(r.content).toContain('提前结束');
    expect(r.content).toContain('统计本身也不完整');
  });
});
