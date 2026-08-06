import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// loadConfig 读 ~/.step-code/config.toml：把 homedir 指到临时目录（对齐 tests/permissionMode.test.ts），
// 避免开发机上的真实配置污染断言。
let fakeHome = '';
vi.mock('node:os', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:os')>();
  return { ...orig, homedir: () => fakeHome };
});

import { loadConfig, resolveProxy } from '../src/config/config.js';
import { runDoctorConfig } from '../src/config/doctor.js';

let dir: string;

function writeHomeConfig(content: string): void {
  const cfgDir = join(dir, '.step-code');
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, 'config.toml'), content, 'utf8');
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'proxy-test-'));
  fakeHome = dir;
});

afterEach(() => {
  fakeHome = '';
  rmSync(dir, { recursive: true, force: true });
});

describe('resolveProxy', () => {
  it('未配置 → undefined（键不进结果对象，语义直连）', async () => {
    expect(resolveProxy(undefined)).toBeUndefined();
    expect(resolveProxy('')).toBeUndefined();
    expect(resolveProxy('   ')).toBeUndefined();
  });

  it('合法 http/https 代理 URL 原样返回（trim）', async () => {
    expect(resolveProxy('http://127.0.0.1:7892')).toBe('http://127.0.0.1:7892');
    expect(resolveProxy('  https://proxy.example.com:8443  ')).toBe('https://proxy.example.com:8443');
  });

  it('非法值抛配置错误（doctor 复用抛错路径 exit 1）', async () => {
    expect(() => resolveProxy('127.0.0.1:7892')).toThrow(/proxy/);
    expect(() => resolveProxy('socks5://127.0.0.1:1080')).toThrow(/proxy/);
    expect(() => resolveProxy(7892)).toThrow(/proxy/);
    expect(() => resolveProxy(true)).toThrow(/proxy/);
  });
});

describe('loadConfig proxy 接线', () => {
  it('配置 proxy 进入结果对象', async () => {
    writeHomeConfig('proxy = "http://127.0.0.1:7892"\n');
    const cfg = loadConfig(dir);
    expect(cfg.proxy).toBe('http://127.0.0.1:7892');
  });

  it('未配置 proxy 时键不进结果对象', async () => {
    writeHomeConfig('language = "zh"\n');
    const cfg = loadConfig(dir);
    expect('proxy' in cfg).toBe(false);
  });

  it('非法 proxy 值 loadConfig 抛错', async () => {
    writeHomeConfig('proxy = "7892"\n');
    expect(() => loadConfig(dir)).toThrow(/proxy/);
  });
});

describe('doctor proxy 校验', () => {
  it('合法 proxy 配置 doctor 通过', async () => {
    writeHomeConfig('proxy = "http://127.0.0.1:7892"\n');
    const r = await runDoctorConfig(join(dir, '.step-code', 'config.toml'));
    expect(r.code).toBe(0);
  });

  it('非法 proxy 配置 doctor exit 1', async () => {
    writeHomeConfig('proxy = "socks5://127.0.0.1:1080"\n');
    const r = await runDoctorConfig(join(dir, '.step-code', 'config.toml'));
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('proxy');
  });
});
