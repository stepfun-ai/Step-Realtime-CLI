import { describe, expect, it } from 'vitest';
import { resolveModelEntry, type StepCodeConfig } from '../../src/config/config.js';

/**
 * 模拟 cli.ts 恢复会话时的 model 别名展开逻辑。
 * 核心断言：session.model 保留别名（用于 resolveStartupModelAlias 反查与持久化），
 * providerModel 承载真实 id（给 provider.stream）。两者分离，避免 session.model
 * 存真实 id 时被 resolveStartupModelAlias 误反查到同名别名。
 */
describe('cli 恢复路径：session.model 保留别名，providerModel 承载真实 id', () => {
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

  it('别名映射到真实 model → session.model 保留别名，providerModel 取真实 id', () => {
    const config = makeConfig({
      explore: { model: 'step-2-16k' },
    });
    const session = { model: 'explore' } as { model: string };
    let providerModel = config.model;

    // 还原 cli.ts 恢复分支
    if (session.model !== '' && session.model !== config.model) {
      const resolved = resolveModelEntry(config, session.model);
      if (resolved !== null) {
        // 模拟 createProvider(resolved) 成功
        const sessionMaxContextSize = resolved.maxContextSize;
        providerModel = resolved.model;
        expect(sessionMaxContextSize).toBe(262_144);
      }
    }

    expect(session.model).toBe('explore'); // 保留别名
    expect(providerModel).toBe('step-2-16k'); // 真实 id 给 provider
  });

  it('同名裸 id（无 models 表）→ 走 config 默认回退，session.model 与 providerModel 一致', () => {
    const config = makeConfig();
    const session = { model: 'step-3.7-flash' } as { model: string };
    let providerModel = config.model;

    if (session.model !== '' && session.model !== config.model) {
      const resolved = resolveModelEntry(config, session.model);
      if (resolved !== null) {
        providerModel = resolved.model;
      }
    }

    // session.model === config.model，不走恢复分支，保持原值
    expect(session.model).toBe('step-3.7-flash');
    expect(providerModel).toBe('step-3.7-flash');
  });

  it('无效别名 → resolveModelEntry 返回 null → 回退到 config 默认（别名优先）', () => {
    const config = makeConfig();
    const session = { model: 'nonexistent-alias' } as { model: string };
    let providerModel = config.model;

    if (session.model !== '' && session.model !== config.model) {
      const resolved = resolveModelEntry(config, session.model);
      if (resolved !== null) {
        providerModel = resolved.model;
      } else {
        session.model = config.modelAlias ?? config.model;
        providerModel = config.model;
      }
    }

    expect(session.model).toBe('step-3.7-flash');
    expect(providerModel).toBe('step-3.7-flash');
  });

  it('别名未声明 model 字段 → providerModel 回退为别名本身（裸 id）', () => {
    const config = makeConfig({
      'step-3.5-flash': {},
    });
    const session = { model: 'step-3.5-flash' } as { model: string };
    let providerModel = config.model;

    if (session.model !== '' && session.model !== config.model) {
      const resolved = resolveModelEntry(config, session.model);
      if (resolved !== null) {
        providerModel = resolved.model;
      }
    }

    // 别名未显式声明 model → entry.model ?? name = 'step-3.5-flash'（即裸 id）
    expect(session.model).toBe('step-3.5-flash'); // 保留别名
    expect(providerModel).toBe('step-3.5-flash'); // 真实 id 恰等于别名
  });

  it('config.modelAlias 存在时新建会话优先存别名', () => {
    const config = makeConfig({
      song: { model: 'kimi-for-coding' },
      'kimi-for-coding': { model: 'kimi-for-coding' },
    });
    config.model = 'kimi-for-coding';
    config.modelAlias = 'song';

    // 模拟 cli.ts 新建会话路径
    const session = { model: '' } as { model: string };
    let providerModel = config.model;
    if (session.model === '' || session.model === undefined) {
      session.model = config.modelAlias ?? config.model;
      providerModel = config.model;
    }

    expect(session.model).toBe('song'); // 存别名
    expect(providerModel).toBe('kimi-for-coding'); // 真实 id 给 provider
  });
});
