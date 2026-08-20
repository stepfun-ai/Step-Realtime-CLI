import { mkdir, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { SessionStore } from '../../session/store.js';
import { parseCron } from './cronexpr.js';
import type { CronJob, CronJobSnapshot } from './scheduler.js';

/**
 * cron 任务持久层：按 cwd 绑定（不按会话），每任务一文件。
 * 布局：SessionStore 数据目录下 cron/<cwd 分桶>/<jobId>.json，内容即内存表示序列化（无 DTO）。
 * 变更即落盘（fire-and-forget）：写用 tmp + rename 原子替换，失败只 warn 不炸（丢的最多是跨重启持久性）。
 */
export class CronJobStore {
  constructor(
    private readonly sessions: SessionStore,
    private readonly warn: (msg: string) => void = (msg) => console.warn(msg),
  ) {}

  private dir(cwd: string): string {
    return this.sessions.cronDirFor(cwd);
  }

  /** 异步落盘单个任务（tmp + rename 原子替换）。失败只 warn。 */
  async save(cwd: string, job: CronJob): Promise<void> {
    const snapshot: CronJobSnapshot = {
      id: job.id,
      cron: job.cron,
      prompt: job.prompt,
      recurring: job.recurring,
      nextFireAt: job.nextFireAt.toISOString(),
      createdAt: job.createdAt,
      sessionId: job.sessionId,
    };
    try {
      const dir = this.dir(cwd);
      await mkdir(dir, { recursive: true });
      const file = join(dir, `${job.id}.json`);
      const tmp = `${file}.tmp`;
      await writeFile(tmp, JSON.stringify(snapshot, null, 2), 'utf8');
      await rename(tmp, file);
    } catch (e) {
      this.warn(`cron 任务落盘失败（${job.id}）：${(e as Error).message}`);
    }
  }

  /** 删除任务文件（不存在也算成功）。失败只 warn。 */
  async remove(cwd: string, id: string): Promise<void> {
    try {
      await rm(join(this.dir(cwd), `${id}.json`), { force: true });
    } catch (e) {
      this.warn(`cron 任务文件删除失败（${id}）：${(e as Error).message}`);
    }
  }

  /** 全量 reload 该 cwd 的任务表：shape guard 校验，坏文件静默丢弃（宁可丢一个坏任务也不拒绝启动）。 */
  load(cwd: string): CronJobSnapshot[] {
    const dir = this.dir(cwd);
    if (!existsSync(dir)) return [];
    const out: CronJobSnapshot[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.json')) continue;
      try {
        const parsed: unknown = JSON.parse(readFileSync(join(dir, name), 'utf8'));
        if (isCronJobSnapshot(parsed)) out.push(parsed);
      } catch {
        // 坏文件静默丢弃
      }
    }
    return out;
  }
}

/** shape guard：字段齐全、cron 表达式可解析、nextFireAt 是合法日期。 */
function isCronJobSnapshot(v: unknown): v is CronJobSnapshot {
  if (typeof v !== 'object' || v === null) return false;
  const s = v as Record<string, unknown>;
  return (
    typeof s['id'] === 'string' &&
    typeof s['cron'] === 'string' &&
    parseCron(s['cron']) !== null &&
    typeof s['prompt'] === 'string' &&
    typeof s['recurring'] === 'boolean' &&
    typeof s['nextFireAt'] === 'string' &&
    !Number.isNaN(Date.parse(s['nextFireAt'])) &&
    typeof s['createdAt'] === 'number'
  );
}

