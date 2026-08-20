import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// loadConfig 读 ~/.step-code/config.toml：把 homedir 指到临时目录，避免碰真实配置。
let fakeHome = '';
vi.mock('node:os', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:os')>();
  return { ...orig, homedir: () => fakeHome };
});

import { loadConfig } from '../src/config/config.js';

const ENV_KEYS = [
  'STEPFUN_API_KEY',
  'STEP_CODE_API_KEY',
  'STEP_CODE_PROVIDER',
  'STEP_CODE_BASE_URL',
  'STEP_CODE_MODEL',
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GW_ENV_KEY',
];
let saved: Record<string, string | undefined>;
let dir: string;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  dir = mkdtempSync(join(tmpdir(), 'stepcode-providers-'));
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

function writeToml(text: string): void {
  const cfgDir = join(dir, '.step-code');
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, 'config.toml'), text, 'utf8');
}

describe('loadConfig [providers.<id>] 集成', () => {
  it('别名引用自定义渠道 → 展开走渠道合并（provider=渠道 type，端点/密钥取自渠道）', () => {
    writeToml(
      [
        'model = "fast"',
        '',
        '[providers.gw]',
        'type = "anthropic"',
        'base_url = "https://gw.example.com"',
        'api_key = "k-gw"',
        '',
        '[models.fast]',
        'provider = "gw"',
        'model = "test-model-y"',
        '',
      ].join('\n'),
    );
    const cfg = loadConfig(dir);
    expect(cfg.provider).toBe('anthropic');
    expect(cfg.baseUrl).toBe('https://gw.example.com');
    expect(cfg.apiKey).toBe('k-gw');
    expect(cfg.model).toBe('test-model-y');
    // 渠道表本身保留在配置里（供 /model 运行时切换查询）
    expect(cfg.providers?.['gw']?.type).toBe('anthropic');
  });

  it('渠道缺省 base_url/api_key → 回落 entry → 隐式渠道 key/预设', () => {
    process.env['STEP_CODE_API_KEY'] = 'k-top';
    writeToml(
      [
        'model = "fast"',
        '',
        '[providers.gw]',
        'type = "stepfun"',
        '',
        '[models.fast]',
        'provider = "gw"',
        'model = "test-model-x"',
        'api_key = "k-entry"',
        '',
      ].join('\n'),
    );
    const cfg = loadConfig(dir);
    // type 与顶层 provider 相同且渠道/entry 未给 base_url → 回落预设（顶层未显式配 base_url 时即预设值）
    expect(cfg.provider).toBe('stepfun');
    expect(cfg.baseUrl).toBe('https://api.stepfun.com');
    expect(cfg.apiKey).toBe('k-entry');
  });

  it('渠道 id 与内置预设同名 → 渠道优先，type 重定义生效', () => {
    writeToml(
      [
        'model = "claude"',
        '',
        '[providers.stepfun]',
        'type = "anthropic"',
        'base_url = "https://gw.example.com"',
        '',
        '[models.claude]',
        'provider = "stepfun"',
        'model = "test-model-y"',
        '',
      ].join('\n'),
    );
    const cfg = loadConfig(dir);
    expect(cfg.provider).toBe('anthropic');
    expect(cfg.baseUrl).toBe('https://gw.example.com');
  });

  it('别名显式指内置预设名 → 无效别名不展开，顶层 model 原样保留', () => {
    writeToml(
      [
        'model = "claude"',
        '',
        '[models.claude]',
        'provider = "anthropic"',
        'model = "test-model-y"',
        '',
      ].join('\n'),
    );
    const cfg = loadConfig(dir);
    // 无效别名不展开：model 保留别名本身，其余顶层字段不动
    expect(cfg.model).toBe('claude');
    expect(cfg.provider).toBe('stepfun');
    expect('providers' in cfg).toBe(false);
  });

  it('渠道 type 非法 → 渠道无效；引用它的别名展开失败，顶层 model 原样保留', () => {
    writeToml(
      [
        'model = "fast"',
        '',
        '[providers.bad]',
        'type = "not-a-real-protocol"',
        '',
        '[models.fast]',
        'provider = "bad"',
        'model = "test-model-x"',
        '',
      ].join('\n'),
    );
    const cfg = loadConfig(dir);
    // 全部渠道无效 → providers 键不进结果对象
    expect('providers' in cfg).toBe(false);
    // 无效别名不展开：model 保留别名本身，其余顶层字段不动
    expect(cfg.model).toBe('fast');
    expect(cfg.provider).toBe('stepfun');
  });

  it('未配置 [providers] → providers 键不进结果对象（旧配置零迁移）', () => {
    process.env['STEP_CODE_API_KEY'] = 'k';
    writeToml(['model = "step-3.7-flash"', ''].join('\n'));
    const cfg = loadConfig(dir);
    expect('providers' in cfg).toBe(false);
    expect(cfg.model).toBe('step-3.7-flash');
  });

  it('models 条目的 display_name / capabilities 经 TOML 解析透传', () => {
    process.env['STEP_CODE_API_KEY'] = 'k';
    writeToml(
      [
        '',
        '[models.fast]',
        'model = "step-3.7-flash"',
        'display_name = "Step 3.7 Flash"',
        'capabilities = ["thinking", "image_in"]',
        '',
      ].join('\n'),
    );
    const cfg = loadConfig(dir);
    expect(cfg.models?.['fast']?.displayName).toBe('Step 3.7 Flash');
    expect(cfg.models?.['fast']?.capabilities).toEqual(['thinking', 'image_in']);
  });
});

describe('loadConfig 多渠道密钥（无顶层 key 场景）', () => {
  it('顶层无任何 key 但别名指向的渠道有 key → 不 throw，展开后 apiKey = 渠道 key', () => {
    writeToml(
      [
        'model = "claude"',
        '',
        '[providers.gw]',
        'type = "anthropic"',
        'base_url = "https://gw.example.com"',
        'api_key = "k-gw"',
        '',
        '[models.claude]',
        'provider = "gw"',
        'model = "test-model-y"',
        '',
      ].join('\n'),
    );
    const cfg = loadConfig(dir);
    expect(cfg.provider).toBe('anthropic');
    expect(cfg.apiKey).toBe('k-gw');
    expect(cfg.model).toBe('test-model-y');
  });

  it('渠道只配 api_key_env → 展开后 apiKey 取自该环境变量（密钥不落盘）', () => {
    process.env['GW_ENV_KEY'] = 'k-gw-from-env';
    writeToml(
      [
        'model = "claude"',
        '',
        '[providers.gw]',
        'type = "anthropic"',
        'api_key_env = "GW_ENV_KEY"',
        '',
        '[models.claude]',
        'provider = "gw"',
        '',
      ].join('\n'),
    );
    const cfg = loadConfig(dir);
    expect(cfg.apiKey).toBe('k-gw-from-env');
    // api_key_env 本身也经 TOML 解析进渠道表
    expect(cfg.providers?.['gw']?.apiKeyEnv).toBe('GW_ENV_KEY');
  });

  it('渠道无任何 key 配置 → 回落渠道 type 的惯例环境变量', () => {
    process.env['ANTHROPIC_API_KEY'] = 'k-env-anthropic';
    writeToml(
      [
        'model = "claude"',
        '',
        '[providers.gw]',
        'type = "anthropic"',
        '',
        '[models.claude]',
        'provider = "gw"',
        '',
      ].join('\n'),
    );
    const cfg = loadConfig(dir);
    expect(cfg.apiKey).toBe('k-env-anthropic');
  });

  it('什么 key 都没有 → 不 throw，apiKey 为 undefined（缺失由 provider 工厂兜底）', () => {
    writeToml(['model = "step-3.7-flash"', ''].join('\n'));
    const cfg = loadConfig(dir);
    expect(cfg.apiKey).toBeUndefined();
    expect(cfg.model).toBe('step-3.7-flash');
  });

  it('STEP_CODE_API_KEY 仍是隐式渠道 key 的最高优先来源（渠道有自己的 key 时渠道胜出）', () => {
    process.env['STEP_CODE_API_KEY'] = 'k-top-env';
    process.env['STEPFUN_API_KEY'] = 'k-legacy';
    writeToml(
      [
        'model = "claude"',
        '',
        '[providers.gw]',
        'type = "anthropic"',
        'api_key = "k-gw"',
        '',
        '[models.claude]',
        'provider = "gw"',
        '',
      ].join('\n'),
    );
    const cfg = loadConfig(dir);
    // 展开命中渠道：渠道 apiKey 优先于隐式渠道 key（隐式渠道 key 只是最后回落）
    expect(cfg.apiKey).toBe('k-gw');
  });

  it('model 未命中别名时隐式渠道只认 STEP_CODE_API_KEY', () => {
    process.env['STEP_CODE_API_KEY'] = 'k-top-env';
    process.env['STEPFUN_API_KEY'] = 'k-legacy';
    writeToml(['model = "plain-model"', ''].join('\n'));
    expect(loadConfig(dir).apiKey).toBe('k-top-env');
  });

  it('顶层无 key 且 model 不命中别名 → STEPFUN_API_KEY 不再识别（旧变量名被忽略）', () => {
    process.env['STEPFUN_API_KEY'] = 'k-legacy';
    writeToml(['model = "step-3.7-flash"', ''].join('\n'));
    const cfg = loadConfig(dir);
    expect(cfg.provider).toBe('stepfun');
    expect(cfg.apiKey).toBeUndefined();
  });

  it('config.toml 顶层 api_key 已不再生效（忽略，不抛错）', () => {
    writeToml(['api_key = "k-toml"', 'model = "plain-model"', ''].join('\n'));
    const cfg = loadConfig(dir);
    expect(cfg.apiKey).toBeUndefined();
    expect(cfg.model).toBe('plain-model');
  });

  it('零配置（无 [providers]/无 [models]）+ 仅环境变量 → 正常拿到 key', () => {
    process.env['STEP_CODE_API_KEY'] = 'k-zero-config';
    const cfg = loadConfig(dir);
    expect(cfg.apiKey).toBe('k-zero-config');
    expect(cfg.provider).toBe('stepfun');
    expect(cfg.model).toBe('step-3.7-flash');
  });
});
