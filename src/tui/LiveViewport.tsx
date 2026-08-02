import { Box, Text, measureElement, type DOMElement } from 'ink';
import { useLayoutEffect, useRef, useState } from 'react';
import { t } from '../i18n.js';

/**
 * 动态区尾部锚定视口（滚动跳顶修复的核心）。
 *
 * 根因（已在依赖源码核实）：Ink 7.1.1 在动态帧高度 ≥ 终端行数时走全量清屏分支，
 * clearTerminal 含 \x1b[3J 会清空终端整个 scrollback，用户向上滚动即被拽回顶部。
 * 修复思路：动态帧永远 < 一屏，让 Ink 永远不进清屏分支，scrollback 只接收 <Static> 的一次性追加。
 *
 * 实现要点：
 * - 外层 maxHeight + overflow=hidden 把帧高**同步**压住——首帧（尚未测量）也不会超高；
 * - justifyContent=flex-end 锚底：内容超限时顶部被裁，保留最后 N 行（行级裁剪，
 *   不是 item 级——单个超长 item 同样被截尾）；
 * - 内层 flexShrink=0 保持自然高度，measureElement 量出真实行数，换算被裁行数，
 *   顶部补一行「已隐藏 N 行」指示；测量用 useLayoutEffect 在 commit 阶段同步完成，
 *   指示行与裁剪同一帧生效，消除帧间高度抖动（useEffect 会晚一帧插入指示行）。
 */
export function LiveViewport({
  maxRows,
  children,
}: {
  /** 视口预算行数（含隐藏指示行）。 */
  maxRows: number;
  children: React.ReactNode;
}): React.ReactElement {
  const innerRef = useRef<DOMElement>(null);
  const [natural, setNatural] = useState<number | null>(null);
  // 同一宏任务拍内连续同步测量 dispatch 的计数（级联保险，见下方 effect）。
  const syncChain = useRef(0);
  // 每次提交同步量一次内容自然高度（流式增长、条目定稿移入 Static 收缩都要追）；
  // 同值不 setState，避免测量触发的二次渲染自我循环。
  //
  // 级联保险：本 effect 在 commit 阶段 dispatch，属 React「嵌套更新」。生产流式下
  // token 更新可能合并进嵌套渲染、每拍又量出新高度再 dispatch，级联自持触顶
  // React 嵌套上限（50）即整进程闪退（线上实测：Maximum update depth exceeded）。
  // 对策：同一宏任务拍内计数超过上限就退到下一拍 dispatch——指示行晚一拍出现，
  // 但同步级联被打断、React 嵌套计数随宏任务边界复位，正常路径行为不变。
  useLayoutEffect(() => {
    if (innerRef.current === null) return;
    const { height } = measureElement(innerRef.current);
    if (syncChain.current >= MAX_SYNC_MEASURE_CHAIN) {
      setImmediate(() => {
        syncChain.current = 0;
        setNatural((prev) => (prev === height ? prev : height));
      });
      return;
    }
    syncChain.current += 1;
    setImmediate(() => {
      syncChain.current = 0;
    });
    setNatural((prev) => (prev === height ? prev : height));
  });
  const clipping = natural !== null && natural > maxRows;
  // 超预算时让出 1 行给隐藏指示；avail 保底 1 行（极小终端下退化为只显示尾部 1 行 + 指示）。
  const avail = Math.max(clipping ? maxRows - 1 : maxRows, 1);
  const hidden = clipping ? natural - avail : 0;
  return (
    <Box flexDirection="column">
      {clipping ? <Text color="gray" wrap="truncate">{t('liveViewport.hiddenLines', { count: hidden })}</Text> : null}
      <Box flexDirection="column" maxHeight={avail} overflow="hidden" justifyContent="flex-end">
        <Box ref={innerRef} flexDirection="column" flexShrink={0}>
          {children}
        </Box>
      </Box>
    </Box>
  );
}

/** 状态栏行数（两行式：徽章行 + hints/context 行，见 StatusBar）。 */
export const STATUS_BAR_ROWS = 2;

/**
 * 同一宏任务拍内允许的连续同步测量 dispatch 上限。远低于 React 嵌套更新上限（50），
 * 给级联中可能并存的其他 commit 阶段 dispatch（spinner、计时器等）留余量。
 */
export const MAX_SYNC_MEASURE_CHAIN = 20;

/** 输入区常态行数：round 边框输入框 3 行（上下边框各 1 + 内容 1）+ busy tip / primed 提示 1 行（见 PromptInput）。 */
export const INPUT_AREA_ROWS = 4;

/**
 * 动态区高度预算：终端行数 − chrome 行数（输入区/弹层 + 状态栏 + 可见条件面板，由调用方按实测结构组装）。
 * termRows 未知（非 TTY、ink-testing-library 的 mock stdout 无 rows）时返回 undefined = 不做窗口化。
 * 保底 1 行：极小终端下视口退化但不为 0/负数。
 * resize 时 stdout.rows 变化，调用方重算传入即可，本函数无状态。
 */
export function computeLiveMaxRows(termRows: number | undefined, chromeRows: number): number | undefined {
  if (termRows === undefined) return undefined;
  return Math.max(termRows - chromeRows, 1);
}
