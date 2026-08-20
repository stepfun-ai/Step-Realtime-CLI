import { describe, expect, it } from 'vitest';
import { ToolScheduler, type ScheduledTask } from '../../src/agent/toolScheduler.js';
import type { ToolAccess } from '../../src/tools/access.js';

const none: ToolAccess = { kind: 'none' };
const all: ToolAccess = { kind: 'all' };
const read = (path: string): ToolAccess => ({ kind: 'read', path });
const write = (path: string): ToolAccess => ({ kind: 'write', path });

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

/** 按数组顺序回收全部任务（模拟 runTurn 的回收循环：每收一个 drain 一次）。 */
async function settleAll(sch: ToolScheduler, count: number): Promise<void> {
  for (let i = 0; i < count; i++) {
    await sch.waitSettled(i);
    sch.drain();
  }
}

describe('ToolScheduler', () => {
  it('不冲突的任务并行启动（断言并发真实发生）', async () => {
    const log: string[] = [];
    let releaseT0!: () => void;
    const t0Gate = new Promise<void>((r) => {
      releaseT0 = r;
    });
    const tasks: ScheduledTask[] = [
      // t0 等 t1 启动后才放行：若串行执行会死等，并行则自然完成
      { access: none, run: async () => { log.push('s0'); await t0Gate; log.push('e0'); } },
      { access: none, run: async () => { log.push('s1'); releaseT0(); log.push('e1'); } },
    ];
    const sch = new ToolScheduler(tasks, { maxSubagentConcurrent: 4 });
    sch.start();
    await settleAll(sch, 2);
    expect(log).toEqual(['s0', 's1', 'e1', 'e0']);
  });

  it('同路径 write/read 冲突 → 串行，后者等前者完成放行', async () => {
    const log: string[] = [];
    const tasks: ScheduledTask[] = [
      { access: write('/x/f'), run: async () => { log.push('s0'); await tick(); log.push('e0'); } },
      { access: read('/x/f'), run: async () => { log.push('s1'); log.push('e1'); } },
    ];
    const sch = new ToolScheduler(tasks, { maxSubagentConcurrent: 4 });
    sch.start();
    expect(log).toEqual(['s0']); // 冲突的 t1 留在队列
    await settleAll(sch, 2);
    expect(log).toEqual(['s0', 'e0', 's1', 'e1']);
  });

  it('排在 queued 前面的任务也占资源：后来的不冲突任务可插队，冲突的等放行', async () => {
    const log: string[] = [];
    const tasks: ScheduledTask[] = [
      { access: write('/x'), run: async () => { log.push('s0'); await tick(); await tick(); log.push('e0'); } },
      { access: read('/x/a'), run: async () => { log.push('s1'); log.push('e1'); } }, // 与 t0 冲突，入队
      { access: read('/y'), run: async () => { log.push('s2'); log.push('e2'); } }, // 与 t0/t1 都不冲突，立即启动
    ];
    const sch = new ToolScheduler(tasks, { maxSubagentConcurrent: 4 });
    sch.start();
    expect(log).toEqual(['s0', 's2', 'e2']); // t1 入队，t2 插队并行（t2 无等待，当场跑完）
    await settleAll(sch, 3);
    // t2 先完成；t0 完成后 t1 才被放行
    expect(log).toEqual(['s0', 's2', 'e2', 'e0', 's1', 'e1']);
  });

  it('任务异常被隔离：标 done 且后续任务照常放行', async () => {
    const log: string[] = [];
    const tasks: ScheduledTask[] = [
      {
        access: all,
        run: async () => {
          log.push('s0');
          await tick();
          throw new Error('boom'); // 执行体未自捕获时，调度器兜底
        },
      },
      { access: all, run: async () => { log.push('s1'); } },
    ];
    const sch = new ToolScheduler(tasks, { maxSubagentConcurrent: 4 });
    sch.start();
    expect(await sch.waitSettled(0)).toBe('done'); // 异常不向上抛
    sch.drain();
    expect(await sch.waitSettled(1)).toBe('done');
    expect(log).toEqual(['s0', 's1']);
  });

  it('子 agent 槽位：超 maxConcurrent 的第 N+1 个等待，完成一个补一个', async () => {
    const log: string[] = [];
    let concurrent = 0;
    let maxConcurrent = 0;
    const spawnTask = (i: number): ScheduledTask => ({
      access: none, // 资源上不冲突，只受槽位约束
      needsSubagentSlot: true,
      run: async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        log.push(`s${i}`);
        await tick();
        await tick();
        log.push(`e${i}`);
        concurrent--;
      },
    });
    const tasks = [spawnTask(0), spawnTask(1), spawnTask(2)];
    const sch = new ToolScheduler(tasks, { maxSubagentConcurrent: 2 });
    sch.start();
    expect(log).toEqual(['s0', 's1']); // 第 3 个等槽位
    await settleAll(sch, 3);
    expect(maxConcurrent).toBe(2);
    // 槽位按数组顺序先到先得
    expect(log).toEqual(['s0', 's1', 'e0', 's2', 'e1', 'e2']);
  });

  it('abort 后不再启动新任务：pending 标 skipped，已启动的等收敛', async () => {
    const ac = new AbortController();
    const log: string[] = [];
    const tasks: ScheduledTask[] = [
      {
        access: all,
        run: async () => {
          log.push('s0');
          ac.abort(); // 执行中中断
          await tick();
          log.push('e0');
        },
      },
      { access: all, run: async () => { log.push('s1'); } },
    ];
    const sch = new ToolScheduler(tasks, { maxSubagentConcurrent: 4, signal: ac.signal });
    sch.start();
    expect(await sch.waitSettled(0)).toBe('done'); // 已启动的收敛
    sch.drain(); // abort 后的扫描：不再启动 t1
    expect(await sch.waitSettled(1)).toBe('skipped');
    expect(log).toEqual(['s0', 'e0']);
  });
});

describe('ToolScheduler 429 重排队', () => {
  it('策略命中 → 重排队尾重跑，onRequeue 透出延迟与次数', async () => {
    // t0 前两次跑完都被策略要求重排（延迟 10/20ms），第三次收敛；t1 长跑保证批内始终有未完成任务
    let runs0 = 0;
    const requeues: [number, number][] = [];
    let releaseT1!: () => void;
    const t1Gate = new Promise<void>((r) => {
      releaseT1 = r;
    });
    const tasks: ScheduledTask[] = [
      {
        access: none,
        needsSubagentSlot: true,
        run: async () => {
          runs0++;
        },
        shouldRequeue: (n) => (runs0 <= 2 ? (n === 0 ? 10 : 20) : undefined),
      },
      {
        access: none,
        needsSubagentSlot: true,
        run: async () => {
          await t1Gate;
        },
      },
    ];
    const sch = new ToolScheduler(tasks, {
      maxSubagentConcurrent: 2,
      onRequeue: (_i, delay, n) => requeues.push([delay, n]),
    });
    sch.start();
    const settled0 = sch.waitSettled(0);
    setTimeout(() => releaseT1(), 300); // 等 t0 重排两次跑完第三次，再放行 t1
    expect(await settled0).toBe('done');
    sch.drain();
    expect(await sch.waitSettled(1)).toBe('done');
    expect(runs0).toBe(3);
    expect(requeues).toEqual([
      [10, 1],
      [20, 2],
    ]);
  });

  it('唯一未完成任务不重排（防死锁）：策略要求重排也直接收敛', async () => {
    let runs = 0;
    const requeues: number[] = [];
    const tasks: ScheduledTask[] = [
      {
        access: none,
        needsSubagentSlot: true,
        run: async () => {
          runs++;
        },
        shouldRequeue: () => 10,
      },
    ];
    const sch = new ToolScheduler(tasks, {
      maxSubagentConcurrent: 1,
      onRequeue: (_i, d) => requeues.push(d),
    });
    sch.start();
    expect(await sch.waitSettled(0)).toBe('done');
    expect(runs).toBe(1);
    expect(requeues).toEqual([]);
  });

  it('无重排策略的任务（非 429 等）跑完直接收敛，不重排', async () => {
    let runs = 0;
    const tasks: ScheduledTask[] = [
      {
        access: none,
        run: async () => {
          runs++;
        },
      },
      {
        access: none,
        run: async () => {
          await tick();
        },
      },
    ];
    const sch = new ToolScheduler(tasks, { maxSubagentConcurrent: 4 });
    sch.start();
    expect(await sch.waitSettled(0)).toBe('done');
    sch.drain();
    expect(await sch.waitSettled(1)).toBe('done');
    expect(runs).toBe(1);
  });

  it('重排期间让出子 agent 槽位：等待中的兄弟任务先补位，被限流任务延迟后最后重跑', async () => {
    const log: string[] = [];
    const tasks: ScheduledTask[] = [
      {
        access: none,
        needsSubagentSlot: true,
        run: async () => {
          log.push('r0');
        },
        shouldRequeue: (n) => (n === 0 ? 50 : undefined), // 第一次必重排
      },
      {
        access: none,
        needsSubagentSlot: true,
        run: async () => {
          log.push('r1');
          await tick();
          await tick();
          await tick();
        },
      },
      {
        access: none,
        needsSubagentSlot: true,
        run: async () => {
          log.push('r2');
        },
      },
    ];
    const sch = new ToolScheduler(tasks, { maxSubagentConcurrent: 2 });
    sch.start();
    // t0/t1 先起跑；t0 立即"被限流"重排让出槽位 → t2 补位；t0 延迟 50ms 后最后重跑
    for (let i = 0; i < 3; i++) {
      await sch.waitSettled(i);
      sch.drain();
    }
    expect(log).toEqual(['r0', 'r1', 'r2', 'r0']);
  });
});
