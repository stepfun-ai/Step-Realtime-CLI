import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  crossedLocalMidnight,
  formatLocalNow,
  localDateKey,
  timeSection,
  utcOffsetLabel,
} from '../../src/agent/nowContext.js';
import { buildSystemPrompt } from '../../src/agent/systemPrompt.js';

/**
 * 时区靠运行时改 `process.env.TZ` 切换（Node 支持，V8 会重读配置）。
 *
 * 为什么必须切时区而不是直接用本机时区断言：本模块要防的 bug 只在非零偏移下显形，
 * 而 CI runner 通常是 UTC——在 UTC 上「取 ISO 前缀」和「取本地字段」结果相同，
 * 断言会一路绿灯，等部署到 UTC+8 的机器上才出错。
 *
 * 注意 `getTimezoneOffset()` 是**动态求值**的：它读的是调用那一刻的 TZ，不是 Date
 * 对象创建时的 TZ。所以断言必须写在设定 TZ 的作用域内完成，跨作用域复用同一个
 * Date 对象会读到已经变化的偏移量。
 */
const originalTz = process.env['TZ'];

function withTz<T>(tz: string, fn: () => T): T {
  process.env['TZ'] = tz;
  try {
    return fn();
  } finally {
    process.env['TZ'] = originalTz;
  }
}

beforeEach(() => {
  process.env['TZ'] = originalTz;
});

afterEach(() => {
  process.env['TZ'] = originalTz;
});

describe('localDateKey：取本地日期，不取 UTC', () => {
  it('东八区清晨：本地日期与 UTC 日期差一天时，取本地那一天', () => {
    withTz('Asia/Shanghai', () => {
      // 本地 2026-08-09 07:30（new Date(y, m, d, h, min) 按本地时区构造）
      const d = new Date(2026, 7, 9, 7, 30);
      expect(localDateKey(d)).toBe('2026-08-09');
      // 同一时刻的 UTC ISO 前缀是前一天——直接把 toISOString() 给模型的取法，
      // 在东八区每天 00:00~08:00 都会把日期报错一天。
      expect(d.toISOString().slice(0, 10)).toBe('2026-08-08');
    });
  });

  it('UTC 时区下两种取法一致（对照组，确保上一条测的是时区而非别的差异）', () => {
    withTz('UTC', () => {
      const d = new Date(2026, 7, 9, 7, 30);
      expect(localDateKey(d)).toBe('2026-08-09');
      expect(d.toISOString().slice(0, 10)).toBe('2026-08-09');
    });
  });

  it('月末跨月与年末跨年的补零正确', () => {
    withTz('UTC', () => {
      expect(localDateKey(new Date(2026, 0, 1, 0, 0))).toBe('2026-01-01');
      expect(localDateKey(new Date(2026, 11, 31, 23, 59))).toBe('2026-12-31');
    });
  });
});

describe('utcOffsetLabel', () => {
  it('整小时正偏移', () => {
    withTz('Asia/Shanghai', () => {
      expect(utcOffsetLabel(new Date(2026, 7, 9, 12, 0))).toBe('UTC+8');
    });
  });

  it('零偏移', () => {
    withTz('UTC', () => {
      expect(utcOffsetLabel(new Date(2026, 7, 9, 12, 0))).toBe('UTC+0');
    });
  });

  it('半小时偏移保留分钟（Asia/Kolkata 恒为 +5:30，无夏令时）', () => {
    withTz('Asia/Kolkata', () => {
      expect(utcOffsetLabel(new Date(2026, 7, 9, 12, 0))).toBe('UTC+5:30');
    });
  });

  it('负偏移（Pacific/Honolulu 恒为 -10，无夏令时）', () => {
    withTz('Pacific/Honolulu', () => {
      expect(utcOffsetLabel(new Date(2026, 7, 9, 12, 0))).toBe('UTC-10');
    });
  });
});

describe('formatLocalNow', () => {
  it('含本地日期、时分与时区标注', () => {
    withTz('Asia/Shanghai', () => {
      const s = formatLocalNow(new Date(2026, 7, 9, 21, 45));
      expect(s).toContain('2026-08-09 21:45');
      expect(s).toContain('UTC+8');
      // IANA 名在能拿到时一并给出（供模型判断地域）
      expect(s).toMatch(/UTC\+8(, [A-Za-z]+\/[A-Za-z_]+)?/);
    });
  });

  it('个位数时分补零', () => {
    withTz('UTC', () => {
      expect(formatLocalNow(new Date(2026, 7, 9, 9, 5))).toContain('2026-08-09 09:05');
    });
  });
});

describe('crossedLocalMidnight', () => {
  it('同一本地日期内不触发', () => {
    withTz('Asia/Shanghai', () => {
      const last = new Date(2026, 7, 9, 1, 0);
      const now = new Date(2026, 7, 9, 23, 30);
      expect(crossedLocalMidnight(last.toISOString(), now)).toBe(false);
    });
  });

  it('跨过本地午夜即触发（间隔可以只有几分钟）', () => {
    withTz('Asia/Shanghai', () => {
      const last = new Date(2026, 7, 9, 23, 58);
      const now = new Date(2026, 7, 10, 0, 3);
      expect(crossedLocalMidnight(last.toISOString(), now)).toBe(true);
    });
  });

  it('按本地午夜判定，不按 UTC 午夜：东八区 08:00 前后不应误判为跨天', () => {
    withTz('Asia/Shanghai', () => {
      // 本地同为 8-09，但 UTC 分别落在 8-08 与 8-09（UTC 午夜在本地 08:00）
      const last = new Date(2026, 7, 9, 7, 0);
      const now = new Date(2026, 7, 9, 9, 0);
      expect(last.toISOString().slice(0, 10)).toBe('2026-08-08');
      expect(now.toISOString().slice(0, 10)).toBe('2026-08-09');
      // 若按 UTC 日期判定这里会误报跨天，用户却还在同一天里
      expect(crossedLocalMidnight(last.toISOString(), now)).toBe(false);
    });
  });

  it('无上一条消息时不触发（新会话，system 快照即当前）', () => {
    expect(crossedLocalMidnight(undefined, new Date(2026, 7, 9, 12, 0))).toBe(false);
  });

  it('坏时间戳判为未跨天，避免每轮重复注入', () => {
    // Invalid Date 的 localDateKey 是 NaN-NaN-NaN，与今天必然不等；
    // 不显式拦掉会导致一条损坏的 ts 让每一轮都注入「日期已变更」。
    expect(crossedLocalMidnight('乱码', new Date(2026, 7, 9, 12, 0))).toBe(false);
    expect(crossedLocalMidnight('', new Date(2026, 7, 9, 12, 0))).toBe(false);
  });
});

describe('timeSection', () => {
  it('给出时刻，并明确声明它是快照、不随会话更新', () => {
    withTz('Asia/Shanghai', () => {
      const s = timeSection(new Date(2026, 7, 9, 21, 45));
      expect(s).toContain('2026-08-09 21:45');
      expect(s).toContain('快照');
      expect(s).toContain('不随会话推进更新');
    });
  });

  it('把真正需要准确时间的场合指向 date 命令，而不是让模型信这个值', () => {
    const s = timeSection(new Date(2026, 7, 9, 21, 45));
    expect(s).toContain('date');
    expect(s).toContain('不要信这个值');
  });

  it('声明训练数据截止，并指向 web_search', () => {
    const s = timeSection(new Date(2026, 7, 9, 21, 45));
    expect(s).toContain('训练数据截止');
    expect(s).toContain('web_search');
  });
});

describe('buildSystemPrompt 的时间段', () => {
  it('注入当前时间段，且 now 可注入（测试不随真实日期漂移）', () => {
    withTz('Asia/Shanghai', () => {
      const sp = buildSystemPrompt('/tmp/x', { now: new Date(2026, 7, 9, 21, 45) });
      expect(sp).toContain('## 当前时间');
      expect(sp).toContain('2026-08-09 21:45');
    });
  });

  it('纯净模式（--print）同样带时间段', () => {
    withTz('Asia/Shanghai', () => {
      const sp = buildSystemPrompt('/tmp/x', { pureMode: true, now: new Date(2026, 7, 9, 21, 45) });
      expect(sp).toContain('## 当前时间');
      expect(sp).toContain('2026-08-09 21:45');
    });
  });

  it('不传 now 时回落到真实时钟（不抛错，且含时间段）', () => {
    const sp = buildSystemPrompt('/tmp/x');
    expect(sp).toContain('## 当前时间');
  });
});
