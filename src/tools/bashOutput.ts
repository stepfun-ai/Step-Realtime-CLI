import { closeSync, mkdirSync, openSync, readdirSync, statSync, unlinkSync, writeSync } from 'node:fs';
import { join } from 'node:path';

/**
 * 前台命令的输出收集器：**两条流分别记账**，触顶后**溢出落盘**。
 *
 * ## 为什么不能让 stdout 和 stderr 共用一个预算
 *
 * 原实现把两条流 append 进同一个字符串、共用一个上限，且判断在追加前
 * （`if (out.length < MAX_COLLECT) out += chunk`）。后果不是「少看一点尾巴」，
 * 而是**命令失败时的错误信息 100% 丢失**：
 *
 *   一条命令先刷满 10MB stdout，最后在 stderr 打印报错并非零退出
 *   → 此后每个 chunk 都进丢弃计数 → 模型拿到 10MB 无用日志，看不到那几行错误。
 *
 * 这个形状一点都不极端：编译失败、测试失败、大批量脚本报错都是「大量 stdout +
 * 尾部少量 stderr」。而 stderr 的尾部恰恰是排障唯一有价值的部分。
 *
 * 所以两条流各有**独立预算**：stdout 吃满也不会占用 stderr 的额度。代价是 stdout
 * 的上限从 10MB 降到 9MB——用 1MB 的日志容量换「错误信息永远拿得到」，值得。
 *
 * ## 合并语义必须保持
 *
 * 对外仍然是**一份按到达顺序合并**的文本（工具描述承诺「返回合并后的 stdout+stderr」，
 * 且后台任务接管时以 `snapshot().text` 为起点）。分别记账只影响「谁的额度先用完」，
 * 不改变拼接顺序，也不把两条流拆成两段返回。
 *
 * ## 溢出落盘
 *
 * 任一条流首次触顶时，把**已收集内容**冲进文件，并从此把**所有**后续 chunk
 * 也写进该文件（无论它是否还在内存预算内）。于是：
 *
 * - 内存：仍然封顶（预算不变），不会因为落盘而膨胀；
 * - 文件：是**完整**输出，不是「触顶之后的那一段」——否则模型要自己拼两半。
 *
 * 落盘是**尽力而为**：目录不可写、磁盘满、路径异常时静默降级为「纯丢弃 + 如实报告」，
 * 绝不让磁盘问题把一条本来能成功的命令变成失败。降级后不再重试（避免每个 chunk
 * 都撞一次同样的 IO 错误）。
 *
 * ## 内存里存字节，不存字符串
 *
 * 收到的每个 chunk 都**原样保留为 Buffer**，只在 `snapshot()` 时统一解码一次。
 * 这不是为了省内存，是为了正确性：`chunk.toString('utf8')` 逐块解码会在 chunk 边界
 * 把多字节字符切成两半，接缝处产生替换字符（U+FFFD）。中文输出撞上这个的概率不低，
 * 而且损坏一旦发生就不可逆——落盘也只会把坏字节写进文件。
 *
 * 统一解码顺带让落盘真正无损：写文件用原始 Buffer，文件内容与命令的实际输出逐字节一致。
 *
 * 代价是 `snapshot()` 要拼接 + 解码，所以结果按 dirty 标记缓存：后台任务管理器会反复
 * 调用它取部分输出，没有新数据时不重算。`close()` 之后数据不再变化，届时释放 Buffer
 * 列表、只留解码结果，避免字节与字符串两份长期共存。
 *
 * 预算因此以**字节**计（原实现用 `out.length` 即 UTF-16 字符数，与「对齐 maxBuffer」
 * 的本意有偏差，中文场景下实际允许的字节数是标称值的数倍）。
 */

/** stdout 与 stderr 的内存预算合计（字节）。 */
const TOTAL_BUDGET = 10 * 1024 * 1024;
/**
 * 每条流的**保底额**：另一条流再怎么刷也吃不掉这部分。
 *
 * 两个方向都要保底，不是只保 stderr：
 * - 保 stderr，防「大量 stdout + 尾部几行报错」——错误信息被日志洪水冲掉（已实测过的 bug）。
 * - 保 stdout，防反向情形「stderr 洪水」——不少构建工具（cargo / tsc / python logging 默认）
 *   把全部输出写 stderr，不保底则正常产物一个字节都留不下。
 */
const PER_STREAM_RESERVE = 1 * 1024 * 1024;
/**
 * 保底之外的**共享池**，两条流先到先得。
 *
 * 为什么需要它：原实现是硬切分（stdout 9MB / stderr 1MB），于是「全部输出走 stderr」的命令
 * 只能留 1MB，而 9MB 的 stdout 额度整场空转——这与「stderr 被 stdout 冲掉」是同一类缺陷的
 * 反向，当时没意识到。加共享池后同一场景可留 1MB 保底 + 8MB 共享 = 9MB。
 *
 * 与外部成熟实现的差别在**时机**不在思想：有的实现在两条流都收完后再分配（stdout 先保底 1/3，
 * stderr 按实际长度取，stderr 没用完的额度回补 stdout），因此能精确回补；我们是流式收集，append
 * 时无法预知后面还有多少字节，做不到后验回补，只能「保底 + 先到先得」。代价是先刷的那条流会
 * 占掉更多共享池——可接受，因为保底额已保证另一条流不会归零。
 */
const SHARED_BUDGET = TOTAL_BUDGET - PER_STREAM_RESERVE * 2;

/** 溢出文件保留个数上限：写新文件前把最旧的删到这个数以内，防止无限堆积。 */
const MAX_OVERFLOW_FILES = 20;
/** 溢出文件所在目录（相对 cwd），与 journal/ workflows/ 同址，已在 gitignore。 */
const OVERFLOW_SUBDIR = join('.step-code', 'tool-output');

export interface OutputCollectorOptions {
  /** 该流保底额（字节）：即使另一条流占满共享池，这部分也 guaranteed。 */
  stdoutReserve?: number;
  /** 该流保底额（字节）：即使另一条流占满共享池，这部分也 guaranteed。 */
  stderrReserve?: number;
  /** 两条流共享的池子（字节）：先到先得，用完后各自退守保底额。 */
  sharedBudget?: number;
  /** 溢出落盘的基准目录（通常是 cwd）。传 null 关闭落盘（测试与不可写环境）。 */
  cwd?: string | null;
  /** 覆盖时间戳来源，仅测试用（保证文件名可预期）。 */
  now?: () => Date;
  /** 向后兼容：若传了 flat budget，退化为无共享池的硬切分。 */
  stdoutBudget?: number;
  stderrBudget?: number;
}

export interface OutputSnapshot {
  /** 按到达顺序合并的文本（受各自预算限制）。 */
  text: string;
  /** stdout 因超预算被丢出内存的字节数。 */
  droppedStdout: number;
  /** stderr 因超预算被丢出内存的字节数。 */
  droppedStderr: number;
  /** 溢出文件路径；未触顶或落盘失败时为 null。 */
  overflowPath: string | null;
  /** 已写入溢出文件的字节数。 */
  overflowBytes: number;
}

export interface OutputCollector {
  append(chunk: Buffer, stream: 'stdout' | 'stderr'): void;
  snapshot(): OutputSnapshot;
  /** 关闭溢出文件句柄。可重复调用。 */
  close(): void;
}

/** 目录内 `bash-*.log` 超过上限时，按 mtime 从旧到新删到上限以内。失败静默忽略。 */
function pruneOverflowDir(dir: string): void {
  try {
    const files = readdirSync(dir)
      .filter((n) => n.startsWith('bash-') && n.endsWith('.log'))
      .map((n) => {
        const p = join(dir, n);
        try {
          return { p, t: statSync(p).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter((x): x is { p: string; t: number } => x !== null)
      .sort((a, b) => a.t - b.t);
    for (const f of files.slice(0, Math.max(0, files.length - (MAX_OVERFLOW_FILES - 1)))) {
      try {
        unlinkSync(f.p);
      } catch {
        // 被占用或已删除：跳过，清理不是关键路径
      }
    }
  } catch {
    // 目录还不存在等情况：交给后续 mkdirSync
  }
}

function timestampName(now: Date, seq: number): string {
  const p = (n: number, w = 2): string => String(n).padStart(w, '0');
  const stamp =
    `${String(now.getFullYear())}${p(now.getMonth() + 1)}${p(now.getDate())}` +
    `-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
  return `bash-${stamp}-${String(process.pid)}-${String(seq)}.log`;
}

let seqCounter = 0;

/**
 * 建收集器。`cwd` 为 null 时完全不碰磁盘（此时触顶等价于旧的纯丢弃行为，
 * 但仍如实计数）。
 */
export function createOutputCollector(opts: OutputCollectorOptions = {}): OutputCollector {
  const cwd = opts.cwd === undefined ? process.cwd() : opts.cwd;
  const nowFn = opts.now ?? ((): Date => new Date());

  const stdoutReserve = opts.stdoutReserve ?? PER_STREAM_RESERVE;
  const stderrReserve = opts.stderrReserve ?? PER_STREAM_RESERVE;
  const sharedPool = opts.sharedBudget ?? SHARED_BUDGET;

  const flatMode = opts.stdoutBudget !== undefined || opts.stderrBudget !== undefined;
  const flatStdBudget = opts.stdoutBudget ?? (SHARED_BUDGET + PER_STREAM_RESERVE);
  const flatErrBudget = opts.stderrBudget ?? PER_STREAM_RESERVE;

  /** 内存保留的原始块（仅预算内的）。close() 后释放，解码结果留在 cachedText。 */
  let chunks: Buffer[] = [];
  /** snapshot() 的解码缓存；null = 有新数据待重算。 */
  let cachedText: string | null = null;
  let stdoutBytes = 0;
  let stderrBytes = 0;
  /** 共享池消耗：每条流各占多少 */
  let stdoutSharedBytes = 0;
  let stderrSharedBytes = 0;
  /** 统一解码：一次性拼接全部字节再解码，chunk 边界不会切碎多字节字符。 */
  const decode = (): string => (cachedText ??= Buffer.concat(chunks).toString('utf8'));
  let droppedStdout = 0;
  let droppedStderr = 0;

  let fd: number | null = null;
  let overflowPath: string | null = null;
  let overflowBytes = 0;
  /** 落盘已被判定不可用（失败过一次）：不再重试。 */
  let overflowDisabled = cwd === null;

  /** 首次触顶时开文件并把已收集内容冲进去。失败则永久降级。 */
  const ensureOverflowFile = (): void => {
    if (fd !== null || overflowDisabled || cwd === null) return;
    try {
      const dir = join(cwd, OVERFLOW_SUBDIR);
      pruneOverflowDir(dir);
      mkdirSync(dir, { recursive: true });
      seqCounter += 1;
      const p = join(dir, timestampName(nowFn(), seqCounter));
      const handle = openSync(p, 'a');
      // 先把内存里已有的部分写入，文件才是「完整输出」而不是「触顶后的尾巴」。
      // 用原始字节而非解码后的文本：解码是有损的（边界替换字符），落盘不该继承这个损失。
      const head = Buffer.concat(chunks);
      if (head.length > 0) {
        writeSync(handle, head);
        overflowBytes += head.length;
      }
      fd = handle;
      overflowPath = p;
    } catch {
      overflowDisabled = true;
      fd = null;
      overflowPath = null;
    }
  };

  const writeOverflow = (chunk: Buffer): void => {
    if (fd === null) return;
    try {
      writeSync(fd, chunk);
      overflowBytes += chunk.length;
    } catch {
      // 写失败（磁盘满等）：关掉并永久降级，已写入的部分仍然可用
      try {
        closeSync(fd);
      } catch {
        // 句柄已失效，忽略
      }
      fd = null;
      overflowDisabled = true;
    }
  };

  return {
    append(chunk, stream) {
      const isErr = stream === 'stderr';
      const used = isErr ? stderrBytes : stdoutBytes;
      const reserve = isErr ? stderrReserve : stdoutReserve;
      let keepSize: number;

      if (flatMode) {
        const budget = isErr ? flatErrBudget : flatStdBudget;
        keepSize = used < budget ? chunk.length : 0;
      } else {
        const spaceInReserve = Math.max(0, reserve - used);
        const sharedRemaining = sharedPool - stdoutSharedBytes - stderrSharedBytes;
        const totalSpace = spaceInReserve + sharedRemaining;
        keepSize = Math.min(chunk.length, totalSpace);
      }

      const dropSize = chunk.length - keepSize;

      // 任一流首次触顶即开始落盘
      if (dropSize > 0) ensureOverflowFile();
      if (fd !== null) writeOverflow(chunk);

      if (dropSize > 0) {
        if (isErr) droppedStderr += dropSize;
        else droppedStdout += dropSize;
        if (keepSize > 0) {
          // 部分保留：先吃保底额剩余，再吃共享池
          const useReserve = Math.min(keepSize, Math.max(0, reserve - used));
          const useShared = keepSize - useReserve;
          chunks.push(chunk.slice(0, keepSize));
          cachedText = null;
          if (isErr) { stderrBytes += keepSize; stderrSharedBytes += useShared; }
          else { stdoutBytes += keepSize; stdoutSharedBytes += useShared; }
        }
        return;
      }

      chunks.push(chunk);
      cachedText = null;
      if (isErr) {
        stderrBytes += chunk.length;
        if (stderrBytes > reserve) stderrSharedBytes += chunk.length - Math.max(0, reserve - (stderrBytes - chunk.length));
      } else {
        stdoutBytes += chunk.length;
        if (stdoutBytes > reserve) stdoutSharedBytes += chunk.length - Math.max(0, reserve - (stdoutBytes - chunk.length));
      }
    },
    snapshot() {
      return { text: decode(), droppedStdout, droppedStderr, overflowPath, overflowBytes };
    },
    close() {
      // 先固化解码结果再释放字节：close() 之后 snapshot() 仍要能拿到完整文本
      decode();
      chunks = [];
      if (fd === null) return;
      try {
        closeSync(fd);
      } catch {
        // 已关闭或句柄失效，忽略
      }
      fd = null;
    },
  };
}

/**
 * 把丢弃与落盘情况渲染成给模型看的提示行（不含展示截断那一段，由调用方拼）。
 *
 * 两条原则：
 * 1. **报真实总量**，不报残值。内存里保留的长度触顶后就不再增长，拿它当「共 N 字符」
 *    会把 50MB 说成 10MB——那比不给数字更坏，因为它看起来精确。
 * 2. **给可执行的下一步**，且优先给不会撑爆自己上下文的那一步：有子 agent 可用时
 *    建议委派去筛（大输出留在子上下文里），没有才建议自己分页读。
 */
export function renderOutputNotes(snap: OutputSnapshot, opts: { canDelegate: boolean }): string[] {
  const notes: string[] = [];
  const droppedTotal = snap.droppedStdout + snap.droppedStderr;
  if (droppedTotal === 0) return notes;

  const kb = (n: number): string => `${String(Math.round(n / 1024))} KB`;
  const parts: string[] = [];
  if (snap.droppedStdout > 0) parts.push(`stdout ${kb(snap.droppedStdout)}`);
  if (snap.droppedStderr > 0) parts.push(`stderr ${kb(snap.droppedStderr)}`);

  if (snap.overflowPath !== null) {
    // 有落盘：内存里少的那部分文件里有，给出取用路径
    const next = opts.canDelegate
      ? `完整输出已存到 ${snap.overflowPath}（约 ${kb(snap.overflowBytes)}）。` +
        `需要它的内容时优先派子 agent 去读并只回结论，避免把整份日志拉进当前上下文；` +
        `自己看就用 read_file 配 offset/limit 分页，或用 grep 在该文件里搜关键行。`
      : `完整输出已存到 ${snap.overflowPath}（约 ${kb(snap.overflowBytes)}），` +
        `用 read_file 配 offset/limit 分页读，或用 grep 在该文件里搜关键行。`;
    notes.push(`超出内存收集上限的 ${parts.join(' + ')} 未包含在上面的正文里；${next}`);
  } else {
    notes.push(
      `另有 ${parts.join(' + ')} 输出因超过内存收集上限被丢弃且未能落盘，不可恢复——` +
        `需要完整输出请把命令的输出重定向到文件，再用 read_file 分页读`,
    );
  }
  return notes;
}
