import { Text, Box } from 'ink';
import { marked, type Token, type Tokens } from 'marked';
import { highlight } from 'cli-highlight';
import type React from 'react';
import { displayWidth, wrappedRows } from './liveBudget.js';
import { link as hyperlink, supportsHyperlinks } from './hyperlink.js';

/**
 * markdown 终端渲染（marked lexer + cli-highlight + chalk/Ink 样式）。
 * 把 assistant 的 markdown 文本渲染成 Ink <Text> 树。
 * transient=true（流式中）时关语法高亮（避免闪烁与开销），完成后重渲染上高亮。
 */

let key = 0;
function k(): number {
  return key++;
}

/** 自链接判等（裸 URL / `<url>` / `[url](url)` 都视为自链接）。 */
function isSelfLink(link: Tokens.Link): boolean {
  return (
    (link.tokens.length === 1 &&
      link.tokens[0].type === 'text' &&
      (link.tokens[0] as Tokens.Text).text === link.href) ||
    link.raw === link.href
  );
}

/** 行内 token → React 节点（加粗/斜体/行内码/删除线/链接）。 */
function renderInline(tokens: Token[] | undefined, transient: boolean): React.ReactNode[] {
  if (tokens === undefined) return [];
  const out: React.ReactNode[] = [];
  for (const t of tokens) {
    switch (t.type) {
      case 'strong':
        out.push(
          <Text key={k()} bold>
            {renderInline((t as Tokens.Strong).tokens, transient)}
          </Text>,
        );
        break;
      case 'em':
        out.push(
          <Text key={k()} italic>
            {renderInline((t as Tokens.Em).tokens, transient)}
          </Text>,
        );
        break;
      case 'codespan':
        out.push(
          <Text key={k()} color="cyan" backgroundColor="#2a2a2a">
            {(t as Tokens.Codespan).text}
          </Text>,
        );
        break;
      case 'del':
        out.push(
          <Text key={k()} strikethrough>
            {renderInline((t as Tokens.Del).tokens, transient)}
          </Text>,
        );
        break;
      case 'link': {
        const link = t as Tokens.Link;
        const selfLink = isSelfLink(link);
        const linkText = renderInline(link.tokens, transient);
        if (supportsHyperlinks() && !selfLink) {
          out.push(
            <Text key={k()} color="blue" underline>
              {hyperlink(renderInlineText(link.tokens), link.href)}
            </Text>,
          );
        } else {
          out.push(
            <Text key={k()} color="blue" underline>
              {linkText}
              {selfLink ? null : <Text color="gray">({link.href})</Text>}
            </Text>,
          );
        }
        break;
      }
      case 'text':
        out.push(<Text key={k()}>{(t as Tokens.Text).text}</Text>);
        break;
      case 'escape':
        out.push(<Text key={k()}>{(t as Tokens.Escape).text}</Text>);
        break;
      default:
        out.push(<Text key={k()}>{'raw' in t ? (t.raw as string) : ''}</Text>);
    }
  }
  return out;
}

/** 单元格内联样式段（用于宽度计算与换行）。 */
interface StyledSegment {
  text: string;
  bold?: boolean;
  italic?: boolean;
  color?: string;
  underline?: boolean;
  strikethrough?: boolean;
  backgroundColor?: string;
}

/** 将 inline tokens 展平为样式段数组，与 renderInline 的最终文本保持一致。 */
function extractCellSegments(tokens: Token[] | undefined, transient: boolean): StyledSegment[] {
  if (tokens === undefined) return [];
  const out: StyledSegment[] = [];
  for (const t of tokens) {
    switch (t.type) {
      case 'strong': {
        const inner = extractCellSegments((t as Tokens.Strong).tokens, transient);
        for (const seg of inner) seg.bold = true;
        out.push(...inner);
        break;
      }
      case 'em': {
        const inner = extractCellSegments((t as Tokens.Em).tokens, transient);
        for (const seg of inner) seg.italic = true;
        out.push(...inner);
        break;
      }
      case 'codespan':
        out.push({ text: (t as Tokens.Codespan).text, color: 'cyan', backgroundColor: '#2a2a2a' });
        break;
      case 'del': {
        const inner = extractCellSegments((t as Tokens.Del).tokens, transient);
        for (const seg of inner) seg.strikethrough = true;
        out.push(...inner);
        break;
      }
      case 'link': {
        const link = t as Tokens.Link;
        const inner = extractCellSegments(link.tokens, transient);
        for (const seg of inner) {
          seg.color = seg.color ?? 'blue';
          seg.underline = true;
        }
        out.push(...inner);
        if (!isSelfLink(link) && !supportsHyperlinks()) {
          out.push({ text: `(${link.href})`, color: 'gray' });
        }
        break;
      }
      case 'text':
        out.push({ text: (t as Tokens.Text).text });
        break;
      case 'escape':
        out.push({ text: (t as Tokens.Escape).text });
        break;
      default:
        if ('raw' in t) out.push({ text: (t as any).raw as string });
    }
  }
  return out;
}

/** 将 extractCellSegments 的纯文本宽度计算出来（含链接 href 后缀等渲染细节）。 */
function renderInlineText(tokens: Token[] | undefined): string {
  return extractCellSegments(tokens, false).map((s) => s.text).join('');
}

/** 对一段文本找最长单词的显示宽度（上限 maxWidth）。 */
function longestWordWidth(text: string, maxWidth: number): number {
  const words = text.split(/\s+/).filter((w) => w.length > 0);
  let longest = 0;
  for (const w of words) {
    longest = Math.max(longest, displayWidth(w));
  }
  return Math.min(longest, maxWidth);
}

/**
 * 表格列宽分配：两遍扫描得出各列自然宽度与最小可读宽度，
 * 总宽超出可用宽度时按 grow potential 比例收缩，余数逐列补齐。
 * 返回 null 表示可用宽度太窄，调用方应回退 raw markdown。
 */
interface ColumnWidthResult {
  allocated: number[];
}

function computeColumnWidths(tbl: Tokens.Table, availableWidth: number): ColumnWidthResult | null {
  const numCols = tbl.header.length;
  if (numCols === 0) return { allocated: [] };

  // border overhead: "│ " + (n-1)*" │ " + " │" = 2 + (n-1)*3 + 2 = 3n + 1
  const borderOverhead = 3 * numCols + 1;
  const availableForCells = availableWidth - borderOverhead;
  if (availableForCells < numCols) {
    return null;
  }

  const maxUnbrokenWordWidth = 30;

  // 两遍扫描：naturalWidths + minWordWidths
  const naturalWidths: number[] = [];
  const minWordWidths: number[] = [];
  for (let i = 0; i < numCols; i++) {
    const headerText = renderInlineText(tbl.header[i]?.tokens);
    naturalWidths[i] = displayWidth(headerText);
    minWordWidths[i] = Math.max(1, longestWordWidth(headerText, maxUnbrokenWordWidth));
  }
  for (const row of tbl.rows) {
    for (let i = 0; i < numCols; i++) {
      const cellText = renderInlineText(row[i]?.tokens);
      const cellWidth = displayWidth(cellText);
      if (cellWidth > (naturalWidths[i] ?? 0)) naturalWidths[i] = cellWidth;
      minWordWidths[i] = Math.max(
        minWordWidths[i] ?? 1,
        longestWordWidth(cellText, maxUnbrokenWordWidth),
      );
    }
  }

  let minColumnWidths = minWordWidths;
  let minCellsWidth = minColumnWidths.reduce((a, b) => a + b, 0);

  if (minCellsWidth > availableForCells) {
    minColumnWidths = new Array(numCols).fill(1);
    const remaining = availableForCells - numCols;
    if (remaining > 0) {
      const totalWeight = minWordWidths.reduce((total, width) => total + Math.max(0, width - 1), 0);
      const growth = minWordWidths.map((width) => {
        const weight = Math.max(0, width - 1);
        return totalWeight > 0 ? Math.floor((weight / totalWeight) * remaining) : 0;
      });
      for (let i = 0; i < numCols; i++) {
        minColumnWidths[i] = (minColumnWidths[i] ?? 1) + (growth[i] ?? 0);
      }
      const allocated = growth.reduce((total, width) => total + width, 0);
      let leftover = remaining - allocated;
      let idx = 0;
      while (leftover > 0 && idx < numCols) {
        minColumnWidths[idx] = (minColumnWidths[idx] ?? 1) + 1;
        leftover--;
        idx++;
      }
    }
    minCellsWidth = minColumnWidths.reduce((a, b) => a + b, 0);
  }

  const totalNaturalWidth = naturalWidths.reduce((a, b) => a + b, 0) + borderOverhead;
  let columnWidths: number[];

  if (totalNaturalWidth <= availableWidth) {
    columnWidths = naturalWidths.map((width, index) => Math.max(width, minColumnWidths[index] ?? 1));
  } else {
    const totalGrowPotential = naturalWidths.reduce((total, width, index) => {
      return total + Math.max(0, width - (minColumnWidths[index] ?? 1));
    }, 0);
    const extraWidth = Math.max(0, availableForCells - minCellsWidth);
    columnWidths = minColumnWidths.map((minWidth, index) => {
      const naturalWidth = naturalWidths[index] ?? 0;
      const minWidthDelta = Math.max(0, naturalWidth - minWidth);
      let grow = 0;
      if (totalGrowPotential > 0) {
        grow = Math.floor((minWidthDelta / totalGrowPotential) * extraWidth);
      }
      return minWidth + grow;
    });

    const allocatedWidth = columnWidths.reduce((a, b) => a + b, 0);
    let remaining = availableForCells - allocatedWidth;
    let grew = true;
    while (remaining > 0 && grew) {
      grew = false;
      for (let i = 0; i < numCols && remaining > 0; i++) {
        if (columnWidths[i] < (naturalWidths[i] ?? 0)) {
          columnWidths[i]++;
          remaining--;
          grew = true;
        }
      }
    }
  }

  return { allocated: columnWidths };
}

/** 判断字符是否为 CJK（可在任意位置断行）。 */
function isCjkChar(ch: string): boolean {
  const cp = ch.codePointAt(0);
  if (cp === undefined) return false;
  return (
    (cp >= 0x1100 && cp <= 0x115f) || // Hangul Jamo
    (cp >= 0x2e80 && cp <= 0x303e) || // CJK 部首 / 标点
    (cp >= 0x3041 && cp <= 0x33ff) || // 假名 / 兼容
    (cp >= 0x3400 && cp <= 0x4dbf) || // CJK 扩展 A
    (cp >= 0x4e00 && cp <= 0x9fff) || // CJK 统一表意
    (cp >= 0xa000 && cp <= 0xa4cf) || // 彝文
    (cp >= 0xac00 && cp <= 0xd7a3) || // 谚文音节
    (cp >= 0xf900 && cp <= 0xfaff) || // CJK 兼容表意
    (cp >= 0xfe30 && cp <= 0xfe4f) || // CJK 兼容形式
    (cp >= 0xff00 && cp <= 0xff60) || // 全角形式
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x20000 && cp <= 0x3fffd) // CJK 扩展 B+
  );
}

/**
 * 把一个非空白片段切成「可断单元」：CJK 逐字成单元，连续拉丁串保持整体。
 * 中文不按空格分词，不切就会整段挤到下一行、留下大片空白。
 */
function splitBreakUnits(part: string): string[] {
  const units: string[] = [];
  let buf = '';
  for (const ch of Array.from(part)) {
    if (isCjkChar(ch)) {
      if (buf !== '') {
        units.push(buf);
        buf = '';
      }
      units.push(ch);
    } else {
      buf += ch;
    }
  }
  if (buf !== '') units.push(buf);
  return units;
}

/**
 * URL-like 单元识别：带 scheme、`www.` 或 `localhost` 开头的连续非空白串。
 * 用于折行保护——见 wrapStyledSegments 的超长分支。
 */
const URL_LIKE_RE = /^(https?:\/\/|www\.|localhost(?::\d+)?(?:\/|$))\S+$/;

/**
 * Greedy wrap：拉丁文优先在空格处断行，CJK 允许逐字换行。
 * 超长单元（>maxWidth）会被拆到字符级；但 URL-like 单元例外——
 * 拆断的 URL 不可读也不可被终端识别为链接，宁可独占一行超宽溢出，
 * 交给终端硬折行（逻辑行保持完整），不做字符级拆分。
 */
export function wrapStyledSegments(segments: StyledSegment[], maxWidth: number): StyledSegment[][] {
  if (maxWidth <= 0) return [[]];
  const lines: StyledSegment[][] = [[]];
  let lineWidth = 0;

  const breakLine = () => {
    lines.push([]);
    lineWidth = 0;
  };

  const append = (seg: StyledSegment, text: string) => {
    if (text.length === 0) return;
    lines[lines.length - 1].push({ ...seg, text });
    lineWidth += displayWidth(text);
  };

  for (const seg of segments) {
    if (seg.text === '') continue;
    // 先按空白分割，空白处是拉丁文的天然断点
    const parts = seg.text.split(/(\s+)/);
    for (const part of parts) {
      if (part === '') continue;
      if (/^\s+$/.test(part)) {
        // 行首的空白直接丢弃（折行后不留缩进），行内空白正常保留
        if (lineWidth > 0) append(seg, part);
        continue;
      }
      for (const unit of splitBreakUnits(part)) {
        const w = displayWidth(unit);
        if (w <= maxWidth) {
          if (lineWidth + w > maxWidth && lineWidth > 0) breakLine();
          append(seg, unit);
        } else if (URL_LIKE_RE.test(unit)) {
          // 超宽 URL：独占一行整体溢出，不做字符级拆分（拆断的 URL 不可读不可点）
          if (lineWidth > 0) breakLine();
          append(seg, unit);
          breakLine();
        } else {
          // 超长拉丁单词：拆到字符级
          for (const ch of Array.from(unit)) {
            const cw = displayWidth(ch);
            if (lineWidth + cw > maxWidth && lineWidth > 0) breakLine();
            append(seg, ch);
          }
        }
      }
    }
  }

  // 去掉每行尾部空白（补齐逻辑会重新填空格，尾随空白会撑歪列宽）
  for (const line of lines) {
    while (line.length > 0 && /^\s+$/.test(line[line.length - 1]!.text)) line.pop();
  }

  if (lines.length === 0) return [[]];
  return lines;
}

/** 将 StyledSegment 数组渲染为 Ink React 节点。 */
function renderStyledSegments(segments: StyledSegment[], keyPrefix: string): React.ReactNode[] {
  return segments.map((seg, i) => (
    <Text
      key={`${keyPrefix}-${i}`}
      bold={seg.bold}
      italic={seg.italic}
      color={seg.color}
      underline={seg.underline}
      strikethrough={seg.strikethrough}
      backgroundColor={seg.backgroundColor}
    >
      {seg.text}
    </Text>
  ));
}

/** 代码块高亮（transient 时跳过，直接返回原文）。 */
function highlightCode(code: string, lang: string | undefined, transient: boolean): string {
  if (transient) return code;
  try {
    return highlight(code, { language: lang !== undefined && lang !== '' ? lang : 'text', ignoreIllegals: true });
  } catch {
    return code;
  }
}

/** 块级 token → React 节点。 */
function renderBlock(t: Token, transient: boolean, width?: number): React.ReactNode {
  switch (t.type) {
    case 'heading': {
      const h = t as Tokens.Heading;
      const prefix = h.depth <= 2 ? '' : '#'.repeat(h.depth) + ' ';
      return (
        <Text key={k()} bold color="magenta" underline={h.depth === 1}>
          {prefix}
          {renderInline(h.tokens, transient)}
        </Text>
      );
    }
    case 'paragraph':
      return <Text key={k()}>{renderInline((t as Tokens.Paragraph).tokens, transient)}</Text>;
    case 'code': {
      const c = t as Tokens.Code;
      return (
        <Box key={k()} flexDirection="column" borderStyle="round" borderColor="gray" paddingX={1}>
          {c.lang !== undefined && c.lang !== '' ? <Text color="gray">{c.lang}</Text> : null}
          <Text>{highlightCode(c.text, c.lang, transient)}</Text>
        </Box>
      );
    }
    case 'list': {
      const l = t as Tokens.List;
      return (
        <Box key={k()} flexDirection="column">
          {l.items.map((item, i) => {
            const marker = l.ordered ? `${(l.start as number) + i}. ` : '• ';
            const task = item.task ? (item.checked ? '[x] ' : '[ ] ') : '';
            // marker 与正文分成「行向 Box + flexShrink 正文盒」两个节点：
            // 正文在自己的 Yoga 盒子里折行，续行获得悬挂缩进（对齐正文而非 marker）。
            // 原先 marker 与正文同一 Text，续行顶格，视觉上像「突然换行」。
            // 与 user `› ` / assistant `● ` 前缀同一套防 Ink squash 模式。
            // 改行结构必须同步改 measureBlock 的 list 分支（行数测量契约）。
            return (
              <Box key={k()} flexDirection="row">
                <Text>
                  {marker}
                  {task}
                </Text>
                <Box flexShrink={1}>
                  <Text>{renderInline(item.tokens, transient)}</Text>
                </Box>
              </Box>
            );
          })}
        </Box>
      );
    }
    case 'blockquote':
      return (
        <Text key={k()} color="gray" italic>
          {'│ '}
          {(t as Tokens.Blockquote).text}
        </Text>
      );
    case 'hr':
      return (
        <Text key={k()} color="gray">
          {'─'.repeat(40)}
        </Text>
      );
    case 'table': {
      const tbl = t as Tokens.Table;
      const cols = tbl.header.length;

      // 有可用宽度时：按列宽分配算法计算；无宽度时走自然宽度
      const hasWidth = width !== undefined;
      const widthResult = hasWidth ? computeColumnWidths(tbl, width) : null;

      if (hasWidth && widthResult === null) {
        // 可用宽度太窄，回退原始 markdown 文本
        return <Text key={k()}>{tbl.raw || ''}</Text>;
      }

      if (!hasWidth) {
        // 自然宽度：取最大值渲染，超宽交给终端硬折行（与上一版行为一致）
        const widths = Array.from({ length: cols }, (_, i) =>
          Math.max(
            displayWidth(renderInlineText(tbl.header[i]?.tokens)),
            ...tbl.rows.map((row) => displayWidth(renderInlineText(row[i]?.tokens))),
          ),
        );
        const renderRowNodes = (cells: Tokens.TableCell[], bold = false): React.ReactNode => {
          const nodes: React.ReactNode[] = [];
          for (let i = 0; i < cells.length; i++) {
            const cell = cells[i];
            const text = renderInline(cell?.tokens, transient);
            const cellWidth = displayWidth(renderInlineText(cell?.tokens));
            const pad = Math.max((widths[i] ?? 0) - cellWidth, 0);
            nodes.push(...text);
            nodes.push(' '.repeat(pad));
            if (i < cells.length - 1) nodes.push(' │ ');
          }
          return bold ? <Text key={k()} bold>{nodes}</Text> : <Text key={k()}>{nodes}</Text>;
        };
        return (
          <Box key={k()} flexDirection="column">
            {renderRowNodes(tbl.header, true)}
            <Text color="gray">{widths.map((w) => '─'.repeat(w)).join('─┼─')}</Text>
            {tbl.rows.map((row) => (
              <Text key={k()}>{renderRowNodes(row)}</Text>
            ))}
          </Box>
        );
      }

      // 宽度自适应渲染（完整外框，与 borderOverhead = 3n + 1 的预留一致）
      const { allocated } = widthResult!;

      const renderRow = (cells: Tokens.TableCell[], rowKey: string, bold = false): React.ReactNode[] => {
        const cellLines: StyledSegment[][][] = allocated.map((w, ci) =>
          wrapStyledSegments(extractCellSegments(cells[ci]?.tokens, transient), w),
        );
        const maxLines = Math.max(...cellLines.map((lines) => lines.length), 1);

        const rows: React.ReactNode[] = [];
        for (let lineIdx = 0; lineIdx < maxLines; lineIdx++) {
          const parts: React.ReactNode[] = [
            <Text key={`${rowKey}-bl${lineIdx}`} color="gray">
              {'│ '}
            </Text>,
          ];
          for (let colIdx = 0; colIdx < allocated.length; colIdx++) {
            const colWidth = allocated[colIdx] ?? 1;
            const line = cellLines[colIdx]?.[lineIdx] ?? [];
            parts.push(...renderStyledSegments(line, `${rowKey}-l${lineIdx}c${colIdx}`));
            // 补齐到分配宽度，否则列分隔符无法纵向对齐
            const lineWidth = line.reduce((sum, seg) => sum + displayWidth(seg.text), 0);
            const pad = Math.max(colWidth - lineWidth, 0);
            if (pad > 0) parts.push(<Text key={`${rowKey}-p${lineIdx}c${colIdx}`}>{' '.repeat(pad)}</Text>);
            parts.push(
              <Text key={`${rowKey}-s${lineIdx}c${colIdx}`} color="gray">
                {colIdx < allocated.length - 1 ? ' │ ' : ' │'}
              </Text>,
            );
          }
          rows.push(
            bold ? (
              <Text key={`${rowKey}-r${lineIdx}`} bold>
                {parts}
              </Text>
            ) : (
              <Text key={`${rowKey}-r${lineIdx}`}>{parts}</Text>
            ),
          );
        }
        return rows;
      };

      const cellRules = allocated.map((w) => '─'.repeat(w));
      const topBorder = `┌─${cellRules.join('─┬─')}─┐`;
      const headerSep = `├─${cellRules.join('─┼─')}─┤`;
      const bottomBorder = `└─${cellRules.join('─┴─')}─┘`;

      return (
        <Box key={k()} flexDirection="column">
          <Text color="gray">{topBorder}</Text>
          {renderRow(tbl.header, 'h', true)}
          <Text color="gray">{headerSep}</Text>
          {tbl.rows.flatMap((row, ri) => renderRow(row, `b${ri}`))}
          <Text color="gray">{bottomBorder}</Text>
        </Box>
      );
    }
    case 'space':
      return <Text key={k()}> </Text>;
    default:
      return 'text' in t && typeof (t as { text?: string }).text === 'string' ? (
        <Text key={k()}>{(t as { text: string }).text}</Text>
      ) : null;
  }
}

/** 渲染 markdown 文本为 Ink 组件树。 */
export function Markdown({
  text,
  transient = false,
  width,
}: {
  text: string;
  transient?: boolean;
  width?: number;
}): React.ReactElement {
  key = 0;
  const tokens = marked.lexer(text);
  return (
    <Box flexDirection="column">
      {tokens.map((t) => renderBlock(t, transient, width))}
    </Box>
  );
}

/**
 * 测量一段 markdown 渲染后占用的终端行数。
 *
 * 存在的理由：`liveBudget` 要求弹层给出行数预算，而 markdown 的**渲染行数与源行数不等**——
 * 表格一条数据行可能渲染成多行（单元格折行）、外框另占 4 行，代码块有边框和可选语言行。
 * 直接用 `text.split('\n').length` 会系统性低估，低估会让动态帧超过终端高度，
 * 触发 Ink 的全量清屏分支（清空 scrollback，历史输出丢失）。
 *
 * **契约是单向的：返回值必须 ≥ 实际渲染行数。** 允许高估（代价是动态区少用一行），
 * 禁止低估（代价是清屏）。因此所有拿不准的地方一律向上取整。
 *
 * 与 `renderBlock` 共用 `marked.lexer` token 流、`computeColumnWidths` 列宽算法与
 * `wrapStyledSegments` 折行逻辑，两者不是各写一份、不会各自漂移。
 * 改 `renderBlock` 的行结构时必须同步改这里（tests/tui/measureMarkdownRows.test.tsx 会失败提醒）。
 */
export function measureMarkdownRows(text: string, width?: number): number {
  let rows = 0;
  for (const token of marked.lexer(text)) rows += measureBlock(token, width);
  return rows;
}

/** 单个 token 的渲染行数。分支与 renderBlock 的 switch 逐个对应。 */
function measureBlock(t: Token, width?: number): number {
  switch (t.type) {
    case 'heading': {
      const h = t as Tokens.Heading;
      const prefix = h.depth <= 2 ? '' : `${'#'.repeat(h.depth)} `;
      return wrappedRows(prefix + renderInlineText(h.tokens), width);
    }
    case 'paragraph':
      return wrappedRows(renderInlineText((t as Tokens.Paragraph).tokens), width);
    case 'code': {
      const c = t as Tokens.Code;
      // Box borderStyle=round + paddingX=1：上下边框 2 行，左右边框+padding 占 4 列
      const inner = width === undefined ? undefined : Math.max(1, width - 4);
      const langRow = c.lang !== undefined && c.lang !== '' ? 1 : 0;
      // highlightCode 只加 ANSI 着色、不改行结构，故按原文逐行折行计
      const codeRows = c.text.split('\n').reduce((n, line) => n + wrappedRows(line, inner), 0);
      return 2 + langRow + codeRows;
    }
    case 'list': {
      const l = t as Tokens.List;
      return l.items.reduce((n, item, i) => {
        const marker = l.ordered ? `${(l.start as number) + i}. ` : '• ';
        const task = item.task ? (item.checked ? '[x] ' : '[ ] ') : '';
        // 悬挂缩进渲染：正文折行宽度 = 总宽 - marker 宽度（与 renderBlock 的
        // 行向 Box + flexShrink 结构一致）；空内容条目也占 1 行
        const prefixW = displayWidth(marker + task);
        const contentWidth = width === undefined ? undefined : Math.max(1, width - prefixW);
        return n + Math.max(1, wrappedRows(renderInlineText(item.tokens), contentWidth));
      }, 0);
    }
    case 'blockquote':
      return wrappedRows(`│ ${(t as Tokens.Blockquote).text}`, width);
    case 'hr':
      return wrappedRows('─'.repeat(40), width);
    case 'table':
      return measureTable(t as Tokens.Table, width);
    case 'space':
      return 1;
    default:
      return 'text' in t && typeof (t as { text?: string }).text === 'string'
        ? wrappedRows((t as { text: string }).text, width)
        : 0;
  }
}

/** 表格的渲染行数：三种模式（窄屏回退 / 自然宽度 / 宽度自适应）与 renderBlock 一一对应。 */
function measureTable(tbl: Tokens.Table, width?: number): number {
  const hasWidth = width !== undefined;
  const widthResult = hasWidth ? computeColumnWidths(tbl, width) : null;

  // 模式一：宽度太窄，renderBlock 回退渲染 tbl.raw 纯文本
  if (hasWidth && widthResult === null) {
    return (tbl.raw || '').split('\n').reduce((n, line) => n + wrappedRows(line, width), 0);
  }

  // 模式二：无宽度信息，自然宽度渲染（表头 + 分隔线 + 每数据行各 1 行，超宽交给终端硬折行）
  if (!hasWidth) return 2 + tbl.rows.length;

  // 模式三：宽度自适应。外框 4 行（顶框/表头分隔/底框 3 行 + 表头自身另算）
  // 每个逻辑行的高度 = 该行各单元格折行后的最大行数。
  // 注意超宽 URL 行：wrapStyledSegments 输出的是 1 条逻辑行，但 Ink 会在列宽处硬折行，
  // 实际占 ceil(行宽/列宽) 个视觉行——测量必须按视觉行数，否则违反「只准高估」契约。
  const { allocated } = widthResult!;
  const visualRows = (line: StyledSegment[], colWidth: number): number => {
    const lw = line.reduce((x, s) => x + displayWidth(s.text), 0);
    return Math.max(1, Math.ceil(lw / colWidth));
  };
  const rowHeight = (cells: Tokens.TableCell[]): number => {
    const lines = allocated.map((w, ci) =>
      wrapStyledSegments(extractCellSegments(cells[ci]?.tokens, false), w).reduce(
        (n, line) => n + visualRows(line, w),
        0,
      ),
    );
    return Math.max(...lines, 1);
  };
  // 顶框 1 + 表头 n + 分隔线 1 + 数据行各自高度 + 底框 1
  return 3 + rowHeight(tbl.header) + tbl.rows.reduce((n, row) => n + rowHeight(row), 0);
}
