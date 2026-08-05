import { mkdirSync, writeFileSync } from 'node:fs';
import { backupBeforeWrite } from './checkpoint.js';
import { dirname } from 'node:path';
import { z } from 'zod';
import { resolvePath } from './fsutil.js';
import { fail, ok, type ToolDef } from './types.js';

const schema = z.object({
  path: z.string().describe('要写入的文件路径。缺失的父目录会自动创建。'),
  content: z.string().describe('写入的完整文件内容（整体覆盖）。'),
});

export const writeFileTool: ToolDef<z.infer<typeof schema>> = {
  name: 'write_file',
  description:
    '创建新文件或整体覆盖已有文件。会自动创建缺失的父目录。对已有文件的局部修改请优先用 edit_file。',
  schema,
  access: (input, ctx) => ({ kind: 'write', path: resolvePath(ctx.cwd, input.path) }),
  async execute(input, ctx) {
    const abs = resolvePath(ctx.cwd, input.path);
    try {
      mkdirSync(dirname(abs), { recursive: true });
      // 文件级 checkpoint：覆盖写前备份原始内容（已存在时），供 /restore 回滚
      backupBeforeWrite(ctx.cwd, abs, 'write_file');
      writeFileSync(abs, input.content, 'utf8');
    } catch (e) {
      return fail(`写入失败：${(e as Error).message}`);
    }
    const bytes = Buffer.byteLength(input.content, 'utf8');
    return ok(`已写入 ${input.path}（${bytes} 字节）。`);
  },
};
