import type { WireEvent } from '../agent/wirelog.js';

/**
 * token 与缓存用量聚合（`/usage` 命令的数据层）。
 *
 * 数据源是事件日志里的 `model.usage` 事件——每轮一条，落盘于会话的 `.wire.jsonl`。
 * 选落盘而非内存累加器有三个理由：落盘覆盖完整会话（含 resume 之前的轮次，
 * 而内存累加器在 resume 后从零开始，缓存效果恰恰要看长会话的累计表现）；
 * 无需改动采集侧；与调试包导出共用同一份事实源，两者结论不会打架。
 *
 * 本模块刻意不含任何渲染逻辑与 i18n 依赖，纯函数便于测试；
 * 文本呈现在 tui 层（`tui/usagePanel.ts`）。
 */

/** 单个模型的用量累计。四个 token 字段都是跨轮次求和。 */
export interface ModelUsageStats {
  /** 模型名；事件里 model 缺失时为 {@link UNKNOWN_MODEL}。 */
  model: string;
  /** 该模型的 API 往返轮次数。 */
  turns: number;
  /**
   * 未命中缓存的输入 token。
   * 注意这是**净值**——服务端返回的 input 已扣除缓存命中部分，
   * 故本字段与 cacheRead / cacheCreation 不重叠，三者可直接相加得总输入。
   */
  input: number;
  output: number;
  /** 命中缓存、直接复用的输入 token。 */
  cacheRead: number;
  /** 写入缓存的输入 token（首轮建缓存时出现，通常为 0）。 */
  cacheCreation: number;
}

/** 聚合结果：逐模型明细 + 合计行。 */
export interface UsageReport {
  /** 按总输入量（三字段之和）降序，便于一眼看到消耗大头。 */
  rows: ModelUsageStats[];
  /** 合计行，model 为 {@link TOTAL_ROW_NAME}。 */
  total: ModelUsageStats;
}

/** 事件缺 model 字段时的分组名。 */
export const UNKNOWN_MODEL = 'unknown';

/** 合计行的 model 名。 */
export const TOTAL_ROW_NAME = 'TOTAL';

function emptyStats(model: string): ModelUsageStats {
  return { model, turns: 0, input: 0, output: 0, cacheRead: 0, cacheCreation: 0 };
}

/** 总输入 token（三字段之和），既是排序键也是命中率的分母。 */
export function totalInput(s: ModelUsageStats): number {
  return s.input + s.cacheRead + s.cacheCreation;
}

/**
 * 缓存命中率：`cacheRead / (input + cacheRead + cacheCreation)`。
 *
 * 分母取三项之和而非单取 input，因为服务端返回的 input 已经扣掉了缓存命中部分：
 * 只拿 input 当分母会把命中率算高（极端情况下命中越多、分母越小、比率越接近 1）。
 *
 * 无任何输入时返回 null 而非 0——「没有数据」与「一次都没命中」是两回事，
 * 后者是需要排查的信号，前者不是。
 */
export function cacheHitRate(s: ModelUsageStats): number | null {
  const denom = totalInput(s);
  if (denom <= 0) return null;
  return s.cacheRead / denom;
}

/**
 * 从事件流聚合出用量报告。非 `model.usage` 事件一律忽略。
 *
 * 该事件不参与状态机重放（`applyWireEvent` 不消费它），所以这里自己扫，
 * 不能指望 replay 后的状态里有它。
 */
export function aggregateModelUsage(events: readonly WireEvent[]): UsageReport {
  const byModel = new Map<string, ModelUsageStats>();
  const total = emptyStats(TOTAL_ROW_NAME);

  for (const ev of events) {
    if (ev.type !== 'model.usage') continue;
    // model 是可选字段：缺失时归入 unknown 分组，不丢弃该轮。
    // 丢弃会让合计与逐行之和对不上，而对不上的报表比多一行 unknown 更难排查。
    const key = ev.model ?? UNKNOWN_MODEL;
    let row = byModel.get(key);
    if (row === undefined) {
      row = emptyStats(key);
      byModel.set(key, row);
    }
    const input = ev.inputTokens ?? 0;
    const output = ev.outputTokens ?? 0;
    const cacheRead = ev.cacheReadTokens ?? 0;
    const cacheCreation = ev.cacheCreationTokens ?? 0;

    row.turns += 1;
    row.input += input;
    row.output += output;
    row.cacheRead += cacheRead;
    row.cacheCreation += cacheCreation;

    total.turns += 1;
    total.input += input;
    total.output += output;
    total.cacheRead += cacheRead;
    total.cacheCreation += cacheCreation;
  }

  const rows = [...byModel.values()].sort((a, b) => {
    const diff = totalInput(b) - totalInput(a);
    // 同量时按模型名稳定排序，避免 Map 插入顺序导致输出抖动（测试也依赖这个确定性）。
    return diff !== 0 ? diff : a.model.localeCompare(b.model);
  });

  return { rows, total };
}
