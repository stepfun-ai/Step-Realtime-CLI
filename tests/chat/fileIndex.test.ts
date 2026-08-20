import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { scanFileIndex } from '../../src/chat/fileIndex.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fileindex-'));
  // 构造一个小型目录树
  mkdirSync(join(dir, 'src/chat'), { recursive: true });
  mkdirSync(join(dir, 'node_modules/pkg'), { recursive: true });
  mkdirSync(join(dir, '.git/objects'), { recursive: true });
  writeFileSync(join(dir, 'src/chat/history.ts'), '');
  writeFileSync(join(dir, 'src/agent.ts'), '');
  writeFileSync(join(dir, 'package.json'), '');
  writeFileSync(join(dir, 'node_modules/pkg/index.js'), '');
  writeFileSync(join(dir, '.git/HEAD'), '');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('scanFileIndex 文件索引', () => {
  it('递归收集相对路径，posix 分隔', async () => {
    const files = await scanFileIndex(dir);
    expect(files).toContain('src/chat/history.ts');
    expect(files).toContain('src/agent.ts');
    expect(files).toContain('package.json');
    // 不含反斜杠
    expect(files.every((f) => !f.includes('\\'))).toBe(true);
  });

  it('排除 node_modules 与 .git', async () => {
    const files = await scanFileIndex(dir);
    expect(files.some((f) => f.includes('node_modules'))).toBe(false);
    expect(files.some((f) => f.startsWith('.git'))).toBe(false);
  });

  it('空目录返回空数组', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'fileindex-empty-'));
    try {
      expect(await scanFileIndex(empty)).toEqual([]);
    } finally {
      rmSync(empty, { recursive: true, force: true });
    }
  });

  it('abort 后提前停止', async () => {
    const controller = new AbortController();
    controller.abort();
    const files = await scanFileIndex(dir, controller.signal);
    expect(files).toEqual([]);
  });
});
