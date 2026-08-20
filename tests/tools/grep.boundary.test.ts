import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { executeTool } from '../../src/tools/index.js';

let readFileCalls = 0;

vi.mock('node:fs', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:fs')>();
  return {
    ...orig,
    readFileSync: (path: unknown, options?: unknown) => {
      if (options === 'utf8' || (typeof options === 'object' && options !== null && (options as { encoding?: string }).encoding === 'utf8')) {
        readFileCalls++;
      }
      return (orig.readFileSync as (p: unknown, opts?: unknown) => string)(path, options);
    },
  };
});

let dir: string;
let ctx: { cwd: string };

describe('grep 文件数上限边界', () => {
  beforeEach(() => {
    readFileCalls = 0;
    dir = mkdtempSync(join(tmpdir(), 'stepcode-grep-boundary-'));
    ctx = { cwd: dir };
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('最多读取 MAX_FILES（3000）个文件内容，第 3001 个不再扫描', async () => {
    for (let i = 0; i < 3002; i++) {
      writeFileSync(join(dir, `f-${i.toString().padStart(4, '0')}.txt`), `content ${i}`);
    }
    const r = await executeTool('grep', { pattern: 'NOTHING_MATCHES' }, ctx);
    expect(r.isError).toBe(false);
    expect(r.content).toContain('无匹配');
    expect(readFileCalls).toBeLessThanOrEqual(3000);
  }, 15_000);
});
