import { nextFireAfter, parseCron, type CronSpec } from './cronexpr.js';

export interface CronJob {
  id: string;
  cron: string;
  prompt: string;
  recurring: boolean;
  nextFireAt: Date;
  /** 创建时间戳（ms），stale 清理依据。 */
  createdAt: number;
  spec: CronSpec;
  /** 创建该任务的会话 ID。用于 session 隔离：新会话不加载旧会话的 cron 任务。 */
  sessionId: string;
}

/** 落盘/恢复的 cron 任务快照：内容即内存表示的序列化（nextFireAt 用 ISO 字符串），无 DTO。 */
export interface CronJobSnapshot {
  id: string;
  cron: string;
  prompt: string;
  recurring: boolean;
  /** 下次触发时间（ISO 字符串），即防重放游标：已推进过的不会重算。 */
  nextFireAt: string;
  createdAt: number;
  /** 创建该任务的会话 ID。旧任务可能无此字段（迁移前创建），加载时按无 sessionId 处理。 */
  sessionId?: string;
}

/** recurring 任务创建超过该时长，恢复 reload 时直接清除。 */
export const CRON_STALE_MS = 7 * 24 * 3600 * 1000;

/** 触发回调（把 prompt 注入主会话）。 */
export type CronFireHandler = (job: CronJob, coalescedCount: number) => void;

/** 任务表变更回调（持久化装配层用）：create / delete 后调用。 */
export type CronJobChangeHandler = (kind: 'create' | 'delete', job: CronJob) => void;

let counter = 0;
function nextId(): string {
  counter += 1;
  return (Date.now().toString(36) + counter.toString(36)).slice(-8);
}

/**
 * cron 调度器：scheduler 与 agent 解耦，后台 tick + isIdle 闸门 + coalesce。
 * 到点把任务交给 onFire 回调；isIdle 由调用方提供（turn 进行中不触发，下个空闲 tick 补发，coalesce 计数）。
 * 纯内存引擎：不做 IO，持久化由装配层经 onJobChange / restore 叠加。
 */
export class CronScheduler {
  private readonly jobs = new Map<string, CronJob>();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** 任务表变更通知（装配层挂持久化，可选）。 */
  onJobChange: CronJobChangeHandler | null = null;

  /** 所属会话 ID：用于 session 隔离，新会话不加载旧会话的 cron 任务。
   *  非 readonly：PiChat 切会话（/new、/resume）时经 rebindSession 重绑，
   *  否则新建任务被打上陈旧 sessionId、下次启动过滤加载不到。 */
  private sessionId: string;

  constructor(
    private readonly onFire: CronFireHandler,
    private readonly isIdle: () => boolean,
    sessionId: string = '',
    private readonly tickMs = 10_000,
  ) {
    this.sessionId = sessionId;
  }

  /** 创建定时任务。非法 cron 表达式抛错。返回 job。 */
  create(cron: string, prompt: string, recurring = true): CronJob {
    const spec = parseCron(cron);
    if (spec === null) throw new Error(`非法 cron 表达式：${cron}`);
    const next = nextFireAfter(spec, new Date());
    if (next === null) throw new Error('该 cron 表达式在可预见时间内不会触发。');
    const job: CronJob = { id: nextId(), cron, prompt, recurring, nextFireAt: next, createdAt: Date.now(), spec, sessionId: this.sessionId };
    this.jobs.set(job.id, job);
    this.ensureTimer();
    this.onJobChange?.('create', job);
    return job;
  }

  list(): CronJob[] {
    return [...this.jobs.values()];
  }

  delete(id: string): boolean {
    const job = this.jobs.get(id);
    const ok = this.jobs.delete(id);
    if (ok && job !== undefined) this.onJobChange?.('delete', job);
    if (this.jobs.size === 0) this.stopTimer();
    return ok;
  }

  /**
   * 从持久层恢复快照（装配层调用，快照需已过 shape guard）。
   * nextFireAt 原样接管（防重放游标），恢复后由 tick 的 coalesce 逻辑补投离线漏跑；
   * recurring 且创建超 CRON_STALE_MS 的不恢复，返回其 id 供装配层清盘。
   */
  restore(snapshots: readonly CronJobSnapshot[], now: Date = new Date()): string[] {
    const stale: string[] = [];
    for (const s of snapshots) {
      if (s.recurring && now.getTime() - s.createdAt > CRON_STALE_MS) {
        stale.push(s.id);
        continue;
      }
      const spec = parseCron(s.cron);
      const nextFireAt = new Date(s.nextFireAt);
      if (spec === null || Number.isNaN(nextFireAt.getTime())) continue;
      this.jobs.set(s.id, { id: s.id, cron: s.cron, prompt: s.prompt, recurring: s.recurring, nextFireAt, createdAt: s.createdAt, spec, sessionId: s.sessionId ?? '' });
    }
    if (this.jobs.size > 0) this.ensureTimer();
    return stale;
  }

  private ensureTimer(): void {
    if (this.timer !== null) return;
    this.timer = setInterval(() => this.tick(), this.tickMs);
    this.timer.unref?.();
  }

  private stopTimer(): void {
    if (this.timer !== null) clearInterval(this.timer);
    this.timer = null;
  }

  stop(): void {
    this.stopTimer();
  }

  /**
   * 切会话时重绑：清空内存任务表、停计时器、改用新 sessionId。
   *
   * 与 cron 跨 session 隔离配套：CronScheduler 实例随 PiChat 生命周期存活，
   * 但旧 session 的任务属旧现场，不能带到新会话。不重绑的后果有二：
   * - 旧任务留在内存，tick 到点照常 onFire，与当前是哪个 session 无关 → 旧会话定时任务在新会话触发（P0 同源）；
   * - 新会话 create 的任务被打上陈旧 sessionId，下次启动按新 sessionId 过滤反而加载不到自己刚建的任务。
   * 调用方随后 restore 本会话自己的任务。
   */
  rebindSession(sessionId: string): void {
    this.jobs.clear();
    this.stopTimer();
    this.sessionId = sessionId;
  }

  /** 每个 tick：到点的任务触发（isIdle 才触发；错过合并 coalesce）。 */
  tick(now: Date = new Date()): void {
    if (!this.isIdle()) return; // turn 进行中不触发，下个空闲 tick 补发
    for (const job of [...this.jobs.values()]) {
      if (now < job.nextFireAt) continue;
      // 计算错过的次数（coalesce）
      let coalesced = 1;
      let next = nextFireAfter(job.spec, job.nextFireAt);
      while (next !== null && next <= now) {
        coalesced += 1;
        next = nextFireAfter(job.spec, next);
      }
      this.onFire(job, coalesced);
      if (job.recurring) {
        job.nextFireAt = next ?? new Date(now.getTime() + 60_000);
        if (next === null) this.jobs.delete(job.id);
      } else {
        this.jobs.delete(job.id); // 一次性任务触发后删除
      }
    }
    if (this.jobs.size === 0) this.stopTimer();
  }
}
