import { spawn, type ChildProcess } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { notifyDedupKey } from '../wirelog.js';
import { notificationIdFor } from './notify.js';

/** 后台任务状态。 */
export type TaskStatus = 'running' | 'completed' | 'failed' | 'killed';

/**
 * 对账恢复专属的终态：磁盘 running 但进程已不存在（任务随旧进程一起死掉）。
 * 不进 TaskStatus 联合、也不进内存任务列表：现有消费点（UI 样式表 `Record<TaskStatus, …>`、
 * 状态过滤）不该被一个只有 resume 路径才会产生的状态强制扩散。lost 任务只存在于
 * meta.json 与 reconcile 返回值里（展示层如何呈现 lost 由 UI 侧另行感知）。
 */
export type LostTask = Omit<BackgroundTask, 'status'> & { status: 'lost' };

/** 前台任务等待方的释放原因：用户主动转后台 / 前台超时自动转后台 / 任务到达终态。 */
export type ForegroundReleaseReason = 'detached' | 'timeout_detached' | 'terminal';

export interface BackgroundTask {
  id: string;
  command: string;
  status: TaskStatus;
  /** 退出码（完成后）。 */
  exitCode?: number;
  startedAt: string;
  endedAt?: string;
  /** 合并输出（stdout+stderr，尾部，内存只留一部分）。 */
  output: string;
  /** 任务类别：process=bash 进程（start/adopt）；subagent/workflow=后台 async 任务（startTask）。 */
  kind?: 'process' | 'subagent' | 'workflow';
  /** 子 agent 类型（general/explore 等），仅 kind=subagent 时有值。 */
  agentType?: string;
  /** 来源 agent id（子 agent 任务通知路由用，进 XML 信封的 agent_id 属性）。 */
  agentId?: string;
  /** 进程 pid（仅 process 类任务；resume 对账时用于存活判定）。 */
  pid?: number;
  /** 完整输出落盘路径（<tasksDir>/<id>/output.log；配置了 tasksDir 才有）。内存 output 只是非权威尾部。 */
  outputPath?: string;
  /** 落盘输出总字节数（进 XML 信封的 bytes 属性）。 */
  outputBytes?: number;
}

interface Internal extends BackgroundTask {
  proc?: ChildProcess;
  /** 后台超时定时器（armed 时存在，终态时清除）。 */
  timer?: NodeJS.Timeout;
  /** onSettle 是否已触发（同一任务只通知一次）。 */
  settled?: boolean;
  /** 进程是否已退出（区分 SIGTERM 宽限期内是否需补 SIGKILL）。 */
  exited?: boolean;
  /** 抑制终态通知（task_stop 亲手杀的任务不再发通知，防噪音）。 */
  suppressNotify?: boolean;
  /** 前台任务标志：registerForeground 登记时显式为 false，detach 转后台后翻 true；未设置视为后台。 */
  detached?: boolean;
  /** 前台等待方的释放信号：仅前台任务存在，detach 或终态时 resolve。 */
  foregroundRelease?: { promise: Promise<ForegroundReleaseReason>; resolve: (r: ForegroundReleaseReason) => void };
  /** 前台命令的部分输出取值器：前台期间输出由调用方收集，detach/终态时才读当前值。 */
  getPartialOutput?: () => string;
  /** async 任务的终止钩子（无进程可杀时由 stop/超时调用，如中断子 agent 的 AbortController）。 */
  onStop?: () => void;
  /** 输出是否经 takeOver 流式落盘（区分进程类与 async 类：后者终态时一次性写入 output.log）。 */
  streamed?: boolean;
}

/** 后台任务管理器选项。 */
export interface BackgroundManagerOptions {
  /** 后台任务超时秒数：>0 时启动即武装，到期先 SIGTERM 后 SIGKILL；0/缺省 = 不限。 */
  taskTimeoutS?: number;
  /** 终态回调（完成/失败/被停），每个任务只触发一次。 */
  onSettle?: (t: BackgroundTask) => void;
  /**
   * 终态事件钩（事件日志 background.task_settle 落盘用）：在 settle 内、通知抑制判定之前触发，
   * 含被抑制通知的任务（task_stop 亲手杀的）——审计与重放要的是「到达终态」这个事实，与是否通知无关。
   */
  onSettleEvent?: (t: BackgroundTask) => void;
  /**
   * 任务持久化目录（<sessionDir>.tasks）：配置后每个任务落盘 <tasksDir>/<id>/meta.json +
   * output.log，内存态降级为非权威。缺省 = 纯内存（进程退出任务全丢，resume 无法对账）。
   */
  tasksDir?: string;
}

const MAX_OUTPUT_BYTES = 64 * 1024; // 内存只留 64KB 尾部
/** SIGTERM 后的宽限期（ms），未退出再 SIGKILL 强杀。 */
const KILL_GRACE_MS = 2000;
let counter = 0;

function nextId(): string {
  counter += 1;
  return `t${Date.now().toString(36)}-${counter}`;
}

/**
 * 后台任务管理器（最小面设计）：
 * 启动即返回 task_id 不阻塞；记录状态与输出尾部；终态后可供 task_list/task_output/task_stop 查询。
 * 终态一方面经 onSettle 回调上报（TUI 提示 / -p 收集），一方面入待投递队列，
 * 由 runAgent 在回合边界 drain 注入会话（或组合根兜底投递），模型无需轮询。
 */
export class BackgroundManager {
  private readonly tasks = new Map<string, Internal>();
  private readonly options: BackgroundManagerOptions;
  /** 已终态、待投递给会话的任务（runAgent 回合边界 drain 注入；抑制通知的任务不入队）。 */
  private readonly pendingSettled: BackgroundTask[] = [];

  constructor(private readonly maxRunning: number = 10, options: BackgroundManagerOptions = {}) {
    this.options = options;
  }

  // ---------- 任务持久化（meta.json + output.log；全部 best-effort，磁盘故障不影响任务生命周期） ----------

  private taskDir(task: Internal): string | undefined {
    const base = this.options.tasksDir;
    return base === undefined ? undefined : join(base, task.id);
  }

  /** 注册时初始化落盘：建任务目录、写 running 态 meta、登记 outputPath。 */
  private initPersistence(task: Internal): void {
    const dir = this.taskDir(task);
    if (dir === undefined) return;
    try {
      mkdirSync(dir, { recursive: true });
      task.outputPath = join(dir, 'output.log');
      task.outputBytes = Buffer.byteLength(task.output, 'utf8');
      if (task.output !== '') appendFileSync(task.outputPath, task.output, 'utf8');
      this.persistMeta(task);
    } catch {
      // 持久化失败不阻断任务启动
    }
  }

  /** 写 meta.json（覆盖写，内容小无需原子换名；终态写是最后一次）。suppressNotify 一并落盘：
   *  被抑制的终态任务（task_stop 亲手杀的）resume 对账时不参与补投。 */
  private persistMeta(task: Internal): void {
    const dir = this.taskDir(task);
    if (dir === undefined) return;
    try {
      mkdirSync(dir, { recursive: true });
      const meta = { ...this.toPublic(task), suppressNotify: task.suppressNotify === true || undefined };
      writeFileSync(join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf8');
    } catch {
      // best-effort
    }
  }

  /** 追加输出到 output.log 并累计字节数（内存 output 仍只留尾部，磁盘是权威全量）。 */
  private persistOutputChunk(task: Internal, chunk: string): void {
    if (task.outputPath === undefined) return;
    try {
      appendFileSync(task.outputPath, chunk, 'utf8');
      task.outputBytes = (task.outputBytes ?? 0) + Buffer.byteLength(chunk, 'utf8');
    } catch {
      // best-effort
    }
  }

  /** 读取磁盘上某任务 output.log 的尾部（resume 对账时回填内存非权威尾部）。 */
  private readOutputTail(outputPath: string): { output: string; outputBytes: number } {
    try {
      const buf = readFileSync(outputPath);
      const text = buf.toString('utf8');
      return {
        output: text.length > MAX_OUTPUT_BYTES ? text.slice(text.length - MAX_OUTPUT_BYTES) : text,
        outputBytes: buf.length,
      };
    } catch {
      return { output: '', outputBytes: 0 };
    }
  }

  activeCount(): number {
    let n = 0;
    for (const t of this.tasks.values()) if (t.status === 'running') n++;
    return n;
  }

  /**
   * 起一个后台 async 任务（如后台子 agent）。立即返回 task id，完成/失败自动置终态。
   * opts.onStop 为终止钩子：async 任务无进程可杀，stop/超时经它传达终止（如中断子 agent）。
   * 不传则 task_stop 只能标记状态、无法真正中止执行中的任务。
   */
  startTask(
    label: string,
    run: Promise<{ output: string; ok: boolean }>,
    onDone?: (t: BackgroundTask) => void,
    meta?: { kind: 'subagent' | 'workflow'; agentType?: string },
    opts?: { onStop?: () => void },
  ): string {
    return this.registerAsyncTask(label, run, false, onDone, meta, opts);
  }

  /**
   * 登记一个前台运行的 async 任务（如前台子 agent），供用户主动转后台。
   * 与 startTask 的差异：detached=false（出现在 listForeground，不计入后台徽章）、
   * 终态通知被抑制（正常跑完由工具结果自身报告）、启动时不武装后台超时（detach 时才武装）。
   * opts.onStop 为终止钩子：async 任务无进程可杀，stop/超时经它传达终止（如中断子 agent）。
   * 超并发上限抛错（调用方据此退化为不支持后台的行为）。
   */
  startForegroundTask(
    label: string,
    run: Promise<{ output: string; ok: boolean }>,
    meta: { kind: 'subagent' | 'workflow'; agentType?: string },
    opts?: { onStop?: () => void },
  ): string {
    return this.registerAsyncTask(label, run, true, undefined, meta, opts);
  }

  /** startTask 与 startForegroundTask 的共用登记逻辑：foreground 区分前台/后台形态。 */
  private registerAsyncTask(
    label: string,
    run: Promise<{ output: string; ok: boolean }>,
    foreground: boolean,
    onDone?: (t: BackgroundTask) => void,
    meta?: { kind: 'subagent' | 'workflow'; agentType?: string },
    opts?: { onStop?: () => void },
  ): string {
    if (this.activeCount() >= this.maxRunning) {
      throw new Error(`后台任务已达上限（${this.maxRunning}），请先等待或停止部分任务。`);
    }
    const id = nextId();
    let foregroundRelease: Internal['foregroundRelease'];
    if (foreground) {
      let resolveRelease!: (r: ForegroundReleaseReason) => void;
      const promise = new Promise<ForegroundReleaseReason>((res) => {
        resolveRelease = res;
      });
      foregroundRelease = { promise, resolve: resolveRelease };
    }
    const task: Internal = {
      id,
      command: label,
      status: 'running',
      startedAt: new Date().toISOString(),
      output: '',
      kind: meta?.kind,
      agentType: meta?.agentType,
      detached: foreground ? false : undefined,
      suppressNotify: foreground ? true : undefined,
      foregroundRelease,
      onStop: opts?.onStop,
    };
    this.tasks.set(id, task);
    this.initPersistence(task);
    if (!foreground) this.armTimeout(task);
    void run
      .then((r) => {
        // 已被超时/停止置终态时，迟到的 promise 结果不再覆盖
        if (task.status !== 'running') return;
        task.output = r.output;
        task.status = r.ok ? 'completed' : 'failed';
      })
      .catch((e) => {
        if (task.status !== 'running') return;
        task.output = `任务异常：${(e as Error).message}`;
        task.status = 'failed';
      })
      .finally(() => {
        if (task.endedAt === undefined) task.endedAt = new Date().toISOString();
        if (task.output.length > MAX_OUTPUT_BYTES) {
          task.output = task.output.slice(task.output.length - MAX_OUTPUT_BYTES);
        }
        this.settle(task);
        onDone?.(task);
      });
    return id;
  }

  /** 起一个后台进程。超并发上限抛错。返回 task id。 */
  start(command: string, shellCmd: string, shellArgs: string[], cwd: string): string {
    if (shellCmd === '') {
      throw new Error('无可用 shell 解释器，无法启动后台命令（Windows 上请安装 Git Bash 或设置 STEP_SHELL_PATH）。');
    }
    if (this.activeCount() >= this.maxRunning) {
      throw new Error(`后台任务已达上限（${this.maxRunning}），请先等待或停止部分任务。`);
    }
    const proc = spawn(shellCmd, shellArgs, { cwd });
    return this.adopt(command, proc, '');
  }

  /**
   * 收养一个已在运行的进程为后台任务（前台超时转后台用）。
   * initialOutput 为收养前已收集的部分输出；收养后输出继续追加、后台超时重新武装。
   */
  adopt(command: string, proc: ChildProcess, initialOutput: string): string {
    if (this.activeCount() >= this.maxRunning) {
      throw new Error(`后台任务已达上限（${this.maxRunning}），请先等待或停止部分任务。`);
    }
    const id = nextId();
    const task: Internal = {
      id,
      command,
      status: 'running',
      startedAt: new Date().toISOString(),
      kind: 'process',
      pid: proc.pid,
      output:
        initialOutput.length > MAX_OUTPUT_BYTES
          ? initialOutput.slice(initialOutput.length - MAX_OUTPUT_BYTES)
          : initialOutput,
      proc,
    };
    this.tasks.set(id, task);
    this.initPersistence(task);
    this.takeOver(task, proc);
    this.armTimeout(task);
    return id;
  }

  /**
   * 登记一个前台运行的进程（启动即登记，供用户主动转后台）。
   * 不接管输出监听、不武装后台超时：前台期间输出收集与计时归调用方，
   * detach 时才以 getPartialOutput() 当前值为起点接管。终态通知被抑制——
   * 正常跑完的前台命令由工具结果自身报告，不再走后台通知。
   * 超并发上限抛错（调用方据此退化为不支持后台的行为）。
   */
  registerForeground(command: string, proc: ChildProcess, getPartialOutput: () => string): string {
    if (this.activeCount() >= this.maxRunning) {
      throw new Error(`后台任务已达上限（${this.maxRunning}），请先等待或停止部分任务。`);
    }
    const id = nextId();
    let resolveRelease!: (r: ForegroundReleaseReason) => void;
    const promise = new Promise<ForegroundReleaseReason>((res) => {
      resolveRelease = res;
    });
    const task: Internal = {
      id,
      command,
      status: 'running',
      startedAt: new Date().toISOString(),
      kind: 'process',
      pid: proc.pid,
      output: '',
      proc,
      detached: false,
      suppressNotify: true,
      foregroundRelease: { promise, resolve: resolveRelease },
      getPartialOutput,
    };
    this.tasks.set(id, task);
    this.initPersistence(task);
    return id;
  }

  /**
   * 把前台任务转为后台：翻 detached 标志、解除通知抑制、以当前部分输出为起点接管
   * 进程监听（进程类任务）、武装后台超时、释放前台等待方。viaTimeout 标记来源
   * （用户主动 / 前台超时），供等待方措辞。任务不存在、已终态或不是前台任务时
   * 返回 false（no-op）。async 任务（子 agent 等）无进程可接管，跳过监听接管。
   */
  detach(id: string, viaTimeout: boolean = false): boolean {
    const task = this.tasks.get(id);
    if (task === undefined || task.status !== 'running') return false;
    const release = task.foregroundRelease;
    if (release === undefined) return false;
    task.detached = true;
    task.suppressNotify = false;
    const partial = task.getPartialOutput?.() ?? '';
    task.output =
      partial.length > MAX_OUTPUT_BYTES ? partial.slice(partial.length - MAX_OUTPUT_BYTES) : partial;
    // 前台期间未流式落盘的部分输出，detach 接管时一次性补写 output.log
    if (task.streamed !== true && task.output !== '') this.persistOutputChunk(task, task.output);
    task.foregroundRelease = undefined;
    if (task.proc !== undefined) this.takeOver(task, task.proc);
    this.armTimeout(task);
    release.resolve(viaTimeout ? 'timeout_detached' : 'detached');
    return true;
  }

  /**
   * 等待前台任务被转后台或到达终态。无释放信号（已转后台 / 已终态 / 任务不存在）
   * 时立即返回 'terminal'。
   */
  waitForegroundRelease(id: string): Promise<ForegroundReleaseReason> {
    const task = this.tasks.get(id);
    return task?.foregroundRelease?.promise ?? Promise.resolve('terminal');
  }

  /**
   * 前台命令结束（进程 close/error）时由调用方上报：静默置终态（前台任务抑制
   * 终态通知）并释放前台等待方。已转后台的任务由 takeOver 的监听负责终态，跳过。
   */
  settleForeground(id: string, exitCode: number | null, error?: string): void {
    const task = this.tasks.get(id);
    if (task === undefined || task.status !== 'running' || task.detached !== false) return;
    task.exited = true;
    const partial = task.getPartialOutput?.() ?? '';
    task.output =
      partial.length > MAX_OUTPUT_BYTES ? partial.slice(partial.length - MAX_OUTPUT_BYTES) : partial;
    if (error !== undefined) {
      task.status = 'failed';
      task.output += `\n[进程错误：${error}]`;
    } else {
      task.status = exitCode === 0 ? 'completed' : 'failed';
      task.exitCode = exitCode ?? undefined;
    }
    task.endedAt = new Date().toISOString();
    this.settle(task);
  }

  /** 当前可转后台的前台任务（running 且未 detach），按启动时间倒序。 */
  listForeground(): BackgroundTask[] {
    return [...this.tasks.values()]
      .filter((t) => t.detached === false && t.status === 'running')
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map((t) => this.toPublic(t));
  }

  /** 任务是否已脱离前台（已转后台 / 不存在 / 已终态均视为脱离，调用方据此不误杀进程）。 */
  isDetached(id: string): boolean {
    const t = this.tasks.get(id);
    return t === undefined || t.detached !== false || t.status !== 'running';
  }

  /** 后台运行中任务数（不含未 detach 的前台任务，供状态栏徽章使用）。 */
  activeBackgroundCount(): number {
    let n = 0;
    for (const t of this.tasks.values()) if (t.status === 'running' && t.detached !== false) n++;
    return n;
  }

  /** 接管进程输出收集与终态监听（adopt 注册时 / detach 前台任务时调用）。 */
  private takeOver(task: Internal, proc: ChildProcess): void {
    const append = (chunk: Buffer): void => {
      const text = chunk.toString('utf8');
      task.streamed = true;
      task.output += text;
      if (task.output.length > MAX_OUTPUT_BYTES) {
        task.output = task.output.slice(task.output.length - MAX_OUTPUT_BYTES);
      }
      // 磁盘 output.log 是权威全量，内存只是尾部
      this.persistOutputChunk(task, text);
    };
    proc.stdout?.on('data', append);
    proc.stderr?.on('data', append);
    proc.on('error', (err) => {
      if (task.status === 'running') {
        task.status = 'failed';
        task.endedAt = new Date().toISOString();
        task.output += `\n[进程错误：${err.message}]`;
      }
      this.settle(task);
    });
    proc.on('close', (code) => {
      task.exited = true;
      if (task.status === 'running') {
        task.status = code === 0 ? 'completed' : 'failed';
        task.exitCode = code ?? undefined;
        task.endedAt = new Date().toISOString();
      }
      this.settle(task);
    });
  }

  /** 武装后台超时：到期终止（先 SIGTERM，宽限期后未退出补 SIGKILL）。taskTimeoutS<=0 时不武装。 */
  private armTimeout(task: Internal): void {
    const s = this.options.taskTimeoutS ?? 0;
    if (s <= 0) return;
    task.timer = setTimeout(() => {
      this.terminate(task, `后台任务超时（${s}s），已终止`);
    }, s * 1000);
    // 不阻止进程退出（非交互模式下遗留定时器不应挂住进程）
    task.timer.unref?.();
  }

  /** 终止运行中任务（超时路径）：附注原因，先温和后强杀，置终态并触发 onSettle。 */
  private terminate(task: Internal, note: string): void {
    if (task.status !== 'running') return;
    task.output += `${task.output === '' ? '' : '\n'}[${note}]`;
    task.proc?.kill('SIGTERM');
    task.onStop?.();
    const force = setTimeout(() => {
      if (task.exited !== true) task.proc?.kill('SIGKILL');
    }, KILL_GRACE_MS);
    force.unref?.();
    task.status = 'killed';
    task.endedAt = new Date().toISOString();
    this.settle(task);
  }

  /** 终态回调：每个任务只触发一次，顺带清理超时定时器。被抑制（task_stop）的任务跳过通知与入队。 */
  private settle(task: Internal): void {
    if (task.settled === true || task.status === 'running') return;
    task.settled = true;
    // 终态也是一种释放：前台等待方（若有）不能再悬挂
    task.foregroundRelease?.resolve('terminal');
    task.foregroundRelease = undefined;
    if (task.timer !== undefined) {
      clearTimeout(task.timer);
      task.timer = undefined;
    }
    // 终态落盘：async 任务的输出此前未经流式通道，此刻一次性写入 output.log；meta 写最终态。
    // 被抑制（task_stop）的任务同样落盘（meta 带 suppressNotify，对账时不补投）。
    if (task.streamed !== true && task.output !== '') this.persistOutputChunk(task, task.output);
    this.persistMeta(task);
    // 终态事件先走审计通道（含被抑制任务），再走通知通道
    this.options.onSettleEvent?.(this.toPublic(task));
    if (task.suppressNotify === true) return;
    this.pendingSettled.push(task);
    this.options.onSettle?.(task);
  }

  /** 标记任务抑制终态通知（task_stop 调用时设置；对未终态任务生效，已终态任务无操作必要）。 */
  suppressNotification(id: string): void {
    const t = this.tasks.get(id);
    if (t !== undefined) t.suppressNotify = true;
  }

  /** 取走全部待投递的终态任务（清空队列），供 runAgent 回合边界注入或组合根兜底投递。 */
  drainSettled(): BackgroundTask[] {
    return this.pendingSettled.splice(0);
  }

  /**
   * resume 对账：磁盘任务状态与进程实况对齐（恢复流程的第 4 步，由调用方在重放完成后触发）。
   * - 磁盘 running 但无存活进程（进程类 pid 已死；async 类重启即死）→ meta 标记 lost 并列入待通知；
   * - 磁盘终态（含此前已标记的 lost）但通知未送达（按幂等键比对 delivered 集合，集合由
   *   事件日志重放回填）→ 列入补投；
   * - meta 带 suppressNotify 的（task_stop 亲手杀的）不参与补投；
   * - 已在内存中的任务（本进程仍活着的）跳过；
   * - 进程类 pid 仍存活（罕见的父死子存）保持 running 不动：无法重新接管输出监听，
   *   但贸然标 lost 会谎报一个其实还活着的任务。
   * lost 任务不进内存列表（LostTask 与 BackgroundTask 不同型，见类型注释）；终态任务登记进
   * 内存列表（task_list/task_output 可见）。通知装配与投递由调用方负责
   * （buildSettleMessage + 事件日志写 background.notify_delivered）。
   */
  reconcile(delivered: ReadonlySet<string>): { lost: LostTask[]; redeliver: (BackgroundTask | LostTask)[] } {
    const result: { lost: LostTask[]; redeliver: (BackgroundTask | LostTask)[] } = { lost: [], redeliver: [] };
    const base = this.options.tasksDir;
    if (base === undefined || !existsSync(base)) return result;
    let entries: string[];
    try {
      entries = readdirSync(base);
    } catch {
      return result;
    }
    for (const id of entries) {
      if (this.tasks.has(id)) continue;
      let meta: (Omit<BackgroundTask, 'status'> & { status: TaskStatus | 'lost'; suppressNotify?: boolean }) | undefined;
      try {
        meta = JSON.parse(readFileSync(join(base, id, 'meta.json'), 'utf8')) as typeof meta;
      } catch {
        continue; // 无 meta 或损坏：跳过
      }
      if (meta === undefined || typeof meta.status !== 'string') continue;
      const outputPath = meta.outputPath ?? join(base, id, 'output.log');
      const tail = existsSync(outputPath)
        ? this.readOutputTail(outputPath)
        : { output: meta.output ?? '', outputBytes: meta.outputBytes ?? 0 };
      const base_fields = {
        ...meta,
        id,
        output: tail.output,
        outputPath,
        outputBytes: tail.outputBytes,
      };
      if (meta.status === 'running') {
        if (this.isAlive({ ...base_fields, status: 'running' })) continue;
        // 标记 lost：只写 meta.json 与返回值，不进内存任务列表
        const lost: LostTask = { ...base_fields, status: 'lost', endedAt: new Date().toISOString() };
        try {
          writeFileSync(
            join(base, id, 'meta.json'),
            JSON.stringify({ ...lost, suppressNotify: meta.suppressNotify === true || undefined }, null, 2),
            'utf8',
          );
        } catch {
          // best-effort
        }
        result.lost.push(lost);
        if (meta.suppressNotify !== true) result.redeliver.push(lost);
        continue;
      }
      if (meta.status === 'lost') {
        const lost: LostTask = { ...base_fields, status: 'lost' };
        if (meta.suppressNotify !== true && !delivered.has(notifyDedupKey(id, 'lost', `task:${id}:lost`))) {
          result.redeliver.push(lost);
        }
        continue;
      }
      // 终态任务登记进内存列表（task_list/task_output 可见），settled 标记防重复触发 settle 通道
      const task: Internal = {
        ...base_fields,
        status: meta.status,
        settled: true,
        suppressNotify: meta.suppressNotify,
      };
      this.tasks.set(id, task);
      if (task.suppressNotify === true) continue;
      if (!delivered.has(notifyDedupKey(task.id, task.status, notificationIdFor(task)))) {
        result.redeliver.push(this.toPublic(task));
      }
    }
    return result;
  }

  /** 进程类任务存活判定：无 pid（async 类）重启即死；有 pid 用 kill(pid, 0) 探测。 */
  private isAlive(task: Internal): boolean {
    if (task.kind !== 'process' || task.pid === undefined) return false;
    try {
      process.kill(task.pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  get(id: string): BackgroundTask | undefined {
    return this.tasks.get(id);
  }

  list(): BackgroundTask[] {
    return [...this.tasks.values()].map((t) => this.toPublic(t));
  }

  /** 剥掉内部字段（进程句柄 / 定时器 / 释放信号等），输出公开任务视图。 */
  private toPublic(t: Internal): BackgroundTask {
    const {
      proc: _p,
      timer: _t,
      settled: _s,
      exited: _e,
      suppressNotify: _n,
      detached: _d,
      foregroundRelease: _f,
      getPartialOutput: _g,
      onStop: _o,
      ...rest
    } = t;
    return rest;
  }

  /** 终止任务。返回是否成功终止。 */
  stop(id: string): boolean {
    const t = this.tasks.get(id);
    if (t === undefined || t.status !== 'running') return false;
    t.proc?.kill('SIGTERM');
    t.onStop?.();
    t.status = 'killed';
    t.endedAt = new Date().toISOString();
    this.settle(t);
    return true;
  }
}
