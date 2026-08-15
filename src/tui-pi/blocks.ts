/**
 * 转录区的消息块组件：把 DisplayItem 渲染成行数组。
 *
 * 与 Ink 版的结构差异（迁移设计里最值得记的一处简化）：
 * Ink 版必须把消息区拆成 <Static>（定稿）+ LiveViewport（在途）两段，因为 Ink 每帧整树
 * 重绘，不拆就会把已定稿的历史反复重画。pi-tui 是行级差分渲染，未变化的行天然不重画，
 * 所以定稿块与在途块用同一个组件即可，不需要 LiveBlock 这个单独概念——流式期就是最后
 * 一个 ItemBlock 在反复 setItem，前面的块因为渲染结果逐行相同而不产生任何终端写入。
 *
 * 每个块自带缓存（item 引用 + width 未变则复用上次行数组），这样 render() 在长会话下
 * 是「取缓存 + 数组拼接」而非重新排版。
 */
import type { Component } from '@earendil-works/pi-tui';
import { Markdown, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import type { DisplayItem, WelcomeData } from '../chat/types.js';
import { c, markdownTheme, thinkingMarkdownTheme } from './theme.js';
import { markdownTransform } from '../chat/markdownPrep.js';
import { t } from '../i18n.js';

// 顶部 logo：FIGlet "Small" 风格的 S（紧凑双线）。与 Ink 版 WelcomeBox 同字形。
const LOGO_LINES = [' ___ ', '/ __|', '\\__ \\', '|___/'];

/**
 * 启动欢迎框：圆角边框 + 蓝色 logo，右侧标题/帮助提示，下方 Directory/Session/Model/Version
 * 四行。手绘边框行（pi-tui 没有边框容器；Box 组件只有 padding 和背景色）。
 * 内容超宽时各值截断到框内，边框随内容宽收缩但不超 width。
 */
export function renderWelcome(data: WelcomeData, width: number): string[] {
  const row = (label: string, value: string): string => `${c.dim(label.padEnd(11))}${value}`;
  const inner: string[] = [
    ...LOGO_LINES.map((line, i) => {
      const right =
        i === 1 ? `  ${c.bold(t('welcome.title'))}` : i === 2 ? `  ${c.dim(t('welcome.helpHint'))}` : '';
      return `${c.logo(line)}${right}`;
    }),
    '',
    row('Directory:', data.cwd),
    row('Session:', data.sessionId),
    row('Model:', data.model),
    row('Version:', data.version),
  ];
  // 框宽 = min(内容最宽行, width - 4)，内容行截断或补齐到框宽
  const frameWidth = Math.min(Math.max(...inner.map((l) => visibleWidth(l)), 20), Math.max(20, width - 4));
  const body = inner.map((l) => {
    const w = visibleWidth(l);
    const clipped = w > frameWidth ? truncateToWidth(l, frameWidth) : l + ' '.repeat(frameWidth - w);
    return `${c.dim('│')} ${clipped} ${c.dim('│')}`;
  });
  const top = c.dim(`╭${'─'.repeat(frameWidth + 2)}╮`);
  const bottom = c.dim(`╰${'─'.repeat(frameWidth + 2)}╯`);
  return [top, ...body, bottom, ''];
}

/** 工具结果折叠口径（与 Ink 版 ToolCall.tsx 一致）：错误输出预览行数。 */
const ERROR_PREVIEW_LINES = 4;
/** diff 结果完整展示的行数上限，超出截断（与 Ink 版 EXPANDED_MAX_LINES 同口径）。 */
const DIFF_MAX_LINES = 200;

/** 工具入参的单行摘要。逻辑抄自 Ink 版 ToolCall.tsx 的 summarizeInput（那边带 JSX，不能直接引）。 */
export function summarizeInput(input: unknown): string {
  if (input === null || typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;
  for (const key of ['path', 'pattern', 'command', 'skill']) {
    const v = obj[key];
    if (typeof v === 'string' && v.length > 0) {
      return v.length > 80 ? `${v.slice(0, 80)}…` : v;
    }
  }
  return '';
}

/** 结果体是否是 diff（首行形如 `--- a/x` 或含 @@ hunk 头）：diff 要完整展示，不折叠。 */
export function looksLikeDiff(lines: readonly string[]): boolean {
  return lines.some((l) => l.startsWith('@@') || l.startsWith('--- ') || l.startsWith('+++ '));
}

/** 一行文本按宽度折行；空串返回单个空行（保住段间空行）。 */
function wrap(text: string, width: number): string[] {
  if (text === '') return [''];
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    if (raw === '') {
      out.push('');
      continue;
    }
    out.push(...wrapTextWithAnsi(raw, Math.max(1, width)));
  }
  return out;
}

/** 给一段行加统一缩进前缀（每行都加，用于引用式竖线）。 */
function indent(lines: readonly string[], prefix: string): string[] {
  return lines.map((l) => prefix + l);
}

/** 悬挂缩进：首行带标记前缀，续行用等宽空格对齐（多行提示不会每行都顶一个圆点）。 */
function hanging(lines: readonly string[], prefix: string, plainWidth: number): string[] {
  const pad = ' '.repeat(plainWidth);
  return lines.map((l, i) => (i === 0 ? prefix : pad) + l);
}

/** 单条 DisplayItem 的渲染组件。 */
export class ItemBlock implements Component {
  private item: DisplayItem;
  private cachedWidth = -1;
  private cachedLines: string[] | undefined;
  /** assistant / thinking 正文交给 pi-tui 的 Markdown 组件渲染（它自带解析缓存）。 */
  private markdown: Markdown | undefined;

  constructor(item: DisplayItem) {
    this.item = item;
  }

  getItem(): DisplayItem {
    return this.item;
  }

  /** 换内容（流式追加、工具状态变更都走这里）：清缓存，下次 render 重排。 */
  setItem(item: DisplayItem): void {
    this.item = item;
    this.invalidate();
  }

  invalidate(): void {
    this.cachedLines = undefined;
    this.markdown?.invalidate();
  }

  render(width: number): string[] {
    if (this.cachedLines !== undefined && this.cachedWidth === width) return this.cachedLines;
    const lines = this.renderItem(width);
    this.cachedLines = lines;
    this.cachedWidth = width;
    return lines;
  }

  private renderMarkdown(text: string, width: number, dim: boolean): string[] {
    if (this.markdown === undefined) {
      this.markdown = new Markdown(text, 0, 0, dim ? thinkingMarkdownTheme : markdownTheme, undefined, { transform: markdownTransform });
    } else {
      this.markdown.setText(text);
    }
    return this.markdown.render(width);
  }

  private renderItem(width: number): string[] {
    const it = this.item;
    switch (it.kind) {
      case 'welcome':
        return renderWelcome(it.data, width);
      case 'user': {
        // 用户消息：竖线 + 青色，与助手正文形成视觉分栏
        const body = wrap(it.text, width - 2);
        return [...indent(body, c.user('│ ')), ''];
      }
      case 'assistant':
        return [...this.renderMarkdown(it.text, width, false), ''];
      case 'thinking': {
        const body = this.renderMarkdown(it.text, width - 2, true);
        return [...indent(body, c.thinking('┊ ')), ''];
      }
      case 'note':
        return [...hanging(wrap(c.note(it.text), width - 2), c.note('· '), 2), ''];
      case 'error':
        return [...hanging(wrap(c.error(it.text), width - 2), c.error('✗ '), 2), ''];
      case 'tool':
        return this.renderTool(it, width);
      case 'goalPanel':
        return [c.accent(`goal: ${it.data.objective}`), ''];
      case 'cron':
        return [c.accent(`cron: ${it.data.prompt ?? ''}`), ''];
      default:
        return [];
    }
  }

  private renderTool(it: Extract<DisplayItem, { kind: 'tool' }>, width: number): string[] {
    const mark = it.status === 'running' ? c.warn('⏳') : it.status === 'ok' ? c.ok('✓') : c.error('✗');
    const arg = summarizeInput(it.input);
    const elapsed =
      it.status === 'running' && it.startedAt !== undefined
        ? c.dim(` ${Math.max(0, Math.round((Date.now() - it.startedAt) / 1000))}s`)
        : '';
    const subagent =
      it.subagentType !== undefined || it.description !== undefined
        ? c.dim(` ${[it.subagentType, it.description].filter((x) => x !== undefined).join(' · ')}`)
        : '';
    const head = `${mark} ${c.toolName(it.name)}${arg !== '' ? ` ${c.toolArg(arg)}` : ''}${subagent}${elapsed}`;
    const out = visibleWidth(head) > width ? wrap(head, width) : [head];

    // 子 agent 嵌套工具事件：运行中显示最近 3 条，完成后折叠计数（对齐 Ink 版）
    const sub = it.subagentToolEvents;
    if (sub !== undefined && sub.length > 0) {
      if (it.status === 'running') {
        for (const ev of sub.slice(-3)) {
          const m = ev.status === 'running' ? '⏳' : ev.status === 'ok' ? '✓' : '✗';
          out.push(c.dim(`    ${m} ${ev.name}`));
        }
      } else {
        out.push(c.dim(`    ↳ ${sub.length} 个子工具调用`));
      }
    }

    if (it.result !== undefined && it.result !== '') {
      const lines = it.result.split('\n');
      if (it.status === 'error') {
        // 错误：预览前若干行，其余折叠
        for (const l of lines.slice(0, ERROR_PREVIEW_LINES)) {
          out.push(...indent(wrap(c.error(l), width - 4), '    '));
        }
        if (lines.length > ERROR_PREVIEW_LINES) {
          out.push(c.dim(`    ↳ 还有 ${lines.length - ERROR_PREVIEW_LINES} 行（Ctrl+O 查看）`));
        }
      } else if (looksLikeDiff(lines)) {
        // diff：完整展示（截到上限），这是用户最需要当场看清的内容
        for (const l of lines.slice(0, DIFF_MAX_LINES)) {
          const colored = l.startsWith('+') ? c.ok(l) : l.startsWith('-') ? c.error(l) : l.startsWith('@@') ? c.accent(l) : c.dim(l);
          out.push(...indent(wrap(colored, width - 4), '    '));
        }
        if (lines.length > DIFF_MAX_LINES) out.push(c.dim(`    ↳ 还有 ${lines.length - DIFF_MAX_LINES} 行`));
      } else {
        // 成功的普通输出：整段折叠成一行提示
        const chars = it.result.length;
        out.push(c.dim(`    ↳ ${lines.length} 行 / ${chars} 字符（Ctrl+O 查看）`));
      }
    }
    out.push('');
    return out;
  }
}
