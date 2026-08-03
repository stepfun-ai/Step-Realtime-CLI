import { closeSync, openSync, readFileSync, readSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import { z } from 'zod';
import { resolvePath } from './fsutil.js';
import { parseImageMeta } from './imageMeta.js';
import { fail, ok, type ToolDef } from './types.js';

const schema = z.object({
  path: z.string().describe('要读取的文件路径，相对当前工作目录或绝对路径。'),
  offset: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('起始行号（1 起）。省略则从头读。'),
  limit: z
    .number()
    .int()
    .positive()
    .optional()
    .describe('读取的行数。省略则读到文件末尾（受内部上限约束）。'),
});

const MAX_LINES = 2000;
const MAX_BYTES = 256 * 1024;

/**
 * 分页读取时单次载入内存的字节上限。
 *
 * MAX_BYTES 只拦「不带 offset/limit 的整文件读」，而它的错误文案恰恰引导调用方改用分页——
 * 若分页路径再走 readFileSync 全量载入，照提示操作反而会触发 OOM（实测 114MB 文件读 5 行，
 * 堆增长 119MB）。因此分页路径改为流式逐行推进，只保留窗口内的行，内存与文件大小解耦。
 */
const STREAM_CHUNK_BYTES = 64 * 1024;

/**
 * 流式按行读取指定窗口，不把整个文件载入内存。
 * 返回窗口内的行、文件总行数、以及窗口后是否还有内容。
 *
 * 逐块解码（TextDecoder stream 模式）保证多字节字符跨块边界不被切坏；
 * 只有落在 [start, start+count) 区间的行才被保留，其余读完即弃。
 */
function readLineWindow(
  file: string,
  start: number,
  count: number,
): { lines: string[]; totalLines: number } {
  const fd = openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(STREAM_CHUNK_BYTES);
    const decoder = new TextDecoder('utf8');
    const kept: string[] = [];
    let carry = ''; // 上一块末尾未完成的一行
    let lineNo = 0; // 已完结的行数
    let bytesRead: number;
    // 窗口已收满：后续只需知道总行数，切换到「字节层数换行」的廉价模式（见下方说明）。
    let windowFull = false;

    const take = (line: string): void => {
      if (lineNo >= start && kept.length < count) kept.push(line);
      lineNo += 1;
    };

    while ((bytesRead = readSync(fd, buf, 0, STREAM_CHUNK_BYTES, null)) > 0) {
      if (windowFull) {
        // 只数 \n，不解码、不拼接、不 split——一个字符串都不产生。
        // 安全性来自 UTF-8 的自同步性：多字节序列的续字节恒 ≥ 0x80，
        // 因此 0x0A 只可能是真正的换行，不可能是某个字符的一部分。
        const view = buf.subarray(0, bytesRead);
        let pos = 0;
        for (;;) {
          const idx = view.indexOf(0x0a, pos);
          if (idx === -1) break;
          lineNo += 1;
          pos = idx + 1;
        }
        continue;
      }

      const text = carry + decoder.decode(buf.subarray(0, bytesRead), { stream: true });
      const parts = text.split('\n');
      carry = parts.pop() ?? ''; // 最后一段可能是半行，留到下一轮
      for (const p of parts) take(p);

      if (count > 0 && kept.length >= count) {
        // 收满即切模式。carry 此刻可能是半行，但它必然在后续某个 \n 处完结、
        // 或者本身就是末行——两种情况都由「循环后无条件 +1」补上，故这里直接丢弃，
        // 不必再维护它。count === 0 时不切（否则第一块就命中，行为退化）。
        windowFull = true;
        carry = '';
      }
    }

    if (windowFull) {
      // 与下方 take(carry) 的无条件 +1 等价：代表最后一个 \n 之后的那一段
      // （文件以 \n 结尾时它是空串，同样计入——「共 N 行」的既有语义）。
      lineNo += 1;
    } else {
      // flush 解码器残留 + 最后一行（文件不以 \n 结尾时 carry 就是末行）
      carry += decoder.decode();
      take(carry);
    }

    return { lines: kept, totalLines: lineNo };
  } finally {
    closeSync(fd);
  }
}

/** 图片扩展名（小写，带点）：命中即引导去 read_media，不让图片落到「文件过大请分页」的误导文案。 */
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico']);

/** 嗅探开头若干字节是否含 NUL（文本文件不会含 NUL，是二进制的可靠信号）。 */
function containsNul(buf: Buffer): boolean {
  return buf.includes(0);
}

/**
 * 渲染读取窗口：每行「行号<TAB>内容」+ 末尾 <system> 状态块。
 * 全量读与流式分页读共用，保证两条路径的输出格式逐字符一致。
 */
function renderWindow(slice: string[], start: number, totalLines: number): string {
  const endLine = start + slice.length;
  const truncated = endLine < totalLines;
  const numbered = slice.map((line, i) => `${start + i + 1}\t${line}`).join('\n');
  const status = `<system>已读取第 ${start + 1}-${endLine} 行，共 ${totalLines} 行${
    truncated ? '（已截断，用 offset/limit 继续翻页）' : '（完整）'
  }。</system>`;
  return `${numbered}\n${status}`;
}

export const readFileTool: ToolDef<z.infer<typeof schema>> = {
  name: 'read_file',
  description:
    '读取文本文件内容。支持用 offset/limit 按行分页。每行以「行号<TAB>内容」返回，末尾附 <system> 状态块（读取行数、总行数、是否截断）。图片请用 read_media。',
  schema,
  access: (input, ctx) => ({ kind: 'read', path: resolvePath(ctx.cwd, input.path) }),
  async execute(input, ctx) {
    const abs = resolvePath(ctx.cwd, input.path);
    let st;
    try {
      st = statSync(abs);
    } catch {
      return fail(`文件不存在：${input.path}`);
    }
    if (st.isDirectory()) {
      return fail(`这是一个目录，不是文件：${input.path}。请用 list_dir。`);
    }

    // 二进制识别前置：图片与含 NUL 的二进制不该落到「文件过大请分页」或乱码文本的误导路径。
    // 图片按扩展名或魔数判定，引导去 read_media；其余含 NUL 的按二进制拒绝。
    const ext = extname(abs).toLowerCase();
    if (IMAGE_EXTS.has(ext)) {
      return fail(`这是图片文件，请用 read_media 读取（path=${input.path}）。`);
    }
    if (st.size > 0) {
      let head: Buffer;
      try {
        // 只读头部 8KB 做嗅探，不整读（大二进制文件整读会撑内存）
        const fd = openSync(abs, 'r');
        try {
          head = Buffer.alloc(Math.min(st.size, 8192));
          readSync(fd, head, 0, head.length, 0);
        } finally {
          closeSync(fd);
        }
      } catch (e) {
        return fail(`读取失败：${(e as Error).message}`);
      }
      if (parseImageMeta(head) !== null) {
        return fail(`这是图片文件，请用 read_media 读取（path=${input.path}）。`);
      }
      if (containsNul(head)) {
        return fail(`这是二进制文件，无法用 read_file 读取：${input.path}`);
      }
    }

    const paged = input.offset !== undefined || input.limit !== undefined;

    if (st.size > MAX_BYTES && !paged) {
      return fail(
        `文件过大（${st.size} 字节，超过 ${MAX_BYTES}）。请用 offset/limit 分页读取。`,
      );
    }

    const start = input.offset !== undefined ? input.offset - 1 : 0;
    const count = Math.min(input.limit ?? MAX_LINES, MAX_LINES);

    // 大文件分页：流式读窗口，内存不随文件大小增长（上面的错误文案正引导到这条路径）
    if (paged && st.size > MAX_BYTES) {
      let win: { lines: string[]; totalLines: number };
      try {
        win = readLineWindow(abs, start, count);
      } catch (e) {
        return fail(`读取失败：${(e as Error).message}`);
      }
      return ok(renderWindow(win.lines, start, win.totalLines));
    }

    let text: string;
    try {
      text = readFileSync(abs, 'utf8');
    } catch (e) {
      return fail(`读取失败：${(e as Error).message}`);
    }

    if (text === '') {
      return ok('<system>文件为空（0 字节）。</system>');
    }

    const lines = text.split('\n');
    return ok(renderWindow(lines.slice(start, start + count), start, lines.length));
  },
};
