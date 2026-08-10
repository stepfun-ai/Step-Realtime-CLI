/**
 * 极简 5 字段 cron 解析（分 时 日 月 周），支持 *、逗号、范围 a-b、步进 a-b/n 或 星/n。
 * 仅用于 step-code 的 cron 定时任务，不追求完整 cron 语义（不含 ?、L、W、# 等扩展）。
 */

export interface CronSpec {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>; // day of month 1-31
  month: Set<number>; // 1-12
  dow: Set<number>; // 0-6 (周日=0)
}

function parseField(field: string, min: number, max: number): Set<number> | null {
  const out = new Set<number>();
  for (const part of field.split(',')) {
    const p = part.trim();
    if (p === '') return null;
    const [rangePart, stepPart] = p.split('/');
    const step = stepPart !== undefined ? parseInt(stepPart, 10) : 1;
    if (!Number.isInteger(step) || step < 1) return null;
    let lo = min;
    let hi = max;
    if (rangePart !== '*') {
      const m = /^(\d+)(?:-(\d+))?$/.exec(rangePart ?? '');
      if (m === null) return null;
      lo = parseInt(m[1]!, 10);
      hi = m[2] !== undefined ? parseInt(m[2], 10) : lo;
    }
    if (lo < min || hi > max || lo > hi) return null;
    for (let v = lo; v <= hi; v += step) out.add(v);
  }
  return out.size > 0 ? out : null;
}

/** 解析 cron 表达式为 CronSpec。非法返回 null。 */
export function parseCron(expr: string): CronSpec | null {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return null;
  const minute = parseField(parts[0]!, 0, 59);
  const hour = parseField(parts[1]!, 0, 23);
  const dom = parseField(parts[2]!, 1, 31);
  const month = parseField(parts[3]!, 1, 12);
  const dow = parseField(parts[4]!, 0, 6);
  if (minute === null || hour === null || dom === null || month === null || dow === null) return null;
  return { minute, hour, dom, month, dow };
}

/** 判断一个 Date 是否匹配 cron spec（本地时区，精确到分钟）。 */
export function matchesCron(spec: CronSpec, date: Date): boolean {
  return (
    spec.minute.has(date.getMinutes()) &&
    spec.hour.has(date.getHours()) &&
    spec.dom.has(date.getDate()) &&
    spec.month.has(date.getMonth() + 1) &&
    spec.dow.has(date.getDay())
  );
}

/** 计算 after 之后下一次触发时间（本地时区，分钟粒度，向后最多找 366 天）。找不到返回 null。 */
export function nextFireAfter(spec: CronSpec, after: Date): Date | null {
  const start = new Date(after.getTime());
  start.setSeconds(0, 0);
  start.setMinutes(start.getMinutes() + 1); // 从下一分钟起
  const limit = start.getTime() + 366 * 24 * 3600 * 1000;
  for (let t = start.getTime(); t < limit; t += 60_000) {
    const d = new Date(t);
    if (matchesCron(spec, d)) return d;
  }
  return null;
}
