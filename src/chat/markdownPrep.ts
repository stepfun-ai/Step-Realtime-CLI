/**
 * Markdown 源文本预处理：软换行合并（对齐已删除的 Ink 版 Markdown.softenBreaks 语义）。
 *
 * 背景：2026-08-15 实测（w=40 渲染探针，记录在 前端设计-pi版/20260815-交互差异清单.md）——
 * pi-tui 的 Markdown 组件把段落内的单个换行渲染成硬换行，中文文档「一句一行」的写法会被
 * 拆成一串短行。Ink 版在 token 层做合并：一侧 CJK 直接接、两侧拉丁补一个空格、
 * 词内标点（`.-/_:@`）+ 小写/数字续接直接接（保护 URL/路径/标识符）。
 *
 * pi-tui 的 Markdown 只暴露源文本级的 `transform` 钩子，没有 token 层入口，所以这里按行做：
 * 只在「连续的非结构行」之间合并，围栏代码块、表格、列表、标题、引用、分割线一律不动。
 * 行级近似与 token 级的差异：段落里混着手写的列表/标题行不会被误吞（它们以结构字符开头），
 * 代价是「段落中间夹一个缩进 continuation 行」这类罕见形态不合并——可接受的保守方向。
 */

/** CJK 与全角区间（与 Ink 版 isCjkChar 同口径）。 */
const CJK_RE = /[⺀-鿿豈-﫿＀-￯　-〿]/u;
/** 词内连接标点：后接小写/数字时换行直接删除（URL、路径、标识符不断行）。 */
const WORD_PUNCT_RE = /[.\-/_:@]/;
const LOWER_NUM_RE = /[a-z0-9]/;

/**
 * 结构行判定：这些行不参与合并（自身是 Markdown 结构，或合并会破坏语义）。
 * 空行返回 true——它本身就是段落边界，由它天然截断连续段。
 */
function isStructural(line: string): boolean {
  const t = line.trimStart();
  if (t === '') return true;
  if (t.startsWith('#')) return true; // ATX 标题
  if (t.startsWith('|')) return true; // 表格行
  if (t.startsWith('>')) return true; // 引用
  if (t.startsWith('- ') || t.startsWith('* ') || t.startsWith('+ ')) return true; // 无序列表
  if (/^\d+[.)]\s/.test(t)) return true; // 有序列表
  if (t.startsWith('```') || t.startsWith('~~~')) return true; // 围栏（主循环另做状态跟踪，这里兜底）
  if (/^(---+|\*\*\*+|___+)$/.test(t)) return true; // 分割线 / setext 二级标题线
  if (/^ {4}\S/.test(line)) return true; // 缩进代码块
  return false;
}

/**
 * 合并段落内的软换行。规则（与 Ink 版一致）：
 * - 任一侧 CJK → 直接接（中文不加空格）
 * - 前行尾是词内标点且后行首是小写/数字 → 直接接（保护 URL/路径）
 * - 其余 → 补一个空格（拉丁词间）
 */
export function softenBreaks(source: string): string {
  const lines = source.split('\n');
  const out: string[] = [];
  let inFence = false;
  for (const line of lines) {
    const t = line.trimStart();
    if (t.startsWith('```') || t.startsWith('~~~')) inFence = !inFence;
    const prev = out.length > 0 ? out[out.length - 1]! : undefined;
    if (inFence || prev === undefined || isStructural(line) || isStructural(prev)) {
      out.push(line);
      continue;
    }
    const a = prev.trimEnd().slice(-1);
    const b = t.slice(0, 1);
    if (CJK_RE.test(a) || CJK_RE.test(b) || (WORD_PUNCT_RE.test(a) && LOWER_NUM_RE.test(b))) {
      out[out.length - 1] = prev.trimEnd() + t;
    } else {
      out[out.length - 1] = `${prev.trimEnd()} ${t}`;
    }
  }
  return out.join('\n');
}

/** pi-tui Markdown 的 transform 入口签名适配（忽略可用宽度参数，合并不依赖宽度）。 */
export function markdownTransform(markdown: string): string {
  return softenBreaks(markdown);
}
