/**
 * TUI 首帧冒烟测试：真实 spawn `dist/main.js`，在 PTY 般的管道上验证它**确实往 stdout 写了字节**。
 *
 * ## 为什么必须有这一条，而单元测试全绿也挡不住
 *
 * 2026-08-03 的空白屏事故里，react 与 react-reconciler 因 `NODE_ENV` 分流不一致而加载了
 * 两套构建，reconciler 调度静默失效——ink 的 `render()` 正常返回、根组件函数从未被调用、
 * 终端零字节输出、无任何异常抛出。当时 159 个测试文件 / 2068 个用例全绿，headless `-p`
 * 模式也完全正常，因为这两条路径都不经过「Node 进程从 bin 入口加载 react + ink 并真的画一帧」
 * 这个完整链路：单元测试用 ink-testing-library 直接渲染组件（进程内、已加载好的 react），
 * `-p` 根本不碰 ink。
 *
 * 结论是这类故障只能从**进程外**观测：判据不是「组件树对不对」，而是「进程有没有产出字节」。
 *
 * ## 为什么断言写成「stdout 非空」而不是断言画面内容
 *
 * 画面内容依赖终端宽度、配置、会话状态、模型可用性，脆且噪声大。而故障态的特征极干净——
 * 零字节。所以只守这条底线：**只要 ink 挂载成功并 commit 了首帧，就必然有 ANSI 输出**。
 *
 * ## 环境依赖与跳过条件
 *
 * 需要 `dist/main.js` 已构建（`npm run build`）。未构建时跳过而非失败——否则在只跑单测的
 * 场景（CI 的 test job 早于 build job、开发者本地改完 src 直接跑 vitest）会红成噪声。
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const entry = join(repoRoot, 'dist', 'main.js');

/**
 * 启动 TUI，等到 stdout 首次产出字节即返回（或超时），随后杀进程。
 *
 * 用「轮询到首字节」而非「固定等待 N 秒」：通过路径下一拿到字节就结束（约 1.5 秒），
 * 不为了给失败路径留余量而在成功路径上白等。
 *
 * 不传 `NODE_ENV`：正是要验证「不显式设置时」引导层把它兜到 production、且 react 与
 * reconciler 落在同一套构建。传了反而绕过被测逻辑。
 */
async function waitFirstFrameBytes(timeoutMs: number): Promise<{ bytes: number; ms: number; stderr: string }> {
  const env = { ...process.env };
  delete env['NODE_ENV'];
  // vitest 会注入这两个，留着会让被测进程以为自己在测试环境里
  delete env['VITEST'];
  delete env['VITEST_WORKER_ID'];

  const t0 = Date.now();
  const child = spawn(process.execPath, [entry], {
    cwd: repoRoot,
    env,
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  let bytes = 0;
  let ms = -1;
  let stderr = '';
  const firstByte = new Promise<void>((resolve) => {
    child.stdout.on('data', (c: Buffer) => {
      bytes += c.length;
      if (ms < 0) {
        ms = Date.now() - t0;
        resolve();
      }
    });
  });
  child.stderr.on('data', (c: Buffer) => {
    stderr += c.toString();
  });

  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  // 首字节、进程自己退出（启动就崩）、超时，三者取先到
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, timeoutMs);
  });
  await Promise.race([firstByte, exited, deadline]);
  if (timer !== undefined) clearTimeout(timer);

  child.kill('SIGKILL');
  await exited;
  return { bytes, ms, stderr };
}

describe('TUI 首帧冒烟（进程级）', () => {
  it.skipIf(!existsSync(entry))(
    'ink 挂载后 stdout 必须有输出（零字节 = reconciler 调度静默失效）',
    async () => {
      // 20 秒不是随手取的：实测空闲机器首字节 1.5s，16 路并发 spawn 时升到 4.9s（max）。
      // 全量套件跑到这里时 CPU 上还压着 2000+ 个 ink 渲染用例，比纯并发 spawn 更重，
      // 6 秒预算实测会假阳性。与 vitest.config.ts 把 testTimeout 提到 20s 是同一判断：
      // 假阳性会训练人忽略红灯，代价高于多等几秒；真正的零输出故障一样会超时，只是晚报。
      const { bytes, ms, stderr } = await waitFirstFrameBytes(20_000);
      expect(
        bytes,
        `dist/main.js 启动 20s 内 stdout 零字节——ink 未画出首帧。\n` +
          `最典型的成因是 react 与 react-reconciler 的构建分流不一致（见 src/main.ts 的引导注释与 tests/env.test.ts）。\n` +
          `子进程 stderr：\n${stderr.slice(0, 2000)}`,
      ).toBeGreaterThan(0);
      // 首字节耗时仅作诊断输出，不设上限断言——它受机器负载影响，断言会变成另一个假阳性来源
      expect(ms).toBeGreaterThan(0);
    },
    40_000,
  );
});
