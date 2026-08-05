import AjvModule from 'ajv';
import type { ValidateFunction } from 'ajv';
import type { QuickJSHandle } from 'quickjs-emscripten';
import type { RunSubagentFn, SpawnSubagentRequest } from '../subagent/types.js';
import type { WorkflowStepEvent } from '../events.js';
import { Journal } from './journal.js';
import { LogBuffer, injectPrimitives, type BudgetFn, type PhaseFn, type SpawnAgentFn } from './primitives.js';
import { DEFAULT_WALL_CLOCK_MS, DETERMINISM_PRELUDE, DynamicWorkflowSandbox, SandboxInterrupt } from './sandbox.js';

/**
 * 动态工作流 runner：把模型现写的 JS 编排脚本包成 async 函数体，在零能力沙箱里执行。
 * 中间结果住脚本变量（不占主上下文），主会话只收最终 return 的报告（上限 32KB）。
 */

export interface RunDynamicWorkflowOptions {
  /** 模型现写的 JS 编排脚本（以 return <值> 收尾；可用全局 agent/parallel/pipeline/phase/budget/args/console）。 */
  script: string;
  /** 传给脚本的参数（沙箱内全局 args）。 */
  args?: Record<string, unknown>;
  /** agent 总数上限（护栏），默认 100，硬顶 1000（工具层拒绝超限）；缓存命中不计数。 */
  maxAgents?: number;
  /** 指定后预载该 run 的 journal 做记忆化重放（命中缓存的 agent() 瞬时返回旧结果）。 */
  resumeFromRunId?: string;
  runSubagent: RunSubagentFn;
  /** 三原语共享的并发上限（来自 ctx.subagentMaxConcurrent）。 */
  maxConcurrent: number;
  signal?: AbortSignal;
  cwd: string;
  /** 测试可注入固定 runId。 */
  runId?: string;
  /** wall-clock 超时（毫秒），默认 30 分钟；脚本内 budget({minutes}) 可收紧。 */
  wallClockMs?: number;
  /** 指令预算（interrupt handler 触发次数上限），测试可调小加速死循环检测。 */
  maxInstructions?: number;
  /** phase(title) 的展示层事件出口（组合根注入，供 TUI 步骤面板消费）。 */
  onWorkflowStep?: (info: WorkflowStepEvent) => void;
}

export interface DynamicWorkflowRunResult {
  report: string;
  agentsUsed: number;
  journalHits: number;
  runId: string;
  journalPath: string;
  /** 本次脚本的自动存档路径（编辑后可用 script_path 重跑）。 */
  scriptPath: string;
  logs: readonly string[];
}

/** run 失败时的错误：携带模型自救所需的全部上下文。 */
export class DynamicWorkflowError extends Error {
  constructor(
    message: string,
    readonly detail: {
      runId: string;
      journalPath: string;
      scriptPath: string;
      agentsUsed: number;
      stack?: string;
    },
  ) {
    super(message);
    this.name = 'DynamicWorkflowError';
  }
}

const DEFAULT_MAX_AGENTS = 100;
const MAX_REPORT_CHARS = 32 * 1024;
/** schema 结构化输出的纠正重试次数（首次 + 2 次纠正，仍败返回 null）。 */
const SCHEMA_MAX_RETRIES = 2;

/** schema 校验器（模块级单例；allErrors 让纠正反馈一次带齐全部违例）。NodeNext 下 ajv 的 CJS 类型需经 .default 取类。 */
const Ajv = AjvModule.default;
const ajv = new Ajv({ allErrors: true });

function newRunId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

/** 把 return 值字符串化（上限 32KB，超出截断并注明）。 */
function stringifyReport(value: unknown): string {
  let report: string;
  if (typeof value === 'string') {
    report = value;
  } else if (value === undefined) {
    report = '（脚本结束但没有 return 值）';
  } else {
    try {
      report = JSON.stringify(value, null, 2) ?? String(value);
    } catch {
      report = String(value);
    }
  }
  if (report.length > MAX_REPORT_CHARS) {
    report = `${report.slice(0, MAX_REPORT_CHARS)}\n…[返回值超 32KB，已截断]`;
  }
  return report;
}

/** 解析子 agent 的 JSON 输出：先整体 parse，再容忍一层 ```json 代码围栏（契约已禁止，纯兜底）。 */
function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const trimmed = text.trim();
  try {
    return { ok: true, value: JSON.parse(trimmed) };
  } catch {
    // 继续尝试代码围栏兜底
  }
  const fence = /```(?:json)?\s*([\s\S]*?)```/.exec(trimmed);
  if (fence !== null) {
    try {
      return { ok: true, value: JSON.parse(fence[1]!.trim()) };
    } catch {
      // 落入失败分支
    }
  }
  return { ok: false, error: '输出不是合法 JSON' };
}

export async function runDynamicWorkflow(opts: RunDynamicWorkflowOptions): Promise<DynamicWorkflowRunResult> {
  const runId = opts.runId ?? newRunId();
  const maxAgents = opts.maxAgents ?? DEFAULT_MAX_AGENTS;
  const maxConcurrent = Math.max(1, opts.maxConcurrent);
  // 自动存档：先定 runId 再落盘，无论成败本次脚本都可经 script_path 编辑重跑。
  const scriptPath = await Journal.archiveScript(opts.cwd, runId, opts.script);
  const journal = await Journal.open(opts.cwd, runId, opts.resumeFromRunId);

  let agentsUsed = 0;
  let journalHits = 0;

  // budget() 可收紧的运行期预算：agentLimit 只减不增，deadlineMs 只早不晚。
  let agentLimit = maxAgents;
  let deadlineMs = Date.now() + (opts.wallClockMs ?? DEFAULT_WALL_CLOCK_MS);

  // 三原语共享的爬坡信号量（完成一个补一个）。
  let active = 0;
  const waiters: (() => void)[] = [];
  const acquire = (): Promise<void> => {
    if (active < maxConcurrent) {
      active += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => waiters.push(resolve));
  };
  const release = (): void => {
    const next = waiters.shift();
    if (next !== undefined) {
      next();
    } else {
      active -= 1;
    }
  };

  /**
   * 真跑一次子 agent。预算/上限耗尽在这里抛错（向沙箱传播，脚本可 catch 自救）；
   * runSubagent 意外抛错按终态失败处理（isError → agent() 返回 null）。
   */
  const runOnce = async (
    prompt: string,
    subagentType: string,
    description?: string,
  ): Promise<{ summary: string; isError: boolean }> => {
    if (Date.now() >= deadlineMs) {
      throw new Error('dynamic_workflow 时间预算耗尽（wall-clock 到点，可能被 budget({minutes}) 收紧）。');
    }
    if (agentsUsed >= agentLimit) {
      throw new Error(`已达 dynamic_workflow agent 总数上限（${agentLimit}）。可减小编排规模，或调大 max_agents 入参。`);
    }
    const n = ++agentsUsed;
    await acquire();
    const req: SpawnSubagentRequest = {
      subagentType,
      prompt,
      depth: 0,
      id: `dwf-${runId}-${n}`,
      description,
      signal: opts.signal,
    };
    try {
      return await opts.runSubagent(req);
    } catch {
      return { summary: '', isError: true }; // runSubagent 意外抛错同样按终态失败处理
    } finally {
      release();
    }
  };

  /**
   * schema 结构化输出：prompt 自动追加输出契约，返回时解析 JSON + ajv 校验；
   * 不匹配带错误让子 agent 纠正重试 ≤ SCHEMA_MAX_RETRIES 次，仍败返回 null。
   * 成功时返回 JSON 字符串（guest 侧 parse 成对象交还脚本）。
   */
  const runWithSchema = async (
    prompt: string,
    schema: unknown,
    subagentType: string,
    description: string | undefined,
    key: string,
  ): Promise<string | null> => {
    let validate: ValidateFunction;
    try {
      validate = ajv.compile(schema as object);
    } catch (e) {
      // schema 本身非法是脚本 bug，抛错让脚本感知（不吞成 null）。
      throw new Error(`agent() 的 schema 不是合法 JSON Schema：${(e as Error).message}`);
    }
    const instruction =
      `\n\n【输出契约】只输出符合以下 JSON Schema 的 JSON：` +
      `不要输出任何解释、前后缀文字或 Markdown 代码围栏。\n${JSON.stringify(schema)}`;
    let lastError = '';
    for (let attempt = 0; attempt <= SCHEMA_MAX_RETRIES; attempt++) {
      const p =
        attempt === 0
          ? prompt + instruction
          : `${prompt}${instruction}\n\n你上一次的输出未通过校验：${lastError}\n请纠正后重新输出，只输出符合 Schema 的 JSON。`;
      const r = await runOnce(p, subagentType, description);
      if (r.isError) return null; // 子 agent 终态失败：按失败语义直接返回 null，不重试
      const parsed = tryParseJson(r.summary);
      if (parsed.ok) {
        if (validate(parsed.value)) {
          const out = JSON.stringify(parsed.value);
          await journal.record(key, out);
          return out;
        }
        lastError = ajv.errorsText(validate.errors);
      } else {
        lastError = parsed.error;
      }
    }
    return null; // 纠正重试仍失败：诚实返回 null，由脚本决定容错
  };

  // 阶段归属：phase() 原语与 agent(..., {phase}) 共用同一事件通道（WorkflowStepEvent kind:'phase'）
  // 与同一日志缓冲（[phase] 行随工具输出进返回给模型的报告）。currentPhase 去重——
  // 连续归属同一阶段的 agent 不重复发事件、不重复记日志。
  // 动机（2026-07-30 实测）：模型为给每个调研标阶段而写出「phase(); await agent(); phase(); await agent()」
  // 的串行结构——agent({phase}) 让并行与阶段标记不再互斥。
  const logs = new LogBuffer();
  let currentPhase: string | undefined;
  const emitPhase = (title: string): void => {
    if (title === currentPhase) return;
    currentPhase = title;
    logs.append(`[phase] ${title}`);
    opts.onWorkflowStep?.({ index: -1, total: 0, kind: 'phase', status: 'start', title });
  };

  const spawn: SpawnAgentFn = async (prompt, spawnOpts) => {
    if (spawnOpts.phase !== undefined) emitPhase(spawnOpts.phase);
    const subagentType = spawnOpts.subagentType ?? 'general';
    // schema 参与缓存 key：同 prompt 不同 schema 是不同调用。
    const key = Journal.key(
      'agent',
      prompt,
      spawnOpts.schema !== undefined ? `${subagentType}::${JSON.stringify(spawnOpts.schema)}` : subagentType,
    );
    const cached = journal.get(key);
    if (cached !== undefined) {
      journalHits += 1;
      return cached;
    }
    if (spawnOpts.schema !== undefined) {
      return runWithSchema(prompt, spawnOpts.schema, subagentType, spawnOpts.description, key);
    }
    const r = await runOnce(prompt, subagentType, spawnOpts.description);
    if (r.isError) return null; // 终态失败返回 null，不写 journal（resume 时真重跑）
    await journal.record(key, r.summary);
    return r.summary;
  };

  const onPhase: PhaseFn = (title) => {
    emitPhase(title);
  };

  const onBudget: BudgetFn = (b) => {
    if (typeof b.agents === 'number' && Number.isFinite(b.agents) && b.agents > 0) {
      agentLimit = Math.min(agentLimit, Math.floor(b.agents));
    }
    if (typeof b.minutes === 'number' && Number.isFinite(b.minutes) && b.minutes >= 0) {
      deadlineMs = Math.min(deadlineMs, Date.now() + b.minutes * 60_000);
    }
  };

  const sandbox = await DynamicWorkflowSandbox.create({
    signal: opts.signal,
    wallClockMs: opts.wallClockMs,
    deadline: () => deadlineMs,
    maxInstructions: opts.maxInstructions,
  });
  try {
    await injectPrimitives(sandbox, { spawn, logs, onPhase, onBudget });

    // 确定性 prelude + args 注入。
    const argsJson = JSON.stringify(opts.args ?? {});
    const boot = await sandbox.eval(
      `${DETERMINISM_PRELUDE}\nglobalThis.args = JSON.parse(${JSON.stringify(argsJson)});`,
      'dwf-boot.js',
    );
    if (boot.error !== undefined) {
      const err = dumpError(sandbox, boot.error);
      throw new DynamicWorkflowError(`dynamic_workflow 启动失败：${err.message}`, {
        runId,
        journalPath: journal.filePath,
        scriptPath,
        agentsUsed,
        stack: err.stack,
      });
    }
    boot.value.dispose();

    // 用户脚本包成 async 函数体执行（脚本以 return <值> 收尾）。
    const wrapped = `(async () => {\n${opts.script}\n})()`;
    const evalResult = await sandbox.eval(wrapped);
    if (evalResult.error !== undefined) {
      const err = dumpError(sandbox, evalResult.error);
      throw new DynamicWorkflowError(`dynamic_workflow 脚本执行失败：${err.message}`, {
        runId,
        journalPath: journal.filePath,
        scriptPath,
        agentsUsed,
        stack: err.stack,
      });
    }
    const promiseHandle = evalResult.value;
    try {
      const state = await sandbox.settle(promiseHandle);
      if (state.type !== 'fulfilled') {
        if (state.type === 'rejected') {
          const err = dumpError(sandbox, state.error);
          throw new DynamicWorkflowError(`dynamic_workflow 脚本抛出异常：${err.message}`, {
            runId,
            journalPath: journal.filePath,
        scriptPath,
            agentsUsed,
            stack: err.stack,
          });
        }
        throw new DynamicWorkflowError('dynamic_workflow 内部错误：脚本 promise 未收束', {
          runId,
          journalPath: journal.filePath,
        scriptPath,
          agentsUsed,
        });
      }
      const value: unknown = sandbox.context.dump(state.value);
      state.value.dispose();
      return {
        report: stringifyReport(value),
        agentsUsed,
        journalHits,
        runId,
        journalPath: journal.filePath,
        scriptPath,
        logs: logs.lines,
      };
    } finally {
      promiseHandle.dispose();
    }
  } catch (e) {
    if (e instanceof DynamicWorkflowError) throw e;
    if (e instanceof SandboxInterrupt) {
      throw new DynamicWorkflowError(`dynamic_workflow 被中断：${e.reason}`, {
        runId,
        journalPath: journal.filePath,
        scriptPath,
        agentsUsed,
      });
    }
    throw new DynamicWorkflowError(`dynamic_workflow 内部错误：${(e as Error).message}`, {
      runId,
      journalPath: journal.filePath,
      scriptPath,
      agentsUsed,
    });
  } finally {
    sandbox.dispose();
  }
}

function dumpError(sandbox: DynamicWorkflowSandbox, errorHandle: QuickJSHandle): { message: string; stack?: string } {
  try {
    const dumped = sandbox.context.dump(errorHandle) as { name?: string; message?: string; stack?: string } | undefined;
    errorHandle.dispose();
    if (typeof dumped === 'object' && dumped !== null) {
      return {
        message: `${dumped.name ?? 'Error'}: ${dumped.message ?? String(dumped)}`,
        stack: typeof dumped.stack === 'string' ? dumped.stack : undefined,
      };
    }
    return { message: String(dumped) };
  } catch {
    return { message: '（错误对象无法序列化）' };
  }
}
