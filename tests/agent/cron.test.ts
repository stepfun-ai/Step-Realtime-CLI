import { describe, expect, it } from 'vitest';
import { matchesCron, nextFireAfter, parseCron } from '../../src/agent/cron/cronexpr.js';
import { CronScheduler } from '../../src/agent/cron/scheduler.js';
import { cronCreateTool, cronListTool } from '../../src/tools/cron.js';

describe('parseCron / matchesCron / nextFireAfter', () => {
  it('解析合法表达式', () => {
    const spec = parseCron('*/5 * * * *');
    expect(spec).not.toBeNull();
    expect(spec!.minute.has(0)).toBe(true);
    expect(spec!.minute.has(5)).toBe(true);
  });

  it('非法表达式 → null', () => {
    expect(parseCron('bad')).toBeNull();
    expect(parseCron('61 * * * *')).toBeNull();
  });

  it('matchesCron 按本地时间匹配', () => {
    const spec = parseCron('30 9 * * *')!;
    const d = new Date(2026, 0, 21, 9, 30, 0);
    expect(matchesCron(spec, d)).toBe(true);
    expect(matchesCron(spec, new Date(2026, 0, 21, 9, 31, 0))).toBe(false);
  });

  it('nextFireAfter 找到下一次触发', () => {
    const spec = parseCron('0 12 * * *')!;
    const after = new Date(2026, 0, 21, 8, 0, 0);
    const next = nextFireAfter(spec, after);
    expect(next).not.toBeNull();
    expect(next!.getHours()).toBe(12);
    expect(next!.getMinutes()).toBe(0);
  });
});

describe('CronScheduler', () => {
  it('创建任务并到点触发（isIdle 为真）', () => {
    const fired: string[] = [];
    const sched = new CronScheduler((job) => fired.push(job.prompt), () => true, 1000);
    const job = sched.create('* * * * *', '每分钟提醒');
    // 手动把 nextFireAt 改到过去，模拟到点
    job.nextFireAt = new Date(Date.now() - 1000);
    sched.tick(new Date());
    expect(fired).toContain('每分钟提醒');
    sched.stop();
  });

  it('isIdle 为假时不触发', () => {
    const fired: string[] = [];
    const sched = new CronScheduler((job) => fired.push(job.prompt), () => false, 1000);
    const job = sched.create('* * * * *', 'x');
    job.nextFireAt = new Date(Date.now() - 1000);
    sched.tick(new Date());
    expect(fired).toHaveLength(0);
    sched.stop();
  });

  it('一次性任务触发后删除', () => {
    const sched = new CronScheduler(() => {}, () => true, 1000);
    const job = sched.create('* * * * *', 'once', false);
    job.nextFireAt = new Date(Date.now() - 1000);
    sched.tick(new Date());
    expect(sched.list()).toHaveLength(0);
    sched.stop();
  });
});

describe('cron 工具', () => {
  it('cron_create 创建，cron_list 列出', async () => {
    const sched = new CronScheduler(() => {}, () => true, 1000);
    const ctx = { cwd: process.cwd(), cron: sched };
    const c = await cronCreateTool.execute({ cron: '0 9 * * *', prompt: '早上提醒' }, ctx);
    expect(c.isError).toBe(false);
    expect(c.content).toContain('已创建定时任务');
    const l = await cronListTool.execute({}, ctx);
    expect(l.content).toContain('0 9 * * *'); // cron 表达式在列表里
    sched.stop();
  });

  it('ctx 无 cron 报不支持', async () => {
    const r = await cronCreateTool.execute({ cron: '* * * * *', prompt: 'x' }, { cwd: process.cwd() });
    expect(r.isError).toBe(true);
    expect(r.content).toContain('不支持');
  });
});

describe('session 隔离：旧会话的 cron 任务不泄漏到新会话', () => {
  /**
   * 2026-08-17 用户反馈：新会话启动后，旧会话创建的 cron 任务被自动恢复并触发，
   * 导致旧任务的 prompt 在新会话里执行（干扰当前工作）。
   *
   * 根因：cron 任务按 cwd 存储（不按 session），新会话启动时 load + restore
   * 把同 cwd 下所有任务都恢复了。
   */
  it('新会话只恢复自己 sessionId 的任务', () => {
    const fired: string[] = [];
    // 会话 A 创建 2 个任务
    const schedA = new CronScheduler((j) => fired.push(j.prompt), () => true, 'session-A', 100);
    schedA.create('*/5 * * * *', '任务 A1', true);
    schedA.create('*/10 * * * *', '任务 A2', true);

    // 会话 B 创建 1 个任务
    const schedB = new CronScheduler((j) => fired.push(j.prompt), () => true, 'session-B', 100);
    schedB.create('*/3 * * * *', '任务 B1', true);

    // 模拟落盘快照（两个会话的快照混合存在）
    const allSnapshots = [
      ...schedA.list().map((j) => ({ id: j.id, cron: j.cron, prompt: j.prompt, recurring: j.recurring, nextFireAt: j.nextFireAt.toISOString(), createdAt: j.createdAt, sessionId: j.sessionId })),
      ...schedB.list().map((j) => ({ id: j.id, cron: j.cron, prompt: j.prompt, recurring: j.recurring, nextFireAt: j.nextFireAt.toISOString(), createdAt: j.createdAt, sessionId: j.sessionId })),
    ];

    // 会话 C 启动：只恢复 session-C 的任务（没有）→ 0 个任务
    const schedC = new CronScheduler((j) => fired.push(j.prompt), () => true, 'session-C', 100);
    schedC.restore(allSnapshots.filter((s) => s.sessionId === 'session-C'));
    expect(schedC.list()).toHaveLength(0);

    // 会话 A 重新启动：只恢复 session-A 的任务 → 2 个
    const schedA2 = new CronScheduler((j) => fired.push(j.prompt), () => true, 'session-A', 100);
    schedA2.restore(allSnapshots.filter((s) => s.sessionId === 'session-A'));
    expect(schedA2.list()).toHaveLength(2);
    expect(fired).toHaveLength(0); // restore 不触发 fire
  });

  it('rebindSession 清空旧会话任务并换 sessionId（进程内切会话，防旧任务在新会话触发）', () => {
    // P0 同源：CronScheduler 实例随 PiChat 存活，sessionId 原为 readonly。切会话不重绑的话，
    // 旧任务留在内存 tick 到点照常 fire；且新会话 create 的任务被打上陈旧 sessionId。
    const fired: string[] = [];
    const sched = new CronScheduler((j) => fired.push(j.prompt), () => true, 'session-A', 100);
    sched.create('* * * * *', 'A 的旧任务');
    expect(sched.list()).toHaveLength(1);

    // 切到 session-B：rebind 清空旧任务、换 sessionId
    sched.rebindSession('session-B');
    expect(sched.list()).toHaveLength(0); // 旧任务已清，不会在新会话触发
    // 新会话 create 的任务带新 sessionId（下次启动过滤加载得到）
    const newJob = sched.create('* * * * *', 'B 的新任务');
    expect(newJob.sessionId).toBe('session-B');

    sched.stop();
    expect(fired).toHaveLength(0); // rebind 后旧任务从未触发
  });
});
