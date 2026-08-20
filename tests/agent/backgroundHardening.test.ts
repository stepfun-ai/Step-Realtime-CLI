import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { BackgroundManager } from '../../src/agent/background/manager.js';

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Git Bash 探测（本套件需要 POSIX 工具集：seq/read/sleep/$!）。 */
function findGitBash(): string | undefined {
  const candidates = [
    process.env['GIT_BASH'],
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
  ].filter((p): p is string => p !== undefined);
  return candidates.find((p) => existsSync(p));
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

async function waitFor(cond: () => boolean, timeoutMs = 8000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (cond()) return true;
    await sleep(100);
  }
  return cond();
}

const bash = findGitBash();
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length > 0) {
    const d = dirs.pop()!;
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      // best-effort
    }
  }
});

describe.skipIf(bash === undefined)('后台任务防失控加固（2026-08-10 磁盘写满事故）', () => {
  it('output.log 超上限滚动截断：文件有界、含标记行、meta 记录截断与总产出', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'step-bg-harden-'));
    dirs.push(dir);
    const max = 4096;
    const mgr = new BackgroundManager(10, { tasksDir: dir, maxOutputFileBytes: max });
    // seq 1 20000 约 109KB，远超 4KB 上限，会触发多次截断
    const id = mgr.start('seq 1 20000', bash!, ['-c', 'seq 1 20000'], process.cwd());
    const done = await waitFor(() => mgr.get(id)?.status !== 'running');
    expect(done).toBe(true);

    const logPath = join(dir, id, 'output.log');
    const content = readFileSync(logPath);
    // 上界 = max + 截断标记行（标记自身占百字节级，文件始终有界即可，不追求精确等于 max）
    expect(content.length).toBeLessThan(max + 1024);
    expect(content.toString('utf8')).toContain('step-code 滚动截断');

    const meta = JSON.parse(readFileSync(join(dir, id, 'meta.json'), 'utf8')) as {
      outputTruncated?: boolean;
      outputTotalBytes?: number;
      outputBytes?: number;
    };
    expect(meta.outputTruncated).toBe(true);
    expect(meta.outputTotalBytes).toBeGreaterThan(max);
    expect(meta.outputBytes).toBeLessThan(max + 1024);
    // 尾部内容保留：最后一行应接近 20000
    const tail = content.toString('utf8').trim().split('\n').pop() ?? '';
    expect(Number(tail)).toBeGreaterThan(19000);
  });

  it('stdin 立即 EOF：read 命令拿到 EOF 正常终态，不挂起', async () => {
    const mgr = new BackgroundManager(10, {});
    // read 在 stdin 为 pipe 且永不关闭时会永远阻塞；'ignore' 让它立即拿到 EOF
    const id = mgr.start('read-eof', bash!, ['-c', 'read x; echo "got-$x"'], process.cwd());
    const done = await waitFor(() => mgr.get(id)?.status !== 'running', 5000);
    expect(done).toBe(true);
    expect(mgr.get(id)?.status).toBe('completed');
    expect(mgr.get(id)?.output).toContain('got-');
  });

  it('stop 杀整棵进程树：孙进程随之终止', async () => {
    const mgr = new BackgroundManager(10, {});
    if (process.platform === 'win32') {
      // cmd 是子、ping 是孙：taskkill /T 应连孙进程一起杀（旧行为只杀 cmd，ping 孤儿化继续跑）
      // MSYS 的 $! 是 cygwin pid、Node 探测不到，故 Windows 侧用 ping.exe 映像名探测
      const pingCount = (): number => {
        try {
          const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq ping.exe', '/NH'], { encoding: 'utf8' });
          return out.split('\n').filter((l) => l.toLowerCase().startsWith('ping.exe')).length;
        } catch {
          return 0;
        }
      };
      if (pingCount() > 0) return; // 环境已有 ping 在跑，无法干净判定，跳过
      const id = mgr.start('tree', 'cmd.exe', ['/c', 'ping -n 300 127.0.0.1 >nul'], process.cwd());
      const started = await waitFor(() => pingCount() > 0);
      expect(started).toBe(true);
      mgr.stop(id);
      // 15s 而非 5s：全量并发跑（176 个文件抢 CPU）时 taskkill 整棵树会被拖慢，
      // 5s 阈值测的是机器闲忙而不是杀树是否有效。
      const dead = await waitFor(() => pingCount() === 0, 15000);
      expect(dead).toBe(true);
      return;
    }
    // POSIX：$! 即真实 pid，process.kill(pid, 0) 可直接探测
    const id = mgr.start('tree', bash!, ['-c', 'sleep 300 & echo GRANDCHILD=$!; wait'], process.cwd());
    const gotPid = await waitFor(() => (mgr.get(id)?.output ?? '').includes('GRANDCHILD='));
    expect(gotPid).toBe(true);
    const m = (mgr.get(id)?.output ?? '').match(/GRANDCHILD=(\d+)/);
    expect(m).not.toBeNull();
    const gpid = Number(m![1]);
    expect(pidAlive(gpid)).toBe(true);

    mgr.stop(id);
    // 进程组信号异步生效，轮询等待
    const dead = await waitFor(() => !pidAlive(gpid), 5000);
    expect(dead).toBe(true);
  });
});
