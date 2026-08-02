import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { workdirKey } from './store.js';

/** 内存与载入保留的最大历史条数，避免超大文件拖慢启动。 */
export const MAX_ENTRIES = 1000;

/**
 * 输入框命令历史：shell 式的输入回溯（方向键上/下切换发送过的输入行）。
 * 存储方案：按工作目录隔离的 JSONL，启动全量载入内存；未超限时 append 落盘，
 * 触发 MAX_ENTRIES 上限时覆写整文件以裁剪旧条目。
 * 布局：<baseDir>/<workdirKey(cwd)>.jsonl，每行 {"text":"..."}。
 */
export class InputHistoryStore {
  private readonly file: string;
  /** 时间正序，末尾最新。 */
  private entriesArr: string[] = [];

  constructor(cwd: string, baseDir?: string) {
    const base = baseDir ?? join(homedir(), '.step-code', 'input-history');
    this.file = join(base, `${workdirKey(cwd)}.jsonl`);
  }

  /** 将当前内存历史完整覆写回磁盘（用于触发上限后的裁剪与坏行压缩）。 */
  private writeAll(): void {
    const data = this.entriesArr.map((entry) => JSON.stringify({ text: entry })).join('\n');
    writeFileSync(this.file, data ? `${data}\n` : '', 'utf8');
  }

  /** 启动时全量读入内存：跳过空行与坏行，只保留最近 MAX_ENTRIES 条。 */
  load(): string[] {
    this.entriesArr = [];
    if (!existsSync(this.file)) return this.entriesArr;
    let raw: string;
    try {
      raw = readFileSync(this.file, 'utf8');
    } catch {
      return this.entriesArr;
    }
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '') continue;
      try {
        const obj = JSON.parse(trimmed) as { text?: unknown };
        if (typeof obj.text === 'string' && obj.text !== '') {
          this.entriesArr.push(obj.text);
        }
      } catch {
        // 跳过坏行，不中断
      }
    }
    if (this.entriesArr.length > MAX_ENTRIES) {
      this.entriesArr = this.entriesArr.slice(-MAX_ENTRIES);
      try {
        mkdirSync(dirname(this.file), { recursive: true });
        this.writeAll();
      } catch {
        // 压缩落盘失败不影响内存历史与本次会话使用
      }
    }
    return this.entriesArr;
  }

  /**
   * 记录一次提交：trim、丢空、相邻去重（与上一条相同则跳过）。
   * 命中则 push 内存并落盘；未超限时 append 以省 IO，触发上限时覆写整文件以裁剪旧条目。
   * 返回 true 表示已记录；否则返回 false。
   */
  record(text: string): boolean {
    const content = text.trim();
    if (content === '') return false;
    if (this.entriesArr.length > 0 && this.entriesArr[this.entriesArr.length - 1] === content) {
      return false;
    }
    this.entriesArr.push(content);
    try {
      mkdirSync(dirname(this.file), { recursive: true });
      if (this.entriesArr.length > MAX_ENTRIES) {
        this.entriesArr = this.entriesArr.slice(-MAX_ENTRIES);
        this.writeAll();
      } else {
        appendFileSync(this.file, `${JSON.stringify({ text: content })}\n`, 'utf8');
      }
    } catch {
      // 落盘失败不影响内存历史与本次会话使用
    }
    return true;
  }

  /** 当前内存历史（时间正序，末尾最新）。 */
  get entries(): string[] {
    return this.entriesArr;
  }
}

/** 历史导航游标状态。index=-1 表示未浏览（当前草稿态）。 */
export interface HistoryNavState {
  index: number;
  /** 进入浏览前暂存的半截草稿，回到底部时恢复。 */
  draft: string;
}

/** 未浏览的初始状态。 */
export function initialNavState(): HistoryNavState {
  return { index: -1, draft: '' };
}

/**
 * 输入历史导航（纯函数，无副作用，便于单测）。
 * 单行输入框专用：Up/Down 直接映射历史回溯，配 bash 风格草稿暂存。
 *
 * @param entries 历史（时间正序，末尾最新）
 * @param state 当前游标
 * @param dir -1 = Up（更旧）；+1 = Down（更新）
 * @param currentValue 输入框当前文本（首次 Up 时暂存为草稿）
 * @returns 新游标与要写回输入框的文本；text 为 undefined 表示不改动
 */
export function navigateHistory(
  entries: string[],
  state: HistoryNavState,
  dir: -1 | 1,
  currentValue: string,
): { state: HistoryNavState; text: string | undefined } {
  if (entries.length === 0) return { state, text: undefined };

  // 未浏览：只有 Up 有效，暂存草稿并跳到最新一条
  if (state.index === -1) {
    if (dir === 1) return { state, text: undefined };
    const index = entries.length - 1;
    return { state: { index, draft: currentValue }, text: entries[index] };
  }

  const next = state.index + dir; // Up: index-1（更旧）；Down: index+1（更新）
  if (next < 0) return { state, text: undefined }; // 已在最旧，Up 不动
  if (next >= entries.length) {
    // 翻过最新一条：恢复草稿并退出浏览
    return { state: { index: -1, draft: '' }, text: state.draft };
  }
  return { state: { ...state, index: next }, text: entries[next] };
}
