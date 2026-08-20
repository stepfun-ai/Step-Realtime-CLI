import { describe, expect, it } from 'vitest';
import { resolveBackgroundConfig } from '../src/config/config.js';

describe('resolveBackgroundConfig', () => {
  it('缺省 / 非对象 → 空对象（键不进结果对象）', () => {
    expect(resolveBackgroundConfig(undefined)).toEqual({});
    expect(resolveBackgroundConfig('not-object')).toEqual({});
    expect(resolveBackgroundConfig(null)).toEqual({});
  });

  it('三字段全配 → 全部进结果对象', () => {
    expect(
      resolveBackgroundConfig({
        bash_auto_background_on_timeout: false,
        bash_task_timeout_s: 120,
        notify_on_complete: false,
      }),
    ).toEqual({
      bashAutoBackgroundOnTimeout: false,
      bashTaskTimeoutS: 120,
      notifyOnComplete: false,
    });
  });

  it('只配部分字段 → 只有所配键进结果对象', () => {
    expect(resolveBackgroundConfig({ notify_on_complete: true })).toEqual({ notifyOnComplete: true });
    expect('bashTaskTimeoutS' in resolveBackgroundConfig({ notify_on_complete: true })).toBe(false);
  });

  it('bash_task_timeout_s 越界 → clamp 到 [0, 86400]，0 合法（不限）', () => {
    expect(resolveBackgroundConfig({ bash_task_timeout_s: 999_999 })).toEqual({ bashTaskTimeoutS: 86_400 });
    expect(resolveBackgroundConfig({ bash_task_timeout_s: -5 })).toEqual({ bashTaskTimeoutS: 0 });
    expect(resolveBackgroundConfig({ bash_task_timeout_s: 0 })).toEqual({ bashTaskTimeoutS: 0 });
  });

  it('非法类型字段 → 视为未配置（键不进结果对象）', () => {
    expect(
      resolveBackgroundConfig({
        bash_auto_background_on_timeout: 'yes',
        bash_task_timeout_s: '600',
        notify_on_complete: 1,
      }),
    ).toEqual({});
  });
});
