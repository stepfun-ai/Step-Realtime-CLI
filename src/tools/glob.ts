import { globSync } from 'node:fs';
import { relative } from 'node:path';
import { z } from 'zod';
import { resolvePath } from './fsutil.js';
import { fail, ok, type ToolDef } from './types.js';

const schema = z.object({
  pattern: z.string().describe('glob 模式，如 "src/**/*.ts" 或 "*.md"。'),
  path: z.string().optional().describe('搜索根目录，默认当前工作目录。'),
});

const MAX_RESULTS = 200;
const IGNORE = ['**/node_modules/**', '**/.git/**', '**/dist/**'];

export const globTool: ToolDef<z.infer<typeof schema>> = {
  name: 'glob',
  description:
    '按 glob 模式查找文件路径。自动忽略 node_modules、.git、dist。返回匹配的文件路径列表。',
  schema,
  access: (input, ctx) => ({ kind: 'read', path: resolvePath(ctx.cwd, input.path ?? '.') }),
  async execute(input, ctx) {
    const root = resolvePath(ctx.cwd, input.path ?? '.');
    let matches: string[];
    try {
      matches = globSync(input.pattern, { cwd: root, exclude: IGNORE }) as string[];
    } catch (e) {
      return fail(`glob 失败：${(e as Error).message}`);
    }
    if (matches.length === 0) {
      return ok('[无匹配文件]');
    }
    const rel = matches.map((m) => relative(ctx.cwd, resolvePath(root, m)).replace(/\\/g, '/'));
    rel.sort();
    const shown = rel.slice(0, MAX_RESULTS);
    let out = shown.join('\n');
    if (rel.length > MAX_RESULTS) {
      out += `\n\n[共 ${rel.length} 个匹配，仅显示前 ${MAX_RESULTS} 个]`;
    }
    return ok(out);
  },
};
