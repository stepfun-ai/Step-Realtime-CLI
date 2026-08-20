import { spawn, type ChildProcess } from 'node:child_process';
import { z } from 'zod';
import { fail, ok, type ToolContext, type ToolDef, type ToolResult } from './types.js';
import { resolveShell, winPathToWsl, rewriteNulRedirect, type ResolvedShell } from './shellResolve.js';
import { createOutputCollector, renderOutputNotes, type OutputSnapshot } from './bashOutput.js';
import { truncateMiddle } from '../agent/toolResultLimit.js';
import { terminateProcTree } from '../agent/background/manager.js';

const schema = z.object({
  command: z.string().describe('要执行的 shell 命令。'),
  timeout: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('超时秒数，默认 60，上限 300。'),
  run_in_background: z
    .boolean()
    .optional()
    .describe('true 则后台执行并立即返回 task_id（用 task_list/task_output/task_stop 管理），不阻塞当前回合。'),
});

const DEFAULT_TIMEOUT = 60;
/** 前台命令的绝对超时上限（秒）。schema 已声明此上限；超过会按此值执行并在结果中告知模型。 */
const MAX_TIMEOUT = 300;
const MAX_OUTPUT = 30_000;

/**
 * 按 shell family 预处理命令与工作目录。
 * - WSL：wsl.exe 是 Windows 程序，cwd 传原生 Windows 路径给 spawn；bash 内部工作目录
 *   通过命令前加 `cd /mnt/...` 显式切换。同时把 NUL 重定向改写成 /dev/null。
 * - posix/busybox：cwd 直接用原生路径（Git Bash 的 bash.exe 认 Windows 路径，转 /c/ 反而报错）；
 *   NUL 重定向改写成 /dev/null。
 * - powershell：命令与 cwd 原样透传（none 在 execute 入口已拦截，走不到这里）。
 * 返回处理后的 command 与传给 spawn 的 cwd。
 * 导出供单元测试直接验证各 family 的处理（生产路径只在本模块内调用）。
 */
export function prepareCommand(
  command: string,
  shell: ResolvedShell,
  cwd: string,
): { command: string; cwd: string } {
  if (shell.family === 'wsl') {
    const wslCwd = winPathToWsl(cwd);
    const withCd = wslCwd ? `cd '${wslCwd.replace(/'/g, "'\\''")}' && ${command}` : command;
    return { command: rewriteNulRedirect(withCd), cwd };
  }
  if (shell.family === 'posix' || shell.family === 'busybox') {
    return { command: rewriteNulRedirect(command), cwd };
  }
  return { command, cwd };
}

/**
 * 截断超长输出并附上收集阶段的损失说明。
 *
 * 两层截断必须分别交代，因为它们的可恢复性完全不同：
 *
 * - **展示截断**（超过 MAX_OUTPUT）：内容还在内存里，只是没全给模型看，所以只需报长度；
 * - **收集丢弃**（超过内存预算）：内容已经不在内存里。有溢出文件时可从文件恢复，
 *   没有时彻底丢失。
 *
 * 「共 N 字符」的 N 只是**内存收集到的长度**，触顶后不再增长。单独看它会把 50MB 说成
 * 10MB；所以它后面必须紧跟丢弃说明，两段并存才不误导。
 *
 * ## 展示截断为什么必须保尾部
 *
 * 原实现是 `out.slice(0, MAX_OUTPUT)`——**只保头**。对失败的命令这恰好切掉了唯一有用的
 * 部分：报错几乎总在输出末尾。这一层与收集层的 stdout/stderr 分流是**同一个问题的两半**，
 * 只修收集层拿不到收益——错误信息刚被保进内存，转头又被展示截断切掉。
 *
 * 因此改用与工具结果兜底同一个中间截断（头 60% + 尾 40%，中间标注省略量），
 * 复用 `truncateMiddle` 而不另写一份，避免两处截断行为漂移。
 */
function truncateOutput(snap: OutputSnapshot, canDelegate: boolean): string {
  const notes: string[] = [];
  const out = snap.text;
  let body = out;
  if (out.length > MAX_OUTPUT) {
    body = truncateMiddle(out, MAX_OUTPUT);
    notes.push(`输出已截断，共 ${out.length} 字符`);
  }
  notes.push(...renderOutputNotes(snap, { canDelegate }));
  if (notes.length === 0) return out;
  return `${body}\n\n[${notes.join('；')}]`;
}

/**
 * 前台执行命令：async spawn + 自行计时（不再用 spawnSync 的超时即杀）。
 * 四种结局：正常退出（按退出码返回）、用户 Esc 中断（杀进程报错）、用户主动转后台、前台超时。
 * 支持后台任务时进程启动即登记为前台任务：用户按键可主动转后台；前台超时默认也不杀——
 * 翻 detached 标志重武装后台超时，tool_result 正常返回；登记失败、配置关闭或上下文
 * 不支持后台任务时保持旧行为（超时即杀报错）。
 */
function runForeground(
  command: string,
  shell: ResolvedShell,
  spawnCwd: string,
  ctx: ToolContext,
  timeoutSec: number,
): Promise<ToolResult> {
  return new Promise<ToolResult>((resolve) => {
    if (ctx.signal?.aborted) {
      resolve(fail('用户中断，命令已终止。'));
      return;
    }
    let proc: ChildProcess;
    try {
      proc = spawn(shell.cmd, shell.args(command), {
        cwd: spawnCwd,
        // stdin 立即 EOF：agent 无 stdin 通道，pipe 永不关闭会让读 stdin 的命令挂起
        stdio: ['ignore', 'pipe', 'pipe'],
        // POSIX 独立进程组，中断/超时杀整组防孙进程逃逸；Windows 杀树靠 taskkill /T
        detached: process.platform !== 'win32',
      });
    } catch (e) {
      resolve(fail(`命令执行异常：${(e as Error).message}`));
      return;
    }

    let settled = false;
    /**
     * 输出收集：两条流**分别记账**，触顶后溢出落盘（细节与理由见 bashOutput.ts 顶部）。
     *
     * 这里最关键的一点是分流本身：合用一个预算时，一条刷满 10MB stdout 的失败命令会把
     * 尾部 stderr 里的错误信息整段挤掉，而那几行恰恰是模型唯一需要的内容。
     */
    const collector = createOutputCollector({ cwd: ctx.cwd });
    const onStdout = (chunk: Buffer): void => {
      collector.append(chunk, 'stdout');
    };
    const onStderr = (chunk: Buffer): void => {
      collector.append(chunk, 'stderr');
    };
    proc.stdout?.on('data', onStdout);
    proc.stderr?.on('data', onStderr);
    /** 有子 agent 可用时，溢出文件的恢复指引优先建议委派（避免把整份日志拉进当前上下文）。 */
    const canDelegate = ctx.runSubagent !== undefined;

    // 启动即登记前台任务（detached=false）：前台期间输出收集与计时归这里，
    // 转后台时 manager 以 getPartialOutput 当前值为起点接管。登记失败（并发上限等）
    // 退化为不支持后台的行为（超时即杀）。
    let taskId: string | undefined;
    if (ctx.bashAutoBackgroundOnTimeout !== false && ctx.background !== undefined) {
      try {
        taskId = ctx.background.registerForeground(command, proc, () => collector.snapshot().text);
      } catch {
        taskId = undefined;
      }
    }

    /** 清理前台计时与自身监听。必须按引用摘除：转后台后 manager 在同一进程上挂了自己的监听，全量摘除会误伤。 */
    const cleanup = (): void => {
      clearTimeout(timer);
      ctx.signal?.removeEventListener('abort', onAbort);
      proc.removeListener('close', onClose);
      proc.removeListener('error', onError);
      proc.stdout?.removeListener('data', onStdout);
      proc.stderr?.removeListener('data', onStderr);
      collector.close();
    };
    const finish = (r: ToolResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(r);
    };

    const onAbort = (): void => {
      // 已转后台的任务独立于回合存活：中断只杀还在前台的进程
      if (taskId !== undefined && ctx.background?.isDetached(taskId) === true) return;
      terminateProcTree(proc);
      finish(fail('用户中断，命令已终止。'));
    };
    ctx.signal?.addEventListener('abort', onAbort, { once: true });

    const onError = (e: Error): void => {
      if (taskId !== undefined) ctx.background?.settleForeground(taskId, null, e.message);
      finish(fail(`命令执行失败：${e.message}`));
    };
    let stdoutEnded = false;
    let stderrEnded = false;
    let exitCode: number | null = null;

    const onStdoutEnd = (): void => {
      stdoutEnded = true;
      maybeFinish();
    };
    const onStderrEnd = (): void => {
      stderrEnded = true;
      maybeFinish();
    };
    const onClose = (code: number | null): void => {
      exitCode = code;
      maybeFinish();
    };
    /** 等 stdout/stderr 的 end 与 close 三者齐了再 snapshot：close 可能在流 data 之前触发，漏掉尾部 stderr。 */
    const maybeFinish = (): void => {
      if (exitCode === null || !stdoutEnded || !stderrEnded) return;
      if (taskId !== undefined) ctx.background?.settleForeground(taskId, exitCode);
      if (ctx.signal?.aborted) {
        finish(fail('用户中断，命令已终止。'));
        return;
      }
      const text = truncateOutput(collector.snapshot(), canDelegate);
      const code = exitCode ?? 0;
      if (code !== 0) {
        finish(fail(`${text}\n\n[退出码：${code}]`));
      } else {
        finish(ok(text === '' ? '[命令执行完毕，无输出]' : text));
      }
    };
    proc.on('error', onError);
    proc.on('close', onClose);
    proc.stdout?.on('end', onStdoutEnd);
    proc.stderr?.on('end', onStderrEnd);

    // 第三方结算源：前台任务被转后台（用户主动 / 前台超时自动）。
    // 终态（terminal）由 close/error 路径结算，这里直接忽略。
    if (taskId !== undefined && ctx.background !== undefined) {
      const background = ctx.background;
      const id = taskId;
      void background.waitForegroundRelease(id).then((reason) => {
        if (settled || reason === 'terminal') return;
        const snap = collector.snapshot();
        const partial = snap.text === '' ? '（暂无输出）' : truncateOutput(snap, canDelegate);
        const lead =
          reason === 'detached'
            ? `命令已转为后台任务 ${id} 继续运行，不再阻塞当前回合。`
            : `命令超过前台超时（${timeoutSec}s），已转为后台任务 ${id} 继续运行，不再阻塞当前回合。`;
        finish(
          ok(
            `${lead}任务到达终态时你会收到完成通知；也可用 task_list 查看状态、task_output 看输出、task_stop 终止。\n\n已收集的部分输出：\n${partial}`,
          ),
        );
      });
    }

    const timer = setTimeout(() => {
      if (settled) return;
      if (taskId === undefined || ctx.background === undefined) {
        // 配置关闭或上下文不支持后台：保持旧行为，超时即杀返回错误
        terminateProcTree(proc);
        finish(fail(`命令超时（${timeoutSec}s）后被终止。`));
        return;
      }
      // 前台超时 = 自动转后台，由 waitForegroundRelease 路径统一结算；
      // 返回 false（恰已终态的竞争）时不动作，close 路径会正常结算
      ctx.background.detach(taskId, true);
    }, timeoutSec * 1000);
  });
}

export const bashTool: ToolDef<z.infer<typeof schema>> = {
  name: 'bash',
  description:
    '执行一条 shell 命令并返回合并后的 stdout+stderr。Windows 上优先用 Git Bash（Unix 语法），无则回退 WSL/busybox/PowerShell。避免交互式或永不结束的命令。run_in_background=true 时后台执行并立即返回 task_id。前台超时后命令自动转为后台任务继续运行。',
  schema,
  async execute(input, ctx) {
    const shell = resolveShell();
    if (shell.family === 'none') {
      return fail(
        'Windows 上未找到可用的 shell 解释器（Git Bash / WSL / busybox / PowerShell 都没有），无法执行命令。请安装 Git for Windows（提供 Git Bash），或把 bash.exe 绝对路径设到环境变量 STEP_SHELL_PATH。',
      );
    }
    const prepared = prepareCommand(input.command, shell, ctx.cwd);

    // 后台执行：起进程、注册、立即返回 task_id
    if (input.run_in_background === true) {
      if (ctx.background === undefined) {
        return fail('当前上下文不支持后台任务。');
      }
      try {
        const id = ctx.background.start(
          input.command,
          shell.cmd,
          shell.args(prepared.command),
          prepared.cwd,
        );
        return ok(
          `已在后台启动任务 ${id}。任务到达终态时你会自动收到完成通知，不要起了就立刻等待或反复轮询；确需查看时用 task_list 看状态、task_output 看输出、task_stop 终止。`,
        );
      } catch (e) {
        return fail((e as Error).message);
      }
    }

    const requestedSec = input.timeout ?? DEFAULT_TIMEOUT;
    const timeoutSec = Math.min(requestedSec, MAX_TIMEOUT);
    const clamped = requestedSec > MAX_TIMEOUT;
    const result = await runForeground(prepared.command, shell, prepared.cwd, ctx, timeoutSec);
    if (clamped) {
      const notice = `【超时已限制】请求 ${requestedSec}s 超过前台上限 ${MAX_TIMEOUT}s，已按 ${timeoutSec}s 执行。`;
      return { ...result, content: `${notice}\n${result.content}` };
    }
    return result;
  },
};
