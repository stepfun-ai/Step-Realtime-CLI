import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createOutputCollector, renderOutputNotes, type OutputSnapshot } from '../../src/tools/bashOutput.js';

/**
 * bash 输出收集器：两条流分别记账 + 触顶溢出落盘。
 *
 * ## 这里回归的是哪个 bug
 *
 * 原实现把 stdout 与 stderr append 进同一个字符串、共用一个上限，且判断在追加前：
 *
 *   if (out.length < MAX_COLLECT) out += chunk; else dropped += chunk.length;
 *
 * 于是「先刷满 stdout 再往 stderr 报错」这个极常见的形状（编译失败、测试失败、
 * 批处理脚本报错）会让**错误信息 100% 丢失**——模型拿到一大堆无用日志，看不到
 * 那几行真正需要的内容。
 *
 * 这些用例全部走纯逻辑（自己喂 chunk），不真跑 10MB 命令：真命令跑一次要几十秒，
 * 而被测的判定逻辑与数据量无关，用小预算就能完整覆盖。端到端另有一例守着接线。
 */

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sc-bashout-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const buf = (s: string): Buffer => Buffer.from(s, 'utf8');

describe('两条流分别记账', () => {
  it('stdout 刷爆预算后，stderr 仍然能进内存（原 bug 的直接回归）', () => {
    const c = createOutputCollector({ stdoutBudget: 8, stderrBudget: 8, cwd: null });
    c.append(buf('AAAAAAAAAAAA'), 'stdout'); // 12 > 8：第一块就进内存，用量记 12
    c.append(buf('BBBB'), 'stdout'); // 已超预算 → 丢弃
    c.append(buf('BOOM'), 'stderr'); // stderr 有独立预算 → 必须留下

    const snap = c.snapshot();
    expect(snap.text).toContain('BOOM');
    expect(snap.droppedStdout).toBe(4);
    expect(snap.droppedStderr).toBe(0);
  });

  it('stderr 刷爆也不占用 stdout 的额度（反向对称）', () => {
    const c = createOutputCollector({ stdoutBudget: 8, stderrBudget: 4, cwd: null });
    c.append(buf('EEEEEE'), 'stderr'); // 6 > 4：进内存后 stderr 用满
    c.append(buf('EEEE'), 'stderr'); // 丢弃
    c.append(buf('KEEP'), 'stdout');

    const snap = c.snapshot();
    expect(snap.text).toContain('KEEP');
    expect(snap.droppedStderr).toBe(4);
    expect(snap.droppedStdout).toBe(0);
  });

  it('丢弃量按字节真实累加，不受内存封顶影响（不低报）', () => {
    const c = createOutputCollector({ stdoutBudget: 4, stderrBudget: 4, cwd: null });
    c.append(buf('AAAA'), 'stdout');
    for (let i = 0; i < 10; i++) c.append(buf('0123456789'), 'stdout'); // 100 字节全丢

    const snap = c.snapshot();
    expect(snap.text).toBe('AAAA'); // 内存封顶
    expect(snap.droppedStdout).toBe(100); // 计数不封顶
  });

  it('合并顺序按到达顺序，不因分流而重排', () => {
    const c = createOutputCollector({ stdoutBudget: 100, stderrBudget: 100, cwd: null });
    c.append(buf('1'), 'stdout');
    c.append(buf('2'), 'stderr');
    c.append(buf('3'), 'stdout');
    expect(c.snapshot().text).toBe('123');
  });
});

describe('保底额 + 共享池', () => {
  it('stderr 洪水能借用共享池，远超自己的保底额（硬切分时代的反向缺陷）', () => {
    // 硬切分实现下 stderr 只能留 4 字节；有共享池后可留 4 + 20 = 24。
    const c = createOutputCollector({
      stdoutReserve: 4,
      stderrReserve: 4,
      sharedBudget: 20,
      cwd: null,
    });
    for (let i = 0; i < 6; i++) c.append(buf('EEEE'), 'stderr'); // 24 字节

    const snap = c.snapshot();
    expect(snap.text).toBe('E'.repeat(24));
    expect(snap.droppedStderr).toBe(0);
  });

  it('一条流借空共享池后，另一条流的保底额依然不可侵占', () => {
    const c = createOutputCollector({
      stdoutReserve: 4,
      stderrReserve: 4,
      sharedBudget: 8,
      cwd: null,
    });
    // stdout 吃掉自己的保底 4 + 全部共享 8 = 12，再往后就该丢
    c.append(buf('A'.repeat(12)), 'stdout');
    c.append(buf('DROP'), 'stdout');
    // stderr 的 4 字节保底没被动过
    c.append(buf('BOOM'), 'stderr');

    const snap = c.snapshot();
    expect(snap.text).toBe(`${'A'.repeat(12)}BOOM`);
    expect(snap.droppedStdout).toBe(4);
    expect(snap.droppedStderr).toBe(0);
  });

  it('共享池先到先得：先刷的那条占住，后来者只剩自己的保底', () => {
    const c = createOutputCollector({
      stdoutReserve: 2,
      stderrReserve: 2,
      sharedBudget: 6,
      cwd: null,
    });
    c.append(buf('A'.repeat(8)), 'stdout'); // 2 保底 + 6 共享，共享池清零
    c.append(buf('EE'), 'stderr'); // 只能用自己的 2 保底
    c.append(buf('XX'), 'stderr'); // 保底用尽且共享池空 → 丢

    const snap = c.snapshot();
    expect(snap.text).toBe(`${'A'.repeat(8)}EE`);
    expect(snap.droppedStderr).toBe(2);
  });

  it('默认预算下 stderr 独占场景可留远超 1MB（对比硬切分的 1MB 上限）', () => {
    const c = createOutputCollector({ cwd: null });
    const mb = Buffer.alloc(1024 * 1024, 0x45);
    for (let i = 0; i < 9; i++) c.append(mb, 'stderr'); // 9MB 全走 stderr

    const snap = c.snapshot();
    // 1MB 保底 + 8MB 共享 = 9MB 全部留下；硬切分实现下这里只会留 1MB
    expect(snap.droppedStderr).toBe(0);
    expect(snap.text.length).toBe(9 * 1024 * 1024);
  });
});

describe('触顶溢出落盘', () => {
  it('文件是完整输出，不是「触顶之后的尾巴」', () => {
    const c = createOutputCollector({ stdoutBudget: 5, stderrBudget: 5, cwd: dir });
    c.append(buf('AAAAA'), 'stdout'); // 进内存，用满
    c.append(buf('BBBBB'), 'stdout'); // 触顶 → 开文件，先冲已有内容再写本块
    c.close();

    const snap = c.snapshot();
    expect(snap.overflowPath).not.toBeNull();
    // 关键：文件含触顶前的 AAAAA，模型不需要自己拼两半
    expect(readFileSync(snap.overflowPath!, 'utf8')).toBe('AAAAABBBBB');
    expect(snap.overflowBytes).toBe(10);
  });

  it('触顶后另一条流仍在预算内的块也写进文件（文件保持全量）', () => {
    const c = createOutputCollector({ stdoutBudget: 3, stderrBudget: 50, cwd: dir });
    c.append(buf('ooo'), 'stdout');
    c.append(buf('XXX'), 'stdout'); // 触顶落盘
    c.append(buf('err'), 'stderr'); // 仍进内存，且也要落盘
    c.close();

    const snap = c.snapshot();
    expect(snap.text).toBe('ooocerr'.replace('c', '')); // 内存：ooo + err
    expect(readFileSync(snap.overflowPath!, 'utf8')).toBe('oooXXXerr');
  });

  it('多字节字符按原始字节落盘，不在 chunk 边界产生替换字符', () => {
    const c = createOutputCollector({ stdoutBudget: 1, stderrBudget: 1, cwd: dir });
    const zh = Buffer.from('中文内容', 'utf8');
    c.append(zh.subarray(0, 5), 'stdout'); // 在「文」中间切断
    c.append(zh.subarray(5), 'stdout');
    c.close();

    const snap = c.snapshot();
    // 文件按字节拼回，内容无损
    expect(readFileSync(snap.overflowPath!, 'utf8')).toBe('中文内容');
  });

  it('未触顶时不产生任何文件（不污染正常路径）', () => {
    const c = createOutputCollector({ stdoutBudget: 100, stderrBudget: 100, cwd: dir });
    c.append(buf('small'), 'stdout');
    c.close();

    expect(c.snapshot().overflowPath).toBeNull();
    expect(readdirSync(dir)).toEqual([]); // 连目录都不建
  });

  it('cwd=null 时完全不碰磁盘，但仍如实计数', () => {
    const c = createOutputCollector({ stdoutBudget: 2, stderrBudget: 2, cwd: null });
    c.append(buf('AA'), 'stdout');
    c.append(buf('BBBB'), 'stdout');
    c.close();

    const snap = c.snapshot();
    expect(snap.overflowPath).toBeNull();
    expect(snap.droppedStdout).toBe(4);
  });

  it('落盘失败时静默降级为纯丢弃，不抛异常、不影响命令结果', () => {
    // 把一个**文件**当作 cwd：mkdirSync 必然失败
    const notADir = join(dir, 'blocker');
    writeFileSync(notADir, 'x');
    const c = createOutputCollector({ stdoutBudget: 2, stderrBudget: 2, cwd: notADir });

    expect(() => {
      c.append(buf('AA'), 'stdout');
      c.append(buf('BBBB'), 'stdout');
      c.close();
    }).not.toThrow();

    const snap = c.snapshot();
    expect(snap.overflowPath).toBeNull(); // 降级
    expect(snap.droppedStdout).toBe(4); // 仍如实报告
  });

  it('溢出文件数超上限时清理最旧的，不无限堆积', () => {
    const outDir = join(dir, '.step-code', 'tool-output');
    mkdirSync(outDir, { recursive: true });
    // 造 25 个旧文件，mtime 递增，便于确认删的是最旧那批
    for (let i = 0; i < 25; i++) {
      const p = join(outDir, `bash-old-${String(i)}.log`);
      writeFileSync(p, 'old');
      const t = new Date(2020, 0, 1, 0, 0, i);
      utimesSync(p, t, t);
    }
    // 无关文件不该被动
    writeFileSync(join(outDir, 'keep-me.txt'), 'keep');

    const c = createOutputCollector({ stdoutBudget: 1, stderrBudget: 1, cwd: dir });
    c.append(buf('A'), 'stdout');
    c.append(buf('B'), 'stdout'); // 触顶 → 清理 + 新建
    c.close();

    const logs = readdirSync(outDir).filter((n) => n.startsWith('bash-') && n.endsWith('.log'));
    expect(logs.length).toBeLessThanOrEqual(20);
    expect(readdirSync(outDir)).toContain('keep-me.txt');
    // 删的是最旧的：old-0 必然已被清掉，最新的 old-24 应还在
    expect(logs).not.toContain('bash-old-0.log');
    expect(logs).toContain('bash-old-24.log');
  });
});

describe('renderOutputNotes：报真实总量 + 给可执行下一步', () => {
  const base: OutputSnapshot = {
    text: 'x',
    droppedStdout: 0,
    droppedStderr: 0,
    overflowPath: null,
    overflowBytes: 0,
  };

  it('没有丢弃时不产生任何提示（不污染正常结果）', () => {
    expect(renderOutputNotes(base, { canDelegate: true })).toEqual([]);
  });

  it('有落盘 + 可派子 agent：优先建议委派，避免把整份日志拉进当前上下文', () => {
    const notes = renderOutputNotes(
      { ...base, droppedStdout: 2048, overflowPath: '/tmp/a.log', overflowBytes: 4096 },
      { canDelegate: true },
    );
    const s = notes.join('\n');
    expect(s).toContain('/tmp/a.log');
    expect(s).toContain('子 agent');
    expect(s).toContain('read_file'); // 自己看的路径也要给
  });

  it('有落盘 + 不能派子 agent：只给自己分页读的路径，不提委派', () => {
    const notes = renderOutputNotes(
      { ...base, droppedStdout: 2048, overflowPath: '/tmp/a.log', overflowBytes: 4096 },
      { canDelegate: false },
    );
    const s = notes.join('\n');
    expect(s).toContain('read_file');
    expect(s).not.toContain('子 agent');
  });

  it('落盘失败：明说不可恢复并给重定向替代路径，不假装还能找回', () => {
    const notes = renderOutputNotes({ ...base, droppedStdout: 2048 }, { canDelegate: true });
    const s = notes.join('\n');
    expect(s).toContain('不可恢复');
    expect(s).toContain('重定向');
    expect(s).not.toContain('已存到');
  });

  it('两条流各自的丢弃量分别列出（不合并成一个模糊总数）', () => {
    const notes = renderOutputNotes(
      { ...base, droppedStdout: 3072, droppedStderr: 1024 },
      { canDelegate: false },
    );
    const s = notes.join('\n');
    expect(s).toContain('stdout 3 KB');
    expect(s).toContain('stderr 1 KB');
  });
});
