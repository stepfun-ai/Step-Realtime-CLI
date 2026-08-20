/**
 * 无头（脱离 Ink/TTY）的 export-debug-zip 子命令逻辑。
 *
 * 与 TUI 斜杠命令 `/export-debug-zip` 共用底层 exportDebugBundle，但这条路径纯 Node：
 * 不 import 任何 Ink/React，只构造 SessionStore、定位会话、打包，返回结构化结果。
 * 把「返回结果」与「进程退出/流写入」拆开，是为了让选中最近会话的逻辑可被单测覆盖
 * （cli.ts 里的调用点只负责把结果落到 stdout/stderr + process.exit）。
 */
import { exportDebugBundle } from './debugBundle.js';
import type { SessionStore } from './store.js';

export interface RunExportDebugZipOptions {
  store: SessionStore;
  cwd: string;
  /** 显式会话 id；缺省时取该 cwd 下最近更新的会话。 */
  sessionId?: string;
  /** ~/.step-code 数据根覆盖（测试用），透传给 exportDebugBundle。 */
  dataDir?: string;
  /** 脱敏级别透传。缺省 vendor。 */
  level?: import('./debugBundle.js').RedactLevel;
}

export interface RunExportDebugZipResult {
  /** 进程退出码：0 成功、1 失败。 */
  code: 0 | 1;
  /** 成功时 = `${zipPath}\n`，供调用点写 stdout。 */
  stdout?: string;
  /** 失败时的错误行（含换行），供调用点写 stderr。 */
  stderr?: string;
}

/**
 * 定位会话并导出调试 zip。
 * - 传了 sessionId 就用它；缺省取该 cwd 下最近更新的会话（复用 store.latest，不重算 workdirKey）。
 * - 该 cwd 下无可用会话 → code 1 + `No session found for current directory`。
 * - 导出成功 → code 0 + stdout=zip 路径；model 能从会话数据拿到就传，拿不到就不传。
 * - 导出抛异常 → code 1 + stderr=错误 message。
 */
export async function runExportDebugZip(opts: RunExportDebugZipOptions): Promise<RunExportDebugZipResult> {
  const { store, cwd, sessionId, dataDir, level } = opts;
  const target = sessionId !== undefined ? store.load(cwd, sessionId) : store.latest(cwd);
  if (target === null) {
    return { code: 1, stderr: 'No session found for current directory\n' };
  }
  try {
    const { zipPath } = await exportDebugBundle({
      store,
      cwd,
      sessionId: target.id,
      ...(target.model ? { model: target.model } : {}),
      ...(dataDir !== undefined ? { dataDir } : {}),
      ...(level !== undefined ? { level } : {}),
    });
    return { code: 0, stdout: `${zipPath}\n` };
  } catch (e) {
    return { code: 1, stderr: `${(e as Error).message}\n` };
  }
}
