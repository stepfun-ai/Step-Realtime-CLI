/**
 * collectConfigWarnings 的单元测试 + 「每个 warning code 都有渲染」的双向覆盖护栏。
 *
 * 双向覆盖钉的是同一份规则的两个出口：doctor（固定中文模板）与 TUI（i18n 双表）。
 * 新增 warning code 只改了一处而漏了另一处时，这里立刻变红——措辞审核脚本的
 * replay-check 缺陷⑤（手抄规则表漂移后漏报）就是这类漂移的反面教材。
 */
import { describe, expect, it } from 'vitest';
import { PROVIDER_PRESETS } from '../../src/config/config.js';
import {
  CONFIG_TOP_LEVEL_KEYS,
  CONFIG_WARNING_CODES,
  collectConfigWarnings,
  formatWarningZh,
  type ConfigWarningCode,
} from '../../src/config/diagnostics.js';
import { I18N_TABLES } from '../../src/i18n.js';

/** 每个 code 一个可用的插值参数样例（渲染完整性测试用）。 */
const PARAM_SAMPLE: Record<ConfigWarningCode, Record<string, string | number>> = {
  unknownTopLevelKey: { key: 'langauge' },
  providerTypeInvalid: { id: 'ch1', allowed: Object.keys(PROVIDER_PRESETS).join(' / ') },
  aliasChannelMissing: { alias: 'k3', channel: 'ch-typo' },
  aliasChannelIsPreset: { alias: 'k3', channel: 'anthropic' },
  aliasChannelInvalid: { alias: 'k3', channel: 'ch1' },
  hookEventInvalid: { index: 1, allowed: 'PreToolUse / PostToolUse' },
};

describe('collectConfigWarnings', () => {
  it('干净的配置零警告', () => {
    expect(
      collectConfigWarnings({
        model: 'k3',
        providers: { ch1: { type: 'openai', base_url: 'https://x' } },
        models: { k3: { model: 'k3', provider: 'ch1' } },
      }),
    ).toEqual([]);
  });

  it('未知顶层键 → unknownTopLevelKey', () => {
    const w = collectConfigWarnings({ langauge: 'en' });
    expect(w).toEqual([{ code: 'unknownTopLevelKey', params: { key: 'langauge' } }]);
  });

  it('渠道 type 非法 → providerTypeInvalid，且该渠道不计入有效渠道', () => {
    const w = collectConfigWarnings({ providers: { ch1: { type: 'opanai' } } });
    expect(w).toHaveLength(1);
    expect(w[0]!.code).toBe('providerTypeInvalid');
  });

  it('别名引用未声明的渠道 id → aliasChannelMissing', () => {
    const w = collectConfigWarnings({ models: { k3: { model: 'k3', provider: 'ch-typo' } } });
    expect(w).toEqual([{ code: 'aliasChannelMissing', params: { alias: 'k3', channel: 'ch-typo' } }]);
  });

  it('别名引用内置协议预设名 → aliasChannelIsPreset（最容易踩的变体）', () => {
    const w = collectConfigWarnings({ models: { k3: { model: 'k3', provider: 'anthropic' } } });
    expect(w).toEqual([{ code: 'aliasChannelIsPreset', params: { alias: 'k3', channel: 'anthropic' } }]);
  });

  it('别名引用被忽略的渠道（type 非法）→ aliasChannelInvalid，且与渠道警告共存', () => {
    const w = collectConfigWarnings({
      providers: { ch1: { type: 'opanai' } },
      models: { k3: { model: 'k3', provider: 'ch1' } },
    });
    const codes = w.map((x) => x.code);
    expect(codes).toContain('providerTypeInvalid');
    expect(codes).toContain('aliasChannelInvalid');
  });

  it('别名未写 provider（继承顶层）→ 不告警', () => {
    expect(collectConfigWarnings({ models: { k3: { model: 'k3' } } })).toEqual([]);
  });

  it('hooks 的 event 非法 → hookEventInvalid', () => {
    const w = collectConfigWarnings({ hooks: [{ event: 'NotAnEvent', command: 'echo' }] });
    expect(w).toEqual([
      { code: 'hookEventInvalid', params: { index: 1, allowed: expect.any(String) } },
    ]);
  });
});

describe('每个 warning code 都有渲染（doctor + TUI 双向覆盖）', () => {
  it('code 全集与顶层键清单同被导出', () => {
    expect(CONFIG_WARNING_CODES.length).toBeGreaterThan(0);
    expect(CONFIG_TOP_LEVEL_KEYS.length).toBeGreaterThan(0);
  });

  it('doctor 中文模板：每个 code 都能渲染出非空文案', () => {
    for (const code of CONFIG_WARNING_CODES) {
      const text = formatWarningZh({ code, params: PARAM_SAMPLE[code] });
      expect(text, `code ${code} 在 doctor 中文模板表缺渲染`).not.toBe('');
    }
  });

  it('TUI i18n：每个 code 在 zh/en 两张表都有对应 key', () => {
    for (const code of CONFIG_WARNING_CODES) {
      const key = `app.config.warn.${code}`;
      expect(I18N_TABLES.zh[key], `code ${code} 在 zh 表缺 key ${key}`).toBeTypeOf('string');
      expect(I18N_TABLES.en[key], `code ${code} 在 en 表缺 key ${key}`).toBeTypeOf('string');
    }
  });
});
