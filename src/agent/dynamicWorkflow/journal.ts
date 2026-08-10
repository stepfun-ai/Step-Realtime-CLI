import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
 * 记忆化 journal：确定性重放 + 记忆化 resume。
 *
 * journal = 追加写 JSONL：`<cwd>/.step-code/journal/dwf-<runId>.jsonl`（.step-code/ 已在 gitignore）。
 * 每条 { key, result }，key = 稳定的 JSON.stringify([fn, prompt, subagentType])。
 * 失败（null）结果不写 journal——resume 时失败调用会真重跑，对修复友好。
 *
 * resume：工具入参 resume_from_run_id 指定后，先预载该 journal 进缓存；
 * 脚本从头重放，命中缓存的 agent() 瞬时返回旧结果（且不占 agent 计数），首个变更点之后真跑。
 */
export class Journal {
  private readonly cache = new Map<string, string>();

  private constructor(
    readonly runId: string,
    readonly filePath: string,
  ) {}

  /** journal 缓存 key：同一 (fn, prompt, subagentType) 视为同一次调用。 */
  static key(fn: string, prompt: string, subagentType: string): string {
    return JSON.stringify([fn, prompt, subagentType]);
  }

  static journalDir(cwd: string): string {
    return path.join(cwd, '.step-code', 'journal');
  }

  static filePathFor(cwd: string, runId: string): string {
    return path.join(Journal.journalDir(cwd), `dwf-${runId}.jsonl`);
  }

  /** 自动存档目录：每次运行的脚本工作副本（与 journal 同域，供编辑后用 script_path 重跑）。 */
  static scriptsDir(cwd: string): string {
    return path.join(Journal.journalDir(cwd), 'scripts');
  }

  static scriptPathFor(cwd: string, runId: string): string {
    return path.join(Journal.scriptsDir(cwd), `${runId}.js`);
  }

  /** 自动存档本次脚本（best-effort：落盘失败不阻断 run，仅失去编辑重跑入口）。返回目标路径。 */
  static async archiveScript(cwd: string, runId: string, script: string): Promise<string> {
    const filePath = Journal.scriptPathFor(cwd, runId);
    try {
      await mkdir(Journal.scriptsDir(cwd), { recursive: true });
      await writeFile(filePath, script, 'utf-8');
    } catch {
      // 存档是迭代循环优化，写失败不致命
    }
    return filePath;
  }

  /** 打开本次 run 的 journal；resumeFromRunId 非空时预载其缓存。 */
  static async open(cwd: string, runId: string, resumeFromRunId?: string): Promise<Journal> {
    await mkdir(Journal.journalDir(cwd), { recursive: true });
    const journal = new Journal(runId, Journal.filePathFor(cwd, runId));
    if (resumeFromRunId !== undefined && resumeFromRunId !== '') {
      await journal.preload(Journal.filePathFor(cwd, resumeFromRunId));
    }
    return journal;
  }

  private async preload(filePath: string): Promise<void> {
    let text: string;
    try {
      text = await readFile(filePath, 'utf-8');
    } catch {
      // resume 目标不存在：按空缓存处理（全量真跑），不阻断。
      return;
    }
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      try {
        const entry = JSON.parse(line) as { key?: unknown; result?: unknown };
        if (typeof entry.key === 'string' && typeof entry.result === 'string') {
          // 同 key 后者覆盖前者（journal 是追加写，后写即新值）。
          this.cache.set(entry.key, entry.result);
        }
      } catch {
        // 跳过损坏行
      }
    }
  }

  get(key: string): string | undefined {
    return this.cache.get(key);
  }

  get size(): number {
    return this.cache.size;
  }

  /** 追加一条成功结果（best-effort：落盘失败不阻断 run，仅失去 resume 能力）。 */
  async record(key: string, result: string): Promise<void> {
    this.cache.set(key, result);
    try {
      await appendFile(this.filePath, `${JSON.stringify({ key, result })}\n`, 'utf-8');
    } catch {
      // journal 是缓存优化，写失败不致命
    }
  }
}
