import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { HookConfigEntry } from '../../src/config/config.js';
import { HookEngine } from '../../src/agent/hooks/engine.js';

/**
 * hook 命令用 node 小脚本写临时文件的方式做（避免 bash 依赖）。
 * 临时目录无 package.json，.js 按 CJS 解释（可用 require）。
 */
let dir = '';

function writeScript(name: string, body: string): string {
  const p = join(dir, name);
  writeFileSync(p, body, 'utf8');
  return p;
}

/** 组装 hook 命令：node 解释器与脚本/参数全部加引号（Windows shell:true 下走 cmd.exe）。 */
function cmd(script: string, ...args: string[]): string {
  return [`"${process.execPath}"`, `"${script}"`, ...args.map((a) => `"${a}"`)].join(' ');
}

function hook(partial: Partial<HookConfigEntry> & Pick<HookConfigEntry, 'event' | 'command'>): HookConfigEntry {
  return { timeout: 30, ...partial };
}

function makeEngine(hooks: HookConfigEntry[]): { engine: HookEngine; notices: string[] } {
  const notices: string[] = [];
  const engine = new HookEngine(hooks, {
    sessionId: 'sess-1',
    cwd: dir,
    onNotice: (m) => notices.push(m),
  });
  return { engine, notices };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stepcode-hook-engine-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('HookEngine 执行语义', () => {
  it('exit 0 放行：stdout 收进结果（上下文注入的来源）', async () => {
    const script = writeScript('ok.js', `process.stdout.write('CTX-123'); process.exit(0);`);
    const { engine } = makeEngine([hook({ event: 'SessionStart', command: cmd(script) })]);
    const r = await engine.run('SessionStart', {});
    expect(r.blocked).toBe(false);
    expect(r.stdout).toBe('CTX-123');
  });

  it('exit 2 阻断：stderr 为 reason', async () => {
    const script = writeScript('block.js', `process.stderr.write('denied-by-hook'); process.exit(2);`);
    const { engine, notices } = makeEngine([hook({ event: 'PreToolUse', command: cmd(script) })]);
    const r = await engine.run('PreToolUse', { tool_name: 'bash' }, 'bash');
    expect(r.blocked).toBe(true);
    expect(r.reason).toBe('denied-by-hook');
    expect(notices.some((n) => n.includes('阻断') && n.includes('denied-by-hook'))).toBe(true);
  });

  it('exit 2 空 stderr：reason 落兜底文案', async () => {
    const script = writeScript('block-empty.js', `process.exit(2);`);
    const { engine } = makeEngine([hook({ event: 'Stop', command: cmd(script) })]);
    const r = await engine.run('Stop', {});
    expect(r.blocked).toBe(true);
    expect(r.reason).toBeTruthy();
  });

  it('其余非零 exit：fail-open 放行，stderr 摘要进 notice', async () => {
    const script = writeScript('fail.js', `process.stderr.write('boom'); process.exit(1);`);
    const { engine, notices } = makeEngine([hook({ event: 'PreToolUse', command: cmd(script) })]);
    const r = await engine.run('PreToolUse', { tool_name: 'bash' }, 'bash');
    expect(r.blocked).toBe(false);
    expect(notices.some((n) => n.includes('boom') || n.includes('exit 1'))).toBe(true);
  });

  it('命令不存在（spawn 失败）：fail-open 放行并进 notice', async () => {
    const { engine, notices } = makeEngine([
      hook({ event: 'Stop', command: 'definitely-not-a-real-command-xyz-123' }),
    ]);
    const r = await engine.run('Stop', {});
    expect(r.blocked).toBe(false);
    expect(notices.length).toBeGreaterThan(0);
  });

  it('超时杀进程树：fail-open + 超时 notice，且不傻等脚本自然结束', async () => {
    const script = writeScript('sleep.js', `setTimeout(() => {}, 30000);`);
    const { engine, notices } = makeEngine([
      hook({ event: 'Stop', command: cmd(script), timeout: 1 }),
    ]);
    const started = Date.now();
    const r = await engine.run('Stop', {});
    const elapsed = Date.now() - started;
    expect(r.blocked).toBe(false);
    expect(elapsed).toBeLessThan(10_000);
    expect(notices.some((n) => n.includes('超时'))).toBe(true);
  }, 20_000);

  it('stdin JSON 字段形状：snake_case 基础字段 + 事件字段', async () => {
    const out = join(dir, 'stdin.json');
    const script = writeScript(
      'dump.js',
      `const fs = require('node:fs');
let d = '';
process.stdin.on('data', (c) => (d += c));
process.stdin.on('end', () => { fs.writeFileSync(process.argv[2], d); process.exit(0); });`,
    );
    const { engine } = makeEngine([hook({ event: 'PreToolUse', command: cmd(script, out) })]);
    await engine.run('PreToolUse', { tool_name: 'bash', tool_input: { command: 'ls -la' } }, 'bash');
    const payload = JSON.parse(readFileSync(out, 'utf8')) as Record<string, unknown>;
    expect(payload['hook_event_name']).toBe('PreToolUse');
    expect(payload['session_id']).toBe('sess-1');
    expect(payload['cwd']).toBe(dir);
    expect(payload['tool_name']).toBe('bash');
    expect(payload['tool_input']).toEqual({ command: 'ls -la' });
  });

  it('同事件多条 hook 并行执行：两条都真实运行', async () => {
    const m1 = join(dir, 'm1.txt');
    const m2 = join(dir, 'm2.txt');
    const script = writeScript(
      'marker.js',
      `require('node:fs').writeFileSync(process.argv[2], 'ran'); process.exit(0);`,
    );
    const { engine } = makeEngine([
      hook({ event: 'SessionStart', command: cmd(script, m1) }),
      hook({ event: 'SessionStart', command: cmd(script, m2) }),
    ]);
    const r = await engine.run('SessionStart', {});
    expect(r.blocked).toBe(false);
    expect(existsSync(m1)).toBe(true);
    expect(existsSync(m2)).toBe(true);
  });

  it('matcher 过滤：不匹配工具名时 hook 不执行；无标识事件上带 matcher 的 hook 不触发', async () => {
    const m1 = join(dir, 'hit.txt');
    const m2 = join(dir, 'skip.txt');
    const script = writeScript(
      'marker2.js',
      `require('node:fs').writeFileSync(process.argv[2], 'ran'); process.exit(0);`,
    );
    const { engine } = makeEngine([
      hook({ event: 'PreToolUse', command: cmd(script, m1), matcher: /^bash$/ }),
      hook({ event: 'Stop', command: cmd(script, m2), matcher: /bash/ }),
    ]);
    // matcher 命中工具名 → 执行
    await engine.run('PreToolUse', { tool_name: 'bash' }, 'bash');
    expect(existsSync(m1)).toBe(true);
    // matcher 不命中 → 不执行
    rmSync(m1);
    await engine.run('PreToolUse', { tool_name: 'write_file' }, 'write_file');
    expect(existsSync(m1)).toBe(false);
    // 无标识事件（Stop 不传 subject）：带 matcher 的 hook 不触发
    await engine.run('Stop', {});
    expect(existsSync(m2)).toBe(false);
  });
});

describe('HookEngine plugin 条目（cwd/env）', () => {
  it('条目携带 cwd/env：cwd 固定工作目录、env 注入环境变量（plugin hook 语义）', async () => {
    // 脚本用相对路径引用：只有 cwd 生效才找得到；stdout 回显注入的环境变量
    writeScript('envprobe.js', `process.stdout.write(process.env.STEP_CODE_PLUGIN_ROOT ?? ''); process.exit(0);`);
    const engine = new HookEngine(
      [
        {
          event: 'SessionStart',
          command: `"${process.execPath}" envprobe.js`,
          timeout: 30,
          cwd: dir,
          env: { STEP_CODE_PLUGIN_ROOT: dir },
        },
      ],
      { sessionId: 'sess-1', cwd: join(dir, 'nonexistent-cwd') },
    );
    const r = await engine.run('SessionStart', {});
    expect(r.blocked).toBe(false);
    // 相对脚本被找到（cwd 生效）且 stdout 回显了注入变量（env 生效）
    expect(r.stdout).toBe(dir);
  });
});
