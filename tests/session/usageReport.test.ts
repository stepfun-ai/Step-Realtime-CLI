import { describe, expect, it } from 'vitest';
import type { WireEvent } from '../../src/agent/wirelog.js';
import {
  aggregateModelUsage,
  cacheHitRate,
  totalInput,
  TOTAL_ROW_NAME,
  UNKNOWN_MODEL,
  type ModelUsageStats,
} from '../../src/session/usageReport.js';

const TS = '2026-08-04T00:00:00.000Z';

/** 造一条 model.usage 事件。model 传 undefined 模拟旧数据缺字段。 */
function usage(
  model: string | undefined,
  input: number,
  output: number,
  cacheRead: number,
  cacheCreation = 0,
): WireEvent {
  return {
    type: 'model.usage',
    ts: TS,
    ...(model !== undefined ? { model } : {}),
    totalTokens: input + output + cacheRead + cacheCreation,
    billedTokens: input + output,
    inputTokens: input,
    outputTokens: output,
    cacheReadTokens: cacheRead,
    cacheCreationTokens: cacheCreation,
    estimatedTokens: 0,
    frameworkTokens: 0,
    measuredLength: 0,
    stopReason: 'end_turn',
  };
}

function rowOf(events: readonly WireEvent[], model: string): ModelUsageStats {
  const row = aggregateModelUsage(events).rows.find((r) => r.model === model);
  expect(row).toBeDefined();
  return row!;
}

describe('aggregateModelUsage', () => {
  it('按模型分组，四个 token 字段跨轮累加', () => {
    const report = aggregateModelUsage([
      usage('step-explore', 100, 10, 0),
      usage('step-explore', 200, 20, 50),
      usage('step-router-v1', 300, 30, 700),
    ]);
    const explore = rowOf(
      [usage('step-explore', 100, 10, 0), usage('step-explore', 200, 20, 50)],
      'step-explore',
    );
    expect(explore.turns).toBe(2);
    expect(explore.input).toBe(300);
    expect(explore.output).toBe(30);
    expect(explore.cacheRead).toBe(50);
    expect(report.rows).toHaveLength(2);
  });

  it('合计行等于各行之和，且 turns 为总轮次', () => {
    const report = aggregateModelUsage([
      usage('a', 100, 10, 5, 1),
      usage('b', 200, 20, 6, 2),
      usage('a', 300, 30, 7, 3),
    ]);
    const sum = (pick: (r: ModelUsageStats) => number): number =>
      report.rows.reduce((acc, r) => acc + pick(r), 0);
    expect(report.total.model).toBe(TOTAL_ROW_NAME);
    expect(report.total.turns).toBe(3);
    expect(report.total.input).toBe(sum((r) => r.input));
    expect(report.total.output).toBe(sum((r) => r.output));
    expect(report.total.cacheRead).toBe(sum((r) => r.cacheRead));
    expect(report.total.cacheCreation).toBe(sum((r) => r.cacheCreation));
  });

  it('model 缺失归入 unknown 分组，不丢弃该轮（合计与逐行之和必须一致）', () => {
    const report = aggregateModelUsage([usage('step-explore', 100, 10, 0), usage(undefined, 400, 40, 0)]);
    const unknown = report.rows.find((r) => r.model === UNKNOWN_MODEL);
    expect(unknown).toBeDefined();
    expect(unknown!.input).toBe(400);
    expect(report.total.turns).toBe(2);
    expect(report.total.input).toBe(500);
  });

  it('忽略非 model.usage 事件', () => {
    const report = aggregateModelUsage([
      { type: 'metadata', version: 1, sessionId: 's', createdAt: TS },
      { type: 'permission.set_mode', ts: TS, mode: 'auto' },
      usage('step-explore', 100, 10, 0),
    ]);
    expect(report.rows).toHaveLength(1);
    expect(report.total.turns).toBe(1);
  });

  it('空事件流：rows 为空、合计全零', () => {
    const report = aggregateModelUsage([]);
    expect(report.rows).toEqual([]);
    expect(report.total.turns).toBe(0);
    expect(report.total.input).toBe(0);
  });

  it('按总输入量降序排，同量按模型名稳定排序', () => {
    const report = aggregateModelUsage([
      usage('small', 10, 1, 0),
      usage('big', 1000, 1, 0),
      usage('mid', 100, 1, 0),
    ]);
    expect(report.rows.map((r) => r.model)).toEqual(['big', 'mid', 'small']);

    const tie = aggregateModelUsage([usage('zeta', 100, 1, 0), usage('alpha', 100, 1, 0)]);
    expect(tie.rows.map((r) => r.model)).toEqual(['alpha', 'zeta']);
  });

  it('缺省的 token 字段按 0 计（不产生 NaN）', () => {
    const report = aggregateModelUsage([
      { type: 'model.usage', ts: TS, model: 'm', totalTokens: 0, billedTokens: 0, estimatedTokens: 0, frameworkTokens: 0, measuredLength: 0, stopReason: 'end_turn' },
    ]);
    const row = report.rows[0]!;
    expect(row.input).toBe(0);
    expect(row.cacheRead).toBe(0);
    expect(Number.isNaN(row.input)).toBe(false);
  });
});

describe('cacheHitRate 口径', () => {
  it('分母是 input + cacheRead + cacheCreation 三者之和，不是单取 input', () => {
    // 这条钉死口径：服务端返回的 input 已扣除缓存部分，两者不重叠。
    // 若误取 input 作分母，900/100 会得出 9（900%），命中越多反而越离谱。
    const stats: ModelUsageStats = {
      model: 'm',
      turns: 1,
      input: 100,
      output: 0,
      cacheRead: 900,
      cacheCreation: 0,
    };
    expect(totalInput(stats)).toBe(1000);
    expect(cacheHitRate(stats)).toBeCloseTo(0.9, 10);
  });

  it('cacheCreation 参与分母', () => {
    const stats: ModelUsageStats = {
      model: 'm',
      turns: 1,
      input: 100,
      output: 0,
      cacheRead: 100,
      cacheCreation: 800,
    };
    expect(cacheHitRate(stats)).toBeCloseTo(0.1, 10);
  });

  it('无任何输入返回 null 而非 0（「没数据」与「一次没命中」要能区分）', () => {
    const empty: ModelUsageStats = {
      model: 'm',
      turns: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheCreation: 0,
    };
    expect(cacheHitRate(empty)).toBeNull();

    const neverHit: ModelUsageStats = { ...empty, turns: 3, input: 5000 };
    expect(cacheHitRate(neverHit)).toBe(0);
  });
});
