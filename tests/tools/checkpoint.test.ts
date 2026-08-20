import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { backupBeforeWrite, hasCheckpoint, restoreFile } from '../../src/tools/checkpoint.js';
import { editFileTool } from '../../src/tools/edit.js';
import { writeFileTool } from '../../src/tools/write.js';
import type { ToolContext } from '../../src/tools/types.js';

let workDir: string;
let fakeHome: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'ckpt-work-'));
  fakeHome = mkdtempSync(join(tmpdir(), 'ckpt-home-'));
  process.env.STEP_CODE_TEST_HOME = fakeHome;
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
  delete process.env.STEP_CODE_TEST_HOME;
});

const ctx = (): ToolContext => ({ cwd: workDir });

describe('文件级 checkpoint', () => {
  it('edit_file 写入前备份原内容，restoreFile 恢复', async () => {
    const f = join(workDir, 'a.txt');
    writeFileSync(f, '原始内容', 'utf8');
    const res = await editFileTool.execute({ path: f, old_string: '原始', new_string: '改动' }, ctx());
    expect(res.isError).not.toBe(true);
    expect(readFileSync(f, 'utf8')).toBe('改动内容');
    // 备份已生成
    expect(hasCheckpoint(workDir, f)).toBe(true);
    // 恢复
    const r = restoreFile(workDir, f);
    expect(r.ok).toBe(true);
    expect(readFileSync(f, 'utf8')).toBe('原始内容');
  });

  it('write_file 覆盖已有文件前备份，可恢复', async () => {
    const f = join(workDir, 'b.txt');
    writeFileSync(f, '旧版本', 'utf8');
    await writeFileTool.execute({ path: f, content: '新版本' }, ctx());
    expect(readFileSync(f, 'utf8')).toBe('新版本');
    const r = restoreFile(workDir, f);
    expect(r.ok).toBe(true);
    expect(readFileSync(f, 'utf8')).toBe('旧版本');
  });

  it('write_file 新建文件不备份（无原内容），restoreFile 报无 checkpoint', async () => {
    const f = join(workDir, 'new.txt');
    await writeFileTool.execute({ path: f, content: '全新' }, ctx());
    expect(existsSync(f)).toBe(true);
    expect(hasCheckpoint(workDir, f)).toBe(false);
    const r = restoreFile(workDir, f);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('checkpoint');
  });

  it('同一文件多次编辑只留最近一次备份', async () => {
    const f = join(workDir, 'c.txt');
    writeFileSync(f, 'v0', 'utf8');
    await editFileTool.execute({ path: f, old_string: 'v0', new_string: 'v1' }, ctx());
    // v0 → v1 的备份是 v0
    await editFileTool.execute({ path: f, old_string: 'v1', new_string: 'v2' }, ctx());
    // 第二次备份覆盖：现在是 v1
    const r = restoreFile(workDir, f);
    expect(r.ok).toBe(true);
    expect(readFileSync(f, 'utf8')).toBe('v1'); // 恢复到最近一次备份（v1），不是 v0
  });

  it('CRLF 文件备份保持原换行风格', async () => {
    const f = join(workDir, 'crlf.txt');
    writeFileSync(f, 'line1\r\nline2\r\n', 'utf8');
    backupBeforeWrite(workDir, f, 'edit_file');
    writeFileSync(f, 'changed\n', 'utf8');
    const r = restoreFile(workDir, f);
    expect(r.ok).toBe(true);
    expect(readFileSync(f, 'utf8')).toBe('line1\r\nline2\r\n');
  });

  it('restoreFile 无 checkpoint 时给明确原因，不误恢复', () => {
    const f = join(workDir, 'none.txt');
    const r = restoreFile(workDir, f);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toContain('checkpoint');
  });
});
