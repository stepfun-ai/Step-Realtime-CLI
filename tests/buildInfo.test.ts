import { describe, expect, it } from 'vitest';
import { formatVersionLine } from '../src/buildInfo.js';
import { VERSION } from '../src/version.js';

describe('构建标识', () => {
  it('无构建信息时只报版本号', () => {
    // 从源码直接跑、或从无 .git 的 tarball 构建都会走这条，必须退回纯版本号而不是报错或留占位符
    expect(formatVersionLine(null)).toBe(VERSION);
  });

  it('有构建信息时附带 commit 与构建时间', () => {
    const line = formatVersionLine({ commit: 'a1b2c3d', dirty: false, time: '2026-08-03T02:46Z' });
    expect(line).toBe(`${VERSION} (a1b2c3d 2026-08-03T02:46Z)`);
  });

  it('工作区不干净时标 +dirty', () => {
    // 这条是本机诊断的关键：带 +dirty 的产物不对应任何一个 commit，出问题时不能按 commit 复现
    const line = formatVersionLine({ commit: 'a1b2c3d', dirty: true, time: '2026-08-03T02:46Z' });
    expect(line).toContain('a1b2c3d+dirty');
  });

  it('版本号本身不掺构建信息', () => {
    // VERSION 要进 MCP 客户端声明与 HTTP user-agent，那是给程序读的字段，格式必须稳定
    expect(VERSION).not.toContain('(');
    expect(VERSION).not.toContain('dirty');
  });
});
