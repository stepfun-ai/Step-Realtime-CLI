/**
 * 交互前端的首帧冒烟测试（进程级）：真实 spawn `dist/main.js`，只守「stdout 有字节」
 * 这条底线。
 *
 * 为什么需要它：Ink 时代的空白屏故障根源（react 与 reconciler 的 NODE_ENV 分流）在
 * pi-tui 下确实不存在了（无 React），但「进程内单测全绿、真进程零输出」这个故障模式与
 * 框架无关——它测的是「从 bin 入口加载整条链路并真的画一帧」，任何一环（动态 import
 * 失败、ProcessTerminal 在非 TTY 下抛错、构造顺序问题）断掉都会是零字节。
 *
 * 两条参数形态都测：M5 删掉 Ink 后 pi-tui 成为唯一交互前端，**默认路径（无参数）才是
 * 真实入口**；`--pi` 退化为 no-op，仍测它是防有人把这个残留开关接回一条已废弃的分支。
 *
 * 依赖 dist/ 已构建，未构建则跳过（避免只跑单测时红成噪声）。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const entry = join(repoRoot, 'dist', 'main.js');

async function waitFirstFrameBytes(timeoutMs: number, args: string[] = []): Promise<{ bytes: number; ms: number; stderr: string; out: string }> {
  const env = { ...process.env };
  delete env['NODE_ENV'];
  delete env['VITEST'];
  delete env['VITEST_WORKER_ID'];

  const t0 = Date.now();
  const child = spawn(process.execPath, [entry, ...args], {
    cwd: repoRoot,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let bytes = 0;
  let ms = -1;
  let stderr = '';
  let out = '';
  const firstByte = new Promise<void>((resolve) => {
    child.stdout.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      out += chunk.toString();
      if (ms < 0) {
        ms = Date.now() - t0;
        resolve();
      }
    });
  });
  child.stderr.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });

  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  await Promise.race([firstByte, exited, deadline]);
  if (timer !== undefined) clearTimeout(timer);
  // 首字节往往只是终端初始化序列（bracketed paste 等），渲染帧稍后到。
  // 再多收一小段，才能断言「真的画了一帧」而不只是「进程动了」。
  await Promise.race([new Promise((r) => setTimeout(r, 1200)), exited]);

  child.kill('SIGKILL');
  await exited;
  return { bytes, ms, stderr, out };
}

describe.each([{ args: [] as string[], label: '默认（无参数）' }, { args: ['--pi'], label: '--pi（no-op 残留开关）' }])(
  'pi-tui 首帧冒烟（进程级）— $label',
  ({ args }) => {
  it.skipIf(!existsSync(entry))(
    'PiChat 挂载后 stdout 必须有输出',
    // 进程级冒烟在全量并行下会与其他 spawn 竞争 CPU，偶发超时。功能真坏时三次都会失败，
    // retry 不掩盖回归。
    { timeout: 40_000, retry: 2 },
    async () => {
      const { bytes, stderr, out } = await waitFirstFrameBytes(20_000, args);
      if (stderr.includes('缺少 API key')) return;
      expect(
        bytes,
        `dist/main.js ${args.join(' ')} 启动 20s 内 stdout 零字节——pi-tui 未画出首帧。\n子进程 stderr：\n${stderr.slice(0, 2000)}`,
      ).toBeGreaterThan(0);
      // 首帧至少要包含同步输出的包裹序列（CSI 2026），证明写出的确实是 pi-tui 的渲染帧
      expect(out).toContain('\x1b[?2026');
    },
  );
  },
);
