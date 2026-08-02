import { spawn, type ChildProcess } from 'node:child_process';
import type { HookConfigEntry, HookEventName } from '../../config/config.js';
import { t } from '../../i18n.js';
import type { ToolResult } from '../../tools/types.js';
import type { Authorization, LoopHooks, StopContinuation, ToolCallRequest } from '../hooks.js';

/** PostToolUse 传入 hook 的 tool_output 截断长度（字符）。 */
export const POST_TOOL_OUTPUT_MAX = 2000;

/** 一次 hook 命令的执行结果（进程层，不含语义判定）。 */
interface HookExecResult {
  /** exit = 正常退出（带码）；timeout = 超时被杀；error = spawn 失败/崩溃。 */
  kind: 'exit' | 'timeout' | 'error';
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * 引擎消费的 hook 条目：在 config.toml 的 [[hooks]] 条目之上可选携带 cwd/env。
 * plugin hooks 用这两个字段把 command 的 cwd 固定为插件根并注入 STEP_CODE_PLUGIN_ROOT。
 */
export interface HookEngineEntry extends HookConfigEntry {
  /** 命令工作目录（缺省继承宿主进程 cwd）。 */
  cwd?: string;
  /** 追加环境变量（在 process.env 之上覆盖）。 */
  env?: Record<string, string>;
}

/** 一次事件触发的聚合结果（同事件多条 hook 并行执行后的汇总）。 */
export interface HookEventResult {
  /** 任一 hook exit 2 即阻断（reason 取第一条阻断 hook 的 stderr）。 */
  blocked: boolean;
  /** 阻断原因（exit 2 hook 的 stderr；空 stderr 时落兜底文案）。 */
  reason?: string;
  /** 全部放行 hook 的 stdout 拼接（trim 后非空才收），供 UserPromptSubmit/SessionStart 注入上下文。 */
  stdout: string;
}

/** 杀掉 hook 进程树：Windows 用 taskkill /T（shell:true 下 child 是 cmd.exe，真命令是其子孙）。 */
function killTree(child: ChildProcess): void {
  if (child.pid === undefined) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  // POSIX：detached 使 child 自成进程组，负 pid 杀整组；失败退回单进程 kill
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}

/**
 * 执行单条 hook 命令：spawn with shell，stdin 写入 JSON 后关闭，收集 stdout/stderr。
 * 超时杀进程树（kind='timeout'）；spawn 失败/进程崩溃归 kind='error'。绝不 reject。
 * opts.cwd/env 供 plugin hook 固定工作目录并注入插件根环境变量。
 */
function execHook(
  command: string,
  stdinText: string,
  timeoutS: number,
  opts?: { cwd?: string; env?: Record<string, string> },
): Promise<HookExecResult> {
  return new Promise((resolve) => {
    const child = spawn(command, {
      shell: true,
      detached: process.platform !== 'win32',
      stdio: ['pipe', 'pipe', 'pipe'],
      ...(opts?.cwd !== undefined ? { cwd: opts.cwd } : {}),
      ...(opts?.env !== undefined ? { env: { ...process.env, ...opts.env } } : {}),
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killTree(child);
      resolve({ kind: 'timeout', code: null, stdout, stderr });
    }, timeoutS * 1000);
    child.stdout?.on('data', (d) => {
      stdout += String(d);
    });
    child.stderr?.on('data', (d) => {
      stderr += String(d);
    });
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ kind: 'error', code: null, stdout, stderr: stderr !== '' ? stderr : e.message });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ kind: 'exit', code, stdout, stderr });
    });
    // 命令立即退出时写 stdin 可能 EPIPE，吞掉防未捕获异常
    child.stdin?.on('error', () => {});
    child.stdin?.end(stdinText);
  });
}

/**
 * 用户可配置 hooks 引擎：按事件匹配配置、并行执行 shell 命令、聚合放行/阻断语义。
 *
 * 执行语义（业界 hook 机制的收敛结论）：
 * - stdin JSON（snake_case）：基础字段 hook_event_name / session_id / cwd + 事件字段
 *   （tool_name / tool_input / tool_output / prompt 等）。
 * - exit 0 → 放行，stdout 在 UserPromptSubmit / SessionStart 下注入上下文；
 *   exit 2 → 阻断，stderr 为原因；其他非零 / 超时 / 崩溃 → 放行（fail-open），stderr 摘要进 notice。
 * - 同事件多条 hook 并行执行，各自带超时（默认 30s，可配，硬顶 600s），超时杀进程树。
 *
 * fail-open 是有意选择：hooks 是体验增强不是安全边界（安全边界在权限系统），
 * hook 脚本崩了不该让 CLI 不可用——hooks 不应作为唯一安全防线。
 */
export class HookEngine {
  /** hook 执行可见性通知出口（TUI 转录区 note / 非交互 stderr），由组合根或 App 注入。 */
  private onNotice: (message: string) => void;

  constructor(
    private readonly hooks: HookEngineEntry[],
    private readonly opts: { sessionId: string; cwd: string; onNotice?: (message: string) => void },
  ) {
    this.onNotice = opts.onNotice ?? (() => {});
  }

  /** 替换通知出口（App 挂载后接到转录区 pushItem）。 */
  setNoticeSink(onNotice: (message: string) => void): void {
    this.onNotice = onNotice;
  }

  /** 匹配某事件的 hook 列表：matcher 只对带标识的事件生效（PreToolUse/PostToolUse 传工具名）。 */
  private matching(event: HookEventName, subject?: string): HookEngineEntry[] {
    return this.hooks.filter(
      (h) =>
        h.event === event &&
        (h.matcher === undefined || (subject !== undefined && h.matcher.test(subject))),
    );
  }

  /**
   * 触发一个事件：并行执行全部匹配 hook，聚合结果。
   * @param event 事件名。
   * @param fields 事件字段（并入 stdin JSON，如 tool_name / tool_input / tool_output / prompt）。
   * @param subject matcher 匹配对象（工具名等）；无标识事件不传（带 matcher 的 hook 在无标识事件上不触发）。
   */
  async run(
    event: HookEventName,
    fields: Record<string, unknown> = {},
    subject?: string,
  ): Promise<HookEventResult> {
    const list = this.matching(event, subject);
    if (list.length === 0) return { blocked: false, stdout: '' };

    let blockedReason: string | undefined;
    const stdoutParts: string[] = [];
    await Promise.all(
      list.map(async (hook) => {
        const payload = {
          hook_event_name: event,
          session_id: this.opts.sessionId,
          cwd: this.opts.cwd,
          ...fields,
        };
        this.onNotice(t('hook.notice.start', { event, command: hook.command }));
        const r = await execHook(hook.command, JSON.stringify(payload), hook.timeout, {
          cwd: hook.cwd,
          env: hook.env,
        });
        if (r.kind === 'timeout') {
          // 超时 fail-open：杀进程树后按放行处理
          this.onNotice(t('hook.notice.timeout', { event, timeout: hook.timeout, command: hook.command }));
          return;
        }
        if (r.kind === 'error') {
          this.onNotice(t('hook.notice.failed', { event, detail: r.stderr.trim(), command: hook.command }));
          return;
        }
        if (r.code === 0) {
          const out = r.stdout.trim();
          if (out !== '') stdoutParts.push(out);
          return;
        }
        if (r.code === 2) {
          const reason = r.stderr.trim() !== '' ? r.stderr.trim() : t('hook.blocked.noReason');
          blockedReason ??= reason;
          this.onNotice(t('hook.notice.blocked', { event, reason }));
          return;
        }
        // 其余非零：fail-open，stderr 摘要进 notice
        this.onNotice(
          t('hook.notice.failed', { event, detail: `exit ${r.code}: ${r.stderr.trim()}`, command: hook.command }),
        );
      }),
    );

    return blockedReason !== undefined
      ? { blocked: true, reason: blockedReason, stdout: '' }
      : { blocked: false, stdout: stdoutParts.join('\n') };
  }
}

/** composeLoopHooks 的返回值：叠加后的 LoopHooks + Stop 一次性续行标志的复位入口。 */
export interface ComposedLoopHooks extends LoopHooks {
  /** 复位 Stop 续行标志（每次用户提交新一轮时调用，防死循环标志每轮只给一次机会）。 */
  resetStopContinuation: () => void;
}

/**
 * 把用户 hooks 叠加到既有 LoopHooks 之上（LoopHooks 接口本身不动）：
 * - PreToolUse：授权链首，deny-only——exit 2 直接拒（reason 回灌模型），放行则继续走既有审批。
 *   hook 只能否决不能批准，不替代人工审批。
 * - PostToolUse：fire-and-forget，不改写结果（tool_output 截断 {@link POST_TOOL_OUTPUT_MAX} 字符传入）。
 * - Stop：exit 2 时返回续接描述（reason 为注入文本），只给一次续行机会（防死循环标志）。
 *   续接与 goal 统一走 continuation 事件，由 App/headless 层注入下一轮，引擎不直写 history。
 * @param engine 用户 hooks 引擎。
 * @param base 既有 LoopHooks（权限审批、goal 续跑等），可传 {}。
 */
export function composeLoopHooks(
  engine: HookEngine,
  base: LoopHooks,
): ComposedLoopHooks {
  let stopContinuationUsed = false;
  return {
    resetStopContinuation: () => {
      stopContinuationUsed = false;
    },
    authorizeToolCall: async (req: ToolCallRequest): Promise<Authorization> => {
      const r = await engine.run('PreToolUse', { tool_name: req.name, tool_input: req.input }, req.name);
      if (r.blocked) return { decision: 'deny', reason: r.reason ?? t('hook.blocked.noReason') };
      if (base.authorizeToolCall === undefined) return { decision: 'allow' };
      return base.authorizeToolCall(req);
    },
    finalizeToolResult: (req: ToolCallRequest, result: ToolResult) => {
      // fire-and-forget：不 await、不改写结果
      void engine.run(
        'PostToolUse',
        { tool_name: req.name, tool_input: req.input, tool_output: result.content.slice(0, POST_TOOL_OUTPUT_MAX) },
        req.name,
      );
      if (base.finalizeToolResult === undefined) return result;
      return base.finalizeToolResult(req, result);
    },
    shouldContinueAfterStop: async (): Promise<StopContinuation | null> => {
      // 先走 base 的续接裁决（goal 预算/计轮、缺省结束）。
      // Stop hook 作为用户侧「阻断停机并注入消息」的扩展，不能绕过 base 的预算 enforcement，
      // 否则每次 resetStopContinuation 后都可再次触发，导致无限循环。
      // base 未实现该 hook 时视为「无额外约束」，仍需执行 Stop hook；
      // base 显式返回 null 时才真正结束（预算耗尽或 goal 完成）。
      const baseCont =
        base.shouldContinueAfterStop !== undefined ? await base.shouldContinueAfterStop() : undefined;
      if (baseCont === null) return null;

      if (!stopContinuationUsed) {
        const r = await engine.run('Stop', {});
        if (r.blocked) {
          stopContinuationUsed = true;
          return { inject: r.reason ?? t('hook.blocked.noReason') };
        }
      }

      return baseCont ?? null;
    },
  };
}
