import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bashTool } from '../../src/tools/bash.js';

/**
 * bash 输出上限的**端到端**接线验证（真起进程、真写盘）。
 *
 * 收集器本身的判定逻辑在 `bashOutput.test.ts` 里用纯逻辑覆盖（快）；这里只守
 * 「装配是否接对」——预算是否真按流分开、溢出文件是否真落盘、展示截断是否真保尾。
 * 这几条只有跑真命令才能证伪，所以慢，但每条都不可替代。
 *
 * 三层上限彼此独立，别混：
 * - 展示上限 MAX_OUTPUT(30k 字符)：内容还在内存，只是不全给模型看 → 中间截断保头尾；
 * - stdout 内存预算(9MB) / stderr 内存预算(1MB)：超出的部分离开内存 → 溢出落盘；
 * - 两者可同时发生。
 */

/** 产出约 N MB stdout 的跨平台命令（测试环境必然有 node）。 */
function bigOutputCmd(mb: number): string {
  return `node -e "const c='x'.repeat(1024*1024);for(let i=0;i<${String(mb)};i++)process.stdout.write(c);"`;
}

let cwd: string;

beforeEach(() => {
  // 用临时目录当 cwd：溢出文件落在 <cwd>/.step-code/tool-output/，不能污染项目仓库
  cwd = mkdtempSync(join(tmpdir(), 'sc-bashcap-'));
});
afterEach(() => {
  rmSync(cwd, { recursive: true, force: true });
});

function overflowFiles(root: string): string[] {
  const dir = join(root, '.step-code', 'tool-output');
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((n) => n.startsWith('bash-') && n.endsWith('.log'));
}

describe('bash 输出收集上限', () => {
  it('超过内存收集上限时落盘，并给出可执行的取用路径', async () => {
    // 12MB > stdout 预算(9MB)，超出部分离开内存但要能从文件恢复
    const r = await bashTool.execute({ command: bigOutputCmd(12), timeout: 120 }, { cwd });

    expect(r.isError ?? false).toBe(false);
    expect(r.content).toContain('输出已截断'); // 展示层
    expect(r.content).toContain('完整输出已存到'); // 收集层：不是「不可恢复」
    expect(r.content).toContain('read_file'); // 必须给下一步

    // 文件真的存在，且体积接近命令的真实产出（≈12MB），不是内存里那 9MB
    const files = overflowFiles(cwd);
    expect(files.length).toBe(1);
    const bytes = statSync(join(cwd, '.step-code', 'tool-output', files[0]!)).size;
    expect(bytes).toBeGreaterThan(11 * 1024 * 1024);
  }, 180000);

  it('stdout 刷爆预算后，命令失败时的 stderr 错误信息仍然可见（回归）', async () => {
    // 这条是整组改动的存在理由：
    // 旧实现两条流共用一个上限、且展示截断只保头，于是「大量 stdout + 尾部报错」
    // 这个极常见形状会让错误信息经历两次丢失（先被挤出内存，再被展示截断切掉）。
    const cmd =
      `node -e "const c='x'.repeat(1024*1024);for(let i=0;i<10;i++)process.stdout.write(c);` +
      `console.error('BOOM-MARKER-42');process.exit(3);"`;
    const r = await bashTool.execute({ command: cmd, timeout: 120 }, { cwd });

    expect(r.isError).toBe(true);
    expect(r.content).toContain('[退出码：3]');
    // 核心断言：错误标记必须活着到达模型
    expect(r.content).toContain('BOOM-MARKER-42');
  }, 180000);

  it('展示截断保留尾部（失败命令的报错几乎总在末尾）', async () => {
    // 1MB 远超展示上限(30k)但未超收集预算(9MB)：只应发生展示截断，不应落盘
    const cmd =
      `node -e "process.stdout.write('HEAD-MARK');const c='y'.repeat(1024*1024);` +
      `process.stdout.write(c);process.stdout.write('TAIL-MARK');"`;
    const r = await bashTool.execute({ command: cmd, timeout: 60 }, { cwd });

    expect(r.content).toContain('输出已截断');
    expect(r.content).toContain('HEAD-MARK'); // 头
    expect(r.content).toContain('TAIL-MARK'); // 尾——旧的 slice(0, N) 实现看不到这个
    expect(r.content).not.toContain('完整输出已存到'); // 没触顶收集上限
    expect(overflowFiles(cwd)).toEqual([]); // 不该产生溢出文件
  }, 60000);

  it('输出未触顶时既不提截断也不落盘（不污染正常结果）', async () => {
    const r = await bashTool.execute({ command: 'echo hello-small' }, { cwd });
    expect(r.content).toContain('hello-small');
    expect(r.content).not.toContain('输出已截断');
    expect(r.content).not.toContain('完整输出已存到');
    expect(overflowFiles(cwd)).toEqual([]);
  });
});
