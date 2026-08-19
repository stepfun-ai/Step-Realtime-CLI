import { spawn, type ChildProcess } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { BackgroundManager, type BackgroundTask } from '../../src/agent/background/manager.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * 轮询等条件成立，而不是固定睡一段。
 *
 * 固定 `sleep(500)` 单跑够、全量并发跑（176 个测试文件抢 CPU）时不够：子进程 spawn +
 * exit 事件被拖到 500ms 之后，断言就偶发失败——测的是机器闲忙，不是代码对错。
 */
const waitUntil = async (cond: () => boolean, timeoutMs = 8000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!cond() && Date.now() < deadline) await sleep(25);
};

const SH = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh';
const shArgs = (cmd: string): string[] => (process.platform === 'win32' ? ['/c', cmd] : ['-c', cmd]);
const LONG_CMD = process.platform === 'win32' ? 'ping -n 30 127.0.0.1 >nul' : 'sleep 25';

describe('BackgroundManager onSettleEvent（终态事件钩）', () => {
  it('自然终态触发 onSettleEvent，载荷是公开任务视图', async () => {
    const events: BackgroundTask[] = [];
    const mgr = new BackgroundManager(10, { onSettleEvent: (t) => events.push(t) });
    mgr.start('echo hi', SH, shArgs('echo hi'), process.cwd());
    await waitUntil(() => events.length >= 1);
    expect(events).toHaveLength(1);
    expect(events[0]!.status).toBe('completed');
    expect(events[0]!.command).toBe('echo hi');
  });

  it('被抑制通知的任务（task_stop 亲手杀的）同样触发 onSettleEvent（审计覆盖与通知解耦）', () => {
    const events: BackgroundTask[] = [];
    const settled: BackgroundTask[] = [];
    const mgr = new BackgroundManager(10, {
      onSettleEvent: (t) => events.push(t),
      onSettle: (t) => settled.push(t),
    });
    const id = mgr.start('long', SH, shArgs(LONG_CMD), process.cwd());
    mgr.suppressNotification(id);
    mgr.stop(id);
    expect(events).toHaveLength(1);
    expect(events[0]!.status).toBe('killed');
    expect(settled).toHaveLength(0); // 通知通道仍被抑制
  });
});

describe('BackgroundManager onSettle', () => {
  it('startTask 带 meta：list 返回 kind/agentType，供 /tasks 面板分类展示', async () => {
    const mgr = new BackgroundManager();
    const id = mgr.startTask('子agent·翻译', Promise.resolve({ output: 'done', ok: true }), undefined, {
      kind: 'subagent',
      agentType: 'explore',
    });
    const wfId = mgr.startTask('workflow·调研', Promise.resolve({ output: 'ok', ok: true }), undefined, {
      kind: 'workflow',
    });
    const tasks = mgr.list();
    const sub = tasks.find((t) => t.id === id);
    const wf = tasks.find((t) => t.id === wfId);
    expect(sub?.kind).toBe('subagent');
    expect(sub?.agentType).toBe('explore');
    expect(wf?.kind).toBe('workflow');
    expect(wf?.agentType).toBeUndefined();
    await sleep(100); // 让两个 promise 任务走到终态，避免悬挂
  });

  it('任务完成时触发 onSettle（completed），带输出尾部', async () => {
    const settled: BackgroundTask[] = [];
    const mgr = new BackgroundManager(10, { onSettle: (t) => settled.push(t) });
    mgr.start('echo hi', SH, shArgs('echo hi'), process.cwd());
    await waitUntil(() => settled.length >= 1);
    expect(settled).toHaveLength(1);
    expect(settled[0]!.status).toBe('completed');
    expect(settled[0]!.output).toContain('hi');
  });

  it('任务失败时触发 onSettle（failed），带退出码', async () => {
    const settled: BackgroundTask[] = [];
    const mgr = new BackgroundManager(10, { onSettle: (t) => settled.push(t) });
    mgr.start('exit 3', SH, shArgs('exit 3'), process.cwd());
    await waitUntil(() => settled.length >= 1);
    expect(settled).toHaveLength(1);
    expect(settled[0]!.status).toBe('failed');
    expect(settled[0]!.exitCode).toBe(3);
  });

  it('stop 终止时触发 onSettle（killed）', async () => {
    const settled: BackgroundTask[] = [];
    const mgr = new BackgroundManager(10, { onSettle: (t) => settled.push(t) });
    const id = mgr.start('long', SH, shArgs(LONG_CMD), process.cwd());
    expect(mgr.stop(id)).toBe(true);
    expect(settled).toHaveLength(1);
    expect(settled[0]!.status).toBe('killed');
  });

  it('去重：同一任务终态后 stop 不再触发，onSettle 只发一次', async () => {
    const settled: BackgroundTask[] = [];
    const mgr = new BackgroundManager(10, { onSettle: (t) => settled.push(t) });
    const id = mgr.start('echo hi', SH, shArgs('echo hi'), process.cwd());
    await waitUntil(() => mgr.get(id)?.status !== "running");
    expect(mgr.stop(id)).toBe(false); // 已终态，无法再停
    await sleep(200);
    expect(settled).toHaveLength(1);
  });

  it('shutdown 终止在途任务并断开结算回调（防切会话回灌，P0 同源）', async () => {
    // rebindBackground 只换引用不终止旧管理器，旧管理器在途任务 settle 时回调经捕获的
    // PiChat this 回灌到新 session（污染转录 / 误报通知 / 注入模型上下文）。shutdown 必须先
    // 置空回调再杀任务，使 settle 短路零回灌。
    const settled: BackgroundTask[] = [];
    const mgr = new BackgroundManager(10, { onSettle: (t) => settled.push(t) });
    const procId = mgr.start('long', SH, shArgs(LONG_CMD), process.cwd());
    // 延迟 resolve 的 async 任务，模拟尚未完成的后台子 agent
    let resolveLate!: (v: { output: string; ok: boolean }) => void;
    mgr.startTask('async·未完成', new Promise<{ output: string; ok: boolean }>((res) => { resolveLate = res; }), undefined, {
      kind: 'subagent',
    });

    mgr.shutdown();

    // 在途 proc 任务被终止，不再是 running
    expect(mgr.get(procId)?.status).not.toBe('running');
    // 回调已断开：shutdown 期间 stop() 触发的 settle 不外泄
    expect(settled).toHaveLength(0);

    // async 任务在 shutdown 之后才 resolve，结算回调已断开，仍不外泄（不回灌新 session）
    resolveLate({ output: 'late', ok: true });
    await sleep(50);
    expect(settled).toHaveLength(0);
  });

  it('后台超时到期自动终止：先置 killed 并触发 onSettle', async () => {
    const settled: BackgroundTask[] = [];
    const mgr = new BackgroundManager(10, { taskTimeoutS: 1, onSettle: (t) => settled.push(t) });
    const id = mgr.start('long', SH, shArgs(LONG_CMD), process.cwd());
    expect(mgr.get(id)?.status).toBe('running');
    await waitUntil(() => mgr.get(id)?.status === "killed", 10000);
    expect(mgr.get(id)?.status).toBe('killed');
    expect(mgr.get(id)?.output).toContain('后台任务超时（1s）');
    expect(settled).toHaveLength(1);
    expect(settled[0]!.status).toBe('killed');
  });

  it('taskTimeoutS=0 时不武装超时', async () => {
    const mgr = new BackgroundManager(10, { taskTimeoutS: 0 });
    const id = mgr.start('echo hi', SH, shArgs('echo hi'), process.cwd());
    await waitUntil(() => mgr.get(id)?.status === "completed");
    expect(mgr.get(id)?.status).toBe('completed');
  });

  it('startTask 的 async 任务终态同样触发 onSettle', async () => {
    const settled: BackgroundTask[] = [];
    const mgr = new BackgroundManager(10, { onSettle: (t) => settled.push(t) });
    mgr.startTask('async', Promise.resolve({ output: 'done', ok: true }));
    await sleep(100);
    expect(settled).toHaveLength(1);
    expect(settled[0]!.status).toBe('completed');
  });
});

describe('BackgroundManager drainSettled', () => {
  it('终态任务进入待投递队列，drain 一次取空', async () => {
    const mgr = new BackgroundManager(10);
    mgr.startTask('a', Promise.resolve({ output: 'A', ok: true }));
    mgr.startTask('b', Promise.resolve({ output: 'B', ok: true }));
    await sleep(100);
    const drained = mgr.drainSettled();
    expect(drained.map((t) => t.command)).toEqual(['a', 'b']);
    expect(mgr.drainSettled()).toEqual([]); // 已取空，不重复投递
  });

  it('suppressNotification 后 stop：不触发 onSettle，也不入待投递队列', async () => {
    const settled: BackgroundTask[] = [];
    const mgr = new BackgroundManager(10, { onSettle: (t) => settled.push(t) });
    const id = mgr.start('long', SH, shArgs(LONG_CMD), process.cwd());
    mgr.suppressNotification(id);
    expect(mgr.stop(id)).toBe(true);
    await sleep(200);
    expect(settled).toHaveLength(0);
    expect(mgr.drainSettled()).toEqual([]);
  });

  it('自然终态的任务不受 suppress 影响：照发通知并入队', async () => {
    const settled: BackgroundTask[] = [];
    const mgr = new BackgroundManager(10, { onSettle: (t) => settled.push(t) });
    mgr.start('echo hi', SH, shArgs('echo hi'), process.cwd());
    await waitUntil(() => settled.length >= 1);
    expect(settled).toHaveLength(1);
    expect(mgr.drainSettled()).toHaveLength(1);
  });
});

describe('BackgroundManager 前台任务（registerForeground / detach）', () => {
  const spawnFg = (cmd: string): ChildProcess => spawn(SH, shArgs(cmd), { cwd: process.cwd() });

  it('registerForeground：listForeground 可见、不计入后台徽章计数、计入并发上限', () => {
    const mgr = new BackgroundManager(1);
    const proc = spawnFg(LONG_CMD);
    const id = mgr.registerForeground('long', proc, () => '');
    expect(mgr.listForeground().map((t) => t.id)).toEqual([id]);
    expect(mgr.activeBackgroundCount()).toBe(0); // 未 detach 不算后台
    expect(mgr.activeCount()).toBe(1); // 但占并发额度
    expect(() => mgr.start('x', SH, shArgs('echo x'), process.cwd())).toThrow(/上限/);
    expect(mgr.isDetached(id)).toBe(false);
    expect(mgr.get(id)?.kind).toBe('process'); // 前台登记的 bash 任务分类为 process
    proc.kill();
  });

  it('detach：翻标志、解除抑制、接管输出、释放等待方（detached），徽章计数 +1', async () => {
    const settled: BackgroundTask[] = [];
    const mgr = new BackgroundManager(10, { onSettle: (t) => settled.push(t) });
    const proc = spawnFg('echo before && echo after');
    let partial = '已收集的部分输出';
    const id = mgr.registerForeground('cmd', proc, () => partial);
    const release = mgr.waitForegroundRelease(id);
    expect(mgr.detach(id)).toBe(true);
    await expect(release).resolves.toBe('detached');
    expect(mgr.listForeground()).toEqual([]);
    expect(mgr.activeBackgroundCount()).toBe(1);
    expect(mgr.isDetached(id)).toBe(true);
    // 接管后输出继续追加（detach 前的部分输出为起点）
    await waitUntil(() => settled.length >= 1);
    expect(mgr.get(id)?.output).toContain('已收集的部分输出');
    expect(mgr.get(id)?.output).toContain('after');
    // 终态照常通知（抑制已解除）
    expect(settled).toHaveLength(1);
    expect(settled[0]!.status).toBe('completed');
    partial = '';
  });

  it('detach(viaTimeout)：等待方收到 timeout_detached，且后台超时重新武装', async () => {
    const settled: BackgroundTask[] = [];
    const mgr = new BackgroundManager(10, { taskTimeoutS: 1, onSettle: (t) => settled.push(t) });
    const proc = spawnFg(LONG_CMD);
    const id = mgr.registerForeground('long', proc, () => '');
    const release = mgr.waitForegroundRelease(id);
    expect(mgr.detach(id, true)).toBe(true);
    await expect(release).resolves.toBe('timeout_detached');
    await waitUntil(() => mgr.get(id)?.status === "killed", 10000);
    expect(mgr.get(id)?.status).toBe('killed');
    expect(mgr.get(id)?.output).toContain('后台任务超时（1s）');
    expect(settled).toHaveLength(1);
  });

  it('重复 detach 与终态后 detach 均为 no-op（返回 false）', async () => {
    const mgr = new BackgroundManager(10);
    const proc = spawnFg(LONG_CMD);
    const id = mgr.registerForeground('long', proc, () => '');
    expect(mgr.detach(id)).toBe(true);
    expect(mgr.detach(id)).toBe(false);
    await sleep(300);
    mgr.stop(id);
    expect(mgr.detach(id)).toBe(false);
  });

  it('settleForeground：静默终态——不触发 onSettle、不入待投递队列、等待方收到 terminal', async () => {
    const settled: BackgroundTask[] = [];
    const mgr = new BackgroundManager(10, { onSettle: (t) => settled.push(t) });
    const proc = spawnFg('echo hi');
    const id = mgr.registerForeground('cmd', proc, () => 'hi\n');
    const release = mgr.waitForegroundRelease(id);
    mgr.settleForeground(id, 0);
    await expect(release).resolves.toBe('terminal');
    expect(mgr.get(id)?.status).toBe('completed');
    expect(mgr.get(id)?.output).toBe('hi\n');
    expect(settled).toHaveLength(0);
    expect(mgr.drainSettled()).toEqual([]);
    expect(mgr.activeCount()).toBe(0);
    proc.kill();
  });

  it('竞争：先 settleForeground 后 detach 为 no-op；已终态任务 waitForegroundRelease 立即 terminal', async () => {
    const mgr = new BackgroundManager(10);
    const proc = spawnFg('echo hi');
    const id = mgr.registerForeground('cmd', proc, () => '');
    mgr.settleForeground(id, 0);
    expect(mgr.detach(id)).toBe(false);
    await expect(mgr.waitForegroundRelease(id)).resolves.toBe('terminal');
    proc.kill();
  });

  it('竞争：detach 后进程才结束——由接管的监听置终态并通知（监听未被误摘）', async () => {
    const settled: BackgroundTask[] = [];
    const mgr = new BackgroundManager(10, { onSettle: (t) => settled.push(t) });
    const proc = spawnFg('echo done');
    const id = mgr.registerForeground('cmd', proc, () => '');
    expect(mgr.detach(id)).toBe(true);
    await waitUntil(() => mgr.get(id)?.status === "completed");
    expect(mgr.get(id)?.status).toBe('completed');
    expect(settled).toHaveLength(1);
    expect(settled[0]!.output).toContain('done');
  });

  it('error 路径：settleForeground 带错误信息置 failed，同样静默', async () => {
    const mgr = new BackgroundManager(10);
    const proc = spawnFg('echo hi');
    const id = mgr.registerForeground('cmd', proc, () => 'partial');
    mgr.settleForeground(id, null, 'boom');
    expect(mgr.get(id)?.status).toBe('failed');
    expect(mgr.get(id)?.output).toContain('boom');
    expect(mgr.drainSettled()).toEqual([]);
    proc.kill();
  });
});

describe('BackgroundManager 前台 async 任务（startForegroundTask）', () => {
  const deferred = <T,>(): { promise: Promise<T>; resolve: (v: T) => void } => {
    let resolve!: (v: T) => void;
    const promise = new Promise<T>((res) => {
      resolve = res;
    });
    return { promise, resolve };
  };

  it('登记：listForeground 可见、带 kind/agentType、不计入后台徽章、正常终态静默', async () => {
    const settled: BackgroundTask[] = [];
    const mgr = new BackgroundManager(10, { onSettle: (t) => settled.push(t) });
    const id = mgr.startForegroundTask('子agent·查资料', Promise.resolve({ output: 'done', ok: true }), {
      kind: 'subagent',
      agentType: 'general',
    });
    expect(mgr.listForeground().map((t) => t.id)).toEqual([id]);
    expect(mgr.activeBackgroundCount()).toBe(0);
    expect(mgr.get(id)?.kind).toBe('subagent');
    expect(mgr.get(id)?.agentType).toBe('general');
    expect(mgr.isDetached(id)).toBe(false);
    await sleep(50);
    expect(mgr.get(id)?.status).toBe('completed');
    expect(mgr.get(id)?.output).toBe('done');
    // 前台任务抑制终态通知：不触发 onSettle、不入待投递队列
    expect(settled).toHaveLength(0);
    expect(mgr.drainSettled()).toEqual([]);
  });

  it('detach：翻标志、释放等待方、解除抑制，终态走通知链路（onSettle + 待投递队列）', async () => {
    const settled: BackgroundTask[] = [];
    const mgr = new BackgroundManager(10, { onSettle: (t) => settled.push(t) });
    const run = deferred<{ output: string; ok: boolean }>();
    const id = mgr.startForegroundTask('子agent·查资料', run.promise, { kind: 'subagent' });
    const release = mgr.waitForegroundRelease(id);
    expect(mgr.detach(id)).toBe(true);
    await expect(release).resolves.toBe('detached');
    expect(mgr.listForeground()).toEqual([]);
    expect(mgr.activeBackgroundCount()).toBe(1);
    expect(mgr.detach(id)).toBe(false); // 重复 detach 为 no-op
    run.resolve({ output: '终态结果', ok: true });
    await sleep(50);
    expect(mgr.get(id)?.status).toBe('completed');
    expect(settled).toHaveLength(1);
    expect(settled[0]!.output).toBe('终态结果');
    expect(mgr.drainSettled().map((t) => t.id)).toEqual([id]);
  });

  it('stop 前台 async 任务：onStop 钩子被调、置 killed、迟到结果不覆盖终态、抑制下静默', async () => {
    const settled: BackgroundTask[] = [];
    const mgr = new BackgroundManager(10, { onSettle: (t) => settled.push(t) });
    let stopped = 0;
    const run = deferred<{ output: string; ok: boolean }>();
    const id = mgr.startForegroundTask('子agent·查资料', run.promise, { kind: 'subagent' }, {
      onStop: () => {
        stopped += 1;
      },
    });
    expect(mgr.stop(id)).toBe(true);
    expect(stopped).toBe(1);
    expect(mgr.get(id)?.status).toBe('killed');
    run.resolve({ output: 'late', ok: true });
    await sleep(50);
    expect(mgr.get(id)?.status).toBe('killed'); // 迟到结果不覆盖
    expect(settled).toHaveLength(0); // 前台抑制仍生效
    expect(mgr.drainSettled()).toEqual([]);
  });

  it('detach 后 stop：onStop 被调且照发通知（抑制已随 detach 解除）', async () => {
    const settled: BackgroundTask[] = [];
    const mgr = new BackgroundManager(10, { onSettle: (t) => settled.push(t) });
    let stopped = 0;
    const run = deferred<{ output: string; ok: boolean }>();
    const id = mgr.startForegroundTask('子agent·查资料', run.promise, { kind: 'subagent' }, {
      onStop: () => {
        stopped += 1;
      },
    });
    expect(mgr.detach(id)).toBe(true);
    expect(mgr.stop(id)).toBe(true);
    expect(stopped).toBe(1);
    expect(mgr.get(id)?.status).toBe('killed');
    expect(settled).toHaveLength(1);
    expect(settled[0]!.status).toBe('killed');
  });

  it('detach 后武装后台超时：到期 terminate 也走 onStop 钩子', async () => {
    const settled: BackgroundTask[] = [];
    const mgr = new BackgroundManager(10, { taskTimeoutS: 1, onSettle: (t) => settled.push(t) });
    let stopped = 0;
    const run = deferred<{ output: string; ok: boolean }>();
    const id = mgr.startForegroundTask('子agent·查资料', run.promise, { kind: 'subagent' }, {
      onStop: () => {
        stopped += 1;
      },
    });
    await sleep(1200); // 前台期间不武装：超时不到期
    expect(mgr.get(id)?.status).toBe('running');
    expect(stopped).toBe(0);
    expect(mgr.detach(id)).toBe(true);
    await sleep(1200); // detach 后武装的 1s 超时到期
    expect(mgr.get(id)?.status).toBe('killed');
    expect(stopped).toBe(1);
    expect(settled).toHaveLength(1);
  });
});
