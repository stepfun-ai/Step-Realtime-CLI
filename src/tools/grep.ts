import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { z } from 'zod';
import { resolvePath } from './fsutil.js';
import { fail, ok, type ToolDef } from './types.js';

const schema = z.object({
  pattern: z.string().describe('要搜索的正则表达式（JavaScript 语法）。'),
  path: z.string().optional().describe('搜索根目录，默认当前工作目录。'),
  ignore_case: z.boolean().optional().describe('是否忽略大小写。默认 false。'),
});

const IGNORE_DIRS = new Set(['node_modules', '.git', 'dist', '.next', 'build', '.cache']);
const MAX_FILES = 3000;
const MAX_MATCHES = 200;
const MAX_FILE_BYTES = 512 * 1024;

function* walk(dir: string, depth: number): Generator<string> {
  if (depth > 20) return;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (IGNORE_DIRS.has(name)) continue;
    const full = join(dir, name);
    let st;
    try {
      st = statSync(full);
    } catch {
      continue;
    }
    if (st.isDirectory()) {
      yield* walk(full, depth + 1);
    } else if (st.isFile() && st.size <= MAX_FILE_BYTES) {
      yield full;
    }
  }
}

export const grepTool: ToolDef<z.infer<typeof schema>> = {
  name: 'grep',
  description:
    '在目录下按正则搜索文件内容，返回 匹配行（path:line:内容）。自动忽略 node_modules、.git、dist 等及超大文件。',
  schema,
  access: (input, ctx) => ({ kind: 'read', path: resolvePath(ctx.cwd, input.path ?? '.') }),
  async execute(input, ctx) {
    const root = resolvePath(ctx.cwd, input.path ?? '.');
    let re: RegExp;
    try {
      re = new RegExp(input.pattern, input.ignore_case === true ? 'i' : undefined);
    } catch (e) {
      return fail(`无效的正则：${(e as Error).message}`);
    }

    const results: string[] = [];
    let fileCount = 0;
    for (const file of walk(root, 0)) {
      if (++fileCount > MAX_FILES) break;
      let text: string;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        continue;
      }
      if (text.includes('\u0000')) continue; // 跳过二进制
      const lines = text.split('\n');
      for (let i = 0; i < lines.length; i++) {
        if (re.test(lines[i]!)) {
          const rel = relative(ctx.cwd, file).replace(/\\/g, '/');
          results.push(`${rel}:${i + 1}:${lines[i]!.slice(0, 300)}`);
          if (results.length >= MAX_MATCHES) break;
        }
      }
      if (results.length >= MAX_MATCHES) break;
    }

    if (results.length === 0) {
      return ok('[无匹配]');
    }
    let out = results.join('\n');
    if (results.length >= MAX_MATCHES) {
      out += `\n\n[结果已达上限 ${MAX_MATCHES} 条，可能还有更多匹配]`;
    }
    return ok(out);
  },
};
