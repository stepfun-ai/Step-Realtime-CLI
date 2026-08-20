/**
 * i18n 反向孤儿守卫（棘轮式）：表里定义但 src 里无任何引用点的 key。
 *
 * 2026-08-17 i18n 全量扫描收口加。文档 `前端设计-pi版/20260816-i18n全量扫描与孤儿key处置.md`。
 *
 * **为什么是棘轮而不是硬性零孤儿**：pi 版是从 Ink 迁移的 WIP，i18n 表是整表带过来的迁移目标表。
 * 实测约 276 个 key 在 pi 的 src 里没有引用点——它们不是写错或残留，而是对应的 Ink 功能
 * 还没迁到 pi。这批 key 必须保留（功能落地要接线），现在删了将来重写。所以断言不是「零孤儿」，
 * 而是「不超过基线」——棘轮只往下走。
 *
 * 棘轮抓的真回归：新增/改名 key 忘接线，或删功能调用忘清 key → 计数上涨 → 红灯。
 *
 * **引用点定义（踩过的坑）**：key 不一定只在 t('key') 里。命令描述 `describe: 'cmd.memory'` 由
 * 菜单侧 t(cmd.describe) 解析——只认 t('...') 字面量会把 30 个已接线 cmd.* 误判孤儿（窄 327 → 宽 276）。
 * 故用「源码里任何带引号字面量命中该 key」+ 动态前缀 t(`prefix.${x}`) 双重判定。
 *
 * allowlist 收录「非字面量方式引用」或「有意保留」的 key，每条必须写理由。
 *
 * **降基线**：某功能迁移、对应 key 被接线后，把新基线写进 ORPHAN_BASELINE，文档补「X 已迁移，-N」。只减不增。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { I18N_TABLES } from '../../src/i18n.js';

/** 2026-08-17 首次实测基线（宽口径：字面量 + 动态前缀）：276 个缺接线 key。只减不增。 */
const ORPHAN_BASELINE = 276;

const ORPHAN_ALLOWLIST: ReadonlySet<string> = new Set<string>([
  // 暂无。若某 key 只在变量拼接（前缀也非字面量）里引用，在这里列 + 写理由。
]);

describe('i18n 反向孤儿守卫（棘轮）', () => {
  it('缺接线 key 数不超过基线（棘轮只往下走）', () => {
    const srcDir = join(__dirname, '..', '..', 'src');
    // 宽口径：任何带引号字面量（覆盖 t('key')、describe: 'key'、对象字段值等）
    const LIT = /['"]([a-zA-Z][\w.-]*)['"]/g;
    // 动态前缀：t(`prefix.${x}`)
    const DYN = /t\(\s*`([a-zA-Z][\w.-]*)\.\$\{/g;
    function walk(dir: string): string[] {
      return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = join(dir, e.name);
        if (e.isDirectory()) return walk(p);
        return e.isFile() && e.name.endsWith('.ts') && p !== join(srcDir, 'i18n.ts') ? [p] : [];
      });
    }
    const referenced = new Set<string>();
    const dynPrefixes = new Set<string>();
    for (const file of walk(srcDir)) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(LIT)) referenced.add(m[1]!);
      for (const m of src.matchAll(DYN)) dynPrefixes.add(m[1]! + '.');
    }
    expect(referenced.size, '字面量提取为空，检索式失效').toBeGreaterThan(100);
    const defined = new Set(Object.keys(I18N_TABLES.zh));
    const orphans = [...defined]
      .filter((k) => !referenced.has(k) && !ORPHAN_ALLOWLIST.has(k) && ![...dynPrefixes].some((p) => k.startsWith(p)))
      .sort();
    expect(
      orphans.length,
      `缺接线 key 数 ${orphans.length} 超过基线 ${ORPHAN_BASELINE}：${
        orphans.length > ORPHAN_BASELINE ? '有新增未接线 key，或检索式退化——先核对 LIT/DYN 是否还能抓到既有引用' : ''
      }\n新增项：${orphans.slice(ORPHAN_BASELINE).join(', ')}`,
    ).toBeLessThanOrEqual(ORPHAN_BASELINE);
  });
});
