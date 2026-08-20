/**
 * loadConfig 的启动自检行为：语法错误 fail-fast、逃生舱、诊断回调。
 *
 * 修的是一条「静默失效」路径：旧实现把 TOML 语法错误吞成 {}，整份配置消失、CLI 照常
 * 启动，随后报出的错（api key 缺失、陌生端点 404）与真实病因之间没有任何可见链条。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 同 config.test.ts：把 homedir 指到临时目录，避免读真实配置。
let fakeHome = '';
vi.mock('node:os', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:os')>();
  return { ...orig, homedir: () => fakeHome };
});

import {
  IGNORE_BAD_CONFIG_ENV,
  loadConfig,
  type ConfigLoadDiagnostics,
} from '../../src/config/config.js';

const BAD_TOML = 'model = "k3"\nthis is not toml ===\n';

let dir: string;
let savedEnv: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stepcode-diag-'));
  fakeHome = dir;
  savedEnv = process.env[IGNORE_BAD_CONFIG_ENV];
  delete process.env[IGNORE_BAD_CONFIG_ENV];
});

afterEach(() => {
  fakeHome = '';
  if (savedEnv === undefined) delete process.env[IGNORE_BAD_CONFIG_ENV];
  else process.env[IGNORE_BAD_CONFIG_ENV] = savedEnv;
  rmSync(dir, { recursive: true, force: true });
});

function writeConfig(content: string): void {
  const dirPath = join(dir, '.step-code');
  mkdirSync(dirPath, { recursive: true });
  writeFileSync(join(dirPath, 'config.toml'), content, 'utf8');
}

describe('loadConfig 启动自检', () => {
  it('语法错误默认抛错，报错指向文件并给逃生舱指引', () => {
    writeConfig(BAD_TOML);
    expect(() => loadConfig(dir)).toThrow(/配置文件解析失败/);
    expect(() => loadConfig(dir)).toThrow(new RegExp(IGNORE_BAD_CONFIG_ENV));
    // 报错里含文件路径，用户能定位到哪份文件坏了
    let message = '';
    try {
      loadConfig(dir);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain('config.toml');
  });

  it('配置文件不存在：正常零配置，不抛错', () => {
    expect(() => loadConfig(dir)).not.toThrow();
  });

  it(`逃生舱 ${IGNORE_BAD_CONFIG_ENV}=1：语法错误降级为忽略，诊断回调带出 ignoredBadFile`, () => {
    writeConfig(BAD_TOML);
    process.env[IGNORE_BAD_CONFIG_ENV] = '1';
    let diag: ConfigLoadDiagnostics | undefined;
    const config = loadConfig(dir, {}, (d) => {
      diag = d;
    });
    expect(diag?.ignoredBadFile).toBeDefined();
    expect(diag?.ignoredBadFile?.path).toContain('config.toml');
    // 被逃生舱放行时，整份配置未生效：跑的是内置默认而非坏文件内容
    expect(config.provider).toBeDefined();
  });

  it('诊断回调把原始 TOML 表交出来（供 collectConfigWarnings 检查）', () => {
    writeConfig('model = "k3"\nlangauge = "en"\n');
    let diag: ConfigLoadDiagnostics | undefined;
    loadConfig(dir, {}, (d) => {
      diag = d;
    });
    expect(diag?.rawToml['langauge']).toBe('en');
    expect(diag?.ignoredBadFile).toBeUndefined();
  });

  it('不传诊断回调：行为不变（既有调用点零感知）', () => {
    writeConfig('model = "k3"\n');
    expect(() => loadConfig(dir)).not.toThrow();
  });
});
