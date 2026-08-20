import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { z } from 'zod';
import { resolvePath } from './fsutil.js';
import { fail, ok, type ToolDef } from './types.js';
import { looksBinaryByHead, scanLinesStreaming, MAX_LINE_BYTES } from './grepScan.js';

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
 *
 * 2026-08-03 起**不再有 `oversize` 类别**：大文件改走流式逐行扫描，不再被跳过，
 * 那个盲区已被消除而不只是被报告。剩下的三类都是无法靠实现方式消掉的。
 */
interface Blind {
  /** 因权限等原因读取失败的文件数。 */
  unreadable: number;
  /** 因撞 MAX_FILES / MAX_MATCHES 上限而提前结束（此时盲区统计本身也不完整）。 */
  stoppedEarly: boolean;
  /** 含超长单行、该行只有前 MAX_LINE_BYTES 参与匹配的文件（记真实行字节数）。 */
  longLines: { path: string; bytes: number }[];
}

/**
 * 遍历出所有候选文件**及其体积**——体积决定走全量读还是流式扫描，所以必须一并交出，
 * 否则调用方要再 stat 一次。
 */
function* walk(dir: string, depth: number): Generator<{ path: string; size: number }> {
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
    } else if (st.isFile()) {
      yield { path: full, size: st.size };
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

  if (blind.longLines.length > 0) {
    const top = [...blind.longLines].sort((a, b) => b.bytes - a.bytes).slice(0, 5);
    const list = top
      .map((f) => `${relative(cwd, f.path).replace(/\\/g, '/')}（单行 ${humanBytes(f.bytes)}）`)
      .join('、');
    const more =
      blind.longLines.length > top.length ? `，另有 ${blind.longLines.length - top.length} 个` : '';
    parts.push(
      `${blind.longLines.length} 个文件含超长单行，每行只有前 ${humanBytes(MAX_LINE_BYTES)} 参与匹配：` +
        `${list}${more}。这类文件多是压缩产物或单行 JSON；要完整检查请用 bash 里的 grep/rg，` +
        `或先格式化再搜。`,
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
    '文件大小不限（大文件走流式扫描），但**含超长单行的文件每行只有前 1MB 参与匹配**，' +
    '这类情况会在结果末尾的「搜索盲区」里列出（无匹配时同样列出）——看到盲区说明本次搜索有未覆盖范围，' +
    '不能据此断定目标不存在。',
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
    const blind: Blind = { unreadable: 0, stoppedEarly: false, longLines: [] };
    let fileCount = 0;
    for (const { path: file, size } of walk(root, 0)) {
      if (++fileCount > MAX_FILES) {
        blind.stoppedEarly = true;
        break;
      }
      const rel = relative(ctx.cwd, file).replace(/\\/g, '/');
      /**
       * 收一条匹配。返回 false = 已达上限、停止扫描。
       * 两条读取路径共用它，匹配与截断规则因此只有一份，不会分叉。
       */
      const take = (line: string, lineNo: number): boolean => {
        if (re.test(line)) results.push(`${rel}:${lineNo}:${line.slice(0, 300)}`);
        return results.length < MAX_MATCHES;
      };

      if (size <= MAX_FILE_BYTES) {
        // 小文件：一次 syscall 读完更快，且二进制判定能看全文。绝大多数源码在此区间，
        // 保留这条路径是为了性能不退化。
        let text: string;
        try {
          text = readFileSync(file, 'utf8');
        } catch {
          blind.unreadable += 1;
          continue;
        }
        if (text.includes('\u0000')) continue; // 跳过二进制
        const lines = text.split('\n');
        for (let i = 0; i < lines.length; i++) if (!take(lines[i]!, i + 1)) break;
      } else {
        // 大文件：流式逐行，内存与文件大小解耦。逐行匹配使正则不可能跨行，
        // 因此按行切分与「全量读入再 split」语义等价（详见 grepScan.ts）。
        try {
          if (looksBinaryByHead(file)) continue;
          const stat = scanLinesStreaming(file, take);
          if (stat.truncatedLineBytes > 0) {
            blind.longLines.push({ path: file, bytes: stat.truncatedLineBytes });
          }
        } catch {
          blind.unreadable += 1;
          continue;
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
