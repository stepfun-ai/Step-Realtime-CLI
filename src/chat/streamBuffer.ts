import type { AgentEvent } from '../agent/events.js';

/**
 * 流式渲染节流：高频增量事件（text / thinking_delta / usage）不逐条 setState（那会每事件
 * 触发一次 Ink 全帧重绘），而是缓冲合并，50ms 内最多渲染一次；结构事件（tool_start /
 * tool_end / retry / error / aborted / continuation / turn_done 等）必须立即反馈，先强制
 * flush 已缓冲的残篇再立即消费，不进入 50ms 等待。
 *
 * 为什么值得：流式输出时模型每吐一个 delta 就是一条 text 事件，一事件一重绘在 CPU 与
 * 终端 I/O 上都很贵（长输出时重绘次数 = delta 数）。合帧后重绘次数与 delta 数解耦，
 * 固定在 ~20 次/秒。参考主流 CLI 的 50ms flush 间隔。
 *
 * 正确性三件事：
 * 1. 最后一帧不丢——turn_done / error / drain() 三处强制 flush，循环结束必落屏；
 * 2. 结构事件即时——flushNow 不等 50ms，tool_start 等立即渲染；
 * 3. 顺序不乱——合帧仅合并同类的连续追加型 delta；一旦出现结构事件，先把缓冲吐净再按序消费。
 *
 * 与 React 的关系：React 18 自动批处理让 flush() 回调里的多次 setState 合并为一次重绘，
 * 因此一个 setTimeout 回调内统一 setState 即达成「50ms 一帧」，无需 unstable_batchedUpdates。
 */

/** 高频、可合帧的追加型事件类型。 */
type StreamDeltaEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking_delta'; text: string };

function isStreamDelta(ev: AgentEvent): ev is Extract<AgentEvent, StreamDeltaEvent> {
  return ev.type === 'text' || ev.type === 'thinking_delta';
}

export interface StreamBufferOptions {
  /** 合帧间隔（毫秒）。默认 50。 */
  flushMs?: number;
  /** 测试注入时间源；缺省用 setTimeout/clearTimeout。 */
  now?: () => number;
}

export class StreamBuffer {
  private readonly flushMs: number;
  private readonly apply: (ev: AgentEvent) => void;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private lastFlushAt = 0;
  private readonly now: () => number;

  // 追加型缓冲：text / thinking_delta 各攒一份字符串，usage 只留最新一条
  private textAccum = '';
  private thinkingAccum = '';
  private usagePending: AgentEvent | undefined;

  constructor(apply: (ev: AgentEvent) => void, opts: StreamBufferOptions = {}) {
    this.apply = apply;
    this.flushMs = opts.flushMs ?? 50;
    this.now = opts.now ?? (() => Date.now());
  }

  /** 喂入一条事件：delta 缓冲合帧，其余（结构/边界事件）立即 flush + 立即消费。 */
  ingest(ev: AgentEvent): void {
    if (isStreamDelta(ev)) {
      if (ev.type === 'text') this.textAccum += ev.text;
      else this.thinkingAccum += ev.text;
      this.scheduleFlush();
      return;
    }
    if (ev.type === 'usage') {
      // usage 只保留最新一条（状态栏数字以最新为准），随下一次 flush 带出
      this.usagePending = ev;
      this.scheduleFlush();
      return;
    }
    // 结构/边界事件：先把缓冲吐净（保持「残篇在前、结构事件在后」的顺序），再立即消费
    this.flushNow();
    this.apply(ev);
  }

  /** 安排一次延迟 flush：若已有定时器则不再重复设置（避免高频刷新把间隔撑大）。 */
  private scheduleFlush(): void {
    if (this.timer !== undefined) return;
    const elapsed = this.now() - this.lastFlushAt;
    const delay = Math.max(0, this.flushMs - elapsed);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, delay);
  }

  /** 立即 flush（清定时器）：结构事件 / 终态用。 */
  flushNow(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer);
      this.timer = undefined;
    }
    this.flush();
  }

  /** 把缓冲的内容按「text → thinking_delta → usage」顺序包装成事件交给 apply。 */
  private flush(): void {
    if (this.textAccum === '' && this.thinkingAccum === '' && this.usagePending === undefined) return;
    this.lastFlushAt = this.now();
    if (this.textAccum !== '') {
      const text = this.textAccum;
      this.textAccum = '';
      this.apply({ type: 'text', text });
    }
    if (this.thinkingAccum !== '') {
      const text = this.thinkingAccum;
      this.thinkingAccum = '';
      this.apply({ type: 'thinking_delta', text });
    }
    if (this.usagePending !== undefined) {
      const u = this.usagePending;
      this.usagePending = undefined;
      this.apply(u);
    }
  }

  /**
   * 循环结束 / 回合收尾时调用：强制吐净所有缓冲（最后一帧不丢），并清掉未触发的定时器。
   * 幂等——缓冲为空时无副作用。
   */
  drain(): void {
    this.flushNow();
  }
}
