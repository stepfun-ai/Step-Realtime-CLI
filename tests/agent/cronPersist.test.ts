import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CRON_STALE_MS, CronScheduler, type CronJobSnapshot } from '../../src/agent/cron/scheduler.js';
import { CronJobStore } from '../../src/agent/cron/store.js';
import { SessionStore } from '../../src/session/store.js';

let base: string;
let sessions: SessionStore;
let store: CronJobStore;
const cwd = 'C:/some/project';

function snapshotOf(overrides: Partial<CronJobSnapshot> = {}): CronJobSnapshot {
  return {
    id: 'job-1',
    cron: '0 * * * *',
    prompt: '每小时提醒',
    recurring: true,
    nextFireAt: new Date(2026, 0, 21, 8, 0, 0).toISOString(),
    createdAt: new Date(2026, 0, 20, 8, 0, 0).getTime(),
    ...overrides,
  };
}

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), 'stepcode-cron-'));
  sessions = new SessionStore(base);
  store = new CronJobStore(sessions);
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

describe('CronJobStore', () => {
  it('save → load 往返：任务表按 cwd 分桶恢复', async () => {
    const sched = new CronScheduler(() => {}, () => true, 1000);
    const job = sched.create('0 9 * * *', '早上提醒');
    await store.save(cwd, job);
    sched.stop();

    const loaded = store.load(cwd);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]).toMatchObject({ id: job.id, cron: '0 9 * * *', prompt: '早上提醒', recurring: true });
    // 其他 cwd 看不到这份任务表
    expect(store.load('D:/other')).toHaveLength(0);
  });

  it('remove 删除任务文件；删不存在的不报错', async () => {
    const sched = new CronScheduler(() => {}, () => true, 1000);
    const job = sched.create('0 9 * * *', 'x');
    await store.save(cwd, job);
    sched.stop();
    await store.remove(cwd, job.id);
    expect(store.load(cwd)).toHaveLength(0);
    await store.remove(cwd, 'no-such-job'); // 不抛
  });

  it('坏文件静默丢弃：非法 JSON 与缺字段文件被跳过，合法文件保留', async () => {
    const dir = sessions.cronDirFor(cwd);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'broken.json'), 'not json{{', 'utf8');
    writeFileSync(join(dir, 'missing.json'), JSON.stringify({ id: 'x', cron: '0 9 * * *' }), 'utf8');
    writeFileSync(join(dir, 'badcron.json'), JSON.stringify(snapshotOf({ id: 'bad', cron: 'bad expr' })), 'utf8');
    writeFileSync(join(dir, 'good.json'), JSON.stringify(snapshotOf({ id: 'good' })), 'utf8');

    const loaded = store.load(cwd);
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.id).toBe('good');
  });

  it('onJobChange 联动：create 落盘、delete 清盘（装配层持久化语义）', async () => {
    const sched = new CronScheduler(() => {}, () => true, 1000);
    const writes: Promise<void>[] = [];
    sched.onJobChange = (kind, job) => {
      writes.push(kind === 'create' ? store.save(cwd, job) : store.remove(cwd, job.id));
    };
    const job = sched.create('0 9 * * *', 'x');
    sched.stop();
    await Promise.all(writes);
    expect(store.load(cwd)).toHaveLength(1);

    writes.length = 0;
    sched.delete(job.id);
    await Promise.all(writes);
    expect(store.load(cwd)).toHaveLength(0);
  });
});

describe('CronScheduler.restore（持久层恢复）', () => {
  it('离线漏跑 coalesce 补投一次并带漏跑计数，nextFireAt 推进到未来', () => {
    const fired: { prompt: string; coalesced: number }[] = [];
    const sched = new CronScheduler(
      (job, coalesced) => fired.push({ prompt: job.prompt, coalesced }),
      () => true,
      1000,
    );
    // 快照游标在 8:00，11:30 恢复：错过 9/10/11 点三次
    const stale = sched.restore([snapshotOf()], new Date(2026, 0, 21, 11, 30, 0));
    expect(stale).toEqual([]);
    sched.tick(new Date(2026, 0, 21, 11, 30, 0));
    expect(fired).toHaveLength(1);
    expect(fired[0]).toEqual({ prompt: '每小时提醒', coalesced: 4 });
    const job = sched.list()[0]!;
    expect(job.nextFireAt.getTime()).toBeGreaterThan(new Date(2026, 0, 21, 11, 30, 0).getTime());
    sched.stop();
  });

  it('一次性任务离线过期：恢复后补投一次并删除', () => {
    const fired: string[] = [];
    const sched = new CronScheduler((job) => fired.push(job.prompt), () => true, 1000);
    sched.restore([snapshotOf({ recurring: false })], new Date(2026, 0, 21, 11, 30, 0));
    sched.tick(new Date(2026, 0, 21, 11, 30, 0));
    expect(fired).toEqual(['每小时提醒']);
    expect(sched.list()).toHaveLength(0);
    sched.stop();
  });

  it('recurring 任务创建超 7 天：恢复时剔除并返回 id 供清盘', () => {
    const sched = new CronScheduler(() => {}, () => true, 1000);
    const now = new Date(2026, 0, 21, 11, 30, 0);
    const stale = sched.restore(
      [snapshotOf({ id: 'old', createdAt: now.getTime() - CRON_STALE_MS - 1000 })],
      now,
    );
    expect(stale).toEqual(['old']);
    expect(sched.list()).toHaveLength(0);
    sched.stop();
  });

  it('未到点的恢复快照不触发（nextFireAt 即防重放游标）', () => {
    const fired: string[] = [];
    const sched = new CronScheduler((job) => fired.push(job.prompt), () => true, 1000);
    const future = new Date(2026, 0, 21, 12, 0, 0);
    sched.restore([snapshotOf({ nextFireAt: future.toISOString() })], new Date(2026, 0, 21, 11, 30, 0));
    sched.tick(new Date(2026, 0, 21, 11, 30, 0));
    expect(fired).toHaveLength(0);
    sched.stop();
  });
});
