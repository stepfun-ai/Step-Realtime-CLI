import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// loadConfig 读 ~/.step-code/config.toml：把 homedir 指到临时目录（对齐 tests/config.test.ts 的做法），
// 避免开发机上的真实配置污染断言。
//
// 容器用 vi.hoisted 而不是裸 `let`：mock 工厂会被 vitest 提升到文件顶部执行，若工厂闭包
// 引用普通 let，而被测模块在 **import 阶段** 就调用了 homedir()（logger 在模块顶层算日志
// 目录即如此），变量还没初始化，会抛 ReferenceError: Cannot access before initialization。
const home = vi.hoisted(() => ({ path: '' }));
vi.mock('node:os', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:os')>();
  return { ...orig, homedir: () => home.path };
});

import { loadConfig, resolvePermissionMode, type StepCodeConfig } from '../src/config/config.js';
import { runDoctorConfig } from '../src/config/doctor.js';
import { resolveStartupMode } from '../src/agent/permission/mode.js';
import { diffConfig } from '../src/chat/reload.js';

const ENV_KEYS = ['STEPFUN_API_KEY', 'STEP_CODE_API_KEY', 'STEP_CODE_PROVIDER', 'STEP_CODE_BASE_URL', 'STEP_CODE_MODEL'];
let saved: Record<string, string | undefined>;
let dir: string;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  dir = mkdtempSync(join(tmpdir(), 'stepcode-permmode-'));
  home.path = dir;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  home.path = '';
  rmSync(dir, { recursive: true, force: true });
});

function writeToml(content: string): string {
  const p = join(dir, 'cfg.toml');
  writeFileSync(p, content, 'utf8');
  return p;
}

/** 写 loadConfig 实际读取的 临时 home 下的 .step-code/config.toml。 */
function writeHomeConfig(content: string): void {
  const cfgDir = join(dir, '.step-code');
  mkdirSync(cfgDir, { recursive: true });
  writeFileSync(join(cfgDir, 'config.toml'), content, 'utf8');
}

describe('resolvePermissionMode', () => {
  it('三个合法值原样返回', async () => {
    expect(resolvePermissionMode('manual')).toBe('manual');
    expect(resolvePermissionMode('auto')).toBe('auto');
    expect(resolvePermissionMode('yolo')).toBe('yolo');
  });

  it('未配置 → undefined（键不进结果对象，缺省 manual 由消费方落）', async () => {
    expect(resolvePermissionMode(undefined)).toBeUndefined();
  });

  it('非法值抛配置错误（安全相关配置，不静默吞）', async () => {
    expect(() => resolvePermissionMode('yes')).toThrow(/permission_mode/);
    expect(() => resolvePermissionMode('MANUAL')).toThrow(/manual \| auto \| yolo/);
    expect(() => resolvePermissionMode(true)).toThrow(/permission_mode/);
    expect(() => resolvePermissionMode(1)).toThrow(/permission_mode/);
  });
});

describe('loadConfig permission_mode 接线', () => {
  it('未配置 → permissionMode 键不进结果对象（与现状行为一致）', async () => {
    writeHomeConfig('provider = "stepfun"\n');
    const cfg = loadConfig(dir);
    expect(cfg.permissionMode).toBeUndefined();
    expect('permissionMode' in cfg).toBe(false);
  });

  it('合法值进结果对象', async () => {
    writeHomeConfig('permission_mode = "yolo"\n');
    expect(loadConfig(dir).permissionMode).toBe('yolo');
  });

  it('非法值 → loadConfig 抛配置错误', async () => {
    writeHomeConfig('permission_mode = "yes"\n');
    expect(() => loadConfig(dir)).toThrow(/permission_mode/);
  });
});

describe('resolveStartupMode 优先级链（flag > config > session > manual）', () => {
  it('全缺省 → manual（config 未设置时与历史行为一致）', async () => {
    expect(resolveStartupMode({})).toBe('manual');
  });

  it('只有 config → config 生效', async () => {
    expect(resolveStartupMode({ config: 'auto' })).toBe('auto');
  });

  it('只有 session（恢复会话）→ session 生效', async () => {
    expect(resolveStartupMode({ session: 'yolo' })).toBe('yolo');
  });

  it('config 压过 session（常驻表态压过会话历史值）', async () => {
    expect(resolveStartupMode({ config: 'manual', session: 'yolo' })).toBe('manual');
  });

  it('flag 永远赢（一次性意图压过常驻偏好与会话历史）', async () => {
    expect(resolveStartupMode({ flag: 'yolo', config: 'manual', session: 'auto' })).toBe('yolo');
    expect(resolveStartupMode({ flag: 'auto', config: 'yolo' })).toBe('auto');
    expect(resolveStartupMode({ flag: 'auto', session: 'yolo' })).toBe('auto');
  });
});

describe('doctor permission_mode 校验', () => {
  it('合法 permission_mode → code 0 且无 warn', async () => {
    const p = writeToml('permission_mode = "auto"\n');
    const res = await runDoctorConfig(p);
    expect(res.code).toBe(0);
    expect(res.stdout).not.toContain('warn:');
  });

  it('非法 permission_mode → code 1（复用 loadConfig 抛错路径）', async () => {
    const p = writeToml('permission_mode = "yes"\n');
    const res = await runDoctorConfig(p);
    expect(res.code).toBe(1);
    expect(res.stderr).toContain('permission_mode');
  });

  it('permission_mode 是已知顶层键，不再触发未知键 warn', async () => {
    const p = writeToml('permission_mode = "manual"\n');
    const res = await runDoctorConfig(p);
    expect(res.code).toBe(0);
    expect(res.stdout).not.toContain('未知顶层键');
  });
});

/** 构造一个最小合法配置（对齐 tests/tui/reload.test.ts 的 makeCfg）。 */
function makeCfg(overrides: Partial<StepCodeConfig> = {}): StepCodeConfig {
  return {
    provider: 'stepfun',
    apiKey: 'k-top',
    baseUrl: 'https://api.stepfun.com',
    model: 'step-3.7-flash',
    maxContextSize: 262_144,
    maxTokens: 65_536,
    subagent: { maxDepth: 1, maxSteps: 100, maxConcurrent: 4 },
    compaction: { triggerRatio: 0.85, reservedTokens: 32_000 },
    thinking: { enabled: false, levels: { low: 1024, medium: 4096, high: 32_000 } },
    ...overrides,
  };
}

describe('reload diff 的 permission_mode 归类', () => {
  it('permission_mode 变更进 diff 且标 restart（一次性固化：只在启动/新会话读取）', async () => {
    const changes = diffConfig(makeCfg(), makeCfg({ permissionMode: 'auto' }));
    expect(changes).toEqual([
      { kind: 'added', path: 'permission_mode', oldText: undefined, newText: 'auto', restart: true },
    ]);
  });

  it('permission_mode 移除也标 restart', async () => {
    const changes = diffConfig(makeCfg({ permissionMode: 'yolo' }), makeCfg());
    expect(changes).toEqual([
      { kind: 'removed', path: 'permission_mode', oldText: 'yolo', newText: undefined, restart: true },
    ]);
  });
});
