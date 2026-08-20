/**
 * ⑤ /provider add 目录导入（从已有渠道复制）测试。
 *
 * runProviderWizard 不可实例化（需要 TUI + config），用 wiring 断言锁源码接线点：
 * 入口选择存在、clone 模式跳过 type picker、clone 模式预填 baseUrl、i18n key 齐备。
 */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const pm = readFileSync(join(repoRoot, 'src', 'tui-pi', 'ProviderManager.ts'), 'utf8');
const i18n = readFileSync(join(repoRoot, 'src', 'i18n.ts'), 'utf8');

describe('⑤ /provider add 从已有渠道复制', () => {
  it('入口选择：有现成渠道时先问手动/复制', () => {
    expect(pm).toContain('entryMode');
    expect(pm).toContain("value: 'clone'");
    expect(pm).toContain("value: 'manual'");
  });

  it('clone 模式选源渠道', () => {
    expect(pm).toContain('cloneSource');
    expect(pm).toContain('clone = existing[source]');
  });

  it('clone 模式跳过 type picker（直接用源渠道协议）', () => {
    // type 步骤改为三元：clone !== null ? clone.type : showPicker(...)
    expect(pm).toContain('clone !== null');
    expect(pm).toContain('clone.type');
  });

  it('clone 模式预填 baseUrl（源渠道地址作 initial）', () => {
    expect(pm).toContain('clone?.baseUrl');
  });

  it('i18n key 齐备（zh + en 各 6 个新 key）', () => {
    const keys = ['ask.entryMode', 'entry.clone', 'entry.cloneDesc', 'entry.manual', 'entry.manualDesc', 'ask.cloneSource'];
    for (const k of keys) {
      const full = `providerWizard.${k}`;
      // 每个 key 在 zh + en 各出现一次 → 共 2 次
      const count = (i18n.match(new RegExp(`'${full.replace(/\./g, '\\.')}'`, 'g')) ?? []).length;
      expect(count, `i18n key ${full} 应出现 2 次（zh+en），实际 ${count}`).toBe(2);
    }
  });

  it('ProviderEntry 已 import', () => {
    expect(pm).toContain('ProviderEntry');
  });
});
