/**
 * 堆水位看护：接近上限前预警，并在更高水位自动 dump 一份 heap snapshot。
 *
 * 存在的理由很具体。2026-08-16 有一次进程跑 109 分钟后 4GB OOM
 * （`FATAL ERROR: Ineffective mark-compacts near heap limit`），事后能定位到根因，
 * 靠的是在本地复现出来之后 dump 的 snapshot——事故现场本身什么都没留下，只有 V8 打在
 * stderr 上的几行 GC 统计。那次的根因（pi-tui widthCache 钉住历史全文）已修，但当时的
 * 4GB 未必全由它造成，量级上还有缺口。
 *
 * 所以这里做两件事：
 * 1. 到警戒水位时告诉用户「进程正在变重」，让他有机会 /new 开新会话而不是等崩；
 * 2. 到危险水位时留下一份 snapshot。崩溃后的堆没法事后检查，只能在崩之前抓。
 *
 * 阈值按堆上限的比例算，不写死字节数：Node 的堆上限随版本与 --max-old-space-size 变化，
 * 写死 1.5GB 在 8GB 上限的机器上会过早喊，在 2GB 上限的机器上又来不及。
 */
import { writeHeapSnapshot } from 'node:v8';
import { getHeapStatistics } from 'node:v8';

/** 检查间隔。堆水位是慢变量，30 秒足够；放太密会在 idle 时白烧 CPU。 */
const CHECK_INTERVAL_MS = 30_000;
/** 警戒水位：占堆上限的比例，到此提示用户。 */
const WARN_RATIO = 0.6;
/** 危险水位：到此 dump snapshot（只 dump 一次）。 */
const DUMP_RATIO = 0.8;

/**
 * 从环境变量读一个 0..1 的比例，非法值忽略。
 *
 * 开这三个口子有两个用处：真机验证时能把阈值压到必然触发；用户怀疑内存问题时能主动收紧
 * 监控（`STEP_CODE_HEAP_WARN_RATIO=0.3 STEP_CODE_HEAP_CHECK_MS=5000`），不必等默认的
 * 60% 水位才拿到线索。
 */
function envRatio(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const v = Number(raw);
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : undefined;
}

function envInt(name: string): number | undefined {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return undefined;
  const v = Number.parseInt(raw, 10);
  return Number.isFinite(v) && v > 0 ? v : undefined;
}

export interface HeapWatchOptions {
  /** 提示出口（落到转录区）。 */
  notify: (text: string) => void;
  /** snapshot 落盘目录。 */
  dumpDir: string;
  /** 覆盖检查间隔（测试用）。 */
  intervalMs?: number;
  /** 覆盖水位比例（测试用）。 */
  warnRatio?: number;
  dumpRatio?: number;
  /** 注入的取样与落盘实现（测试用；缺省走真实 v8）。 */
  readHeap?: () => { used: number; limit: number };
  writeSnapshot?: (path: string) => string;
}

export interface HeapWatchState {
  /** 已经喊过警戒了（同一进程只喊一次，反复提示是噪声）。 */
  warned: boolean;
  /** 已经 dump 过了（snapshot 动辄几十上百 MB，只留一份）。 */
  dumped: boolean;
}

/**
 * 单次检查。抽成纯函数是为了能在测试里直接喂水位，不必真把堆撑到 GB 级。
 *
 * @returns 本次是否做了动作（供测试与调用方判断）
 */
export function checkHeapOnce(
  state: HeapWatchState,
  opts: HeapWatchOptions,
): { warned: boolean; dumpedTo?: string } {
  const read = opts.readHeap ?? (() => {
    const s = getHeapStatistics();
    return { used: s.used_heap_size, limit: s.heap_size_limit };
  });
  const { used, limit } = read();
  if (limit <= 0) return { warned: false };
  const ratio = used / limit;
  const warnAt = opts.warnRatio ?? envRatio('STEP_CODE_HEAP_WARN_RATIO') ?? WARN_RATIO;
  const dumpAt = opts.dumpRatio ?? envRatio('STEP_CODE_HEAP_DUMP_RATIO') ?? DUMP_RATIO;
  const mb = (b: number): string => (b / 1024 / 1024).toFixed(0);
  const out: { warned: boolean; dumpedTo?: string } = { warned: false };

  if (ratio >= dumpAt && !state.dumped) {
    state.dumped = true;
    // 同时把警戒标记也置上：dump 的提示里已经带了水位数字，再补一条警戒是重复。
    // 实测过顺序问题——启动时水位就过危险线的话，首次检查只 dump 并 return，下一次检查
    // 才发警戒，用户先看到「正在导出快照」再看到「内存 1%」，读起来是倒的。
    state.warned = true;
    // 先提示再写：snapshot 可能要几秒且会短暂卡住进程，用户得知道那是什么
    opts.notify(
      `堆内存已用 ${mb(used)}MB / 上限 ${mb(limit)}MB，正在导出快照以便排查（可能卡顿几秒）。` +
        `建议随后用 /new 开新会话释放内存。`,
    );
    try {
      const write = opts.writeSnapshot ?? ((p: string) => writeHeapSnapshot(p));
      const path = write(`${opts.dumpDir}/heap-${Date.now()}.heapsnapshot`);
      out.dumpedTo = path;
      opts.notify(`堆快照已写入 ${path}（请私下发给我们排查，里面含会话正文）`);
    } catch (e) {
      opts.notify(`堆快照导出失败：${(e as Error).message}`);
    }
    return out;
  }

  if (ratio >= warnAt && !state.warned) {
    state.warned = true;
    out.warned = true;
    opts.notify(
      `堆内存已用 ${mb(used)}MB / 上限 ${mb(limit)}MB（${(ratio * 100).toFixed(0)}%）。` +
        `长会话会持续变重，建议用 /new 开新会话；继续用下去有 OOM 崩溃的风险。`,
    );
  }
  return out;
}

/** 起一个后台看护定时器。返回停止函数。 */
export function startHeapWatch(opts: HeapWatchOptions): () => void {
  const state: HeapWatchState = { warned: false, dumped: false };
  const timer = setInterval(() => {
    try {
      checkHeapOnce(state, opts);
    } catch {
      // 看护自身出错不能影响主流程
    }
  }, opts.intervalMs ?? envInt('STEP_CODE_HEAP_CHECK_MS') ?? CHECK_INTERVAL_MS);
  // 不 ref 事件循环：看护不该让进程多活一秒
  timer.unref?.();
  return () => clearInterval(timer);
}
