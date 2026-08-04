import { t } from '../i18n.js';
import {
  cacheHitRate,
  totalInput,
  TOTAL_ROW_NAME,
  type ModelUsageStats,
  type UsageReport,
} from '../session/usageReport.js';
import { formatCount } from './duration.js';

/**
 * `/usage` 的文本呈现。
 *
 * 展示分层的取舍：缓存指标只在本命令里给，**不进主状态栏**。
 * 状态栏那个 `context: N%` 表达的是「上下文物理占用」，混入缓存命中会让
 * 这个数字的语义变浑；而缓存命中率在单轮尺度上抖动很大（首轮建缓存必然是 0%），
 * 按会话累计才有意义，因此适合按需触发的命令、不适合常驻显示。
 */

/** 命中率告警的输入量下限：低于此量样本太小，比率没有意义。 */
export const LOW_HIT_INPUT_FLOOR = 1_000_000;

/** 命中率告警的上限：正常长会话应远高于此值，取保守下界避免误报。 */
export const LOW_HIT_RATE_CEIL = 0.2;

const COL = { turns: 6, tokens: 10, rate: 8 } as const;

function formatRate(rate: number | null): string {
  return rate === null ? '—' : `${(rate * 100).toFixed(1)}%`;
}

function renderRow(s: ModelUsageStats, nameWidth: number): string {
  return [
    '  ',
    s.model.padEnd(nameWidth),
    String(s.turns).padStart(COL.turns),
    formatCount(s.input).padStart(COL.tokens),
    formatCount(s.cacheRead).padStart(COL.tokens),
    formatRate(cacheHitRate(s)).padStart(COL.rate),
  ].join('');
}

function renderHeader(nameWidth: number): string {
  return [
    '  ',
    'model'.padEnd(nameWidth),
    'turns'.padStart(COL.turns),
    'input'.padStart(COL.tokens),
    'cached'.padStart(COL.tokens),
    'hit%'.padStart(COL.rate),
  ].join('');
}

/** 命中率低到值得提示的模型（输入量够大才算，避免小样本误报）。 */
export function lowHitModels(report: UsageReport): ModelUsageStats[] {
  return report.rows.filter((r) => {
    const rate = cacheHitRate(r);
    return rate !== null && totalInput(r) >= LOW_HIT_INPUT_FLOOR && rate < LOW_HIT_RATE_CEIL;
  });
}

/**
 * 渲染用量报告。
 *
 * @param scopeLabel 统计范围的描述（单会话或多会话汇总），由调用方按 i18n 组装。
 */
export function formatUsageReport(report: UsageReport, scopeLabel: string): string {
  if (report.total.turns === 0) return t('app.usage.none');

  const nameWidth = Math.max(
    'model'.length,
    TOTAL_ROW_NAME.length,
    ...report.rows.map((r) => r.model.length),
  );
  const lines: string[] = [
    t('app.usage.header', { scope: scopeLabel, turns: String(report.total.turns) }),
    '',
    renderHeader(nameWidth),
  ];
  for (const row of report.rows) lines.push(renderRow(row, nameWidth));
  // 分隔线按表格实际宽度画，避免宽窄不一
  lines.push('  ' + '─'.repeat(nameWidth + COL.turns + COL.tokens * 2 + COL.rate));
  lines.push(renderRow(report.total, nameWidth));

  // cache_creation 通常恒为 0，不为它常设一列；真的不为 0 时补一行说明，
  // 否则「分母里多出一块看不见的量」会让人怀疑命中率算错了。
  const withCreation = report.rows.filter((r) => r.cacheCreation > 0);
  if (withCreation.length > 0) {
    lines.push('');
    lines.push(
      t('app.usage.cacheCreateNote', {
        detail: withCreation.map((r) => `${r.model} ${formatCount(r.cacheCreation)}`).join('、'),
      }),
    );
  }

  const low = lowHitModels(report);
  if (low.length > 0) {
    lines.push('');
    for (const r of low) {
      lines.push(
        t('app.usage.lowHit', {
          model: r.model,
          rate: formatRate(cacheHitRate(r)),
        }),
      );
    }
  }

  return lines.join('\n');
}
