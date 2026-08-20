/**
 * 堆水位看护的行为测试。
 *
 * 水位与落盘都走注入，不真把堆撑到 GB 级、也不真写几十 MB 的快照——那样测一次要几分钟，
 * 且结果依赖机器内存。这里要验的是判定逻辑：什么水位做什么、以及「只做一次」。
 */
import { describe, expect, it } from 'vitest';
import { checkHeapOnce, type HeapWatchState } from '../../src/tui-pi/heapWatch.js';

const GB = 1024 * 1024 * 1024;

function mk(): { state: HeapWatchState; notes: string[]; dumps: string[] } {
  return { state: { warned: false, dumped: false }, notes: [], dumps: [] };
}

function opts(ctx: ReturnType<typeof mk>, used: number, limit = 4 * GB) {
  return {
    notify: (t: string) => ctx.notes.push(t),
    dumpDir: '/tmp/x',
    readHeap: () => ({ used, limit }),
    writeSnapshot: (p: string) => {
      ctx.dumps.push(p);
      return p;
    },
  };
}

describe('堆水位看护', () => {
  it('水位低于警戒线：什么都不做', () => {
    const ctx = mk();
    checkHeapOnce(ctx.state, opts(ctx, 1 * GB)); // 25%
    expect(ctx.notes).toEqual([]);
    expect(ctx.dumps).toEqual([]);
  });

  it('过警戒线：提示一次，且提示里给出可执行动作与具体数字', () => {
    const ctx = mk();
    checkHeapOnce(ctx.state, opts(ctx, 2.6 * GB)); // 65%
    expect(ctx.notes).toHaveLength(1);
    // 光说「内存高」没用，要让用户知道高多少、该做什么
    expect(ctx.notes[0]).toMatch(/2662MB/);
    expect(ctx.notes[0]).toMatch(/4096MB/);
    expect(ctx.notes[0]).toContain('/new');
    expect(ctx.dumps).toEqual([]);
  });

  it('警戒提示只发一次（反复提示是噪声，用户会开始忽略它）', () => {
    const ctx = mk();
    for (let i = 0; i < 5; i++) checkHeapOnce(ctx.state, opts(ctx, 2.8 * GB));
    expect(ctx.notes).toHaveLength(1);
  });

  it('过危险线：dump 一份快照，并在写之前先提示（写快照会卡住进程几秒）', () => {
    const ctx = mk();
    checkHeapOnce(ctx.state, opts(ctx, 3.4 * GB)); // 85%
    expect(ctx.dumps).toHaveLength(1);
    expect(ctx.dumps[0]).toMatch(/heap-\d+\.heapsnapshot$/);
    // 两条提示：动作前的说明 + 落盘路径；顺序不能颠倒
    expect(ctx.notes).toHaveLength(2);
    expect(ctx.notes[0]).toContain('正在导出快照');
    expect(ctx.notes[1]).toContain(ctx.dumps[0]!);
    // 含会话正文，必须提醒别公开发
    expect(ctx.notes[1]).toMatch(/私下|会话正文/);
  });

  it('快照只 dump 一次（每份几十上百 MB，反复写会把磁盘填满）', () => {
    const ctx = mk();
    for (let i = 0; i < 4; i++) checkHeapOnce(ctx.state, opts(ctx, 3.6 * GB));
    expect(ctx.dumps).toHaveLength(1);
  });

  it('dump 失败不抛错，转成提示（看护自身不能拖垮主流程）', () => {
    const ctx = mk();
    const o = {
      ...opts(ctx, 3.5 * GB),
      writeSnapshot: () => {
        throw new Error('磁盘满');
      },
    };
    expect(() => checkHeapOnce(ctx.state, o)).not.toThrow();
    expect(ctx.notes.some((n) => n.includes('磁盘满'))).toBe(true);
  });

  /**
   * 阈值按比例而非固定字节：Node 的堆上限随版本与 --max-old-space-size 变化。
   * 写死 1.5GB 在 8GB 上限的机器上会过早喊，在 2GB 上限的机器上又来不及。
   */
  it('阈值随堆上限缩放：同样的绝对用量，在不同上限下判定不同', () => {
    const small = mk();
    checkHeapOnce(small.state, opts(small, 1.5 * GB, 2 * GB)); // 75% → 该警戒
    expect(small.notes).toHaveLength(1);

    const large = mk();
    checkHeapOnce(large.state, opts(large, 1.5 * GB, 8 * GB)); // 19% → 不该动
    expect(large.notes).toEqual([]);
  });

  it('limit 取不到（返回 0）时不误判', () => {
    const ctx = mk();
    checkHeapOnce(ctx.state, opts(ctx, 1 * GB, 0));
    expect(ctx.notes).toEqual([]);
    expect(ctx.dumps).toEqual([]);
  });
});

describe('提示顺序（真机实测暴露的问题）', () => {
  /**
   * 启动时水位就已过危险线的场景：首次检查直接 dump，不能在下一次检查再补一条警戒。
   * 那样用户先看到「正在导出快照」，一秒后才看到「内存 1%」，读起来是倒的。
   * dump 的提示本身已带水位数字，警戒是多余的。
   */
  it('首检就过危险线：只发 dump 相关提示，后续不再补发警戒', () => {
    const ctx = mk();
    const o = opts(ctx, 3.5 * GB);
    checkHeapOnce(ctx.state, o);
    const afterFirst = ctx.notes.length;
    // 再检查几次，水位维持高位
    for (let i = 0; i < 3; i++) checkHeapOnce(ctx.state, o);
    expect(ctx.notes).toHaveLength(afterFirst);
    expect(ctx.notes.some((n) => n.includes('长会话会持续变重'))).toBe(false);
  });
});
