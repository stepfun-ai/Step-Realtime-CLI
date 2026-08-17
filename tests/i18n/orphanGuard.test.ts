/**
 * i18n 反向孤儿守卫（棘轮式）：表里定义但 src 里无 t() 调用点的 key。
 *
 * 2026-08-17 i18n 全量扫描收口加。文档 `前端设计-pi版/20260816-i18n全量扫描与孤儿key处置.md`。
 *
 * **为什么是棘轮而不是硬性零孤儿**：pi 版是从 Ink 迁移的 WIP，i18n 表是**整表带过来的迁移目标表**。
 * 2026-08-17 实测 321 个 key 在 pi 的 src 里没有 t() 调用点——它们不是写错或残留，而是对应的
 * Ink 功能（export / memory / resume / restore / reflect / queue / goal-steer / image 高级 /
 * loop / team 细节 / think 高级…）**还没迁到 pi**。这批 key 必须保留（功能落地时要接线），
 * 现在删了将来要重写。所以断言不是「零孤儿」，而是「不超过基线」——棘轮只往下走。
 *
 * 棘轮能抓的真回归：有人新增/改名了一个 key 却忘了接线，或删了功能调用却忘了清 key → 计数上涨 → 红灯。
 * 它抓不到的：基线内的 321 个内部增减（某个缺接线 key 被接线了，计数下降，正常）。
 *
 * 检索式必须与 `i18n.test.ts`「调用→表」守卫同款（T_CALL 静态 + DYN_PREFIX 动态前缀），两侧才不会打架。
 * allowlist 收录「非 t() 方式引用」或「有意保留」的 key，每条必须写理由。
 *
 * **降基线的手续**：当某个 Ink 功能迁移到 pi、对应 key 被接线后，把新基线写进 BASELINE 并
 * 在文档补一条「X 功能已迁移，孤儿 -N」。只减不增。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { I18N_TABLES } from '../../src/i18n.js';

/** 2026-08-17 首次实测基线：321 个缺接线 key（待 pi 迁移对应 Ink 功能）。只减不增。 */
const ORPHAN_BASELINE = 321;

const ORPHAN_ALLOWLIST: ReadonlySet<string> = new Set<string>([
  // 暂无。若某 key 只在 askLine 回调/overlay 里按变量拼接、静态提取抓不到，在这里列 + 写理由。
]);

describe('i18n 反向孤儿守卫（棘轮）', () => {
  it('缺接线 key 数不超过基线（棘轮只往下走）', () => {
    const srcDir = join(__dirname, '..', '..', 'src');
    const T_CALL = /(?<![a-zA-Z0-9_$.])t\(\s*'([a-zA-Z][\w.-]*)'/g;
    const DYN_PREFIX = /(?<![a-zA-Z0-9_$.])t\(\s*(?:`([a-zA-Z][\w.-]*)\.\$\{|'([a-zA-Z][\w.-]*)\.'\s*\+)/g;
    function walk(dir: string): string[] {
      return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = join(dir, e.name);
        if (e.isDirectory()) return walk(p);
        return e.isFile() && e.name.endsWith('.ts') && p !== join(srcDir, 'i18n.ts') ? [p] : [];
      });
    }
    const called = new Set<string>();
    const dynPrefixes = new Set<string>();
    for (const file of walk(srcDir)) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(T_CALL)) called.add(m[1]!);
      for (const m of src.matchAll(DYN_PREFIX)) dynPrefixes.add((m[1] ?? m[2])!);
    }
    expect(called.size, 't() 静态调用提取为空，检索式失效').toBeGreaterThan(100);
    const defined = new Set(Object.keys(I18N_TABLES.zh));
    const orphans = [...defined]
      .filter((k) => !called.has(k) && !ORPHAN_ALLOWLIST.has(k) && ![...dynPrefixes].some((p) => k.startsWith(p)))
      .sort();
    // 棘轮：超过基线 = 有新的缺接线 key 混进来，必须查清是新增还是检索式退化
    expect(
      orphans.length,
      `缺接线 key 数 ${orphans.length} 超过基线 ${ORPHAN_BASELINE}：${orphans.length > ORPHAN_BASELINE ? '有新增未接线 key，或检索式退化——先核对 T_CALL/DYN_PREFIX 是否还能抓到既有调用' : ''}\n新增项：${orphans.slice(ORPHAN_BASELINE).join(', ')}`,
    ).toBeLessThanOrEqual(ORPHAN_BASELINE);
  });
});
