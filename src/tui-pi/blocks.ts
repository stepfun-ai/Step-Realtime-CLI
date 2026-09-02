/**
 * 转录区的消息块组件：把 DisplayItem 渲染成行数组。
 * 行级差分渲染下，未变化的行不重画，所以定稿块与在途块共用同一组件。
 * 每个块自带缓存（width 未变则复用上次行数组），render() 是取缓存 + 拼接。
 */
import type { Component } from '@earendil-works/pi-tui';
import { Markdown, truncateToWidth, visibleWidth, wrapTextWithAnsi } from '@earendil-works/pi-tui';
import type { DisplayItem, WelcomeData } from '../chat/types.js';

/** Braille 转圈帧序列，供 running 状态动态 spinner。 */
const BRAILLE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const SPINNER_INTERVAL_MS = 80;

/** 当前 braille 帧：由时间派生，不存计数器。 */
function spinnerFrame(): string {
  return BRAILLE_FRAMES[Math.floor(Date.now() / SPINNER_INTERVAL_MS) % BRAILLE_FRAMES.length] ?? BRAILLE_FRAMES[0]!;
}
import { THINKING_FOLD_LINES } from '../chat/expandable.js';
import { c, dimAll, markdownTheme, thinkingMarkdownTheme } from './theme.js';
import { markdownTransform } from '../chat/markdownPrep.js';
import { formatDuration } from '../chat/duration.js';
import { formatCount } from './StatusLine.js';
import { t } from '../i18n.js';

// 顶部 logo：FIGlet "Small" 风格的 S（紧凑双线）。
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

/** 错误输出预览行数。 */
const ERROR_PREVIEW_LINES = 4;
/** diff 结果完整展示的行数上限，超出截断。 */
const DIFF_MAX_LINES = 200;

/**
 * 能被 Ctrl+B 转后台的工具：它们跑起来会在 BackgroundManager 里留前台任务，
 * applyCtrlB 一次性把这些全转后台。集中成常量而不是散在条件里，是因为将来新增
 * 可后台化的工具时，忘了改这里的表现就是「功能能用但用户不知道」。
 */
const CTRL_B_TOOLS = new Set(['bash', 'spawn_agent', 'dynamic_workflow']);

/**
 * 按工具错误码返回视觉样式。不同错误码用不同颜色/标记，帮助用户一眼区分错误性质。
 * 目前只区分 PLAN_MODE_BLOCKED（计划模式拦截）和普通执行错误。
 */
function toolErrorStyle(errorCode?: string): { mark: string; color: (s: string) => string; badge?: string } {
  if (errorCode === 'PLAN_MODE_BLOCKED') {
    return { mark: c.warn('✗'), color: c.warn, badge: c.accent('[plan mode]') };
  }
  return { mark: c.error('✗'), color: c.error };
}

/** 工具入参的单行摘要（折叠态标题行与 Ctrl+O 条目标题共用）。字段顺序即优先级。 */
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
 * 子 agent 统计段：`N tools · 时长[ · X tok]`。
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
        // 压缩保真原话（user_verbatim）：降权显示——去掉整行黄底、改 dim 灰色、加「原话」标记前缀。
        // 为何必须区分：压缩过的长会话 resume 后，保真原话与真人输入在此一视同仁都高亮成黄泡，
        // 结果是「满屏用户消息」掩盖模型输出（2026-08-18 实测会话 122e9c：14 条原话堆顶部）。
        // 真人输入仍是高亮黄底，两相对比才分得出「这是你刚说的」还是「那是早先保留下来的」。
        if (it.verbatim === true) {
          const body = wrap(it.text, width - 2).map((l) => c.dim(l));
          return [...hanging(body, c.dim('┊ 原话 '), 2), ''];
        }
        // 蓝色前缀 + 黄色正文 + 整行深灰背景（SGR 48;5;236）。
        // 背景覆盖整行：前缀和正文都套 c.userBg，长对话靠背景块区分用户/助手输出。
        const bg = c.userBg;
        const body = wrap(it.text, width - 2).map((l) => bg(c.userText(l)));
        return [...indent(body, bg(c.user('│ '))), ''];
      }
      case 'assistant': {
        // 前缀灰色 ●，第一行带前缀，续行对齐
        const md = this.renderMarkdown(it.text, width - 2, false);
        return [...hanging(md, c.dim('● '), 2), ''];
      }
      case 'thinking': {
        // thinking 只走灰色（dimAll），左侧不带装饰符——与黄色状态栏已足以标识
        const rendered = dimAll(this.renderMarkdown(it.text, width - 2, true));
        if (rendered.length <= THINKING_FOLD_LINES) return [...hanging(rendered, '  ', 2), ''];
        const head = rendered.slice(0, THINKING_FOLD_LINES);
        const folded = c.dim(`  … 还有 ${rendered.length - THINKING_FOLD_LINES} 行（Ctrl+O 查看）`);
        return [...hanging(head, '  ', 2), folded, ''];
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
    const errStyle = toolErrorStyle(it.errorCode);
    const mark = it.status === 'running' ? c.warn(spinnerFrame()) : it.status === 'ok' ? c.ok('✓') : errStyle.mark;
    const elapsed =
      it.status === 'running' && it.startedAt !== undefined
        ? c.dim(t('toolCall.elapsed', { s: Math.max(0, Math.round((Date.now() - it.startedAt) / 1000)) }))
        : '';
    // 前台任务运行中才提示可转后台。Ctrl+B 转全部前台任务（bash / spawn_agent / dynamic_workflow），
    // 故提示统一落在卡片上。key 名里的 bash 是历史包袱，文案通用，保留不改以免 i18n 分叉。
    const bgHint = it.status === 'running' && CTRL_B_TOOLS.has(it.name) ? c.dim(t('toolCall.bashBackgroundHint')) : '';
    const subagent =
      it.subagentType !== undefined || it.description !== undefined
        ? c.dim(` ${[it.subagentType, it.description].filter((x) => x !== undefined).join(' · ')}`)
        : '';
    const badge = errStyle.badge ? `${errStyle.badge} ` : '';
    const head = `${mark} ${c.toolName(it.name)}${badge}${toolArgText(it)}${subagent}${elapsed}${bgHint}`;
    const out = visibleWidth(head) > width ? wrap(head, width) : [head];

    // dynamic_workflow 阶段：运行中逐个列出（● 当前 / ✓ 已完成），终态坍缩成一行计数
    const wf = it.dynamicWorkflow;
    if (wf !== undefined && wf.phases.length > 0) {
      if (it.status === 'running') {
        for (const ph of wf.phases) {
          const m = ph.status === 'running' ? c.warn('●') : c.ok('✓');
          // 阶段标题可能很长（模型自取），窄终端下超宽会触发 doRender 崩溃，故 wrap + 截断。
          out.push(...indent(wrap(c.dim(`${m} ${ph.title}`), width - 4), '    '));
        }
      } else {
        out.push(c.dim(`    ↳ ${wf.phases.length} 个阶段`));
      }
    }

    // 子 agent 进度：统计段 + 嵌套工具事件（运行中显示最近 3 条，完成后折叠计数），直接挂在卡片上
    const stats = subagentStats(it);
    if (stats !== '') out.push(...indent(wrap(c.dim(stats), width - 4), '    '));
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
        const color = errStyle.color;
        for (const l of lines.slice(0, ERROR_PREVIEW_LINES)) {
          out.push(...indent(wrap(color(l), width - 4), '    '));
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
    // 全局兜底：任何遗漏的超宽行（长无空格串、未来新增分支）都被钳到 width，
    // 避免触发 pi-tui doRender 的宽度断言崩溃。与 pickers.render 同款防线。
    return out.map((l) => truncateToWidth(l, width));
  }
}

/** 工具参数摘要的着色文本（主界面卡片与 Ctrl+O 展开态共用，避免两处漂移）。 */
function toolArgText(it: Extract<DisplayItem, { kind: 'tool' }>): string {
  if (it.forming === true) {
    // 参数流式中：input 还是空对象，从半截 JSON 里抠关键字段做预览（填参数流的等待空窗）。
    const preview = extractArgsPreview(it.partialArgs ?? '');
    return c.dim(preview !== '' ? `  ${preview}…` : '  参数成形中…');
  }
  const arg = summarizeInput(it.input);
  if (arg === '') return '';
  // 两个空格：单空格时 `write_file src/x.ts` 读起来像一个词组，双空格才分得出「工具」与「操作对象」
  return it.name === 'skill' ? c.toolArgSkill(`  ${arg}`) : c.toolArg(`  ${arg}`);
}

/**
 * 从半截工具参数 JSON 里抠出第一个已知关键字段做预览。
 * 正则容忍未闭合的字符串（[^"]* 匹配到串尾），半截 JSON 也能抠出值。
 * 字段优先级按「用户最想知道工具要动什么」排：路径/命令/模式/查询词。
 */
export function extractArgsPreview(partialJson: string): string {
  const KEYS = ['file_path', 'path', 'command', 'pattern', 'query', 'url', 'prompt'];
  for (const key of KEYS) {
    const m = new RegExp(`"${key}"\\s*:\\s*"([^"]{0,60})`).exec(partialJson);
    if (m !== null && m[1] !== undefined && m[1] !== '') return `${key}=${m[1]}`;
  }
  return '';
}

/**
 * 查看器用：工具结果全文铺开（不折叠、不截断），diff 保持着色。
 * 头部状态行/子工具列表沿用 renderTool 的口径，这里只重做结果体。
 */
function renderToolExpanded(it: Extract<DisplayItem, { kind: 'tool' }>, width: number): string[] {
  const errStyle = toolErrorStyle(it.errorCode);
  const mark = it.status === 'running' ? c.warn(spinnerFrame()) : it.status === 'ok' ? c.ok('✓') : errStyle.mark;
  const subagent =
    it.subagentType !== undefined || it.description !== undefined
      ? c.dim(` ${[it.subagentType, it.description].filter((x) => x !== undefined).join(' · ')}`)
      : '';
  const badge = errStyle.badge ? `${errStyle.badge} ` : '';
  const head = `${mark} ${c.toolName(it.name)}${badge}${toolArgText(it)}${subagent}`;
  const out = visibleWidth(head) > width ? wrap(head, width) : [head];
  if (it.result !== undefined && it.result !== '') {
    const lines = it.result.split('\n');
    if (it.status === 'error') {
      const color = errStyle.color;
      for (const l of lines) out.push(...indent(wrap(color(l), width - 4), '    '));
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
