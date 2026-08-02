import { accessConflict, type ToolAccess } from '../tools/access.js';

/**
 * 一个待调度任务。run 必须自行捕获异常（把结果写回自己的槽位），不向外抛——
 * 错误隔离在任务级，兄弟任务零影响。
 */
export interface ScheduledTask {
  /** 资源访问声明（冲突判定的依据）。 */
  access: ToolAccess;
  /** 是否占用子 agent 并发槽位（spawn_agent 专属，worker pool 语义）。 */
  needsSubagentSlot?: boolean;
  run: () => Promise<void>;
  /**
   * 失败重排策略（429 限流的第二道防线，spawn_agent 专属）：任务跑完后调用，
   * 返回延迟 ms 表示重排队尾（让出槽位、延迟后重新竞争），undefined 表示就此收敛。
   * requeued = 已重排次数。是否真正重排还受调度器约束：本批唯一未完成任务不重排（防死锁）。
   */
  shouldRequeue?: (requeued: number) => number | undefined;
}

export interface SchedulerOptions {
  /** 子 agent 并发上限（来自 ctx.subagentMaxConcurrent）。 */
  maxSubagentConcurrent: number;
  /** 中断信号：abort 后不再启动新任务，pending 的直接标 skipped（由调用方合成中断结果占槽）。 */
  signal?: AbortSignal;
  /** 任务首次启动时回调（runTurn 在此发 tool_start：执行时才发，保证串行场景事件逐个交替）。重排重启不重复触发。 */
  onStart?: (index: number) => void;
  /** 任务被重排队尾时回调（runTurn 在此发 notice 透出重排事件）。requeued 从 1 起。 */
  onRequeue?: (index: number, delayMs: number, requeued: number) => void;
}

export type TaskState = 'pending' | 'running' | 'done' | 'skipped';

/**
 * 冲突驱动的并行调度器：按数组顺序扫描，与所有 running 及排在前面的 pending 任务
 * 不冲突即启动，冲突则留在队列等放行。不设数字上限——一轮 tool_use 数量被模型输出
 * 长度天然约束，冲突模型才是真边界；只有 spawn_agent 额外受并发槽位约束（背后是
 * 真实 API 调用配额）。
 *
 * 调度不由完成回调自驱，而由调用方驱动：start() 初始放行一轮，之后每回收完一个
 * 任务（按数组顺序）调一次 drain() 扫描放行——这样串行场景下「下一个 tool_start」
 * 永远排在「上一个 tool_end」之后，事件序列与旧串行实现一致。
 * 唯一的自驱例外是 429 重排：延迟到点后由内部定时器触发 drain（回收方可能正卡在等它）。
 */
export class ToolScheduler {
  private readonly states: TaskState[];
  /** 每任务的收敛 deferred：仅在最终收敛（done / skipped）时 resolve，重排不 resolve。 */
  private readonly settled: { promise: Promise<void>; resolve: () => void }[];
  private readonly requeueCounts: number[];
  private readonly notBefore: (number | undefined)[];
  private readonly everStarted: boolean[];
  private subagentSlots = 0;

  constructor(
    private readonly tasks: ScheduledTask[],
    private readonly opts: SchedulerOptions,
  ) {
    this.states = tasks.map(() => 'pending' as TaskState);
    this.settled = tasks.map(() => {
      let resolve!: () => void;
      const promise = new Promise<void>((r) => {
        resolve = r;
      });
      return { promise, resolve };
    });
    this.requeueCounts = tasks.map(() => 0);
    this.notBefore = tasks.map(() => undefined);
    this.everStarted = tasks.map(() => false);
  }

  /** 初始放行：从队首扫描一轮，启动所有当前可启动的任务。 */
  start(): void {
    this.drain();
  }

  /**
   * 扫描放行：abort 则把全部 pending 标 skipped（不再启动新任务）；
   * 否则按数组顺序把不冲突的 pending 启动。完成任务后由调用方调用。
   */
  drain(): void {
    if (this.opts.signal?.aborted) {
      for (let i = 0; i < this.tasks.length; i++) {
        if (this.states[i] === 'pending') {
          this.states[i] = 'skipped';
          this.settled[i]!.resolve();
        }
      }
      return;
    }
    for (let i = 0; i < this.tasks.length; i++) {
      if (this.states[i] !== 'pending') continue;
      if (!this.canStart(i)) continue;
      this.launch(i);
    }
  }

  /** 等待第 i 个任务最终收敛（done / skipped；重排不算收敛）。回收按数组顺序调用，结果顺序自然对齐。 */
  async waitSettled(i: number): Promise<TaskState> {
    await this.settled[i]!.promise;
    return this.states[i]!;
  }

  /** 可启动条件：过了重排延迟、有子 agent 槽位，且与所有 running 及排在前面的 pending 不冲突。 */
  private canStart(i: number): boolean {
    const t = this.tasks[i]!;
    const notBefore = this.notBefore[i];
    if (notBefore !== undefined && Date.now() < notBefore) return false;
    if (t.needsSubagentSlot === true && this.subagentSlots >= this.opts.maxSubagentConcurrent) {
      return false;
    }
    for (let j = 0; j < i; j++) {
      // 排在前面的 pending 也算占用：同一资源按 provider 顺序先到先得，避免后来的插队
      if (this.states[j] === 'running' || this.states[j] === 'pending') {
        if (accessConflict(this.tasks[j]!.access, t.access)) return false;
      }
    }
    return true;
  }

  /** 除 i 之外是否还有未完成任务（pending / running）：唯一未完成任务不重排，防死锁。 */
  private hasOtherUnfinished(i: number): boolean {
    for (let j = 0; j < this.tasks.length; j++) {
      if (j === i) continue;
      if (this.states[j] === 'pending' || this.states[j] === 'running') return true;
    }
    return false;
  }

  private launch(i: number): void {
    const t = this.tasks[i]!;
    this.states[i] = 'running';
    if (t.needsSubagentSlot === true) this.subagentSlots++;
    if (!this.everStarted[i]) {
      this.everStarted[i] = true;
      this.opts.onStart?.(i);
    }
    void (async () => {
      try {
        await t.run();
      } catch {
        // 执行体按约定自行捕获；兜底吞掉，防止一个任务的异常炸穿整个回收
      }
      // 429 重排队尾：策略要求重排 且 未中断 且 本批还有其他未完成任务（防死锁）。
      // 让出槽位、延迟后重新竞争——子 agent 内部的重试循环已先扛过一轮，这是第二道防线。
      const delay = t.shouldRequeue?.(this.requeueCounts[i]!);
      if (delay !== undefined && !this.opts.signal?.aborted && this.hasOtherUnfinished(i)) {
        this.requeueCounts[i]!++;
        if (t.needsSubagentSlot === true) this.subagentSlots--;
        this.states[i] = 'pending';
        this.notBefore[i] = Date.now() + delay;
        this.opts.onRequeue?.(i, delay, this.requeueCounts[i]!);
        // 让出的槽位立即归还池子：扫描放行等待中的兄弟任务（本任务被 notBefore 挡住）。
        // 回收方可能正卡在等本任务，不能指望它再来 drain。
        this.drain();
        // 延迟到点自动回到待启动扫描（同理不能指望调用方 drain）。
        // 清掉 notBefore 再扫描，避免定时器提早几 ms 触发导致永远等下一次 drain。
        setTimeout(() => {
          this.notBefore[i] = undefined;
          this.drain();
        }, delay);
        return;
      }
      this.states[i] = 'done';
      if (t.needsSubagentSlot === true) this.subagentSlots--;
      this.settled[i]!.resolve();
    })();
  }
}
