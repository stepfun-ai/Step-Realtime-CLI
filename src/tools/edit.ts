import { readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { resolvePath } from './fsutil.js';
import { fail, ok, type ToolDef } from './types.js';
import { renderDiffClustered } from '../tui/diffView.js';

/** edit 结果预览的 diff 主体最大行数（折叠上限，超出附「N more changes hidden」）。 */
const EDIT_DIFF_MAX_LINES = 40;

const schema = z.object({
  path: z.string().describe('要编辑的文件路径。'),
  old_string: z.string().describe('要被替换的原文，必须与文件中的内容逐字符匹配。'),
  new_string: z.string().describe('替换后的新内容。'),
  replace_all: z
    .boolean()
    .optional()
    .describe('是否替换全部匹配。默认 false，此时 old_string 必须唯一。'),
});

export const editFileTool: ToolDef<z.infer<typeof schema>> = {
  name: 'edit_file',
  description:
    '对已有文件做精确字符串替换。old_string 必须与文件内容逐字符匹配。默认要求唯一匹配，replace_all=true 时替换所有匹配。',
  schema,
  access: (input, ctx) => ({ kind: 'write', path: resolvePath(ctx.cwd, input.path) }),
  async execute(input, ctx) {
    const abs = resolvePath(ctx.cwd, input.path);
    let text: string;
    try {
      text = readFileSync(abs, 'utf8');
    } catch {
      return fail(`文件不存在或无法读取：${input.path}`);
    }

    if (input.old_string === input.new_string) {
      return fail('old_string 与 new_string 相同，无需编辑。');
    }

    // 换行符处理：模型生成的 old_string 通常是 LF，而 Windows 文件多为 CRLF，
    // 逐字符精确匹配会因 \r 失配而报「未找到」。策略：
    // 1. 先按原样精确匹配（不破坏任何已能工作的场景）；
    // 2. 精确匹配失败时，把三方都归一化为 LF 再匹配（容忍换行符差异）；
    // 3. 写回时按文件原有换行风格恢复（CRLF 文件不被污染成 LF）。
    const toLF = (s: string): string => s.replace(/\r\n/g, '\n');

    let searchText = text;
    let oldStr = input.old_string;
    let newStr = input.new_string;

    let occurrences = searchText.split(oldStr).length - 1;
    if (occurrences === 0) {
      // fallback：归一化换行符后重试匹配
      const normText = toLF(text);
      const normOld = toLF(input.old_string);
      const normCount = normText.split(normOld).length - 1;
      if (normCount > 0) {
        searchText = normText;
        oldStr = normOld;
        newStr = toLF(input.new_string);
        occurrences = normCount;
      }
    }

    if (occurrences === 0) {
      return fail('未找到 old_string。请先 read_file 确认原文（含缩进与换行）后再试。');
    }
    if (occurrences > 1 && input.replace_all !== true) {
      return fail(
        `old_string 在文件中出现 ${occurrences} 次，不唯一。请补充上下文使其唯一，或设 replace_all=true。`,
      );
    }

    let next =
      input.replace_all === true
        ? searchText.split(oldStr).join(newStr)
        : searchText.replace(oldStr, newStr);

    // 若匹配走了归一化路径（searchText 已是 LF），按文件原有换行风格写回。
    // 判定「文件原本是否为 CRLF」：只要出现过 \r\n 就视为 CRLF 文件，统一转回 CRLF。
    if (searchText !== text && /\r\n/.test(text)) {
      next = next.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n');
    }

    try {
      writeFileSync(abs, next, 'utf8');
    } catch (e) {
      return fail(`写入失败：${(e as Error).message}`);
    }

    // 生成改动预览：用归一化 LF 文本算 diff（避免 CRLF 的 \r 干扰行分割）。
    const diffBody = renderDiffClustered(toLF(text), toLF(next), input.path, {
      maxLines: EDIT_DIFF_MAX_LINES,
    });
    const summary = `已编辑 ${input.path}（替换 ${occurrences} 处）。`;
    return ok(diffBody.length > 1 ? `${summary}\n${diffBody.join('\n')}` : summary);
  },
};
