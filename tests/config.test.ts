import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// loadConfig 读 ~/.step-code/config.toml：把 homedir 指到临时目录，避免碰真实配置。
// 不 mock 的话，开发机上一份真实 config.toml 就会污染断言（顶层 model 若是别名，
// 展开时还会走渠道分支取到渠道 api_key），且只能靠 existsSync 跳过整个用例、丧失覆盖。
let fakeHome = '';
vi.mock('node:os', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:os')>();
  return { ...orig, homedir: () => fakeHome };
});

import { loadConfig, conventionalApiKeyEnvVar, resolveCompactionConfig, resolveModelEntry, resolveModels, resolveProviders, resolveStringArray, resolveSubagentLimits, resolveTuiConfig, type StepCodeConfig } from '../src/config/config.js';

const ENV_KEYS = [
  'STEPFUN_API_KEY',
  'STEP_CODE_API_KEY',
  'STEP_CODE_PROVIDER',
  'STEP_CODE_BASE_URL',
  'STEP_CODE_MODEL',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GW_ENV_KEY',
  'ENTRY_ENV_KEY',
];
let saved: Record<string, string | undefined>;
let dir: string;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  dir = mkdtempSync(join(tmpdir(), 'stepcode-cfg-'));
  fakeHome = dir;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  fakeHome = '';
  rmSync(dir, { recursive: true, force: true });
});

describe('loadConfig', () => {
  it('环境变量优先，覆盖默认值', () => {
    process.env['STEP_CODE_API_KEY'] = 'k-env';
    process.env['STEP_CODE_MODEL'] = 'step-custom';
    process.env['STEP_CODE_BASE_URL'] = 'https://example.test';
    const cfg = loadConfig(dir);
    expect(cfg.apiKey).toBe('k-env');
    expect(cfg.model).toBe('step-custom');
    expect(cfg.baseUrl).toBe('https://example.test');
  });

  it('从 cwd/.env 读取 key（env 未设时）', () => {
    writeFileSync(join(dir, '.env'), 'STEP_CODE_API_KEY=k-dotenv\n');
    const cfg = loadConfig(dir);
    expect(cfg.apiKey).toBe('k-dotenv');
  });

  it('有 key 时给出合理默认（model=step-3.7-flash）', () => {
    process.env['STEP_CODE_API_KEY'] = 'k';
    const cfg = loadConfig(dir);
    expect(cfg.model).toBe('step-3.7-flash');
    expect(cfg.baseUrl).toBe('https://api.stepfun.com');
    expect(cfg.maxContextSize).toBeGreaterThan(0);
  });

  it('完全无 key 时不抛错，apiKey 为 undefined（缺失由 provider 工厂兜底）', () => {
    const cfg = loadConfig(dir);
    expect(cfg.apiKey).toBeUndefined();
  });

  it('media_keep_recent 解析：正整数进结果对象，缺省/非法值不进', () => {
    const cfgDir = join(dir, '.step-code');
    mkdirSync(cfgDir, { recursive: true });
    // 缺省：键不进结果对象
    writeFileSync(join(cfgDir, 'config.toml'), 'model = "step-3.7-flash"\n', 'utf8');
    expect(loadConfig(dir).mediaKeepRecentImages).toBeUndefined();
    // 正整数正常解析
    writeFileSync(join(cfgDir, 'config.toml'), 'media_keep_recent = 5\n', 'utf8');
    expect(loadConfig(dir).mediaKeepRecentImages).toBe(5);
    // 小数向下取整、负数钳到 0
    writeFileSync(join(cfgDir, 'config.toml'), 'media_keep_recent = 4.9\n', 'utf8');
    expect(loadConfig(dir).mediaKeepRecentImages).toBe(4);
    writeFileSync(join(cfgDir, 'config.toml'), 'media_keep_recent = -2\n', 'utf8');
    expect(loadConfig(dir).mediaKeepRecentImages).toBe(0);
    // 非法值（非数字）不进结果对象
    writeFileSync(join(cfgDir, 'config.toml'), 'media_keep_recent = "abc"\n', 'utf8');
    expect(loadConfig(dir).mediaKeepRecentImages).toBeUndefined();
  });

  it('config 带 subagent 与 compaction 字段', () => {
    process.env['STEP_CODE_API_KEY'] = 'k';
    const cfg = loadConfig(dir);
    expect(cfg.subagent.maxDepth).toBeGreaterThanOrEqual(1);
    expect(cfg.subagent.maxSteps).toBeGreaterThanOrEqual(1);
    expect(cfg.compaction.triggerRatio).toBeGreaterThanOrEqual(0.5);
    expect(cfg.compaction.reservedTokens).toBeGreaterThanOrEqual(0);
  });
});

describe('loadConfig provider 解析', () => {
  it('默认 provider 为 stepfun，且预设默认字节级不变', () => {
    process.env['STEP_CODE_API_KEY'] = 'k';
    const cfg = loadConfig(dir);
    expect(cfg.provider).toBe('stepfun');
    expect(cfg.baseUrl).toBe('https://api.stepfun.com');
    expect(cfg.model).toBe('step-3.7-flash');
  });

  it('STEP_CODE_PROVIDER 覆盖为 anthropic，未配 model 时用预设（anthropic 无预设 model → 空串）', () => {
    process.env['STEP_CODE_API_KEY'] = 'k';
    process.env['STEP_CODE_PROVIDER'] = 'anthropic';
    const cfg = loadConfig(dir);
    expect(cfg.provider).toBe('anthropic');
    expect(cfg.baseUrl).toBe('https://api.anthropic.com');
    expect(cfg.model).toBe('');
  });

  it('overrides.provider 优先于环境变量', () => {
    process.env['STEP_CODE_API_KEY'] = 'k';
    process.env['STEP_CODE_PROVIDER'] = 'stepfun';
    const cfg = loadConfig(dir, { provider: 'anthropic' });
    expect(cfg.provider).toBe('anthropic');
  });

  it('overrides.model 优先于环境变量与预设', () => {
    process.env['STEP_CODE_API_KEY'] = 'k';
    process.env['STEP_CODE_MODEL'] = 'env-model';
    const cfg = loadConfig(dir, { model: 'cli-model' });
    expect(cfg.model).toBe('cli-model');
  });

  it('STEPFUN_API_KEY 不再识别（旧变量名被忽略）', () => {
    process.env['STEPFUN_API_KEY'] = 'legacy-key';
    const cfg = loadConfig(dir);
    expect(cfg.apiKey).toBeUndefined();
  });

  it('STEP_CODE_API_KEY 生效，STEPFUN_API_KEY 被忽略', () => {
    process.env['STEPFUN_API_KEY'] = 'legacy-key';
    process.env['STEP_CODE_API_KEY'] = 'new-key';
    const cfg = loadConfig(dir);
    expect(cfg.apiKey).toBe('new-key');
  });

  it('用户显式 baseUrl/model 优先于 provider 预设', () => {
    process.env['STEP_CODE_API_KEY'] = 'k';
    process.env['STEP_CODE_PROVIDER'] = 'anthropic';
    process.env['STEP_CODE_BASE_URL'] = 'https://custom.example';
    process.env['STEP_CODE_MODEL'] = 'my-model';
    const cfg = loadConfig(dir);
    expect(cfg.baseUrl).toBe('https://custom.example');
    expect(cfg.model).toBe('my-model');
  });
});

describe('resolveSubagentLimits', () => {
  it('缺省 → 默认值', () => {
    expect(resolveSubagentLimits(undefined)).toEqual({
      maxDepth: 1,
      maxSteps: 100,
      maxConcurrent: 4,
      retention: { deleteWithParent: true, maxSessions: 0, ttlDays: 0 },
    });
  });

  it('越界 → clamp 到边界（上限）', () => {
    expect(resolveSubagentLimits({ max_depth: 5, max_steps: 9999, max_concurrent: 999 })).toEqual({
      maxDepth: 3,
      maxSteps: 1000,
      maxConcurrent: 16,
      retention: { deleteWithParent: true, maxSessions: 0, ttlDays: 0 },
    });
  });

  it('越界 → clamp 到边界（下限）', () => {
    expect(resolveSubagentLimits({ max_depth: 0, max_steps: -3, max_concurrent: 0 })).toEqual({
      maxDepth: 1,
      maxSteps: 1,
      maxConcurrent: 1,
      retention: { deleteWithParent: true, maxSessions: 0, ttlDays: 0 },
    });
  });

  it('小数四舍五入', () => {
    expect(resolveSubagentLimits({ max_depth: 1.6 }).maxDepth).toBe(2);
  });

  it('非法类型 / 非对象 → 默认值', () => {
    expect(resolveSubagentLimits({ max_depth: 'x' })).toEqual({
      maxDepth: 1,
      maxSteps: 100,
      maxConcurrent: 4,
      retention: { deleteWithParent: true, maxSessions: 0, ttlDays: 0 },
    });
    expect(resolveSubagentLimits('not-object')).toEqual({
      maxDepth: 1,
      maxSteps: 100,
      maxConcurrent: 4,
      retention: { deleteWithParent: true, maxSessions: 0, ttlDays: 0 },
    });
  });
});

describe('resolveSubagentRetention（[subagent.retention] 留存策略）', () => {
  it('缺省 → delete_with_parent=true、max_sessions=0（不限）、ttl_days=0（不过期）', () => {
    expect(resolveSubagentLimits(undefined).retention).toEqual({
      deleteWithParent: true,
      maxSessions: 0,
      ttlDays: 0,
    });
    expect(resolveSubagentLimits({ retention: {} }).retention).toEqual({
      deleteWithParent: true,
      maxSessions: 0,
      ttlDays: 0,
    });
  });

  it('显式配置生效；delete_with_parent 仅显式 false 才关', () => {
    const r = resolveSubagentLimits({
      retention: { delete_with_parent: false, max_sessions: 20, ttl_days: 30 },
    }).retention;
    expect(r).toEqual({ deleteWithParent: false, maxSessions: 20, ttlDays: 30 });
    // 缺省 true，非 false 的值不改语义
    expect(resolveSubagentLimits({ retention: { delete_with_parent: 0 } }).retention.deleteWithParent).toBe(true);
  });

  it('负数 retention 值 clamp 到 0（关闭）', () => {
    const r = resolveSubagentLimits({ retention: { max_sessions: -5, ttl_days: -1 } }).retention;
    expect(r.maxSessions).toBe(0);
    expect(r.ttlDays).toBe(0);
  });
});

describe('resolveCompactionConfig', () => {
  it('缺省 → 默认值', () => {
    expect(resolveCompactionConfig(undefined)).toEqual({ triggerRatio: 0.85, reservedTokens: 32000 });
  });

  it('越界 → clamp（上限）', () => {
    expect(resolveCompactionConfig({ trigger_ratio: 2, reserved_tokens: 9_999_999 })).toEqual({
      triggerRatio: 0.99,
      reservedTokens: 500000,
    });
  });

  it('越界 → clamp（下限）', () => {
    expect(resolveCompactionConfig({ trigger_ratio: 0.1, reserved_tokens: -5 })).toEqual({
      triggerRatio: 0.5,
      reservedTokens: 0,
    });
  });

  it('非法类型 / 非对象 → 默认值', () => {
    expect(resolveCompactionConfig('x')).toEqual({ triggerRatio: 0.85, reservedTokens: 32000 });
    expect(resolveCompactionConfig({ trigger_ratio: 'a' })).toEqual({
      triggerRatio: 0.85,
      reservedTokens: 32000,
    });
  });

  it('配置 model → 进结果对象', () => {
    expect(resolveCompactionConfig({ model: 'step-flash' })).toEqual({
      triggerRatio: 0.85,
      reservedTokens: 32000,
      model: 'step-flash',
    });
  });

  it('未配置 model → 键不进结果对象', () => {
    const cfg = resolveCompactionConfig({ trigger_ratio: 0.9 });
    expect('model' in cfg).toBe(false);
    expect(cfg.model).toBeUndefined();
  });

  it('model 为空串 / 非字符串 → 视为未配置', () => {
    expect('model' in resolveCompactionConfig({ model: '' })).toBe(false);
    expect('model' in resolveCompactionConfig({ model: 123 })).toBe(false);
  });
});

describe('resolveStringArray（agents_paths / extra_skill_dirs）', () => {
  it('合法字符串数组 → 原样返回', () => {
    expect(resolveStringArray(['~/docs', 'a/b'])).toEqual(['~/docs', 'a/b']);
    expect(resolveStringArray(['/abs/one'])).toEqual(['/abs/one']);
  });

  it('未配置 / 非数组 / 空数组 → undefined', () => {
    expect(resolveStringArray(undefined)).toBeUndefined();
    expect(resolveStringArray('not-array')).toBeUndefined();
    expect(resolveStringArray([])).toBeUndefined();
  });

  it('含非法元素（非字符串 / 空串）→ undefined', () => {
    expect(resolveStringArray(['ok', 123])).toBeUndefined();
    expect(resolveStringArray(['ok', ''])).toBeUndefined();
    expect(resolveStringArray([null])).toBeUndefined();
  });
});

describe('resolveModels（[models.<别名>] 表）', () => {
  it('合法别名 → 已知字段进结果，未知字段忽略', () => {
    expect(
      resolveModels({
        fast: {
          model: 'step-3.7-flash',
          provider: 'stepfun',
          base_url: 'https://example.test',
          api_key: 'k-entry',
          max_context_size: 1_048_576,
          max_tokens: 32768,
          unknown_field: 'ignored',
        },
      }),
    ).toEqual({
      fast: {
        model: 'step-3.7-flash',
        provider: 'stepfun',
        baseUrl: 'https://example.test',
        apiKey: 'k-entry',
        maxContextSize: 1_048_576,
        maxTokens: 32768,
      },
    });
  });

  it('未配置 / 非对象 / 数组 → undefined', () => {
    expect(resolveModels(undefined)).toBeUndefined();
    expect(resolveModels('not-object')).toBeUndefined();
    expect(resolveModels(123)).toBeUndefined();
    expect(resolveModels(['x'])).toBeUndefined();
  });

  it('别名空串或别名值非对象 → 跳过该别名', () => {
    expect(resolveModels({ '': { model: 'x' }, bad: 'not-object', arr: [1] })).toBeUndefined();
    expect(resolveModels({ ok: {}, '': { model: 'x' } })).toEqual({ ok: {} });
  });

  it('字段类型非法 → 该字段不进 entry（空 entry 保留，别名即模型 id）', () => {
    expect(resolveModels({ a: { model: 123, max_tokens: 'x' } })).toEqual({ a: {} });
  });

  it('空字符串字段 → 视为未配置', () => {
    expect(resolveModels({ a: { model: '', provider: '' } })).toEqual({ a: {} });
  });

  it('全部无效 → undefined（键不进结果对象）', () => {
    expect(resolveModels({})).toBeUndefined();
    expect(resolveModels({ '': {} })).toBeUndefined();
  });
});

describe('resolveModelEntry（别名展开合并）', () => {
  function baseConfig(models?: StepCodeConfig['models']): StepCodeConfig {
    return {
      provider: 'stepfun',
      apiKey: 'k-implicit',
      baseUrl: 'https://api.stepfun.com',
      model: 'step-3.7-flash',
      maxContextSize: 262_144,
      maxTokens: 32768,
      subagent: resolveSubagentLimits(undefined),
      compaction: resolveCompactionConfig(undefined),
      ...(models !== undefined ? { models } : {}),
    };
  }

  it('未命中别名 / 无 models 表 → null', () => {
    expect(resolveModelEntry(baseConfig({ fast: {} }), 'nope')).toBeNull();
    expect(resolveModelEntry(baseConfig(), 'fast')).toBeNull();
  });

  it('entry 字段覆盖顶层，缺省字段继承顶层', () => {
    const cfg = baseConfig({
      big: { model: 'test-model-x', maxTokens: 65536, apiKey: 'k-entry' },
    });
    const merged = resolveModelEntry(cfg, 'big');
    expect(merged).not.toBeNull();
    expect(merged!.model).toBe('test-model-x');
    expect(merged!.maxTokens).toBe(65536);
    expect(merged!.apiKey).toBe('k-entry');
    // 缺省继承顶层
    expect(merged!.provider).toBe('stepfun');
    expect(merged!.baseUrl).toBe('https://api.stepfun.com');
    expect(merged!.maxContextSize).toBe(262_144);
  });

  it('model 缺省 = 别名本身', () => {
    const merged = resolveModelEntry(baseConfig({ 'step-3.5-flash': {} }), 'step-3.5-flash');
    expect(merged!.model).toBe('step-3.5-flash');
  });

  it('entry.provider 显式写内置预设名 → 无效别名，返回 null', () => {
    expect(
      resolveModelEntry(baseConfig({ claude: { provider: 'anthropic', model: 'test-model-y' } }), 'claude'),
    ).toBeNull();
    expect(
      resolveModelEntry(baseConfig({ fast: { provider: 'stepfun' } }), 'fast'),
    ).toBeNull();
  });

  it('provider 没变且没给 baseUrl → 继承顶层 baseUrl（不走预设）', () => {
    const cfg = baseConfig({ fast: {} });
    cfg.baseUrl = 'https://custom.example';
    const merged = resolveModelEntry(cfg, 'fast');
    expect(merged!.baseUrl).toBe('https://custom.example');
  });

  it('不改原对象', () => {
    const cfg = baseConfig({ big: { model: 'test-model-x', maxTokens: 65536 } });
    const before = JSON.parse(JSON.stringify(cfg));
    const merged = resolveModelEntry(cfg, 'big');
    expect(merged).not.toBe(cfg);
    expect(cfg).toEqual(before);
  });
});

describe('resolveModels（display_name / capabilities）', () => {
  it('display_name 与 capabilities 合法 → 原样透传', () => {
    expect(
      resolveModels({
        fast: { model: 'step-3.7-flash', display_name: 'Step 3.7 Flash', capabilities: ['thinking', 'image_in'] },
      }),
    ).toEqual({
      fast: { model: 'step-3.7-flash', displayName: 'Step 3.7 Flash', capabilities: ['thinking', 'image_in'] },
    });
  });

  it('capabilities 非数组 / 空数组 / 含非字符串元素 → 报错，不静默忽略', () => {
    // 旧行为是静默丢弃该字段，表现为「配了但不生效」且无任何提示，极难排查。
    expect(() => resolveModels({ a: { capabilities: 'thinking' } })).toThrow(/必须是非空字符串数组/);
    expect(() => resolveModels({ a: { capabilities: [] } })).toThrow(/必须是非空字符串数组/);
    expect(() => resolveModels({ a: { capabilities: ['thinking', 1] } })).toThrow(
      /必须是非空字符串数组/,
    );
    expect(() => resolveModels({ a: { capabilities: [''] } })).toThrow(/必须是非空字符串数组/);
  });

  it('capabilities 含未知能力名 → 报错并列出可用值（拼写错误不再静默失效）', () => {
    expect(() => resolveModels({ a: { capabilities: ['image-in'] } })).toThrow(
      /含未知能力名：image-in/,
    );
    expect(() => resolveModels({ a: { capabilities: ['image_in', 'vision'] } })).toThrow(
      /含未知能力名：vision/,
    );
  });

  it('capabilities 大小写与空白被归一', () => {
    expect(resolveModels({ a: { capabilities: ['  IMAGE_IN ', 'Thinking'] } })).toEqual({
      a: { capabilities: ['image_in', 'thinking'] },
    });
  });

  it('display_name 空串 → 视为未配置', () => {
    expect(resolveModels({ a: { display_name: '' } })).toEqual({ a: {} });
  });
});

describe('resolveProviders（渠道表解析）', () => {
  it('未配置 / 非对象 / 数组 → undefined', () => {
    expect(resolveProviders(undefined)).toBeUndefined();
    expect(resolveProviders('not-object')).toBeUndefined();
    expect(resolveProviders(123)).toBeUndefined();
    expect(resolveProviders(['x'])).toBeUndefined();
  });

  it('合法渠道：type + base_url/api_key 全字段解析', () => {
    expect(
      resolveProviders({
        gw: { type: 'anthropic', base_url: 'https://gw.example.com', api_key: 'k-gw', unknown_field: 'ignored' },
      }),
    ).toEqual({ gw: { type: 'anthropic', baseUrl: 'https://gw.example.com', apiKey: 'k-gw' } });
  });

  it('base_url/api_key 缺省 → 键不进 entry', () => {
    expect(resolveProviders({ gw: { type: 'stepfun' } })).toEqual({ gw: { type: 'stepfun' } });
  });

  it('type 缺失 / 空串 / 不在预设表 → 该渠道无效跳过', () => {
    expect(resolveProviders({ a: {}, b: { type: '' }, c: { type: 'not-a-real-protocol' } })).toBeUndefined();
    expect(resolveProviders({ bad: { type: 'not-a-real-protocol' }, ok: { type: 'stepfun' } })).toEqual({ ok: { type: 'stepfun' } });
  });

  it('id 空串或渠道值非对象 → 跳过该渠道', () => {
    expect(resolveProviders({ '': { type: 'stepfun' }, bad: 'not-object', arr: [1] })).toBeUndefined();
  });
});

describe('resolveModelEntry（自定义渠道合并）', () => {
  function channelConfig(
    providers: StepCodeConfig['providers'],
    models: StepCodeConfig['models'],
  ): StepCodeConfig {
    return {
      provider: 'stepfun',
      apiKey: 'k-implicit',
      baseUrl: 'https://api.stepfun.com',
      model: 'step-3.7-flash',
      maxContextSize: 262_144,
      maxTokens: 32768,
      subagent: resolveSubagentLimits(undefined),
      compaction: resolveCompactionConfig(undefined),
      ...(providers !== undefined ? { providers } : {}),
      ...(models !== undefined ? { models } : {}),
    };
  }

  it('entry.provider 命中自定义渠道 → provider = 渠道 type，baseUrl/apiKey 取自渠道', () => {
    const merged = resolveModelEntry(
      channelConfig(
        { gw: { type: 'anthropic', baseUrl: 'https://gw.example.com', apiKey: 'k-gw' } },
        { claude: { provider: 'gw', model: 'test-model-y' } },
      ),
      'claude',
    );
    expect(merged).not.toBeNull();
    expect(merged!.provider).toBe('anthropic');
    expect(merged!.baseUrl).toBe('https://gw.example.com');
    expect(merged!.apiKey).toBe('k-gw');
    expect(merged!.model).toBe('test-model-y');
  });

  it('渠道缺省字段回落 entry → 顶层', () => {
    const merged = resolveModelEntry(
      channelConfig(
        { gw: { type: 'anthropic' } },
        { claude: { provider: 'gw', apiKey: 'k-entry' } },
      ),
      'claude',
    );
    // apiKey：渠道缺省 → entry
    expect(merged!.apiKey).toBe('k-entry');
    // baseUrl：渠道与 entry 都缺省且 type 与顶层不同 → type 预设
    expect(merged!.baseUrl).toBe('https://api.anthropic.com');
    const merged2 = resolveModelEntry(
      channelConfig(
        { gw: { type: 'anthropic' } },
        { claude: { provider: 'gw' } },
      ),
      'claude',
    );
    // apiKey：渠道与 entry 都缺省 → 隐式渠道 key
    expect(merged2!.apiKey).toBe('k-implicit');
  });

  it('渠道 type 与顶层 provider 相同且未给 baseUrl → 继承顶层 baseUrl（不走预设）', () => {
    const cfg = channelConfig({ gw: { type: 'stepfun' } }, { fast: { provider: 'gw' } });
    cfg.baseUrl = 'https://custom.example';
    const merged = resolveModelEntry(cfg, 'fast');
    expect(merged!.provider).toBe('stepfun');
    expect(merged!.baseUrl).toBe('https://custom.example');
  });

  it('渠道 id 与内置预设同名 → 渠道优先（type 重定义）', () => {
    const merged = resolveModelEntry(
      channelConfig(
        { stepfun: { type: 'anthropic', baseUrl: 'https://gw.example.com' } },
        { claude: { provider: 'stepfun', model: 'test-model-y' } },
      ),
      'claude',
    );
    expect(merged!.provider).toBe('anthropic');
    expect(merged!.baseUrl).toBe('https://gw.example.com');
  });

  it('entry.provider 显式指内置预设名 → null（无效别名，不再走预设回落）', () => {
    expect(
      resolveModelEntry(
        channelConfig({ gw: { type: 'stepfun' } }, { claude: { provider: 'anthropic', model: 'test-model-y' } }),
        'claude',
      ),
    ).toBeNull();
  });

  it('entry.provider 既非渠道也非内置预设 → null（无效别名）', () => {
    expect(resolveModelEntry(channelConfig({ gw: { type: 'stepfun' } }, { bad: { provider: 'not-a-real-protocol' } }), 'bad')).toBeNull();
    // 无渠道表时，未知 provider 同样无效
    expect(resolveModelEntry(channelConfig(undefined, { bad: { provider: 'not-a-real-protocol' } }), 'bad')).toBeNull();
  });

  it('entry.provider 缺省 → 继承顶层 provider，不查渠道表', () => {
    const merged = resolveModelEntry(channelConfig({ gw: { type: 'anthropic' } }, { fast: {} }), 'fast');
    expect(merged!.provider).toBe('stepfun');
  });
});

describe('resolveModelEntry（跨渠道 key 回落校验）', () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    saved.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
    saved.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
    saved.STEP_CODE_API_KEY = process.env.STEP_CODE_API_KEY;
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  // channelConfig 把顶层写死成 stepfun（无惯例 env），测不出拒绝分支，这里显式构造 anthropic 顶层。
  const anthropicTop = (extra?: Partial<StepCodeConfig>): StepCodeConfig => ({
    provider: 'anthropic',
    apiKey: 'k-top',
    baseUrl: 'https://api.anthropic.com',
    model: 'claude-x',
    maxContextSize: 262_144,
    maxTokens: 32768,
    subagent: resolveSubagentLimits(undefined),
    compaction: resolveCompactionConfig(undefined),
    ...extra,
  });

  it('渠道缺 key 且回落目标 = 顶层惯例 env（绑死顶层 type）→ 跨 type 借用被拒绝', () => {
    // 顶层 anthropic，ANTHROPIC_API_KEY 就是 config.apiKey；渠道 openai 没配 key，
    // 回落会把 anthropic 的 key 发到 openai 端点 = 跨服务商泄露。
    process.env.ANTHROPIC_API_KEY = 'k-top';
    expect(() =>
      resolveModelEntry(
        anthropicTop({ providers: { gw: { type: 'openai' } }, models: { c: { provider: 'gw' } } }),
        'c',
      ),
    ).toThrow(/channelMismatch|跨/);
  });

  it('渠道缺 key 但回落目标是通用 STEP_CODE_API_KEY → 放行（不绑 type）', () => {
    // config.apiKey 来自通用 STEP_CODE_API_KEY，不等于 anthropic 惯例 env → 不绑 type，放行。
    process.env.STEP_CODE_API_KEY = 'k-generic';
    process.env.ANTHROPIC_API_KEY = 'k-other'; // 与 config.apiKey 不同，boundToTopType 为 false
    const merged = resolveModelEntry(
      anthropicTop({
        apiKey: 'k-generic',
        providers: { gw: { type: 'openai' } },
        models: { c: { provider: 'gw' } },
      }),
      'c',
    );
    expect(merged).not.toBeNull();
    expect(merged!.apiKey).toBe('k-generic');
  });

  it('渠道自己配了 key → 不触发回落校验', () => {
    process.env.ANTHROPIC_API_KEY = 'k-top';
    const merged = resolveModelEntry(
      anthropicTop({
        providers: { gw: { type: 'openai', apiKey: 'k-gw-own' } },
        models: { c: { provider: 'gw' } },
      }),
      'c',
    );
    expect(merged!.apiKey).toBe('k-gw-own');
  });

  it('渠道 type 与顶层相同时回落惯例 env → 不报错（同服务商）', () => {
    // 顶层 anthropic，渠道也是 anthropic，回落 ANTHROPIC_API_KEY 是同服务商，合法。
    process.env.ANTHROPIC_API_KEY = 'k-top';
    const merged = resolveModelEntry(
      anthropicTop({ providers: { gw: { type: 'anthropic' } }, models: { c: { provider: 'gw' } } }),
      'c',
    );
    expect(merged).not.toBeNull();
    expect(merged!.apiKey).toBe('k-top');
  });
});

describe('conventionalApiKeyEnvVar（惯例环境变量映射）', () => {
  it('已知 type → 对应惯例变量名', () => {
    expect(conventionalApiKeyEnvVar('anthropic')).toBe('ANTHROPIC_API_KEY');
    expect(conventionalApiKeyEnvVar('openai')).toBe('OPENAI_API_KEY');
    expect(conventionalApiKeyEnvVar('openai_responses')).toBe('OPENAI_API_KEY');
  });

  it('stepfun（无惯例变量）/ 未知 type / 空串 → undefined', () => {
    expect(conventionalApiKeyEnvVar('stepfun')).toBeUndefined();
    expect(conventionalApiKeyEnvVar('not-a-real-protocol')).toBeUndefined();
    expect(conventionalApiKeyEnvVar('')).toBeUndefined();
  });
});

describe('api_key_env 解析（resolveModels / resolveProviders）', () => {
  it('[models] 条目解析 api_key_env，空串视为未配置', () => {
    expect(resolveModels({ a: { api_key_env: 'ENTRY_ENV_KEY' } })).toEqual({ a: { apiKeyEnv: 'ENTRY_ENV_KEY' } });
    expect(resolveModels({ a: { api_key_env: '' } })).toEqual({ a: {} });
  });

  it('[providers] 渠道解析 api_key_env，空串视为未配置', () => {
    expect(resolveProviders({ gw: { type: 'anthropic', api_key_env: 'GW_ENV_KEY' } })).toEqual({
      gw: { type: 'anthropic', apiKeyEnv: 'GW_ENV_KEY' },
    });
    expect(resolveProviders({ gw: { type: 'anthropic', api_key_env: '' } })).toEqual({ gw: { type: 'anthropic' } });
  });
});

describe('resolveModelEntry（apiKey 多渠道回落链）', () => {
  function chainConfig(
    providers?: StepCodeConfig['providers'],
    models?: StepCodeConfig['models'],
  ): StepCodeConfig {
    return {
      provider: 'stepfun',
      apiKey: 'k-implicit',
      baseUrl: 'https://api.stepfun.com',
      model: 'step-3.7-flash',
      maxContextSize: 262_144,
      maxTokens: 32768,
      subagent: resolveSubagentLimits(undefined),
      compaction: resolveCompactionConfig(undefined),
      ...(providers !== undefined ? { providers } : {}),
      ...(models !== undefined ? { models } : {}),
    };
  }

  // 渠道分支完整优先级：channel.apiKey > 渠道 api_key_env > 渠道 type 惯例 env > entry.apiKey > entry api_key_env > 隐式渠道 key
  it('渠道分支：channel.apiKey 优先于一切', () => {
    process.env['ANTHROPIC_API_KEY'] = 'k-env-anthropic';
    process.env['GW_ENV_KEY'] = 'k-gw-env';
    process.env['ENTRY_ENV_KEY'] = 'k-entry-env';
    const merged = resolveModelEntry(
      chainConfig(
        { gw: { type: 'anthropic', apiKey: 'k-gw', apiKeyEnv: 'GW_ENV_KEY' } },
        { c: { provider: 'gw', apiKey: 'k-entry', apiKeyEnv: 'ENTRY_ENV_KEY' } },
      ),
      'c',
    );
    expect(merged!.apiKey).toBe('k-gw');
  });

  it('渠道分支：渠道无 apiKey → 渠道 api_key_env 指向的 env 胜出', () => {
    process.env['ANTHROPIC_API_KEY'] = 'k-env-anthropic';
    process.env['GW_ENV_KEY'] = 'k-gw-env';
    const merged = resolveModelEntry(
      chainConfig(
        { gw: { type: 'anthropic', apiKeyEnv: 'GW_ENV_KEY' } },
        { c: { provider: 'gw', apiKey: 'k-entry' } },
      ),
      'c',
    );
    expect(merged!.apiKey).toBe('k-gw-env');
  });

  it('渠道分支：渠道两项都缺 → 渠道 type 的惯例 env', () => {
    process.env['ANTHROPIC_API_KEY'] = 'k-env-anthropic';
    const merged = resolveModelEntry(
      chainConfig({ gw: { type: 'anthropic' } }, { c: { provider: 'gw', apiKey: 'k-entry' } }),
      'c',
    );
    expect(merged!.apiKey).toBe('k-env-anthropic');
  });

  it('渠道分支：惯例 env 也没有 → entry.apiKey > entry api_key_env > 隐式渠道 key', () => {
    process.env['ENTRY_ENV_KEY'] = 'k-entry-env';
    const withEntryKey = resolveModelEntry(
      chainConfig(
        { gw: { type: 'anthropic' } },
        { c: { provider: 'gw', apiKey: 'k-entry', apiKeyEnv: 'ENTRY_ENV_KEY' } },
      ),
      'c',
    );
    expect(withEntryKey!.apiKey).toBe('k-entry');
    const withEntryEnv = resolveModelEntry(
      chainConfig({ gw: { type: 'anthropic' } }, { c: { provider: 'gw', apiKeyEnv: 'ENTRY_ENV_KEY' } }),
      'c',
    );
    expect(withEntryEnv!.apiKey).toBe('k-entry-env');
    const implicitOnly = resolveModelEntry(
      chainConfig({ gw: { type: 'anthropic' } }, { c: { provider: 'gw' } }),
      'c',
    );
    expect(implicitOnly!.apiKey).toBe('k-implicit');
  });

  it('渠道分支：渠道 api_key_env 指向的变量为空串 → 视为未设置，继续回落', () => {
    process.env['GW_ENV_KEY'] = '';
    process.env['ANTHROPIC_API_KEY'] = 'k-env-anthropic';
    const merged = resolveModelEntry(
      chainConfig({ gw: { type: 'anthropic', apiKeyEnv: 'GW_ENV_KEY' } }, { c: { provider: 'gw' } }),
      'c',
    );
    expect(merged!.apiKey).toBe('k-env-anthropic');
  });

  // 继承分支：entry.apiKey > entry api_key_env > 顶层 provider 惯例 env > 隐式渠道 key
  it('继承分支：entry.apiKey 优先于 entry api_key_env 与惯例 env', () => {
    process.env['ANTHROPIC_API_KEY'] = 'k-env-anthropic';
    process.env['ENTRY_ENV_KEY'] = 'k-entry-env';
    const cfg = chainConfig(undefined, { c: { apiKey: 'k-entry', apiKeyEnv: 'ENTRY_ENV_KEY' } });
    cfg.provider = 'anthropic';
    const merged = resolveModelEntry(cfg, 'c');
    expect(merged!.apiKey).toBe('k-entry');
  });

  it('继承分支：entry 无 apiKey → entry api_key_env 指向的 env', () => {
    process.env['ANTHROPIC_API_KEY'] = 'k-env-anthropic';
    process.env['ENTRY_ENV_KEY'] = 'k-entry-env';
    const cfg = chainConfig(undefined, { c: { apiKeyEnv: 'ENTRY_ENV_KEY' } });
    cfg.provider = 'anthropic';
    const merged = resolveModelEntry(cfg, 'c');
    expect(merged!.apiKey).toBe('k-entry-env');
  });

  it('继承分支：entry 两项都缺 → 顶层 provider 的惯例 env', () => {
    process.env['ANTHROPIC_API_KEY'] = 'k-env-anthropic';
    const cfg = chainConfig(undefined, { c: {} });
    cfg.provider = 'anthropic';
    const merged = resolveModelEntry(cfg, 'c');
    expect(merged!.apiKey).toBe('k-env-anthropic');
  });

  it('继承分支：顶层 provider 为 stepfun（无惯例 env）→ 回落隐式渠道 apiKey', () => {
    const merged = resolveModelEntry(chainConfig(undefined, { c: {} }), 'c');
    expect(merged!.apiKey).toBe('k-implicit');
  });

  it('继承分支：各级都缺 → apiKey 为 undefined（不抛错，由 provider 工厂兜底）', () => {
    const cfg = chainConfig(undefined, { c: {} });
    cfg.apiKey = undefined;
    const merged = resolveModelEntry(cfg, 'c');
    expect(merged).not.toBeNull();
    expect(merged!.apiKey).toBeUndefined();
  });

  it('渠道与顶层都没有任何 key → apiKey 为 undefined（不抛错，由 provider 工厂兜底）', () => {
    const cfg = chainConfig({ gw: { type: 'anthropic' } }, { c: { provider: 'gw' } });
    cfg.apiKey = undefined;
    const merged = resolveModelEntry(cfg, 'c');
    expect(merged).not.toBeNull();
    expect(merged!.apiKey).toBeUndefined();
  });
});

describe('resolveTuiConfig', () => {
  it('缺省时返回 undefined（键不进结果对象）', () => {
    expect(resolveTuiConfig(undefined)).toBeUndefined();
    expect(resolveTuiConfig('not-object')).toBeUndefined();
    expect(resolveTuiConfig([])).toBeUndefined();
    expect(resolveTuiConfig({})).toBeUndefined(); // 空对象无字段
  });

  it('默认值 4，clamp [1, 20]', () => {
    expect(resolveTuiConfig({ error_preview_lines: 1 })).toEqual({ errorPreviewLines: 1 });
    expect(resolveTuiConfig({ error_preview_lines: 20 })).toEqual({ errorPreviewLines: 20 });
    expect(resolveTuiConfig({ error_preview_lines: 0 })).toEqual({ errorPreviewLines: 1 });
    expect(resolveTuiConfig({ error_preview_lines: 100 })).toEqual({ errorPreviewLines: 20 });
    expect(resolveTuiConfig({ error_preview_lines: 3.7 })).toEqual({ errorPreviewLines: 4 });
  });

  it('非法值（非数字）视为缺失，返回 undefined', () => {
    expect(resolveTuiConfig({ error_preview_lines: 'abc' })).toBeUndefined();
  });

  it('terminal_title 布尔值独立解析', () => {
    expect(resolveTuiConfig({ terminal_title: false })).toEqual({ terminalTitle: false });
    expect(resolveTuiConfig({ terminal_title: true })).toEqual({ terminalTitle: true });
  });

  it('两个字段可同时配置、互不影响（回归：旧实现只配 terminal_title 时整段被吞）', () => {
    expect(resolveTuiConfig({ error_preview_lines: 8, terminal_title: false })).toEqual({
      errorPreviewLines: 8,
      terminalTitle: false,
    });
  });

  it('terminal_title 非布尔值忽略（不污染结果对象）', () => {
    expect(resolveTuiConfig({ terminal_title: 'yes' })).toBeUndefined();
  });
});
