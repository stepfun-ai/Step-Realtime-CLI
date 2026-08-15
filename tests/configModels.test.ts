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
  dir = mkdtempSync(join(tmpdir(), 'stepcode-models-'));
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

describe('loadConfig [models.<别名>] 集成', () => {
  it('顶层 model 写别名 → 展开为真实 id，entry 字段覆盖顶层', () => {
    process.env['STEP_CODE_API_KEY'] = 'k-top';
    writeToml(
      [
        'model = "big"',
        'max_tokens = 32768',
        '',
        '[models.big]',
        'model = "test-model-x"',
        'api_key = "k-entry"',
        'max_context_size = 1048576',
        'max_tokens = 65536',
        '',
      ].join('\n'),
    );
    const cfg = loadConfig(dir);
    expect(cfg.model).toBe('test-model-x');
    expect(cfg.apiKey).toBe('k-entry');
    expect(cfg.maxContextSize).toBe(1_048_576);
    expect(cfg.maxTokens).toBe(65536);
    // 别名表本身保留在配置里（供 /model 运行时切换查询）
    expect(cfg.models?.['big']?.model).toBe('test-model-x');
  });

  it('别名缺省 model 字段 → 真实 id = 别名本身', () => {
    process.env['STEP_CODE_API_KEY'] = 'k';
    writeToml(['model = "step-3.5-flash"', '', '[models.step-3.5-flash]', ''].join('\n'));
    const cfg = loadConfig(dir);
    expect(cfg.model).toBe('step-3.5-flash');
  });

  it('--model 别名（overrides）同样展开', () => {
    process.env['STEP_CODE_API_KEY'] = 'k';
    writeToml(
      ['', '[models.fast]', 'model = "step-3.7-flash"', 'max_tokens = 8192', ''].join('\n'),
    );
    const cfg = loadConfig(dir, { model: 'fast' });
    expect(cfg.model).toBe('step-3.7-flash');
    expect(cfg.maxTokens).toBe(8192);
  });

  it('model 未命中别名 → 原样保留，不受影响', () => {
    process.env['STEP_CODE_API_KEY'] = 'k';
    writeToml(['model = "plain-model"', '', '[models.fast]', 'model = "test-model-x"', ''].join('\n'));
    const cfg = loadConfig(dir);
    expect(cfg.model).toBe('plain-model');
  });

  it('[models] 全部无效 → models 键不进结果对象', () => {
    process.env['STEP_CODE_API_KEY'] = 'k';
    writeToml(['', '[models]', ''].join('\n'));
    const cfg = loadConfig(dir);
    expect('models' in cfg).toBe(false);
  });

  it('capabilities 接受 "-" 前缀取负（-image_in），孤立 "-" 与未知名仍报错', () => {
    process.env['STEP_CODE_API_KEY'] = 'k';
    writeToml(
      [
        'model = "vl"',
        '',
        '[models.vl]',
        'model = "m1"',
        'capabilities = ["thinking", "-image_in"]',
      ].join('\n'),
    );
    expect(loadConfig(dir).capabilities).toEqual(['thinking', '-image_in']);

    writeToml(['[models.vl]', 'model = "m1"', 'capabilities = ["-"]'].join('\n'));
    expect(() => loadConfig(dir)).toThrow('未知能力名');
  });

  it('别名声明 capabilities → 命中别名时带入结果；未命中别名时不带', () => {
    process.env['STEP_CODE_API_KEY'] = 'k';
    writeToml(
      [
        'model = "vl"',
        '',
        '[models.vl]',
        'model = "test-model-vl"',
        'capabilities = ["thinking", "image_in"]',
        '',
      ].join('\n'),
    );
    const cfg = loadConfig(dir);
    expect(cfg.model).toBe('test-model-vl');
    expect(cfg.capabilities).toEqual(['thinking', 'image_in']);
    // 裸模型（未命中别名）不带 capabilities
    const bare = loadConfig(dir, { model: 'plain-model' });
    expect(bare.capabilities).toBeUndefined();
  });
});

describe('loadConfig [models] 的 api_key_env（密钥间接引用）', () => {
  it('别名条目配 api_key_env → 展开后 apiKey 取自该环境变量', () => {
    process.env['ENTRY_ENV_KEY'] = 'k-entry-from-env';
    writeToml(
      [
        'model = "big"',
        '',
        '[models.big]',
        'model = "test-model-x"',
        'api_key_env = "ENTRY_ENV_KEY"',
        '',
      ].join('\n'),
    );
    const cfg = loadConfig(dir);
    expect(cfg.apiKey).toBe('k-entry-from-env');
    // api_key_env 本身经 TOML 解析进别名表
    expect(cfg.models?.['big']?.apiKeyEnv).toBe('ENTRY_ENV_KEY');
  });

  it('别名同时配 api_key 与 api_key_env → api_key 优先', () => {
    process.env['ENTRY_ENV_KEY'] = 'k-entry-from-env';
    writeToml(
      [
        'model = "big"',
        '',
        '[models.big]',
        'model = "test-model-x"',
        'api_key = "k-entry"',
        'api_key_env = "ENTRY_ENV_KEY"',
        '',
      ].join('\n'),
    );
    expect(loadConfig(dir).apiKey).toBe('k-entry');
  });

  it('别名只有 api_key_env 且 env 未设 → 回落惯例 env / 隐式渠道 key（此处落到隐式渠道 key）', () => {
    process.env['STEP_CODE_API_KEY'] = 'k-top';
    writeToml(
      [
        'model = "big"',
        '',
        '[models.big]',
        'model = "test-model-x"',
        'api_key_env = "ENTRY_ENV_KEY"',
        '',
      ].join('\n'),
    );
    expect(loadConfig(dir).apiKey).toBe('k-top');
  });
});
