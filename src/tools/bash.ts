import { spawn, type ChildProcess } from 'node:child_process';
import { z } from 'zod';
import { fail, ok, type ToolContext, type ToolDef, type ToolResult } from './types.js';
import { resolveShell, winPathToWsl, rewriteNulRedirect, type ResolvedShell } from './shellResolve.js';

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
/** 前台运行期间收集的部分输出上限（对齐原 spawnSync maxBuffer）。 */
const MAX_COLLECT = 10 * 1024 * 1024;

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
 * 截断超长输出（保留头部，与原 spawnSync 路径一致）。
 *
 * `droppedBytes` 是**收集阶段**就被丢弃的量（输出超过 MAX_COLLECT 后不再累积）。
 * 它必须单独报告：`out.length` 只是「收集到的长度」，一旦触顶就不再增长，
 * 于是「共 N 字符」会把 50MB 的输出说成 10MB，让调用方以为只丢了一点点。
 * 收集阶段丢掉的内容无法事后找回，所以提示里要给出重定向到文件的替代路径。
 */
function truncateOutput(out: string, droppedBytes = 0): string {
  const notes: string[] = [];
  let body = out;
  if (out.length > MAX_OUTPUT) {
    body = out.slice(0, MAX_OUTPUT);
    notes.push(`输出已截断，共 ${out.length} 字符`);
  }
  if (droppedBytes > 0) {
    notes.push(
      `另有约 ${Math.round(droppedBytes / 1024)} KB 输出因超过 ${MAX_COLLECT / (1024 * 1024)}MB 收集上限被丢弃，` +
        `不可恢复——需要完整输出请把命令的 stdout 重定向到文件，再用 read_file 分页读`,
    );
  }
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
      proc = spawn(shell.cmd, shell.args(command), { cwd: spawnCwd });
    } catch (e) {
      resolve(fail(`命令执行异常：${(e as Error).message}`));
      return;
    }

    let out = '';
    let settled = false;
    /**
     * 收集触顶后被丢弃的字节数。不记录的话，触顶后所有后续输出会**无声消失**，
     * 而 `out.length` 停在上限值，让「共 N 字符」这个数字变成低报。
     */
    let droppedBytes = 0;
    const append = (chunk: Buffer): void => {
      if (out.length < MAX_COLLECT) out += chunk.toString('utf8');
      else droppedBytes += chunk.length;
    };
    proc.stdout?.on('data', append);
    proc.stderr?.on('data', append);

    // 启动即登记前台任务（detached=false）：前台期间输出收集与计时归这里，
    // 转后台时 manager 以 getPartialOutput 当前值为起点接管。登记失败（并发上限等）
    // 退化为不支持后台的行为（超时即杀）。
    let taskId: string | undefined;
    if (ctx.bashAutoBackgroundOnTimeout !== false && ctx.background !== undefined) {
      try {
        taskId = ctx.background.registerForeground(command, proc, () => out);
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
      proc.stdout?.removeListener('data', append);
      proc.stderr?.removeListener('data', append);
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
      proc.kill();
      finish(fail('用户中断，命令已终止。'));
    };
    ctx.signal?.addEventListener('abort', onAbort, { once: true });

    const onError = (e: Error): void => {
      if (taskId !== undefined) ctx.background?.settleForeground(taskId, null, e.message);
      finish(fail(`命令执行失败：${e.message}`));
    };
    const onClose = (code: number | null): void => {
      // 无论中断与否都先同步终态：登记过的前台任务不能留在 running（中断杀死的进程同样到达终态）
      if (taskId !== undefined) ctx.background?.settleForeground(taskId, code);
      // Esc 中断后进程被杀也会触发 close：中断语义优先（与旧行为一致）
      if (ctx.signal?.aborted) {
        finish(fail('用户中断，命令已终止。'));
        return;
      }
      const text = truncateOutput(out, droppedBytes);
      const exitCode = code ?? 0;
      if (exitCode !== 0) {
        finish(fail(`${text}\n\n[退出码：${exitCode}]`));
      } else {
        finish(ok(text === '' ? '[命令执行完毕，无输出]' : text));
      }
    };
    proc.on('error', onError);
    proc.on('close', onClose);

    // 第三方结算源：前台任务被转后台（用户主动 / 前台超时自动）。
    // 终态（terminal）由 close/error 路径结算，这里直接忽略。
    if (taskId !== undefined && ctx.background !== undefined) {
      const background = ctx.background;
      const id = taskId;
      void background.waitForegroundRelease(id).then((reason) => {
        if (settled || reason === 'terminal') return;
        const partial = out === '' ? '（暂无输出）' : truncateOutput(out, droppedBytes);
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
        proc.kill();
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
