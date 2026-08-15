import { readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

/**
 * @ 文件引用的文件索引：启动时后台扫描 cwd 的相对路径列表，供 PromptInput 的
 * computeCompletions 做文件补全。只存路径不读内容。
 *
 * 性能与正确性约束：
 * - 排除常见重型/无关目录（node_modules/.git/dist/build/各类点目录与缓存），
 *   否则大仓库扫描慢且候选被依赖文件淹没。
 * - 总条数上限（MAX_FILES）：超出即停扫（候选截断是补全的固有语义，宁可少不可慢）。
 * - 用 Node fs.promises 递归（跨平台，不依赖 shell/rg），失败目录跳过。
 * - 后台异步扫描：App 挂载后触发，不阻塞首帧；扫描完成前 @ 补全为空（优雅降级）。
 */

/** 排除的目录名（命中即整棵子树跳过）。 */
const EXCLUDED_DIRS = new Set([
  'node_modules',
  '.git',
  'dist',
  'dist-bundle',
  'dist-sea',
  'build',
  'out',
  '.next',
  '.cache',
  'coverage',
  '.venv',
  'venv',
  '__pycache__',
  'uv-cache',
  '.turbo',
  '.idea',
  '.vscode-test',
]);

/** 索引文件总数上限。 */
const MAX_FILES = 20_000;

/**
 * 递归扫描 cwd，返回相对路径（posix 分隔，跨平台一致）列表。
 * 超上限提前停止；失败目录跳过。
 */
export async function scanFileIndex(cwd: string, signal?: AbortSignal): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    if (out.length >= MAX_FILES) return;
    if (signal?.aborted) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // 无权限/已删除：跳过
    }
    for (const entry of entries) {
      if (out.length >= MAX_FILES) return;
      if (signal?.aborted) return;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (EXCLUDED_DIRS.has(entry.name) || entry.name.startsWith('.')) continue;
        await walk(full);
      } else if (entry.isFile()) {
        // 相对路径统一 posix 分隔（补全展示与匹配跨平台一致）
        out.push(relative(cwd, full).split('\\').join('/'));
      }
    }
  };
  await walk(cwd);
  return out;
}
