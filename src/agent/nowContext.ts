/**
 * 时间上下文：给模型的「现在是什么时候」。
 *
 * 为什么全部用本地时间而不是 UTC ISO：
 * 直接给 `new Date().toISOString()` 是个常见取法，但它在非零偏移下会错日期。
 * 在 UTC+8 下，本地 2026-08-09 07:00 会被格式化成 `2026-08-08T23:00:00Z`——模型读到的
 * 日期比本地日期早一天，而它无法自行修正（不知道用户在哪个时区）。每天午夜到早八点
 * 这段时间的日期都是错的。若再叠加「跨天判定用本地日期、system 快照用 UTC」，两侧口径
 * 还会不一致。本模块统一用本地时间，并显式标注偏移量与 IANA 时区名：偏移量供模型算时差，
 * IANA 名供它判断地域。
 *
 * 为什么所有函数都要求显式传入 now：
 * 便于测试锁定时刻（跨午夜行为、时区换算），避免依赖真实时钟导致用例随日期漂移。
 */

/** 两位补零。 */
function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/**
 * 本地日期键（YYYY-MM-DD），用于跨天比对。
 * 必须用本地日期而非 UTC 日期：否则 UTC+8 会在本地时间 08:00 才判定「跨天」，
 * 而用户在 00:00 就已经进入新的一天。
 */
export function localDateKey(now: Date): string {
  return `${now.getFullYear()}-${pad2(now.getMonth() + 1)}-${pad2(now.getDate())}`;
}

/** UTC 偏移标注，如 `UTC+8`、`UTC+5:30`、`UTC-3`。半小时时区（如 Asia/Kolkata）保留分钟。 */
export function utcOffsetLabel(now: Date): string {
  // getTimezoneOffset 返回「UTC 减本地」的分钟数，东半球为负，故取反。
  const offsetMin = -now.getTimezoneOffset();
  const sign = offsetMin < 0 ? '-' : '+';
  const abs = Math.abs(offsetMin);
  const h = Math.floor(abs / 60);
  const m = abs % 60;
  return m === 0 ? `UTC${sign}${h}` : `UTC${sign}${h}:${pad2(m)}`;
}

/** IANA 时区名（如 Asia/Shanghai）；运行环境拿不到时返回空串。 */
function ianaZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone ?? '';
  } catch {
    return '';
  }
}

/** 人类可读的本地时刻，如 `2026-08-09 21:45（UTC+8, Asia/Shanghai）`。 */
export function formatLocalNow(now: Date): string {
  const date = localDateKey(now);
  const time = `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
  const zone = ianaZone();
  const zoneLabel = zone === '' ? utcOffsetLabel(now) : `${utcOffsetLabel(now)}, ${zone}`;
  return `${date} ${time}（${zoneLabel}）`;
}

/**
 * 自 lastTs 以来是否跨过了**本地**午夜（据此决定要不要注入跨天提醒）。
 *
 * 坏 ts 一律判为「未跨天」：`new Date('乱码')` 得到 Invalid Date，其 localDateKey 会是
 * `NaN-NaN-NaN`，与今天的键必然不等——若不显式拦掉，一条损坏的时间戳会导致每轮都注入
 * 一条「日期已变更」，且内容恒定，模型无从判断真假。
 */
export function crossedLocalMidnight(lastTs: string | undefined, now: Date): boolean {
  if (lastTs === undefined) return false;
  const last = new Date(lastTs);
  if (Number.isNaN(last.getTime())) return false;
  return localDateKey(last) !== localDateKey(now);
}

/**
 * system prompt 的「当前时间」段。
 *
 * 这是**进程启动时刻的快照**，不随会话推进更新——systemPrefix 在启动时构建一次，
 * 且 system 整块打 cache_control（见 provider/prepare.ts 的 buildSystemBlocks）：
 * 任何字节变化都会让 system 断点连同其后的 tools 与历史断点一起失效。
 * 所以这里不追求「保持准确」，而是诚实标注时效，并把真正需要准确时间的场合指向 `date`。
 * 唯一不可容忍的过时（跨天后日期错一天）由 loop 的跨天提醒单独修正。
 */
export function timeSection(now: Date): string {
  return `## 当前时间
- 当前时刻快照：${formatLocalNow(now)}。取自本次启动，不随会话推进更新。
- 长会话里这个值可能已过时数小时，只能当粗略参考。
- 凡是真正依赖当前时间的判断（搜索结果的新鲜度、时效与过期检查、「最新」「最近」这类措辞、写入文档或 commit 的日期），用 bash \`date\` 现取，不要信这个值，也不要从上下文推算。
- 你的训练数据截止于此之前。涉及此后的库版本、API 变更、行业事件，用 web_search 查证，不要凭记忆回答。`;
}
