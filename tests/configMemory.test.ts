import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * [memory] 段的解析与回写。
 *
 * saveMemoryEnabled 的测试重点锁一个修过的坑：saveSectionKey 原先只支持 string | number，
 * 字符串值会写成带引号的 `"true"`（TOML 字符串），而解析端是 `enabled === true`（布尔）——
 * 开关会永远不生效。现在 boolean 走 TOML 裸值，本测试验证落盘的就是裸 `true`/`false`。
 *
 * homedir 用模块级 mock 替换（ESM 命名导出不可 spyOn）：saveSectionKey 写真实的
 * ~/.step-code/config.toml，测试必须把它重定向到临时目录。
 */

const mockHome = vi.hoisted(() => ({ value: '' }));
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => mockHome.value };
});

// config.ts 在被测文件里 import，须晚于 vi.mock 声明（vitest 会提升 mock）
const { resolveMemoryConfig, saveMemoryEnabled } = await import('../src/config/config.js');

beforeEach(() => {
  mockHome.value = mkdtempSync(join(tmpdir(), 'stepcode-memcfg-'));
});

afterEach(() => {
  rmSync(mockHome.value, { recursive: true, force: true });
});

describe('resolveMemoryConfig', () => {
  it('缺省 → enabled=false', () => {
    expect(resolveMemoryConfig(undefined)).toEqual({ enabled: false });
    expect(resolveMemoryConfig('not-object')).toEqual({ enabled: false });
    expect(resolveMemoryConfig({})).toEqual({ enabled: false });
  });

  it('仅 true 启用；其它真值形态不算', () => {
    expect(resolveMemoryConfig({ enabled: true }).enabled).toBe(true);
    expect(resolveMemoryConfig({ enabled: 'true' }).enabled).toBe(false); // 字符串不算
    expect(resolveMemoryConfig({ enabled: 1 }).enabled).toBe(false);
    expect(resolveMemoryConfig({ enabled: false }).enabled).toBe(false);
  });
});

describe('saveMemoryEnabled', () => {
  it('写入 TOML 裸布尔值（不是带引号的字符串）', () => {
    saveMemoryEnabled(true);
    const text = readFileSync(join(mockHome.value, '.step-code', 'config.toml'), 'utf-8');
    expect(text).toContain('[memory]');
    expect(text).toMatch(/enabled = true\b/);
    expect(text).not.toContain('"true"'); // 带引号会被解析端判为 false，开关永远不生效
  });

  it('再写 false：同段更新为裸 false', () => {
    saveMemoryEnabled(true);
    saveMemoryEnabled(false);
    const text = readFileSync(join(mockHome.value, '.step-code', 'config.toml'), 'utf-8');
    expect(text).toMatch(/enabled = false\b/);
    expect(text).not.toContain('"false"');
    // 段只有一个（幂等更新，不重复追加）
    expect(text.match(/\[memory\]/g)).toHaveLength(1);
  });
});
