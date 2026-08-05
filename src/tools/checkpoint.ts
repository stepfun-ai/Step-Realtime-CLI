import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * 文件级 checkpoint：edit_file / write_file 写文件前，把目标文件的原始内容备份到
 * `~/.step-code/checkpoints/<cwdHash>/<fileHash>.json`，供 /restore 一键回滚。
 *
 * 与对话级 undo（backtrack，只回退对话历史、明确「代码改动不受影响」）互补——
 * 这条补的是「工具改的文件能撤回」的另一半。
 *
 * 设计取舍：
 * - **按 cwd 组织，不按 session**：文件改动的归属是项目目录，不是某次会话；
 *   跨会话仍应能 /restore（重启或新会话后误改的文件依然可回滚）。
 * - **同一文件只留最近一次备份**：反复编辑同一文件不累积副本，磁盘占用有界。
 *   （历史链式回滚是更大的一档，见设计文档的后续项，本期不做。）
 * - **不覆盖 bash**：bash 命令事先不知道会改哪些文件，且删除类操作无法靠
 *   「写前备份」恢复——那是 Shadow Git 才覆盖的场景，属后续更大改动。
 * - **大文件阈值**：超过 MAX_BACKUP_BYTES 不备份（避免单文件备份撑爆磁盘/内存），
 *   备份缺失时 /restore 明确报「无可用 checkpoint」而非误恢复。
 */

/** 单文件备份的最大字节数（约 8MB）：超出不备份。 */
const MAX_BACKUP_BYTES = 8 * 1024 * 1024;

interface CheckpointRecord {
  /** 绝对路径（恢复时写回的目标）。 */
  absPath: string;
  /** 原始内容（utf8 文本）。 */
  content: string;
  /** 备份时间（ISO）。 */
  savedAt: string;
  /** 备份来源工具。 */
  tool: string;
}

function cwdHash(cwd: string): string {
  return createHash('sha1').update(cwd).digest('hex').slice(0, 16);
}

function fileHash(absPath: string): string {
  return createHash('sha1').update(absPath).digest('hex').slice(0, 16);
}

function homeBase(): string {
  // 测试注入：STEP_CODE_TEST_HOME 覆盖 home，避免测试写真实 ~/.step-code/checkpoints
  return process.env.STEP_CODE_TEST_HOME ?? homedir();
}

function checkpointDir(cwd: string): string {
  return join(homeBase(), '.step-code', 'checkpoints', cwdHash(cwd));
}

function checkpointFile(cwd: string, absPath: string): string {
  return join(checkpointDir(cwd), `${fileHash(absPath)}.json`);
}

/**
 * 写文件前备份原始内容。仅当目标文件已存在且内容不超过阈值时备份；
 * 新文件（不存在）无需备份（/restore 对新建文件的语义是「删除它」，见 restoreFile）。
 * 备份失败不阻塞写操作（静默跳过，宁可没有 checkpoint 也不让工具失败）。
 */
export function backupBeforeWrite(cwd: string, absPath: string, tool: string): void {
  try {
    if (!existsSync(absPath)) return;
    const content = readFileSync(absPath, 'utf8');
    if (Buffer.byteLength(content, 'utf8') > MAX_BACKUP_BYTES) return;
    const dir = checkpointDir(cwd);
    mkdirSync(dir, { recursive: true });
    const record: CheckpointRecord = {
      absPath,
      content,
      savedAt: new Date().toISOString(),
      tool,
    };
    writeFileSync(checkpointFile(cwd, absPath), JSON.stringify(record), 'utf8');
  } catch {
    // 备份失败静默跳过：checkpoint 是安全网，不应反过来让正常写操作失败
  }
}

export type RestoreResult =
  | { ok: true; restored: 'content' }
  | { ok: true; restored: 'deleted' }
  | { ok: false; reason: string };

/**
 * 恢复指定文件的最近一次 checkpoint。
 * - 有备份：写回备份内容。
 * - 备份标记为「新建文件」（文件写入前不存在）：/restore 的语义是删除该新建文件。
 *   本期不实现新建文件备份（existsSync 为 false 时不备份），故无此分支——
 *   新建文件的回滚由「未找到 checkpoint」提示承载，用户自行删除。
 */
export function restoreFile(cwd: string, absPath: string): RestoreResult {
  const file = checkpointFile(cwd, absPath);
  if (!existsSync(file)) {
    return { ok: false, reason: `未找到 ${absPath} 的 checkpoint（可能：文件是新建的、超过备份阈值、或从未经 edit_file/write_file 改过）` };
  }
  try {
    const record = JSON.parse(readFileSync(file, 'utf8')) as CheckpointRecord;
    writeFileSync(record.absPath, record.content, 'utf8');
    return { ok: true, restored: 'content' };
  } catch (e) {
    return { ok: false, reason: `恢复失败：${(e as Error).message}` };
  }
}

/** 列出某文件是否有可用 checkpoint（供 /restore 无参时提示，或测试断言）。 */
export function hasCheckpoint(cwd: string, absPath: string): boolean {
  return existsSync(checkpointFile(cwd, absPath));
}
