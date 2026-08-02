import { Box, measureElement, type DOMElement } from 'ink';
import { useLayoutEffect, useRef } from 'react';
import { MAX_SYNC_MEASURE_CHAIN } from './LiveViewport.js';

/**
 * 偏移锚定视口（Ctrl+O 查看器 v2 的滚动内核，LiveViewport 的变体）。
 *
 * 与 LiveViewport 的关系：同一套「外层 maxHeight + overflow=hidden 同步压帧高、
 * 内层 flexShrink=0 保自然高」外壳——首帧（尚未测量）帧高也不会超预算，
 * 动态帧 < 一屏的不变量不变，Ink 不进清屏分支、scrollback 不被清。
 * 差异在锚定方式：LiveViewport 用 justifyContent=flex-end 锚底裁顶（恒看尾部），
 * 本组件用内层负 marginTop=-offset 平移（Yoga 支持负 margin），露出
 * [offset, offset+maxRows) 任意窗口；offset 由调用方管理（行级滚动/翻页/轮次跳转），
 * 因此不再需要尾部锚定与「已隐藏 N 行」指示。
 *
 * 测量：useLayoutEffect 在 commit 阶段同步量内层自然高（含流式增长），
 * 经 onNaturalHeight 回调上报，供外层 clamp offset。级联保险照抄 LiveViewport：
 * 同一宏任务拍内连续同步 dispatch 超过 MAX_SYNC_MEASURE_CHAIN 就退到下一拍——
 * 本组件挂在 busy 流式会话上，同样可能踩「Maximum update depth exceeded」。
 */
export function OffsetViewport({
  offset,
  maxRows,
  onNaturalHeight,
  children,
}: {
  /** 窗口起始行（相对内容自然行 0 起），调用方已 clamp 到 [0, max(0, natural-maxRows)]。 */
  offset: number;
  /** 视口预算行数。 */
  maxRows: number;
  /** 内层自然高量出后回调（同值重复回调由调用方用函数式 setState 去重）。 */
  onNaturalHeight: (height: number) => void;
  children: React.ReactNode;
}): React.ReactElement {
  const innerRef = useRef<DOMElement>(null);
  // 同一宏任务拍内连续同步测量 dispatch 的计数（级联保险，语义同 LiveViewport）。
  const syncChain = useRef(0);
  useLayoutEffect(() => {
    if (innerRef.current === null) return;
    const { height } = measureElement(innerRef.current);
    if (syncChain.current >= MAX_SYNC_MEASURE_CHAIN) {
      setImmediate(() => {
        syncChain.current = 0;
        onNaturalHeight(height);
      });
      return;
    }
    syncChain.current += 1;
    setImmediate(() => {
      syncChain.current = 0;
    });
    onNaturalHeight(height);
  });
  return (
    <Box flexDirection="column" maxHeight={maxRows} overflow="hidden">
      <Box ref={innerRef} flexDirection="column" flexShrink={0} marginTop={-offset}>
        {children}
      </Box>
    </Box>
  );
}
