/**
 * 后台任务终态后的引用释放（回归：2026-08-16 的 4GB OOM）。
 *
 * `tasks` Map 里的条目在任务完成后不删除——这是有意的，`task_list` / `task_output` 还要读它，
 * 元数据本身只有几百字节。问题在条目上挂着的三个**重引用**：
 *
 * - `onStop`：子 agent 任务的中断钩子，闭包捕获 AbortController。控制器持有它 signal 上
 *   注册的全部 abort 监听器，而子 agent 跑一趟会注册一批（每次 provider fetch、每个工具
 *   调用），那些闭包各自捕获着请求缓冲与消息数组。于是一条
 *   `tasks → onStop → controller → signal → listeners → 子 agent 整份上下文` 的链在任务
 *   结束后依然完整。
 * - `proc`：已退出进程的 ChildProcess 句柄，连着 stdout/stderr 的内部缓冲。
 * - `getPartialOutput`：前台命令的输出取值器，捕获调用方的收集缓冲。
 *
 * 事故现场：109 分钟、29 个后台任务、堆 4GB 且 Mark-Compact 一个字节都回收不动（全是活对象）。
 * 会话文件只有 240KB，所以泄漏量与会话内容无关——与「跑过多少个子 agent」有关。
 *
 * `stop()` 在 status !== 'running' 时直接返回，终态后这三个字段再无读取方，可以安全丢弃。
 */
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import { BackgroundManager } from '../../src/agent/background/manager.js';

function acquireGc(): (() => void) | undefined {
  if (typeof global.gc === 'function') return global.gc.bind(global);
  try {
    setFlagsFromString('--expose-gc');
    const fn = runInNewContext('gc') as unknown;
    return typeof fn === 'function' ? (fn as () => void) : undefined;
  } catch {
    return undefined;
  }
}

const gc = acquireGc();
const canGc = gc !== undefined;

function heapAfterGc(): number {
  gc!();
  gc!();
  return process.memoryUsage().heapUsed;
}

/** 每个任务捕获约 4MB，模拟子 agent 上下文的量级。 */
const PAYLOAD_BYTES = 4 * 1024 * 1024;

/**
 * 堆内 payload。不能用 `Buffer.allocUnsafe`——Buffer 走堆外（external）内存，
 * `heapUsed` 完全看不见它，测出来必然是 0 增长、断言必然通过。第一版就是这么写的，
 * 红都红不出来（下方对照组是唯一能发现这件事的东西）。
 */
function makePayload(): unknown {
  // 每个元素一个独立对象，强制留在堆上；约 4MB 量级
  const n = Math.floor(PAYLOAD_BYTES / 64);
  const arr: { i: number; s: string }[] = new Array(n);
  for (let i = 0; i < n; i++) arr[i] = { i, s: 'x' };
  return arr;
}

/**
 * 跑 n 个后台子 agent 任务，每个都把一块 payload 挂在 AbortController 的 abort 监听器上
 * （复刻真实链路：provider 请求把自己的缓冲注册进 signal，等回合结束才该释放）。
 * 返回全部任务终态后、强制 GC 后的堆增量。
 */
async function measureRetention(n: number): Promise<number> {
  const mgr = new BackgroundManager({});
  const before = heapAfterGc();
  for (let i = 0; i < n; i++) {
    const ctrl = new AbortController();
    // 这块 payload 只被 abort 监听器捕获：任务结束后除了 onStop → ctrl 这条路，没人再引用它
    const payload = makePayload();
    ctrl.signal.addEventListener('abort', () => {
      // 引用 payload，让闭包真的捕获它（不能只写注释，V8 会优化掉未使用的捕获）
      if (Array.isArray(payload) && payload.length === 0) throw new Error('unreachable');
    });
    const run = Promise.resolve({ output: `任务 ${i} 完成`, ok: true });
    mgr.startTask(`子agent·任务${i}`, run, undefined, { kind: 'subagent' }, { onStop: () => ctrl.abort() });
  }
  // 等所有 async 任务落终态（registerAsyncTask 的 then 在微任务队列里）
  await new Promise((r) => setTimeout(r, 50));
  const tasks = mgr.list();
  expect(tasks).toHaveLength(n);
  expect(tasks.every((t) => t.status !== 'running')).toBe(true);
  return heapAfterGc() - before;
}

describe.skipIf(!canGc)('后台任务终态后不得钉住子 agent 上下文', () => {
  it('20 个已完成的子 agent 任务：堆增量远小于 payload 总量', async () => {
    const growth = await measureRetention(20);
    const totalPayload = 20 * PAYLOAD_BYTES;
    // 修复前：20 × 4MB = 80MB 全部钉住。修复后应只剩元数据（几十 KB 量级）。
    // 阈值取总量的 1/4，既能容忍测量噪声，也能在 onStop 未释放时（80MB）稳定报红。
    expect(
      growth,
      `堆增量 ${(growth / 1024 / 1024).toFixed(1)}MB，接近 payload 总量 ${totalPayload / 1024 / 1024}MB。` +
        '终态任务的 onStop/proc/getPartialOutput 可能又被保留了，见 manager.ts 的 settle()',
    ).toBeLessThan(totalPayload / 4);
  }, 60_000);

  it('增量不随任务数线性上升（40 个不应是 20 个的两倍）', async () => {
    const g20 = await measureRetention(20);
    const g40 = await measureRetention(40);
    // 泄漏未修时两者严格线性（80MB vs 160MB）。修好后都在噪声量级，比值失去线性。
    expect(
      g40,
      `20 个增量 ${(g20 / 1024 / 1024).toFixed(1)}MB，40 个增量 ${(g40 / 1024 / 1024).toFixed(1)}MB，` +
        '呈线性说明每个终态任务仍各钉一份上下文',
    ).toBeLessThan(40 * PAYLOAD_BYTES / 4);
  }, 60_000);
});

describe.skipIf(!canGc)('对照组：测量方法本身必须能测出这类保留', () => {
  /**
   * 不经 BackgroundManager，直接把 20 份 payload 挂在自己持有的数组上。
   * 这条**必须**测出接近总量的增长；测不出说明 payload 不在堆上（Buffer 就是这种情况）
   * 或 GC 时机不对，此时上面两条绿了也说明不了任何事。
   */
  it('手工保留 20 份 payload：能测出接近总量的堆增长', () => {
    const before = heapAfterGc();
    const held: unknown[] = [];
    for (let i = 0; i < 20; i++) held.push(makePayload());
    const growth = heapAfterGc() - before;
    expect(held).toHaveLength(20);
    expect(
      growth,
      `手工保留 20 × 4MB 只测出 ${(growth / 1024 / 1024).toFixed(1)}MB 增长，` +
        '说明测量方法失效（payload 可能在堆外，或 GC 时机不对），上面两条断言不可信',
    ).toBeGreaterThan(10 * 1024 * 1024);
  }, 60_000);
});

describe('终态释放不得让超时进程变孤儿', () => {
  /**
   * 超时终止是「先 SIGTERM，宽限期（2s）后补 SIGKILL」，中间夹着 settle()——而 settle()
   * 现在会把 task.proc 清空以断开泄漏链。若 SIGKILL 兜底仍读 task.proc，宽限期到点时
   * 只会拿到 undefined，温和终止没成功的进程就此变孤儿继续跑。
   *
   * 这个仓库有过一次同类事故（2026-08-10：任务标 killed 后孙进程又写了 24GB），所以
   * 这条时序不能只靠读源码保证。killProc 这个注入缝就是为它开的。
   */
  it('SIGKILL 兜底拿到的仍是原句柄（不是被 settle 清空后的 undefined）', async () => {
    const calls: { proc: unknown; signal: string }[] = [];
    const mgr = new BackgroundManager(10, {
      taskTimeoutS: 0.05,
      killProc: (proc, signal) => calls.push({ proc, signal }),
    });
    // 假进程：只需 pid 存在（真实实现据此 taskkill），且不响应 SIGTERM（exited 保持 false）
    const fakeProc = { pid: 99999, on: () => {}, once: () => {}, stdout: null, stderr: null } as never;
    const id = mgr.adopt('sleep 999', fakeProc, '');
    // 等超时触发 SIGTERM + 宽限期（2s）后的 SIGKILL
    await new Promise((r) => setTimeout(r, 2400));

    const term = calls.find((c) => c.signal === 'SIGTERM');
    const kill = calls.find((c) => c.signal === 'SIGKILL');
    expect(term, 'SIGTERM 没发出，超时路径没走到').toBeDefined();
    expect(kill, 'SIGKILL 兜底没发出').toBeDefined();
    expect(
      kill?.proc,
      'SIGKILL 拿到的是 undefined：settle() 清空 task.proc 后兜底定时器才执行，进程会变孤儿',
    ).toBe(fakeProc);
    expect(mgr.list().find((t) => t.id === id)?.status).toBe('killed');
  }, 15_000);
});
