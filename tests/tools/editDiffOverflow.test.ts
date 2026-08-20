import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { editFileTool } from '../../src/tools/edit.js';
import type { ToolContext } from '../../src/tools/types.js';

/**
 * 待办 #13：edit_file diff 截断提示曾是「Ctrl+O 展开」的假承诺——被截内容
 * 从未进入 content，展开也看不到。现改为完整 diff 落盘、提示行给真实路径。
 */

let workDir: string;
let fakeHome: string;

beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), 'editdiff-work-'));
  fakeHome = mkdtempSync(join(tmpdir(), 'editdiff-home-'));
  process.env.STEP_CODE_TEST_HOME = fakeHome;
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
  rmSync(fakeHome, { recursive: true, force: true });
  delete process.env.STEP_CODE_TEST_HOME;
});

const ctx = (): ToolContext => ({ cwd: workDir });

/** 生成一份改动行数远超 40 行预览上限的编辑前后文本。 */
function bigEdit(): { oldText: string; newText: string } {
  const oldLines: string[] = [];
  const newLines: string[] = [];
  // 10 簇、每簇间隔足够远（不被聚类合并），每簇改 5 行 → 总 diff 远超 40 行
  for (let c = 0; c < 10; c++) {
    for (let i = 0; i < 20; i++) {
      oldLines.push(`c${c}-ctx-${i}`);
      newLines.push(`c${c}-ctx-${i}`);
    }
    for (let i = 0; i < 5; i++) {
      oldLines.push(`c${c}-old-${i}`);
      newLines.push(`c${c}-new-${i}`);
    }
  }
  return { oldText: oldLines.join('\n'), newText: newLines.join('\n') };
}

describe('edit_file diff 截断：完整 diff 落盘替代 Ctrl+O 假承诺', () => {
  it('超限时提示行给落盘路径，不再是 Ctrl+O 假承诺', async () => {
    const f = join(workDir, 'big.txt');
    const { oldText, newText } = bigEdit();
    writeFileSync(f, oldText, 'utf8');

    const res = await editFileTool.execute(
      { path: f, old_string: 'c0-old-0', new_string: 'c0-new-0' },
      ctx(),
    );
    // 上面只改了 1 行，不触发截断；做一个真正超限的编辑
    expect(res.isError).toBeFalsy();

    writeFileSync(f, oldText, 'utf8');
    const res2 = await editFileTool.execute(
      { path: f, old_string: oldText, new_string: newText },
      ctx(),
    );
    expect(res2.isError).toBeFalsy();
    const text = res2.content;
    expect(text).toContain('more changes hidden');
    expect(text).toContain('完整 diff 已存 .step-code/tool-output/edit-diff-');
    expect(text).not.toContain('Ctrl+O to expand');
  });

  it('落盘文件包含被隐藏的完整改动', async () => {
    const f = join(workDir, 'big.txt');
    const { oldText, newText } = bigEdit();
    writeFileSync(f, oldText, 'utf8');

    const res = await editFileTool.execute(
      { path: f, old_string: oldText, new_string: newText },
      ctx(),
    );
    const m = res.content.match(/完整 diff 已存 (\.step-code\/tool-output\/\S+)/);
    expect(m).toBeTruthy();
    const saved = join(workDir, m![1]!);
    expect(existsSync(saved)).toBe(true);
    const full = readFileSync(saved, 'utf8');
    // 末簇的改动（必在预览截断之外）在落盘文件中完整存在
    expect(full).toContain('c9-old-4');
    expect(full).toContain('c9-new-4');
  });

  it('未超限的编辑照常带 Ctrl+O 提示之外的普通预览，不落盘', async () => {
    const f = join(workDir, 'small.txt');
    writeFileSync(f, 'hello', 'utf8');
    const res = await editFileTool.execute({ path: f, old_string: 'hello', new_string: 'world' }, ctx());
    expect(res.isError).toBeFalsy();
    expect(res.content).not.toContain('完整 diff 已存');
    expect(existsSync(join(workDir, '.step-code', 'tool-output'))).toBe(false);
  });
});
