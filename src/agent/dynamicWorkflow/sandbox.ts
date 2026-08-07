import type {
  JSPromiseState,
  QuickJSContext,
  QuickJSHandle,
  QuickJSRuntime,
} from 'quickjs-emscripten';

/**
 * 动态工作流沙箱：quickjs-emscripten（wasm 真隔离，脚本默认零能力，
 * 文件/网络/进程/环境变量在脚本世界里根本不存在，能用的只有注入的编排原语）。
 *
 * 生命周期：每次 dynamic_workflow 调用新建一个 runtime，跑完即销毁，无跨调用状态泄漏。
 * 懒加载：首次调用才 import wasm 模块并初始化，CLI 启动零成本。
 *
 * 异步桥接：宿主异步函数（派子 agent）通过 newPromise 返回 guest promise，
 * settle 泵循环驱动 executePendingJobs 直到顶层 promise 收束。
 * 注意：没用 asyncify 变体（newAsyncRuntime）——promise 桥接不需要它，
 * 且其 runtime 销毁顺序有 bug（deleteRuntime 先于 QTS_FreeRuntime，
 * 带宿主函数的 runtime 销毁时必抛 "not found when trying to free HostRef"），
 * sync 变体销毁顺序正确（Phase 0 已双向验证）。
 */

/** 默认 wall-clock 超时（毫秒）：30 分钟。runner 的 budget({minutes}) 在同一口径上收紧。 */
export const DEFAULT_WALL_CLOCK_MS = 30 * 60 * 1000;

/**
 * 确定性 prelude：封死非确定性 API（会破坏 resume 的缓存前缀对齐）。
 * Date 用代理函数整体覆盖：无参 new Date() / Date() 抛错（提示从 args 传时间戳），
 * 带参构造保留（确定性不受影响）；Date.now / Math.random 直接封死。
 */
export const DETERMINISM_PRELUDE = `
const __NativeDate = Date;
function SandboxDate(...args) {
  if (new.target === undefined) {
    // Date(...) 调用形式忽略参数、永远返回当前时间字符串，同样是确定性洞。
    throw new Error('dynamic_workflow 沙箱禁用非确定性 API：Date() 调用形式（永远返回当前时间）。请从 args 传入时间戳，用 new Date(timestamp) 构造。');
  }
  if (args.length === 0) {
    throw new Error('dynamic_workflow 沙箱禁用非确定性 API：new Date() 无参构造（会破坏 resume 缓存对齐）。请从 args 传入时间戳，用 new Date(timestamp) 构造。');
  }
  return new __NativeDate(...args);
}
SandboxDate.prototype = __NativeDate.prototype;
SandboxDate.parse = __NativeDate.parse;
SandboxDate.UTC = __NativeDate.UTC;
globalThis.Date = SandboxDate;
Date.now = () => { throw new Error('dynamic_workflow 沙箱禁用非确定性 API：Date.now（会破坏 resume 缓存对齐）'); };
Math.random = () => { throw new Error('dynamic_workflow 沙箱禁用非确定性 API：Math.random（会破坏 resume 缓存对齐）'); };
`;

export interface SandboxOptions {
  /** 用户取消信号。 */
  signal?: AbortSignal;
  /** wall-clock 超时（毫秒），默认 30 分钟。 */
  wallClockMs?: number;
  /**
   * 动态 deadline 读取器（毫秒时间戳）。提供后取代 wallClockMs 派生的固定 deadline——
   * runner 用它让 budget({minutes}) 在脚本运行中收紧 wall-clock。
   */
  deadline?: () => number;
  /** interrupt handler 触发次数预算（防死循环烧 CPU）。 */
  maxInstructions?: number;
  /** wasm 内存上限（字节）。 */
  memoryLimitBytes?: number;
  /** 栈上限（字节）。 */
  maxStackSizeBytes?: number;
}

const DEFAULT_MAX_INSTRUCTIONS = 10_000_000;
const DEFAULT_MEMORY_LIMIT = 64 * 1024 * 1024;
const DEFAULT_MAX_STACK = 1024 * 1024;

/** 沙箱被强制中断（取消 / 超时 / 指令预算耗尽）时抛出。 */
export class SandboxInterrupt extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'SandboxInterrupt';
  }
}

export class DynamicWorkflowSandbox {
  private readonly deadline: number;
  private instructionBudget: number;
  /** interrupt handler 触发的中断原因（guest 执行期间）。 */
  private interruptReason: string | null = null;
  private disposed = false;

  private constructor(
    private readonly runtime: QuickJSRuntime,
    readonly context: QuickJSContext,
    private readonly opts: SandboxOptions,
  ) {
    this.deadline = Date.now() + (opts.wallClockMs ?? DEFAULT_WALL_CLOCK_MS);
    this.instructionBudget = opts.maxInstructions ?? DEFAULT_MAX_INSTRUCTIONS;
    runtime.setMemoryLimit(opts.memoryLimitBytes ?? DEFAULT_MEMORY_LIMIT);
    runtime.setMaxStackSize(opts.maxStackSizeBytes ?? DEFAULT_MAX_STACK);
    // interrupt handler 是 wasm→JS FFI 调用，每次都有开销，因此 Date.now 降频检查。
    let ticks = 0;
    runtime.setInterruptHandler(() => {
      if (this.opts.signal?.aborted === true) {
        this.interruptReason = '用户取消';
        return true;
      }
      if (--this.instructionBudget <= 0) {
        this.interruptReason = `指令预算耗尽（疑似死循环）`;
        return true;
      }
      if (++ticks % 4096 === 0 && Date.now() > this.deadlineNow()) {
        this.interruptReason = `执行超时（wall-clock ${Math.round((this.opts.wallClockMs ?? DEFAULT_WALL_CLOCK_MS) / 60000)} 分钟）`;
        return true;
      }
      return false;
    });
  }

  /** 当前生效的 deadline：优先动态读取器（budget 收紧后即时生效），否则固定值。 */
  private deadlineNow(): number {
    return this.opts.deadline !== undefined ? this.opts.deadline() : this.deadline;
  }

  /** 懒加载 quickjs-emscripten 并新建一个一次性沙箱。 */
  static async create(opts: SandboxOptions): Promise<DynamicWorkflowSandbox> {
    const { getQuickJS } = await import('quickjs-emscripten');
    const qjs = await getQuickJS();
    const runtime = qjs.newRuntime();
    const context = runtime.newContext();
    return new DynamicWorkflowSandbox(runtime, context, opts);
  }

  /** eval 一段代码；返回 VmCallResult（error 分支由调用方处理）。 */
  async eval(code: string, filename = 'dwf-script.js') {
    const result = this.context.evalCode(code, filename);
    if (result.error !== undefined && this.interruptReason !== null) {
      result.error.dispose();
      throw new SandboxInterrupt(this.interruptReason);
    }
    return result;
  }

  /**
   * 泵循环：驱动 executePendingJobs 直到 guest promise 收束。
   * 等待宿主异步（子 agent）期间 guest 是 idle 的，interrupt handler 不会触发，
   * 因此取消/超时必须在这里检查。
   */
  async settle(promiseHandle: QuickJSHandle): Promise<JSPromiseState> {
    for (;;) {
      const state = this.context.getPromiseState(promiseHandle);
      if (state.type !== 'pending') {
        // 中断导致的 rejection（InternalError: interrupted）优先报真实原因。
        if (state.type === 'rejected' && this.interruptReason !== null) {
          state.error.dispose();
          throw new SandboxInterrupt(this.interruptReason);
        }
        return state;
      }
      if (this.opts.signal?.aborted === true) throw new SandboxInterrupt('用户取消');
      if (Date.now() > this.deadlineNow()) throw new SandboxInterrupt('执行超时（wall-clock）');
      const jobs = this.runtime.executePendingJobs();
      if (jobs.error !== undefined) {
        // pending job 里的未捕获错误：promise 状态会携带，继续泵即可；
        // 但 interrupt（取消/超时/预算）必须立刻上抛，否则死循环的 job 错误会被吞掉。
        jobs.error.dispose();
        if (this.interruptReason !== null) throw new SandboxInterrupt(this.interruptReason);
      }
      await new Promise((r) => setImmediate(r));
    }
  }

  /** 沙箱是否已销毁：在途宿主异步回调（如 __agent 的 spawn.then）据此短路，避免 UseAfterFree。 */
  get isDisposed(): boolean {
    return this.disposed;
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.context.dispose();
    this.runtime.dispose();
  }
}
