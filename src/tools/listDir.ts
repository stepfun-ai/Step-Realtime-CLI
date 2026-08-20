import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { resolvePath } from './fsutil.js';
import { fail, ok, type ToolDef } from './types.js';

const schema = z.object({
  path: z.string().optional().describe('要列出的目录，默认当前工作目录。'),
});

const MAX_ENTRIES = 500;

export const listDirTool: ToolDef<z.infer<typeof schema>> = {
  name: 'list_dir',
  description: '列出目录内容，标注每项是文件还是目录。',
  schema,
  access: (input, ctx) => ({ kind: 'read', path: resolvePath(ctx.cwd, input.path ?? '.') }),
  async execute(input, ctx) {
    const abs = resolvePath(ctx.cwd, input.path ?? '.');
    let entries: string[];
    try {
      entries = readdirSync(abs);
    } catch {
      return fail(`目录不存在或无法读取：${input.path ?? '.'}`);
    }
    entries.sort((a, b) => a.localeCompare(b));
    const shown = entries.slice(0, MAX_ENTRIES);
    const lines = shown.map((name) => {
      try {
        const st = statSync(join(abs, name));
        return st.isDirectory() ? `${name}/` : name;
      } catch {
        return name;
      }
    });
    let out = lines.join('\n');
    if (entries.length > MAX_ENTRIES) {
      out += `\n\n[共 ${entries.length} 项，仅显示前 ${MAX_ENTRIES} 项]`;
    }
    return ok(out === '' ? '[空目录]' : out);
  },
};
