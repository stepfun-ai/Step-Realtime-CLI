import { describe, expect, it } from 'vitest';
import { bashTool } from '../../src/tools/bash.js';

/**
 * bash 输出**收集上限**触顶后的如实报告。
 *
 * 原实现：`if (out.length < MAX_COLLECT) out += chunk`，触顶后所有后续输出
 * 被静默丢弃，没有任何记录。危害有两层：
 *
 * 1. 输出尾部无声消失，调用方不知道自己看到的是残缺内容；
 * 2. 更隐蔽——随后的「输出已截断，共 N 字符」里的 N 是**已收集长度**，触顶后
 *    不再增长。50MB 的输出会被报成 10MB，让调用方以为只丢了一点点。
 *
 * 收集阶段丢掉的内容无法事后找回（进程已退出），所以提示必须给出替代路径：
 * 重定向到文件后分页读。
 */

/** 产出约 N MB stdout 的跨平台命令（测试环境必然有 node）。 */
function bigOutputCmd(mb: number): string {
  return `node -e "const c='x'.repeat(1024*1024);for(let i=0;i<${mb};i++)process.stdout.write(c);"`;
}

describe('bash 输出收集上限', () => {
  it('输出超过 10MB 收集上限时，如实报告被丢弃的量并给出替代路径', async () => {
    // 12MB > MAX_COLLECT(10MB)，触顶后约 2MB 被丢弃
    const r = await bashTool.execute(
      { command: bigOutputCmd(12), timeout: 120 },
      { cwd: process.cwd() },
    );

    expect(r.isError ?? false).toBe(false);
    // 头部内容仍然给出
    expect(r.content.startsWith('xxxx')).toBe(true);
    // 两段提示都要在：显示截断 + 收集丢弃
    expect(r.content).toContain('输出已截断');
    expect(r.content).toContain('被丢弃');
    expect(r.content).toContain('不可恢复');
    // 必须给出可执行的替代路径，而不是只报告损失
    expect(r.content).toContain('read_file');
    // 丢弃量应是 MB 量级（约 2MB → 约 2000 KB 上下，放宽到 >500KB 以容忍 chunk 边界）
    const m = r.content.match(/另有约 (\d+) KB/);
    expect(m).not.toBeNull();
    expect(Number(m![1])).toBeGreaterThan(500);
  }, 180000);

  it('输出未触顶时不出现丢弃提示（不污染正常结果）', async () => {
    const r = await bashTool.execute({ command: 'echo hello-small' }, { cwd: process.cwd() });
    expect(r.content).toContain('hello-small');
    expect(r.content).not.toContain('被丢弃');
    expect(r.content).not.toContain('输出已截断');
  });

  it('输出超过展示上限但未触顶收集上限时，只报截断不报丢弃', async () => {
    // 1MB > MAX_OUTPUT(30k 字符) 但 << MAX_COLLECT(10MB)
    const r = await bashTool.execute(
      { command: bigOutputCmd(1), timeout: 60 },
      { cwd: process.cwd() },
    );
    expect(r.content).toContain('输出已截断');
    expect(r.content).not.toContain('被丢弃');
  }, 60000);
});
