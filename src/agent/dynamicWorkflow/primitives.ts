import type { QuickJSContext } from 'quickjs-emscripten';
import type { DynamicWorkflowSandbox } from './sandbox.js';

/**
 * 编排原语注入：agent / parallel / pipeline / phase / budget。
 * loop / 条件 / 提前终止不做原语——模型自己写 for / if / break，这是 JS 路线的核心红利。
 *
 * 桥接方式：宿主侧只注入底层函数 __agent(prompt, optsJson) / __log / __phase / __budget，
 * 五个原语在 guest prelude 里用纯 JS 定义。并发控制由宿主侧信号量统一完成，
 * 因此 parallel 的 Promise.all 扇出天然受同一个并发上限约束。
 */

/** 宿主侧派生子 agent 的实现（runner 注入，内含并发限制、计数护栏、journal、schema 校验重试）。 */
export type SpawnAgentFn = (
  prompt: string,
  opts: { subagentType?: string; description?: string; schema?: unknown; phase?: string },
) => Promise<string | null>;

/** 阶段切换回调（runner 注入：转发 ctx.onWorkflowStep，供 TUI 步骤面板消费）。 */
export type PhaseFn = (title: string) => void;

/** 预算设定回调（runner 注入：收紧本 run 的 agent 上限 / wall-clock）。 */
export type BudgetFn = (budget: { agents?: number; minutes?: number }) => void;

/**
 * guest 侧 prelude：原语定义。失败语义全部收敛为 null（见设计文档第四节）。
 * schema 分支：宿主侧已校验通过并返回 JSON 字符串，guest 只需 parse 成对象交还脚本。
 */
export const PRIMITIVES_PRELUDE = `
globalThis.agent = (prompt, opts) => {
  if (prompt === null || prompt === undefined) throw new Error('agent() 需要 prompt 参数');
  const o = opts ?? {};
  return __agent(String(prompt), JSON.stringify(o)).then((r) =>
    r !== null && o.schema !== undefined && o.schema !== null ? JSON.parse(r) : r,
  );
};
// parallel：并发 barrier，永不 reject，失败/异常位置为 null。
globalThis.parallel = (thunks) => Promise.all(thunks.map((th) => {
  try {
    return Promise.resolve(th()).then((v) => (v === undefined ? null : v), () => null);
  } catch {
    return Promise.resolve(null);
  }
}));
// pipeline：每项串行过各 stage；某项某 stage 失败（null/异常）则该项掉为 null 并跳过后续 stage，其他项不受影响。
globalThis.pipeline = (items, ...stages) => Promise.all(items.map(async (item) => {
  let v = item;
  for (const st of stages) {
    try {
      v = await st(v);
    } catch {
      return null;
    }
    if (v === null || v === undefined) return null;
  }
  return v;
}));
// phase：记录阶段切换（展示层语义，不影响执行）——经 onWorkflowStep 发 kind:'phase' 事件，并进 console 缓冲。
globalThis.phase = (title) => __phase(String(title));
// budget：收紧本 run 的预算（只能收紧不能放松）——agents 覆盖 agent 上限，minutes 收紧 wall-clock。
globalThis.budget = (opts) => __budget(JSON.stringify(opts ?? {}));
// 限额 console：脚本日志回宿主缓冲（条数与总量受限），不进主上下文，只在最终报告附带。
globalThis.console = {
  log: (...args) => __log(args.map(String).join(' ')),
  info: (...args) => __log(args.map(String).join(' ')),
  warn: (...args) => __log(args.map(String).join(' ')),
  error: (...args) => __log(args.map(String).join(' ')),
};
`;

const MAX_LOG_ENTRIES = 100;
const MAX_LOG_ENTRY_CHARS = 1024;
const MAX_LOG_TOTAL_CHARS = 8 * 1024;

/** 脚本日志缓冲（限额）。 */
export class LogBuffer {
  private entries: string[] = [];
  private totalChars = 0;

  append(line: string): void {
    if (this.entries.length >= MAX_LOG_ENTRIES || this.totalChars >= MAX_LOG_TOTAL_CHARS) return;
    const trimmed = line.length > MAX_LOG_ENTRY_CHARS ? `${line.slice(0, MAX_LOG_ENTRY_CHARS)}…` : line;
    this.entries.push(trimmed);
    this.totalChars += trimmed.length;
  }

  get lines(): readonly string[] {
    return this.entries;
  }
}

export interface InjectPrimitivesOptions {
  spawn: SpawnAgentFn;
  logs: LogBuffer;
  onPhase?: PhaseFn;
  onBudget?: BudgetFn;
}

/**
 * 把 __agent / __log / __phase / __budget 注入沙箱全局，再 eval 原语 prelude。
 * spawn 抛错（如 agent 数超限、预算耗尽）会以 rejected promise 进沙箱，脚本可 catch。
 * budget 入参非法时宿主函数抛错，同样进沙箱（同步抛在 budget() 调用处）。
 */
export async function injectPrimitives(sandbox: DynamicWorkflowSandbox, opts: InjectPrimitivesOptions): Promise<void> {
  const ctx: QuickJSContext = sandbox.context;
  const { spawn, logs, onPhase, onBudget } = opts;

  const agentFn = ctx.newFunction('__agent', (promptH, optsH) => {
    const prompt = ctx.getString(promptH);
    let agentOpts: { subagentType?: string; description?: string; schema?: unknown } = {};
    if (optsH !== undefined) {
      try {
        const parsed: unknown = JSON.parse(ctx.getString(optsH));
        if (typeof parsed === 'object' && parsed !== null) agentOpts = parsed as typeof agentOpts;
      } catch {
        // opts 无法解析时按缺省处理，不阻断主流程
      }
    }
    const deferred = ctx.newPromise();
    spawn(prompt, agentOpts).then(
      (summary) => {
        // 沙箱已销毁（中断/超时后的 finally dispose）时不再触碰 ctx，
        // 否则 deferred.resolve 指向已释放的 QuickJS context 会触发 UseAfterFree 并使整个进程崩溃。
        if (sandbox.isDisposed) return;
        if (summary === null) {
          deferred.resolve(ctx.null);
        } else {
          const h = ctx.newString(summary);
          deferred.resolve(h);
          h.dispose();
        }
      },
      (err: unknown) => {
        if (sandbox.isDisposed) return;
        // reject 一个真正的 Error，脚本 catch 后能拿到 e.message。
        const h = ctx.newError(err instanceof Error ? err.message : String(err));
        deferred.reject(h);
        h.dispose();
      },
    );
    // 注意：不要在 settled 回调里自行 executePendingJobs——
    // asyncify 同一 wasm 模块只允许一个 async action，泵循环（sandbox.settle）是唯一驱动者。
    return deferred.handle;
  });
  ctx.setProp(ctx.global, '__agent', agentFn);
  agentFn.dispose();

  const logFn = ctx.newFunction('__log', (lineH) => {
    logs.append(ctx.getString(lineH));
  });
  ctx.setProp(ctx.global, '__log', logFn);
  logFn.dispose();

  const phaseFn = ctx.newFunction('__phase', (titleH) => {
    const title = ctx.getString(titleH);
    // [phase] 日志由宿主侧 onPhase（emitPhase）统一记入，与 agent({phase}) 同一出口且带去重，此处不再单独 append。
    onPhase?.(title);
  });
  ctx.setProp(ctx.global, '__phase', phaseFn);
  phaseFn.dispose();

  const budgetFn = ctx.newFunction('__budget', (jsonH) => {
    let budget: { agents?: number; minutes?: number };
    try {
      const parsed: unknown = JSON.parse(ctx.getString(jsonH));
      if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
      budget = parsed as typeof budget;
    } catch {
      throw new Error('budget() 需要一个对象参数，如 budget({ agents: 20, minutes: 10 })');
    }
    onBudget?.(budget);
  });
  ctx.setProp(ctx.global, '__budget', budgetFn);
  budgetFn.dispose();

  const preludeResult = await sandbox.eval(PRIMITIVES_PRELUDE, 'dwf-primitives.js');
  if (preludeResult.error !== undefined) {
    preludeResult.error.dispose();
    throw new Error('dynamic_workflow 原语 prelude 注入失败');
  }
  preludeResult.value.dispose();
}
