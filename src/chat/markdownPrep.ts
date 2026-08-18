/**
 * Markdown 源文本预处理：合并段落内的软换行。
 *
 * pi-tui 的 Markdown 把段落内单个换行渲染成硬换行，中文「一句一行」会被拆成短行。
 * 这里按行合并连续的非结构行（围栏代码块、表格、列表、标题、引用、分割线不动）；
 * 词内标点（`.-/_:@`）+ 小写/数字续接直接接，保护 URL/路径/标识符不断行。
 */

/** CJK 与全角区间。 */
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
 * 合并段落内的软换行。规则：
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
