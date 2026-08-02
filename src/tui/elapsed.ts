/**
 * 墙钟时长紧凑格式（goal 徽标/面板用）：
 * <60s → "45s"；<60m → "4m"；<24h → "1h23m"（整点 "1h"）；否则 "2d3h"（整天 "2d"）。
 */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return m % 60 === 0 ? `${h}h` : `${h}h${m % 60}m`;
  const d = Math.floor(h / 24);
  return h % 24 === 0 ? `${d}d` : `${d}d${h % 24}h`;
}
