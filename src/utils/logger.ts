/**
 * 运行日志（诊断通道）。会话记录走 SessionStore 的 `.wire.jsonl`，与此无关。
 *
 * 设计：
 * - 一条通道，同时写全局文件 `~/.step-code/logs/step-code.log` 和进程内环形缓冲。
 * - TUI 交互模式：只进文件 + 缓冲，绝不写 stderr/stdout（Ink 独占终端，写终端会打乱渲染）。
 * - headless（`-p` 一次性执行）模式：才允许写 stderr，默认只 error 级。
 * - 级别沿用 STEP_CODE_DEBUG：默认记 info 及以上，=1 时降到 debug。
 * - 启动轮转：文件超阈值则重命名为 `.log.old`，不引入日志库。
 * - 写入前做 best-effort 脱敏（redactSecrets）。
 * - 环形缓冲经 dumpLogBuffer() 导出，供 debug-zip 取最近现场。
 *
 * logDebug/logError 的签名与行为向后兼容：headless 下仍写 stderr（logError 无条件、
 * logDebug 仅 STEP_CODE_DEBUG=1 时），TUI 下改为只进文件 + 缓冲。
 */
import { appendFileSync, chmodSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { redactSecrets } from './redact.js';

export type LogMode = 'tui' | 'headless';
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_RANK: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const DEBUG = process.env['STEP_CODE_DEBUG'] === '1';
/** 记录阈值：低于此级别的日志既不进文件也不进缓冲。STEP_CODE_DEBUG=1 时放宽到 debug。 */
const RECORD_THRESHOLD: number = DEBUG ? LEVEL_RANK.debug : LEVEL_RANK.info;

/** 环形缓冲容量（条）。 */
const BUFFER_CAPACITY = 500;
/** 文件轮转阈值（字节），超过则启动时轮转一次。 */
const ROTATE_BYTES = 5 * 1024 * 1024;

/** 默认 headless：进程早期（配置/provider 加载失败）尚未 configure 时，错误应能进 stderr。 */
let mode: LogMode = 'headless';
/** 日志目录（默认 ~/.step-code/logs）。测试可通过 configureLogger 覆盖。 */
let logDir: string = join(homedir(), '.step-code', 'logs');
let logFile: string = join(logDir, 'step-code.log');

/** 环形缓冲：定容数组，满了丢最旧。 */
let buffer: string[] = [];
/** 文件通道是否已初始化（建目录 + 启动轮转，只做一次）。 */
let fileReady = false;

/**
 * 配置 logger。通常在 cli.ts 区分 `-p` 一次性 vs 交互 TUI 的分叉点调用：
 * 交互 TUI 传 { mode: 'tui' }，headless 保持默认。dir 供测试重定向日志目录。
 */
export function configureLogger(opts: { mode?: LogMode; dir?: string }): void {
  if (opts.mode !== undefined) mode = opts.mode;
  if (opts.dir !== undefined) {
    logDir = opts.dir;
    logFile = join(logDir, 'step-code.log');
    fileReady = false; // 新目录需要重新初始化 + 轮转
  }
}

/** 便捷设置模式。 */
export function setLogMode(m: LogMode): void {
  mode = m;
}

/** 导出环形缓冲为多行文本，供 debug-zip 写入 errors.log。 */
export function dumpLogBuffer(): string {
  return buffer.join('\n');
}

/** 清空缓冲并重置文件初始化状态。仅供测试使用。 */
export function resetLoggerForTest(): void {
  buffer = [];
  fileReady = false;
  mode = 'headless';
}

/** 首次写入前：建目录、启动轮转、收紧权限。任何失败都吞掉，日志不可因落盘失败而拖垮主流程。 */
function ensureFileReady(): void {
  if (fileReady) return;
  fileReady = true; // 无论成败只尝试一次，避免每条日志都重试建目录
  try {
    mkdirSync(logDir, { recursive: true });
    // 启动轮转：现有文件超阈值则重命名为 .log.old（覆盖旧的 .old）
    if (existsSync(logFile)) {
      try {
        if (statSync(logFile).size > ROTATE_BYTES) {
          const old = `${logFile}.old`;
          if (existsSync(old)) rmSync(old, { force: true });
          renameSync(logFile, old);
        }
      } catch {
        // 轮转失败不阻塞
      }
    }
  } catch {
    // 建目录失败：后续 append 会再失败并被吞，主流程不受影响
  }
}

function fmtArg(a: unknown): string {
  if (typeof a === 'string') return a;
  if (a instanceof Error) return a.stack ?? a.message;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

function pushBuffer(line: string): void {
  buffer.push(line);
  if (buffer.length > BUFFER_CAPACITY) buffer.shift();
}

function writeFile(line: string): void {
  ensureFileReady();
  try {
    appendFileSync(logFile, `${line}\n`, { mode: 0o600 });
    // unix 下收紧权限（append 只在新建时应用 mode，故补一发 chmod）；Windows 忽略报错
    try {
      chmodSync(logFile, 0o600);
    } catch {
      // Windows 或权限受限：忽略
    }
  } catch {
    // 落盘失败不影响主流程
  }
}

/** headless 下是否把该级别写到 stderr：error 恒写；STEP_CODE_DEBUG=1 时放宽到全部已记录级别。 */
function shouldWriteStderr(level: LogLevel): boolean {
  if (mode !== 'headless') return false;
  if (level === 'error') return true;
  return DEBUG;
}

/** 统一日志入口：级别过滤 → 脱敏 → 文件 + 缓冲 →（headless）stderr。 */
function log(level: LogLevel, args: unknown[]): void {
  if (LEVEL_RANK[level] < RECORD_THRESHOLD) return;
  const msg = redactSecrets(args.map(fmtArg).join(' '));
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} ${msg}`;
  pushBuffer(line);
  writeFile(line);
  if (shouldWriteStderr(level)) {
    process.stderr.write(`[step-code${level === 'error' ? ':error' : ''}] ${msg}\n`);
  }
}

export function logDebug(...args: unknown[]): void {
  log('debug', args);
}

export function logInfo(...args: unknown[]): void {
  log('info', args);
}

export function logWarn(...args: unknown[]): void {
  log('warn', args);
}

export function logError(...args: unknown[]): void {
  log('error', args);
}
