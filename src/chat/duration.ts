/**
 * 子 agent 卡片用的墙钟时长格式：
 * <60s → "45s"；<60m → "2m 28s"（分钟级带秒）；更长 → "1h 3m"。
 * 与 formatElapsed（分钟级不带秒，goal 徽标/状态栏共用）刻意分开，互不影响。
 */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/**
 * 千进制紧凑计数（1000 进制：107k / 1.2M），StatusBar context 显示与子 agent
 * 卡片 tok 段共用——两处必须同口径，宁可与 1024 进制的习惯写法不同，也不能自相矛盾。
 */
export function formatCount(n: number): string {
  if (n >= 1_000_000) return `${trimZero(n / 1_000_000)}M`;
  if (n >= 1000) return `${trimZero(n / 1000)}k`;
  return String(n);
}

function trimZero(x: number): string {
  return x.toFixed(1).replace(/\.0$/, '');
}
