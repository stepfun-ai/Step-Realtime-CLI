import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 动态区高度预算与 chrome 降级（滚动跳顶修复的预算层；渲染层的尾部锚定视口见 LiveViewport.tsx 头部注释）。
 *
 * 不变量：动态帧总高（chrome + live 视口）恒 ≤ 终端行数 − 1。
 * Windows 上 ink 帧高 ≥ rows 即走全量清屏分支，clearTerminal 含 \x1b[3J 会清掉整个
 * scrollback（用户向上滚动被拽回），因此预算留 1 行余量。
 * chrome 逼近一屏时按「QueuePreview → TodoPanel → 思考预览缩减」的优先级丢弃可选面板；
 * AgentGroup（busy 关键进度）与输入区/弹层/状态栏不可降级。
 */

export interface ChromeBlocks {
  /** 状态栏行数（固定）。 */
  statusRows: number;
  /** 输入区实测行数或弹层估算行数（固定，不可降级）。 */
  promptRows: number;
  /** TodoPanel 行数（0 = 不可见）。 */
  todoRows?: number;
  /** AgentGroup 行数（0 = 不可见；busy 关键面板，不参与降级）。 */
  agentRows?: number;
  /** QueuePreview 行数（0 = 不可见）。 */
  queueRows?: number;
  /** 图片横幅行数（0 或 1，固定）。 */
  imageRows?: number;
  /** 思考流式预览行数（0 = 不可见；含标题行）。 */
  thinkingRows?: number;
  /** 忙碌态状态行 WorkingStatus 行数（0 = 不可见；busy 关键面板，固定不降级）。 */
  workingRows?: number;
}

export interface LiveBudget {
  /** chrome 总行数（降级后）。 */
  chromeRows: number;
  /** live 视口预算行数；termRows 未知（非 TTY / 测试 mock）时不窗口化。 */
  liveMaxRows: number | undefined;
  showTodos: boolean;
  showQueue: boolean;
  /** 降级后思考预览行数（0 = 整块隐藏）。 */
  thinkingRows: number;
  /** 是否触发过降级（调试日志用）。 */
  degraded: boolean;
}

/** 思考预览降级下限：标题 + 至少 1 行正文，给不出来就整块隐藏。 */
const MIN_THINKING_ROWS = 2;

export function computeLiveBudget(termRows: number | undefined, blocks: ChromeBlocks): LiveBudget {
  const todoRows = blocks.todoRows ?? 0;
  const agentRows = blocks.agentRows ?? 0;
  const queueRows = blocks.queueRows ?? 0;
  const imageRows = blocks.imageRows ?? 0;
  const workingRows = blocks.workingRows ?? 0;
  let thinkingRows = blocks.thinkingRows ?? 0;
  let showTodos = todoRows > 0;
  let showQueue = queueRows > 0;
  let degraded = false;
  const fixedRows = blocks.statusRows + blocks.promptRows + agentRows + imageRows + workingRows;
  let chromeRows = fixedRows + todoRows + queueRows + thinkingRows;

  if (termRows !== undefined) {
    // 总高预算 rows − 1，再减 live 视口保底 1 行，得 chrome 上限。
    const chromeBudget = Math.max(termRows - 2, 0);
    if (chromeRows > chromeBudget && showQueue) {
      showQueue = false;
      chromeRows -= queueRows;
      degraded = true;
    }
    if (chromeRows > chromeBudget && showTodos) {
      showTodos = false;
      chromeRows -= todoRows;
      degraded = true;
    }
    if (chromeRows > chromeBudget && thinkingRows > 0) {
      const allowed = chromeBudget - (chromeRows - thinkingRows);
      const next = allowed >= MIN_THINKING_ROWS ? Math.min(thinkingRows, allowed) : 0;
      if (next !== thinkingRows) degraded = true;
      chromeRows += next - thinkingRows;
      thinkingRows = next;
    }
    // fixed 部分（状态栏 + 输入区/弹层 + AgentGroup + 图片横幅）超限时无可再降，
    // liveMaxRows 保底 1，总高可能触线——由 logRenderBudget 标 DANGER 暴露。
  }

  const liveMaxRows = termRows === undefined ? undefined : Math.max(termRows - 1 - chromeRows, 1);
  return { chromeRows, liveMaxRows, showTodos, showQueue, thinkingRows, degraded };
}

/** 宽字符区间（CJK、全角、emoji 等，占 2 列）；其余按 1 列。 */
const WIDE_RE =
  /[ᄀ-ᅟ⺀-〿぀-ヿ㐀-䶿一-鿿ꥠ-꥿가-힣豈-﫿︰-﹯＀-｠￠-￦\u{1F300}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u;

/** 终端显示宽度估算（宽字符 2 列）。预算按行估算用，不做像素级精确。 */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) width += WIDE_RE.test(ch) ? 2 : 1;
  return width;
}

/** 一条逻辑行在终端内折行后的行数（宽字符按 2 列）；宽度未知时退化为 1 行。弹层行数估算统一入口。 */
export function wrappedRows(text: string, width: number | undefined): number {
  if (width === undefined || width <= 0) return 1;
  return Math.max(1, Math.ceil(displayWidth(text) / width));
}

/**
 * STEP_DEBUG_RENDER=1 时输出动态帧预算诊断。
 * 只在触线（总高 ≥ rows，标 DANGER）或触发过降级（标 DEGRADED）时写
 * %TEMP%/step-code-render-debug.log——常态贴预算运行不落盘，不在渲染热路径做常态 IO。
 */
export function logRenderBudget(termRows: number | undefined, budget: LiveBudget): void {
  if (process.env.STEP_DEBUG_RENDER !== '1' || termRows === undefined) return;
  const total = budget.chromeRows + (budget.liveMaxRows ?? 0);
  const slack = termRows - total;
  if (!budget.degraded && slack > 0) return;
  const tag = slack <= 0 ? 'DANGER' : 'DEGRADED';
  try {
    fs.appendFileSync(
      path.join(os.tmpdir(), 'step-code-render-debug.log'),
      `${new Date().toISOString()} ${tag} rows=${termRows} chrome=${budget.chromeRows} live=${budget.liveMaxRows} total=${total} slack=${slack}\n`,
    );
  } catch {
    // 调试日志写失败不影响渲染
  }
}
