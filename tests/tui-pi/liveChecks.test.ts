/**
 * 五项待复核功能的**进程级**实测（第三组遗留项）。
 *
 * 为什么必须进程级：这五项都属「链路接线」类，进程内单测覆盖不到——
 * 单测能证明 `HookEngine.run('SessionStart')` 自身工作，但证明不了 PiChat 真的去调它、
 * 也证明不了配置真的被读进来。前面已经栽过一次：SessionStart 的 hook 执行点整块缺失，
 * 而 2400 多个单测全绿。
 *
 * 每个用例把 HOME/USERPROFILE 指到临时目录，写一份最小 config.toml，spawn 真进程，
 * 从 stdout 的渲染帧里断言可观测证据。不连真实模型（无 API key 时进程走首帧后停在输入框，
 * 这足以验证启动期链路）。
 *
 * dist/ 未构建时跳过，避免只跑单测时红成噪声。
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const entry = join(repoRoot, 'dist', 'main.js');
const built = existsSync(entry);

let home = '';
let work = '';

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'pi-home-'));
  work = mkdtempSync(join(tmpdir(), 'pi-work-'));
  mkdirSync(join(home, '.step-code'), { recursive: true });
});

afterEach(async () => {
  // Windows 下 SIGKILL 后子进程仍会短暂持有 cwd 句柄，立刻 rmSync 会 EPERM。
  // 清理失败不该盖掉真实断言结果——临时目录留给 OS 回收即可。
  await new Promise((r) => setTimeout(r, 300));
  for (const d of [home, work]) {
    try {
      rmSync(d, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    } catch {
      // 忽略：只是临时目录没删掉
    }
  }
});

function writeConfig(toml: string): void {
  writeFileSync(join(home, '.step-code', 'config.toml'), toml, 'utf8');
}

/**
 * 起一个真进程，收集 stdout 直到出现 stopWhen 命中的内容或超时，然后 SIGKILL。
 * 返回去掉 ANSI 的纯文本，便于断言。
 */
async function runProcess(
  opts: { stdin?: string; timeoutMs?: number; stopWhen?: RegExp; args?: string[] } = {},
): Promise<{ text: string; raw: string; exited: boolean }> {
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  delete env['NODE_ENV'];
  delete env['VITEST'];
  delete env['VITEST_WORKER_ID'];
  env['HOME'] = home;
  env['USERPROFILE'] = home;
  // 变量名必须是 STEP_CODE_API_KEY。2026-08-16 这里曾写成 STEPFUN_API_KEY（渠道名 stepfun
  // 的想当然拼法），provider 根本不认，于是每个用例的进程都停在首次运行向导：SessionStart
  // 的 hook 执行点没走到（被误判成「功能缺失」），而 /memory 与 /compact-model 却「通过」了
  // ——它们的 stopWhen 命中的是向导文案里的字样，属假绿。故下面加了 assertPastFirstRun。
  env['STEP_CODE_API_KEY'] = 'sk-test-not-a-real-key';

  const child = spawn(process.execPath, [entry, ...(opts.args ?? [])], {
    cwd: work,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let raw = '';
  let exited = false;
  const stop = opts.stopWhen;
  const done = new Promise<void>((resolve) => {
    const finish = (): void => resolve();
    child.stdout.on('data', (c: Buffer) => {
      raw += c.toString();
      if (stop !== undefined && stop.test(raw.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ''))) finish();
    });
    child.on('exit', () => {
      exited = true;
      finish();
    });
    setTimeout(finish, opts.timeoutMs ?? 6000);
  });

  if (opts.stdin !== undefined) {
    // 等首帧画完再喂输入，否则按键可能早于 TUI 接管
    await new Promise((r) => setTimeout(r, 1200));
    child.stdin.write(opts.stdin);
  }
  await done;
  child.kill('SIGKILL');
  return { text: raw.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, ''), raw, exited };
}

/**
 * 假绿守卫：确认进程真的越过了首次运行向导、进了主界面。
 *
 * 停在向导时屏幕上仍有大量文案（标题、渠道列表、文档链接），stopWhen 与内容断言都可能
 * 偶然命中，于是「功能可用」的结论建立在一个根本没走到那段代码的进程上。每个用例断言
 * 业务内容之前先过这道门。
 */
function assertPastFirstRun(text: string): void {
  expect(text, '进程停在首次运行向导，本用例的其余断言全部无效（检查 STEP_CODE_API_KEY 是否生效）').not.toMatch(
    /未检测到 API key|No API key detected/,
  );
}

describe.skipIf(!built)('五项待复核（进程级实测）', () => {
  it('① SessionStart hook 真的被执行：命令跑起来且 stdout 被收走', async () => {
    // hook 往临时文件写一行，进程起来后该文件存在 = hook 确实执行过。
    // 这比断言屏幕内容可靠：stdout 注入的是 system 尾部，界面上看不见。
    const marker = join(work, 'hook-ran.txt');
    const cmd = `node -e "require('fs').writeFileSync(${JSON.stringify(marker).replace(/"/g, "'")}, 'ran')" && echo INJECTED_CONTEXT_MARKER`;
    writeConfig(`
model = "step-3"

[[hooks]]
event = "SessionStart"
command = ${JSON.stringify(cmd)}
timeout = 20
`);
    const r1 = await runProcess({ timeoutMs: 7000, stopWhen: /›/ });
    assertPastFirstRun(r1.text);
    // 给 hook 的异步 then 一点时间（PiChat 里是 void engine.run(...).then(...)）
    await new Promise((r) => setTimeout(r, 800));
    expect(existsSync(marker), 'SessionStart hook 未被执行（标记文件不存在）').toBe(true);
  }, 20000);

  it('① 反证：不配 hook 时不会凭空产生标记（确认上一条不是自证）', async () => {
    const marker = join(work, 'hook-ran.txt');
    writeConfig('model = "step-3"\n');
    const r2 = await runProcess({ timeoutMs: 6000, stopWhen: /›/ });
    assertPastFirstRun(r2.text);
    await new Promise((r) => setTimeout(r, 500));
    expect(existsSync(marker)).toBe(false);
  }, 20000);

  it('② /memory 命令有真实响应（不是「未接线」占位）', async () => {
    writeConfig('model = "step-3"\n');
    const { text } = await runProcess({
      stdin: '/memory\r',
      timeoutMs: 8000,
      stopWhen: /记忆|memory|观察池/i,
    });
    assertPastFirstRun(text);
    // 关键是它不能回「pi 版尚未接线」这类占位
    expect(text, '/memory 报未接线').not.toMatch(/尚未接线|not wired/i);
    expect(text, '/memory 无任何响应').toMatch(/记忆|观察|memory/i);
  }, 20000);

  it('③ /compact-model 命令存在且能显示当前绑定', async () => {
    writeConfig('model = "step-3"\n');
    const { text } = await runProcess({
      stdin: '/compact-model\r',
      timeoutMs: 8000,
      stopWhen: /压缩模型|compact.*model/i,
    });
    assertPastFirstRun(text);
    expect(text, '/compact-model 报未知命令').not.toMatch(/未知命令|unknown command/i);
    expect(text).toMatch(/压缩模型|compact/i);
  }, 20000);

  /**
   * ②③ 的对照组：不存在的命令不应触发那两条断言的匹配词。
   *
   * ②③ 各自只用了「屏幕上出现某类词」做证据，这种断言的风险是词太宽——若「记忆」「压缩」
   * 本来就出现在首帧或帮助文案里，命令根本没接线也会绿。2026-08-16 手工反证过一次（纯首帧
   * 与错误命令都不含这两类词），这里把那次反证固化下来，日后有人放宽断言词会在这里炸。
   */
  it('②③ 对照组：不存在的命令不会触发记忆/压缩类断言词（证明上两条不是词太宽而绿）', async () => {
    writeConfig('model = "step-3"\n');
    const { text } = await runProcess({ stdin: '/zzznotacommand\r', timeoutMs: 6000 });
    assertPastFirstRun(text);
    expect(text, '错误命令下也出现「记忆」类词，说明 ② 的断言词太宽').not.toMatch(/记忆|观察池/);
    expect(text, '错误命令下也出现「压缩模型」，说明 ③ 的断言词太宽').not.toMatch(/压缩模型/);
  }, 20000);
});
