import { describe, expect, it } from 'vitest';
import { resolveModelEntry, type StepCodeConfig } from '../../src/config/config.js';

/**
 * 模拟 cli.tsx 恢复会话时的 model 别名展开与同步逻辑。
 * 核心断言：resolveModelEntry 成功后，session.model 必须同步为真实模型 id，
 * 否则后续 provider.stream 会把别名当模型 ID 发给服务端，导致 404 model_invalid。
 */
describe('cli 恢复路径：session.model 别名展开后同步回真实模型 id', () => {
  function makeConfig(models?: StepCodeConfig['models']): StepCodeConfig {
    return {
      provider: 'stepfun',
      apiKey: 'k-implicit',
      baseUrl: 'https://api.stepfun.com',
      model: 'step-3.7-flash',
      maxContextSize: 262_144,
      maxTokens: 32768,
      subagent: { maxTokens: 16384, maxTurns: 20, maxTotalTokens: 1_048_576 },
      compaction: { maxContextSize: 262_144, maxTokens: 32768, trimThreshold: 0.75, summaryModel: '', recentMessages: 12 },
      ...(models !== undefined ? { models } : {}),
    };
  }

  it('别名映射到真实 model → session.model 更新为真实 id（非别名）', () => {
    const config = makeConfig({
      explore: { model: 'step-2-16k' },
    });
    const session = { model: 'explore' } as { model: string };

    // 还原 cli.tsx:646-652 的恢复分支
    if (session.model !== '' && session.model !== config.model) {
      const resolved = resolveModelEntry(config, session.model);
      if (resolved !== null) {
        // 模拟 createProvider(resolved) 成功
        const sessionMaxContextSize = resolved.maxContextSize;
        // 修复点：provider 重建成功后，必须把展开后的真实模型 id 同步回 session.model
        session.model = resolved.model;
        expect(sessionMaxContextSize).toBe(262_144);
      }
    }

    expect(session.model).toBe('step-2-16k');
  });

  it('同名裸 id（无 models 表）→ 走 config.model 回退，不更新为别名', () => {
    const config = makeConfig();
    const session = { model: 'step-3.7-flash' } as { model: string };

    if (session.model !== '' && session.model !== config.model) {
      const resolved = resolveModelEntry(config, session.model);
      if (resolved !== null) {
        session.model = resolved.model;
      }
    }

    // session.model === config.model，不走恢复分支，保持原值
    expect(session.model).toBe('step-3.7-flash');
  });

  it('无效别名 → resolveModelEntry 返回 null → 回退到 config.model', () => {
    const config = makeConfig();
    const session = { model: 'nonexistent-alias' } as { model: string };

    if (session.model !== '' && session.model !== config.model) {
      const resolved = resolveModelEntry(config, session.model);
      if (resolved !== null) {
        session.model = resolved.model;
      } else {
        session.model = config.model;
      }
    }

    expect(session.model).toBe('step-3.7-flash');
  });

  it('别名未声明 model 字段 → 回退为别名本身（裸 id）', () => {
    const config = makeConfig({
      'step-3.5-flash': {},
    });
    const session = { model: 'step-3.5-flash' } as { model: string };

    if (session.model !== '' && session.model !== config.model) {
      const resolved = resolveModelEntry(config, session.model);
      if (resolved !== null) {
        session.model = resolved.model;
      }
    }

    // 别名未显式声明 model → entry.model ?? name = 'step-3.5-flash'（即裸 id）
    expect(session.model).toBe('step-3.5-flash');
  });
});
