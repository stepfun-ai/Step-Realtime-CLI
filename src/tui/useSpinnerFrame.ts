import { useEffect, useState } from 'react';

/** 通用 braille 转圈帧序列，供各处 spinner 复用。 */
export const BRAILLE_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * 帧动画 hook：active 为真时按 intervalMs 触发 re-render，返回当前应显示的帧。
 *
 * 帧号由时间派生（`frames[Math.floor(Date.now()/intervalMs) % frames.length]`），
 * 定时器只负责「到点触发 re-render」，不存自增计数器——这样多个 spinner 天然同步、
 * 组件重挂也不会错乱。
 *
 * 纪律：active 为真才起 setInterval，active 转假或组件卸载时（useEffect cleanup）
 * 立即 clearInterval，绝不在空闲时空转烧 CPU。active 为假时直接返回静止首帧 frames[0]。
 */
export function useSpinnerFrame(active: boolean, frames: string[], intervalMs = 80): string {
  // tick 仅用于触发 re-render，值本身不参与展示（帧由时间派生）。
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setTick((t) => t + 1), intervalMs);
    return () => clearInterval(timer);
    // 故意不把 frames 放进依赖：帧内容每次渲染实时读取，
    // 定时器只受 active/intervalMs 控制，避免调用方传内联数组导致定时器反复重建。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, intervalMs]);

  if (!active) return frames[0] ?? '';
  return frames[Math.floor(Date.now() / intervalMs) % frames.length] ?? frames[0] ?? '';
}

/**
 * 墙钟 tick：active 为真时按 intervalMs 触发 re-render（时长按秒跳动用），
 * 值本身不参与展示（时长由 startedAt 现算）。纪律同 useSpinnerFrame：
 * active 才起 setInterval，active 转假或卸载时立即 clearInterval，空闲零成本。
 */
export function useNowTick(active: boolean, intervalMs = 1000): void {
  const [, setTick] = useState(0);

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setTick((t) => t + 1), intervalMs);
    return () => clearInterval(timer);
  }, [active, intervalMs]);
}
