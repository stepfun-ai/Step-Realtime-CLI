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

/**
 * 本次搜索的**盲区**——被跳过或未走到的部分。
 *
 * 为什么必须随结果返回：grep 返回 `[无匹配]` 时，调用方（模型）会据此推断
 * 「这个符号不存在」。但零命中有两种互斥解释：真的不存在，或者**它在没被搜到的
 * 文件里**。工具描述里写「自动忽略超大文件」不解决问题——模型读到空结果的那一刻
 * 不会回头重读工具描述。盲区必须出现在结果里，才可能被纳入判断。
 */
interface Blind {
  /** 因超过 MAX_FILE_BYTES 被跳过的文件（按体积降序取前若干个展示）。 */
  oversize: { path: string; size: number }[];
  /** 因权限等原因读取失败的文件数。 */
  unreadable: number;
  /** 因撞 MAX_FILES / MAX_MATCHES 上限而提前结束（此时盲区统计本身也不完整）。 */
  stoppedEarly: boolean;
}

function* walk(dir: string, depth: number, blind: Blind): Generator<string> {
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
      yield* walk(full, depth + 1, blind);
    } else if (st.isFile()) {
      if (st.size <= MAX_FILE_BYTES) {
        yield full;
      } else {
        blind.oversize.push({ path: full, size: st.size });
      }
    }
  }
}

/** 字节数渲染成人读单位，用于盲区提示里标注被跳过文件的体积。 */
function humanBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.round(n / 1024)} KB`;
}

/**
 * 把盲区渲染成给调用方看的提示；无盲区时返回空串。
 *
 * 措辞刻意点明「未搜索 ≠ 不存在」并给出下一步动作：光报告数字，调用方仍可能
 * 把空结果当成结论。列举上限 5 个，按体积降序——体积最大的文件恰好最可能是
 * 「搜不到的东西藏在哪」的答案。
 */
function renderBlind(blind: Blind, cwd: string): string {
  const parts: string[] = [];

  if (blind.oversize.length > 0) {
    const top = [...blind.oversize].sort((a, b) => b.size - a.size).slice(0, 5);
    const list = top
      .map((f) => `${relative(cwd, f.path).replace(/\\/g, '/')}（${humanBytes(f.size)}）`)
      .join('、');
    const more = blind.oversize.length > top.length ? `，另有 ${blind.oversize.length - top.length} 个` : '';
    parts.push(
      `${blind.oversize.length} 个文件因超过 ${humanBytes(MAX_FILE_BYTES)} 未被搜索：${list}${more}。` +
        `要覆盖它们：用 read_file 配 offset/limit 分页读，或在 bash 里跑 grep/rg。`,
    );
  }

  if (blind.unreadable > 0) {
    parts.push(`${blind.unreadable} 个文件读取失败（权限或被占用），未参与匹配。`);
  }

  if (blind.stoppedEarly) {
    parts.push(
      `搜索因触及上限提前结束（文件数上限 ${MAX_FILES} / 匹配数上限 ${MAX_MATCHES}），` +
        `目录树未走完，因此上面的盲区统计本身也不完整。缩小 path 或收紧 pattern 再搜。`,
    );
  }

  if (parts.length === 0) return '';
  return `[搜索盲区]（本次结果不覆盖以下范围，「没搜到」不等于「不存在」）\n- ${parts.join('\n- ')}`;
}

export const grepTool: ToolDef<z.infer<typeof schema>> = {
  name: 'grep',
  description:
    '在目录下按正则搜索文件内容，返回 匹配行（path:line:内容）。自动忽略 node_modules、.git、dist 等目录；' +
    '超过 512KB 的文件不参与搜索，但会在结果末尾的「搜索盲区」里逐个列出（无匹配时同样列出）——' +
    '看到盲区说明本次搜索有未覆盖范围，不能据此断定目标不存在。',
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
    const blind: Blind = { oversize: [], unreadable: 0, stoppedEarly: false };
    let fileCount = 0;
    for (const file of walk(root, 0, blind)) {
      if (++fileCount > MAX_FILES) {
        blind.stoppedEarly = true;
        break;
      }
      let text: string;
      try {
        text = readFileSync(file, 'utf8');
      } catch {
        blind.unreadable += 1;
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
      if (results.length >= MAX_MATCHES) {
        blind.stoppedEarly = true;
        break;
      }
    }

    const notice = renderBlind(blind, ctx.cwd);

    if (results.length === 0) {
      // 空结果**必须**带上盲区：否则「没搜到」会被直接当成「不存在」。
      return ok(notice === '' ? '[无匹配]' : `[无匹配]\n\n${notice}`);
    }
    let out = results.join('\n');
    if (results.length >= MAX_MATCHES) {
      out += `\n\n[结果已达上限 ${MAX_MATCHES} 条，可能还有更多匹配]`;
    }
    if (notice !== '') out += `\n\n${notice}`;
    return ok(out);
  },
};
