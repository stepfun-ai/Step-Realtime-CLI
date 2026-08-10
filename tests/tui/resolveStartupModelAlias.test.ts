import { describe, expect, it } from 'vitest';
import type { StepCodeConfig } from '../../src/config/config.js';
import { resolveStartupModelAlias } from '../../src/tui/App.js';

/** 构造一个最小合法配置（默认值对齐 config.ts 内置默认），用 overrides 覆盖差异字段。 */
function makeCfg(overrides: Partial<StepCodeConfig> = {}): StepCodeConfig {
  return {
    provider: 'stepfun',
    apiKey: 'k-top',
    baseUrl: 'https://api.stepfun.com',
    model: 'step-3.7-flash',
    maxContextSize: 262_144,
    maxTokens: 65_536,
    subagent: { maxDepth: 1, maxSteps: 100, maxConcurrent: 4, retention: { deleteWithParent: true, maxSessions: 0, ttlDays: 0 } },
    compaction: { triggerRatio: 0.85, reservedTokens: 32_000 },
    thinking: { enabled: false, levels: { low: 1024, medium: 4096, high: 32_000 } },
    ...overrides,
  };
}

/** 只测纯函数：根据 resume 会话的 session.model（可能是别名 / 真实 id / 空串）与当前配置，
 *  返回应作为启动别名指针的值；未命中任何别名时返回 undefined，调用方回退全局默认。 */
describe('resolveStartupModelAlias', () => {
  const baseCfg = (): StepCodeConfig =>
    makeCfg({
      models: {
        router: { model: 'step-router-v1', displayName: 'Step Router' },
        step37: { model: 'step-3.7-flash', displayName: 'Step 3.7 Flash' },
        step37plan: { model: 'step-3.7-flash', displayName: 'Step 3.7 Flash Plan' },
      },
    });

  it('resume 会话存储别名且命中 config.models → 返回该别名', () => {
    expect(resolveStartupModelAlias('step37plan', baseCfg())).toBe('step37plan');
  });

  it('resume 会话存储真实 id（旧格式）→ 未命中别名，返回 undefined', () => {
    expect(resolveStartupModelAlias('step-3.7-flash', baseCfg())).toBeUndefined();
  });

  it('resume 会话存储空串 → 返回 undefined', () => {
    expect(resolveStartupModelAlias('', baseCfg())).toBeUndefined();
  });

  it('resume 会话存储 undefined → 返回 undefined', () => {
    expect(resolveStartupModelAlias(undefined as unknown as string, baseCfg())).toBeUndefined();
  });
});
