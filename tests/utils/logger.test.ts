import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  configureLogger,
  dumpLogBuffer,
  logDebug,
  logError,
  logInfo,
  resetLoggerForTest,
} from '../../src/utils/logger.js';

let dir: string;
const logFile = (): string => join(dir, 'step-code.log');

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stepcode-log-'));
  resetLoggerForTest();
  configureLogger({ mode: 'tui', dir });
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('logger 文件通道', () => {
  it('info/error 写入文件并可读回', () => {
    logInfo('hello info');
    logError('boom error');
    const raw = readFileSync(logFile(), 'utf8');
    expect(raw).toContain('INFO');
    expect(raw).toContain('hello info');
    expect(raw).toContain('ERROR');
    expect(raw).toContain('boom error');
  });

  it('写入前做脱敏', () => {
    logError('failed with api_key=SUPERSECRET123 and sk-ABCDEFGH1234567890');
    const raw = readFileSync(logFile(), 'utf8');
    expect(raw).not.toContain('SUPERSECRET123');
    expect(raw).not.toContain('sk-ABCDEFGH1234567890');
    expect(raw).toContain('[REDACTED]');
  });
});

describe('logger 环形缓冲', () => {
  it('dumpLogBuffer 返回已记录的行', () => {
    logInfo('line one');
    logError('line two');
    const dump = dumpLogBuffer();
    expect(dump).toContain('line one');
    expect(dump).toContain('line two');
    expect(dump.split('\n')).toHaveLength(2);
  });

  it('缓冲满了丢最旧（容量 500）', () => {
    for (let i = 0; i < 520; i++) logInfo(`msg-${i}`);
    const lines = dumpLogBuffer().split('\n');
    expect(lines).toHaveLength(500);
    // 最旧的 msg-0..msg-19 被挤掉，msg-20 成为最旧
    expect(lines[0]).toContain('msg-20');
    expect(lines[lines.length - 1]).toContain('msg-519');
  });
});

describe('logger 级别过滤', () => {
  it('默认（无 STEP_CODE_DEBUG）不记 debug 级', () => {
    // 测试进程默认未设 STEP_CODE_DEBUG=1，debug 应被过滤
    const hasDebugEnv = process.env['STEP_CODE_DEBUG'] === '1';
    logDebug('debug-should-drop');
    logInfo('info-kept');
    const dump = dumpLogBuffer();
    expect(dump).toContain('info-kept');
    if (!hasDebugEnv) {
      expect(dump).not.toContain('debug-should-drop');
    }
  });
});

describe('logger TUI 模式不写终端', () => {
  it('TUI 模式下 logError 不写 stderr', () => {
    const chunks: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    // @ts-expect-error 测试期覆盖 write
    process.stderr.write = (c: string) => {
      chunks.push(String(c));
      return true;
    };
    try {
      logError('tui-error-not-on-terminal');
    } finally {
      process.stderr.write = orig;
    }
    expect(chunks.join('')).not.toContain('tui-error-not-on-terminal');
    // 但文件里有
    expect(readFileSync(logFile(), 'utf8')).toContain('tui-error-not-on-terminal');
  });

  it('headless 模式下 logError 写 stderr', () => {
    configureLogger({ mode: 'headless', dir });
    const chunks: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    // @ts-expect-error 测试期覆盖 write
    process.stderr.write = (c: string) => {
      chunks.push(String(c));
      return true;
    };
    try {
      logError('headless-error-on-terminal');
    } finally {
      process.stderr.write = orig;
    }
    expect(chunks.join('')).toContain('headless-error-on-terminal');
  });
});

describe('logger 启动轮转', () => {
  it('已有文件超阈值时轮转为 .log.old', () => {
    // 预置一个超过 5MB 的日志文件
    const big = 'x'.repeat(6 * 1024 * 1024);
    writeFileSync(logFile(), big, 'utf8');
    // 重新 configure（fileReady 复位），首次写入触发轮转
    configureLogger({ mode: 'tui', dir });
    logInfo('after-rotate');
    const rotated = readFileSync(`${logFile()}.old`, 'utf8');
    expect(rotated.length).toBeGreaterThan(5 * 1024 * 1024);
    const current = readFileSync(logFile(), 'utf8');
    expect(current).toContain('after-rotate');
    expect(current.length).toBeLessThan(1024);
  });
});
