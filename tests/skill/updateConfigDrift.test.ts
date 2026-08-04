/**
 * 防漂移测试：内置 update-config skill 自包含内嵌 schema 表，事实源是
 * src/config/config.ts。config.ts 加/删配置键而 skill（或 doctor 顶层键清单）
 * 未同步时，本测试变红，强制同步——自包含路线的漂移保险。
 *
 * 键集合提取方式（纯源码解析，不要求 config.ts 导出额外清单）：
 * - 顶层键：TomlConfigShape interface 的字段名；
 * - 各 section 嵌套键：resolver 里的 t['snake_case'] 字面量。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { CONFIG_TOP_LEVEL_KEYS } from '../../src/config/doctor.js';
import { UPDATE_CONFIG_SKILL } from '../../src/skill/builtin/updateConfig.js';

const configTsPath = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'config', 'config.ts');
const src = readFileSync(configTsPath, 'utf8');

/** TomlConfigShape interface 的字段名（顶层键）。 */
function topLevelKeysFromSource(): string[] {
  const m = /interface TomlConfigShape \{([\s\S]*?)\n\}/.exec(src);
  if (m === null) throw new Error('未在 config.ts 中找到 TomlConfigShape');
  const keys: string[] = [];
  for (const km of m[1]!.matchAll(/^\s+([a-z_]+)\?:/gm)) {
    keys.push(km[1]!);
  }
  return keys;
}

/** resolver 里 t['snake_case'] 字面量（各 section 的嵌套键）。 */
function nestedKeysFromSource(): string[] {
  const keys = new Set<string>();
  for (const km of src.matchAll(/\bt\['([a-z_0-9]+)'\]/g)) {
    keys.add(km[1]!);
  }
  return [...keys].sort();
}

describe('update-config skill 防漂移', () => {
  it('doctor 顶层键清单与 config.ts TomlConfigShape 一致', () => {
    expect([...CONFIG_TOP_LEVEL_KEYS].sort()).toEqual(topLevelKeysFromSource().sort());
  });

  it('skill 内嵌表覆盖全部顶层键', () => {
    for (const key of topLevelKeysFromSource()) {
      expect(UPDATE_CONFIG_SKILL.content, `skill 缺顶层键 ${key}`).toContain(key);
    }
  });

  it('skill 内嵌表覆盖全部 section 嵌套键', () => {
    for (const key of nestedKeysFromSource()) {
      expect(UPDATE_CONFIG_SKILL.content, `skill 缺嵌套键 ${key}`).toContain(key);
    }
  });

  it('skill 记录配置相关环境变量', () => {
    for (const env of [
      'STEP_CODE_API_KEY',
      'STEP_CODE_PROVIDER',
      'STEP_CODE_MODEL',
      'STEP_CODE_BASE_URL',
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
    ]) {
      expect(UPDATE_CONFIG_SKILL.content, `skill 缺环境变量 ${env}`).toContain(env);
    }
  });
});
