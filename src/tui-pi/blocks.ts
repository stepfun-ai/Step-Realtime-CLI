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

/** Braille 转圈帧序列（与 Ink 版 BRAILLE_FRAMES 同口径），供 running 状态动态 spinner。 */
const BRAILLE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_INTERVAL_MS = 80;

/** 当前 braille 帧：由时间派生（与 Ink 版 useSpinnerFrame 同口径），不存计数器。 */
function spinnerFrame(): string {
  return BRAILLE_FRAMES[Math.floor(Date.now() / SPINNER_INTERVAL_MS) % BRAILLE_FRAMES.length] ?? BRAILLE_FRAMES[0]!;
}
import { THINKING_FOLD_LINES } from '../chat/expandable.js';
import { c, dimAll, markdownTheme, thinkingMarkdownTheme } from './theme.js';
import { markdownTransform } from '../chat/markdownPrep.js';
import { formatDuration } from '../chat/duration.js';
import { formatCount } from './StatusLine.js';
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

/**
 * 能被 Ctrl+B 转后台的工具：它们跑起来会在 BackgroundManager 里留前台任务，
 * applyCtrlB 一次性把这些全转后台。集中成常量而不是散在条件里，是因为将来新增
 * 可后台化的工具时，忘了改这里的表现就是「功能能用但用户不知道」。
 */
const CTRL_B_TOOLS = new Set(['bash', 'spawn_agent', 'dynamic_workflow']);

/**
 * 工具入参的单行摘要（折叠态标题行与 Ctrl+O 条目标题共用口径）。
 *
 * 字段顺序即优先级，取第一个命中的字符串字段。两处与 Ink 版不同，属 pi 版有意差异：
 *
 * 1. `pattern` 排在 `path` 前。grep/glob 同时有这两个字段，搜索词比搜索目录更能说明
 *    这次调用在干什么；Ink 版顺序反了，显式传 path 的 grep 卡片只显示目录。
 * 2. 补了 query/url/task_id/mission_id/objective/subject 六个字段。Ink 版只认前四个，
 *    于是搜索类、web_fetch、任务类、team、goal 的卡片全都只剩一个工具名——「调用了
 *    web_search」不告诉任何信息，「web_search  pi-tui 源码」才是。
 *
 * 入参是数组或对象的工具（todo_list 的 todos、ask_user 的 questions）不在这里凑摘要：
 * 它们的结果体本身就会把内容列出来，标题行再塞一遍是重复。
 */
export function summarizeInput(input: unknown): string {
  if (input === null || typeof input !== 'object') return '';
  const obj = input as Record<string, unknown>;
  for (const key of [
    'pattern',
    'path',
    'command',
    'skill',
    'query',
    'url',
    'task_id',
    'mission_id',
    'objective',
    'subject',
  ]) {
    const v = obj[key];
    if (typeof v === 'string' && v.length > 0) {
      return v.length > 80 ? `${v.slice(0, 80)}…` : v;
    }
  }
  return '';
}

/** edit_file 输出的 diff 数据行：4 位行号 + 空格 + 标记（+/-/空格）。formatRow 格式。 */
const DIFF_ROW_RE = /^(\s*\d+) ([+\-]) /;

/**
 * 结果体是否是 diff：unified diff（@@/---/+++ 头）或 edit_file 的摘要头（前两行命中 +N -M path）。
 * 早前只认 unified diff 头，edit_file 真实输出（首行中文 summary + 第二行 +N -M path）被漏识别，
 * 永远走折叠分支——diff 铺开展示从未对真实 edit 结果生效过。
 */
export function looksLikeDiff(lines: readonly string[]): boolean {
  if (lines.some((l) => l.startsWith('@@') || l.startsWith('--- ') || l.startsWith('+++ '))) return true;
  // edit_file 摘要头 `+N -M path` 在第二行（首行是「已编辑…」中文 summary），扫前两行
  return lines.slice(0, 2).some((l) => /^[+-]\d+ /.test(l));
}

/**
 * diff 行着色：按行内容识别 diff 语义上色，覆盖两种格式。
 * - formatRow（`   1 +code`）：行号 + 标记 → + 绿 / - 红
 * - 省略/截断提示行（`     …`）：暗色
 * - edit_file 摘要头（`+N -M path`）：accent 色
 * - unified diff（`+`/`-`/`@@` 前缀）：+ 绿 / - 红 / @@ accent
 * - 其余（中文 summary 行等）：暗色
 */
function colorDiffLine(line: string): string {
  const row = DIFF_ROW_RE.exec(line);
  if (row !== null) return row[2] === '+' ? c.ok(line) : c.error(line);
  if (/^\s*…/.test(line)) return c.dim(line);
  if (/^[+-]\d+ /.test(line)) return c.accent(line);
  if (line.startsWith('+') && !line.startsWith('+++')) return c.ok(line);
  if (line.startsWith('-') && !line.startsWith('---')) return c.error(line);
  if (line.startsWith('@@')) return c.accent(line);
  return c.dim(line);
}

/**
 * 一行文本按宽度折行；空串返回单个空行（保住段间空行）。
 *
 * 安全网：`wrapTextWithAnsi` 只按空格/换行折行，长 URL / base64 / 无空格代码串不会被断开，
 * 单行可能远超终端宽度。pi-tui doRender 检测到 visibleWidth > width 就直接 throw。
 * 2026-08-17 两次因此崩溃（line 19 w=89>87、line 399 w=992>67）。
 * 折行后逐行 `truncateToWidth` 钳到 width，是组件层最后一道防线。
 */
function wrap(text: string, width: number): string[] {
  if (text === '') return [''];
  const w = Math.max(1, width);
  const out: string[] = [];
  for (const raw of text.split('\n')) {
    if (raw === '') {
      out.push('');
      continue;
    }
    out.push(...wrapTextWithAnsi(raw, w).map((l) => truncateToWidth(l, w)));
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

/**
 * 子 agent 统计段：`N tools · 时长[ · X tok]`（对齐 Ink 版 AgentGroup 的行内统计）。
 * 运行中用现算时长（startedAt），终态用 runner 回传的定格值（subagentDurationMs）。
 * tok 为 0 或缺省时不显示——开头一片「0 tok」只是噪音。
 */
export function subagentStats(it: Extract<DisplayItem, { kind: 'tool' }>, now = Date.now()): string {
  if (it.name !== 'spawn_agent') return '';
  const toolCount = it.subagentToolUses ?? it.subagentToolEvents?.length;
  const durMs =
    it.subagentDurationMs ?? (it.status === 'running' && it.startedAt !== undefined ? Math.max(0, now - it.startedAt) : undefined);
  const parts: string[] = [];
  if (toolCount !== undefined && toolCount > 0) parts.push(`${toolCount} tools`);
  if (durMs !== undefined) parts.push(formatDuration(durMs));
  if (it.subagentTokens !== undefined && it.subagentTokens > 0) parts.push(`${formatCount(it.subagentTokens)} tok`);
  return parts.join(' · ');
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

  /**
   * 显式释放渲染资源：清缓存行 + 丢弃 Markdown 实例。
   *
   * 与 invalidate() 的区别：invalidate 只清 cachedLines、保留 markdown 实例（下次 render 复用）；
   * dispose 连 markdown 实例一起丢弃——Transcript 折叠旧块时对被替换的块调用，让 pi-tui Markdown
   * 的解析缓存随块一起被 GC。只 invalidate 不 dispose，折叠等于没释放（OOM 第二道防线的前提）。
   * dispose 后该块不应再 render；若误用，render 会按 markdown===undefined 分支重新建实例。
   */
  dispose(): void {
    this.cachedLines = undefined;
    this.markdown = undefined;
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
    // 安全网：Markdown 组件内部 wrapTextWithAnsi 对长 URL/base64/无空格串不折行，
    // 可能产出宽于 width 的行，触发 pi-tui doRender 的宽度断言。逐行钳到 width。
    const w = Math.max(1, width);
    return this.markdown.render(w).map((l) => truncateToWidth(l, w));
  }

  /**
   * 渲染一条展开内容（查看器复用）：去掉主界面的折叠提示，全文铺开。
   * 与 render 路径共用同一个 Markdown 实例没必要——查看器是低频操作，新建一个即可。
   */
  static renderExpanded(item: Extract<DisplayItem, { kind: 'tool' | 'thinking' }>, width: number): string[] {
    if (item.kind === 'thinking') {
      const md = new Markdown(item.text, 0, 0, thinkingMarkdownTheme, undefined, { transform: markdownTransform });
      // 压灰同主界面：查看器里也不该出现半灰半白
      const w = Math.max(1, width - 2);
      return dimAll(md.render(w).map((l) => truncateToWidth(l, w)));
    }
    return renderToolExpanded(item, width);
  }


  private renderItem(width: number): string[] {
    const it = this.item;
    switch (it.kind) {
      case 'welcome':
        return renderWelcome(it.data, width);
      case 'user': {
        // 蓝色前缀 + 黄色正文 + 整行深灰背景，对齐 Ink 版 MessageList user 分支
        // （Ink 用 backgroundColor="#262600" 深灰底，pi 用 SGR 48;5;236）。
        // 背景必须覆盖整行：前缀和正文都套 c.userBg，长对话靠背景块区分用户/助手输出。
        const bg = c.userBg;
        const body = wrap(it.text, width - 2).map((l) => bg(c.userText(l)));
        return [...indent(body, bg(c.user('│ '))), ''];
      }
      case 'assistant': {
        // 前缀灰色 ●，对齐 Ink 版 MessageList assistant 分支（Ink 前缀灰色 ●）。
        // 第一行带前缀，续行对齐（与 thinking 的 ┊ 同口径）。
        const md = this.renderMarkdown(it.text, width - 2, false);
        return [...indent(md, c.dim('● ')), ''];
      }
      case 'thinking': {
        // 长 thinking 在主界面折叠为前 N 行 + 「还有 N 行（Ctrl+O 查看）」，
        // 全文进 ExpandViewer（Ctrl+O）。与 Ink 版同语义；阈值 3 行（Ink 是 2，
        // pi 流式预览只有尾部 1 行，定稿多给一行，从流式到定稿的视觉落差更小）。
        const rendered = dimAll(this.renderMarkdown(it.text, width - 2, true));
        if (rendered.length <= THINKING_FOLD_LINES) return [...indent(rendered, c.thinking('┊ ')), ''];
        const head = rendered.slice(0, THINKING_FOLD_LINES);
        const folded = c.thinking(`┊ … 还有 ${rendered.length - THINKING_FOLD_LINES} 行（Ctrl+O 查看）`);
        return [...indent(head, c.thinking('┊ ')), folded, ''];
      }
      case 'note':
        return [...hanging(wrap(c.note(it.text), width - 2), c.note('· '), 2), ''];
      case 'error':
        return [...hanging(wrap(c.error(it.text), width - 2), c.error('✗ '), 2), ''];
      case 'tool':
        return this.renderTool(it, width);
      case 'goalPanel':
        return [...wrap(`goal: ${it.data.objective}`, width - 2).map((l) => c.accent(l)), ''];
      case 'foldSummary':
        // 逐回合折叠的摘要占位：一行 dim，告知更早的块已被折成摘要释放内存。
        // 正文/user/assistant 不折叠（用户最常回看），只有 tool/thinking 等旧块进摘要。
        return [...hanging(wrap(c.dim(`↳ 折叠了 ${it.count} 个旧块（更早的轮次，仍在历史中）`), width - 2), c.dim('· '), 2), ''];
      case 'cron':
        // cron prompt 可能很长（几百字符），必须先 wrap 再逐行着色。
        // 原来直接 `c.accent(prompt)` 整段当一行返回，992 字符 > 67 列终端宽度
        // → pi-tui doRender 断言崩溃（2026-08-17 第二次宽度溢出）。
        // 先 wrap 再 map(c.accent)：每个换行后的子行独立着色，不丢失颜色。
        return [...wrap(`cron: ${it.data.prompt ?? ''}`, width - 2).map((l) => c.accent(l)), ''];
      default:
        return [];
    }
  }

  private renderTool(it: Extract<DisplayItem, { kind: 'tool' }>, width: number): string[] {
    const mark = it.status === 'running' ? c.warn(spinnerFrame()) : it.status === 'ok' ? c.ok('✓') : c.error('✗');
    const elapsed =
      it.status === 'running' && it.startedAt !== undefined
        ? c.dim(t('toolCall.elapsed', { s: Math.max(0, Math.round((Date.now() - it.startedAt) / 1000)) }))
        : '';
    // 前台任务运行中才提示可转后台。Ctrl+B（applyCtrlB）转的是**全部前台任务**，
    // 不只是 bash——子 agent 与 dynamic_workflow 同样在列。Ink 版这里只判 bash，是因为
    // 它有独立的 AgentGroup 面板单独显示子 agent 的转后台提示；pi 版按有意差异把进度
    // 内嵌进卡片，提示也就该落在卡片上（等价物，不是漏抄）。
    //
    // key 名里的 bash 是历史包袱，文案本身「（Ctrl+B 转后台运行）」是通用的。不改名以
    // 免与主仓 i18n 表无谓分叉。
    const bgHint = it.status === 'running' && CTRL_B_TOOLS.has(it.name) ? c.dim(t('toolCall.bashBackgroundHint')) : '';
    const subagent =
      it.subagentType !== undefined || it.description !== undefined
        ? c.dim(` ${[it.subagentType, it.description].filter((x) => x !== undefined).join(' · ')}`)
        : '';
    const head = `${mark} ${c.toolName(it.name)}${toolArgText(it)}${subagent}${elapsed}${bgHint}`;
    const out = visibleWidth(head) > width ? wrap(head, width) : [head];

    // dynamic_workflow 阶段：运行中逐个列出（● 当前 / ✓ 已完成），终态坍缩成一行计数
    const wf = it.dynamicWorkflow;
    if (wf !== undefined && wf.phases.length > 0) {
      if (it.status === 'running') {
        for (const ph of wf.phases) {
          const m = ph.status === 'running' ? c.warn('●') : c.ok('✓');
          out.push(c.dim(`    ${m} ${ph.title}`));
        }
      } else {
        out.push(c.dim(`    ↳ ${wf.phases.length} 个阶段`));
      }
    }

    // 子 agent 进度：统计段 + 嵌套工具事件（运行中显示最近 3 条，完成后折叠计数）。
    // Ink 版把这些放在独立的 AgentGroup 面板里（还要处理「终态后撤下面板」的生命周期），
    // 这里直接挂在工具卡片上——差分渲染下条目内嵌就是实时面板。
    const stats = subagentStats(it);
    if (stats !== '') out.push(c.dim(`    ${stats}`));
    const sub = it.subagentToolEvents;
    if (sub !== undefined && sub.length > 0) {
      if (it.status === 'running') {
        for (const ev of sub.slice(-3)) {
          const m = ev.status === 'running' ? spinnerFrame() : ev.status === 'ok' ? '✓' : '✗';
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
        // diff：完整展示（截到上限），这是用户最需要当场看清的内容。
        // 统计增删行：同时支持 unified diff（+/ -前缀）和 edit_file formatRow（行号 + 标记），
        // 并排除 edit_file 的 +N -M path 摘要头（它的 + 前缀会被误算成 +1 行）。
        let added = 0, removed = 0;
        for (const l of lines) {
          const row = DIFF_ROW_RE.exec(l);
          if (row !== null) { if (row[2] === '+') added++; else removed++; }
          else if (!/^[+-]\d+ /.test(l)) {
            if (l.startsWith('+') && !l.startsWith('+++')) added++;
            else if (l.startsWith('-') && !l.startsWith('---')) removed++;
          }
        }
        let summary = '';
        if (added > 0) summary += c.ok(`+${added} `);
        if (removed > 0) summary += c.error(`-${removed} `);
        if (summary !== '') out.push(`    ${summary.trimEnd()}`);
        for (const l of lines.slice(0, DIFF_MAX_LINES)) {
          out.push(...indent(wrap(colorDiffLine(l), width - 4), '    '));
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

/**
 * 工具参数摘要的着色文本（主界面卡片与 Ctrl+O 展开态共用口径）。
 *
 * 抽成函数是因为这两处标题行历史上就容易漂移：Ink 版靠注释约定「共用口径」，
 * pi 版早先是两份各自拼接的字符串，改一处漏一处。
 */
function toolArgText(it: Extract<DisplayItem, { kind: 'tool' }>): string {
  const arg = summarizeInput(it.input);
  if (arg === '') return '';
  // 两个空格：单空格时 `write_file src/x.ts` 读起来像一个词组，双空格才分得出
  // 「工具」与「操作对象」两段（Ink 版同口径）。
  return it.name === 'skill' ? c.toolArgSkill(`  ${arg}`) : c.toolArg(`  ${arg}`);
}

/**
 * 查看器用：工具结果全文铺开（不折叠、不截断），diff 保持着色。
 * 头部状态行/子工具列表沿用 renderTool 的口径，这里只重做结果体。
 */
function renderToolExpanded(it: Extract<DisplayItem, { kind: 'tool' }>, width: number): string[] {
  const mark = it.status === 'running' ? c.warn(spinnerFrame()) : it.status === 'ok' ? c.ok('✓') : c.error('✗');
  const subagent =
    it.subagentType !== undefined || it.description !== undefined
      ? c.dim(` ${[it.subagentType, it.description].filter((x) => x !== undefined).join(' · ')}`)
      : '';
  const head = `${mark} ${c.toolName(it.name)}${toolArgText(it)}${subagent}`;
  const out = visibleWidth(head) > width ? wrap(head, width) : [head];
  if (it.result !== undefined && it.result !== '') {
    const lines = it.result.split('\n');
    if (it.status === 'error') {
      for (const l of lines) out.push(...indent(wrap(c.error(l), width - 4), '    '));
    } else if (looksLikeDiff(lines)) {
      for (const l of lines) {
        out.push(...indent(wrap(colorDiffLine(l), width - 4), '    '));
      }
    } else {
      for (const l of lines) out.push(...indent(wrap(l, width - 4), '    '));
    }
  }
  out.push('');
  return out;
}
