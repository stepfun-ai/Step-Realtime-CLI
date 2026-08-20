import { afterEach, describe, expect, it } from 'vitest';
import { I18N_TABLES, setLocale } from '../../src/i18n.js';
import { SLASH_COMMANDS, busyRoute } from '../../src/chat/commands.js';
import type { ModelUsageStats, UsageReport } from '../../src/session/usageReport.js';
import { TOTAL_ROW_NAME } from '../../src/session/usageReport.js';
import {
  formatUsageReport,
  lowHitModels,
  LOW_HIT_INPUT_FLOOR,
  LOW_HIT_RATE_CEIL,
} from '../../src/chat/usagePanel.js';

afterEach(() => {
  setLocale('zh');
});

function stats(
  model: string,
  turns: number,
  input: number,
  cacheRead: number,
  cacheCreation = 0,
): ModelUsageStats {
  return { model, turns, input, output: 0, cacheRead, cacheCreation };
}

function report(rows: ModelUsageStats[]): UsageReport {
  const total = rows.reduce(
    (acc, r) => ({
      model: TOTAL_ROW_NAME,
      turns: acc.turns + r.turns,
      input: acc.input + r.input,
      output: acc.output + r.output,
      cacheRead: acc.cacheRead + r.cacheRead,
      cacheCreation: acc.cacheCreation + r.cacheCreation,
    }),
    stats(TOTAL_ROW_NAME, 0, 0, 0, 0),
  );
  return { rows, total };
}

describe('formatUsageReport', () => {
  it('无往返记录时给提示文案，不渲染空表', () => {
    const text = formatUsageReport(report([]), '会话 x');
    expect(text).toBe(I18N_TABLES.zh['app.usage.none']);
    expect(text).not.toContain('model');
  });

  it('渲染表头、逐模型行与合计行，命中率为百分比', () => {
    const text = formatUsageReport(
      report([stats('step-router-v1', 8, 112_000, 1_240_000), stats('step-explore', 26, 1_820_000, 0)]),
      '会话 abc',
    );
    expect(text).toContain('会话 abc');
    expect(text).toContain('34 轮');
    expect(text).toContain('model');
    expect(text).toContain('hit%');
    expect(text).toContain('step-explore');
    expect(text).toContain(TOTAL_ROW_NAME);
    // 1.24M / (112k + 1.24M) = 91.7%
    expect(text).toMatch(/91\.7%/);
    // 一次未命中显示 0.0%，不是空白也不是 —
    expect(text).toMatch(/0\.0%/);
  });

  it('输入量大且命中率低于阈值时追加告警行', () => {
    const low = stats('step-explore', 164, 22_706_508, 427_817);
    const text = formatUsageReport(report([low]), '会话 abc');
    expect(lowHitModels(report([low]))).toHaveLength(1);
    expect(text).toContain('step-explore');
    expect(text).toContain('⚠');
  });

  it('输入量不足阈值时不告警（小样本比率无意义）', () => {
    const tiny = stats('step-explore', 2, LOW_HIT_INPUT_FLOOR - 1, 0);
    expect(lowHitModels(report([tiny]))).toHaveLength(0);
    expect(formatUsageReport(report([tiny]), 's')).not.toContain('⚠');
  });

  it('命中率达标时不告警', () => {
    const ok = stats('step-router-v1', 217, 1_349_531, 14_464_448);
    expect(lowHitModels(report([ok]))).toHaveLength(0);
  });

  it('阈值边界：恰好等于上限不告警，略低于上限告警', () => {
    // 命中率 = cacheRead / (input + cacheRead)
    const atCeil = stats('m', 10, 8_000_000, 2_000_000); // 0.2
    const belowCeil = stats('m', 10, 8_100_000, 1_900_000); // 0.19
    expect(lowHitModels(report([atCeil]))).toHaveLength(0);
    expect(LOW_HIT_RATE_CEIL).toBe(0.2);
    expect(lowHitModels(report([belowCeil]))).toHaveLength(1);
  });

  it('cacheCreation 不为 0 时补说明行（否则分母里多出的量看不见）', () => {
    const withCreate = stats('step-explore', 5, 1000, 100, 32_909);
    const text = formatUsageReport(report([withCreate]), 's');
    expect(text).toContain('cache_creation');
    expect(text).toContain('32.9k');

    const noCreate = stats('step-explore', 5, 1000, 100, 0);
    expect(formatUsageReport(report([noCreate]), 's')).not.toContain('cache_creation');
  });

  it('英文语境下走 en 表', () => {
    setLocale('en');
    const text = formatUsageReport(report([stats('m', 1, 100, 0)]), 'session x');
    expect(text).toContain('turns');
    expect(formatUsageReport(report([]), 'session x')).toBe(I18N_TABLES.en['app.usage.none']);
  });
});

describe('/usage 命令注册', () => {
  it('已注册，且 describe 键在 zh / en 两表齐备', () => {
    const cmd = SLASH_COMMANDS.find((c) => c.name === 'usage');
    expect(cmd).toBeDefined();
    expect(I18N_TABLES.zh[cmd!.describe as keyof typeof I18N_TABLES.zh]).toBeTruthy();
    expect(I18N_TABLES.en[cmd!.describe as keyof typeof I18N_TABLES.en]).toBeTruthy();
  });

  it('是只读命令：busy 时即时执行，不排队到回合边界', () => {
    expect(busyRoute('usage', '')).toBe('instant');
    expect(busyRoute('usage', '--all')).toBe('instant');
  });
});
