import { Text, Box } from 'ink';
import { marked, type Token, type Tokens } from 'marked';
import { highlight } from 'cli-highlight';
import type React from 'react';
import { displayWidth } from './liveBudget.js';

/**
 * markdown 终端渲染（marked lexer + cli-highlight + chalk/Ink 样式）。
 * 把 assistant 的 markdown 文本渲染成 Ink <Text> 树。
 * transient=true（流式中）时关语法高亮（避免闪烁与开销），完成后重渲染上高亮。
 */

let key = 0;
function k(): number {
  return key++;
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
        // 链接有两种形态，显示规则不同：
        // 1. 有描述文字（`[文字](url)`）：文字与地址是两份信息，渲染为「文字 (url)」。
        // 2. 自链接（裸 URL、`<url>`、`[url](url)`）：文字就是地址本身，只有一份信息，只渲染一次。
        // marked 默认开 GFM autolink，裸 URL 也会成为 text === href 的 link token，
        // 若不区分就会把同一地址打印两遍，并在折行处留下括号残片。
        const selfLink =
          (link.tokens.length === 1 &&
            link.tokens[0].type === 'text' &&
            (link.tokens[0] as Tokens.Text).text === link.href) ||
          link.raw === link.href;
        out.push(
          <Text key={k()} color="blue" underline>
            {renderInline(link.tokens, transient)}
            {selfLink ? null : <Text color="gray">({link.href})</Text>}
          </Text>,
        );
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
function renderBlock(t: Token, transient: boolean): React.ReactNode {
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
            return (
              <Text key={k()}>
                {marker}
                {task}
                {renderInline(item.tokens, transient)}
              </Text>
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
      // 列宽 = 该列所有单元格纯文本显示宽度的最大值（宽字符按 2 列，displayWidth 见 liveBudget）
      const widths = Array.from({ length: cols }, (_, i) =>
        Math.max(
          displayWidth(tbl.header[i]?.text ?? ''),
          ...tbl.rows.map((row) => displayWidth(row[i]?.text ?? '')),
        ),
      );
      // 单元格 = 行内渲染 + 按显示宽度补齐的空格（React 节点无法 padEnd，单独补空格 Text）
      const renderCells = (cells: Tokens.TableCell[]): React.ReactNode[] =>
        widths.flatMap((w, i) => {
          const cell = cells[i];
          const pad = Math.max(w - displayWidth(cell?.text ?? ''), 0);
          const nodes: React.ReactNode[] = [
            <Text key={k()}>
              {renderInline(cell?.tokens, transient)}
              {' '.repeat(pad)}
            </Text>,
          ];
          if (i < cols - 1) nodes.push(<Text key={k()}> │ </Text>);
          return nodes;
        });
      return (
        <Box key={k()} flexDirection="column">
          <Text bold>{renderCells(tbl.header)}</Text>
          <Text color="gray">{widths.map((w) => '─'.repeat(w)).join('─┼─')}</Text>
          {tbl.rows.map((row) => (
            <Text key={k()}>{renderCells(row)}</Text>
          ))}
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
export function Markdown({ text, transient = false }: { text: string; transient?: boolean }): React.ReactElement {
  key = 0;
  const tokens = marked.lexer(text);
  return (
    <Box flexDirection="column">
      {tokens.map((t) => renderBlock(t, transient))}
    </Box>
  );
}
