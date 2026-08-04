import { describe, expect, it, vi } from 'vitest';
import Anthropic from '@anthropic-ai/sdk';
import {
  abortableSleep,
  computeBackoff,
  computeRetryDelay,
  errorAdvice,
  isContextOverflowError,
  isRateLimitError,
  isRetryableError,
  RETRY_AFTER_MAX_MS,
  RETRY_BASE_MS,
  RETRY_MAX_MS,
  retryAfterMs,
  summarizeError,
  withRetry,
} from '../../src/provider/retry.js';

describe('summarizeError', () => {
  it('裸 JSON body（{"type":"error"} 现场）→ 剥状态码前缀，保 type 信息', () => {
    const err = Anthropic.APIError.generate(400, { type: 'error' }, '{"type":"error"}', new Headers());
    expect(summarizeError(err)).toBe('HTTP 400 · {"type":"error"}');
  });

  it('标准错误形 → type: message 可读摘要', () => {
    const err = Anthropic.APIError.generate(
      400,
      { error: { type: 'invalid_request_error', message: 'prompt is too long' } },
      'prompt is too long',
      new Headers(),
    );
    expect(summarizeError(err)).toBe('HTTP 400 · invalid_request_error: prompt is too long');
  });

  it('普通 Error（非 APIError）→ 原文返回，不加状态码', () => {
    expect(summarizeError(new Error('boom'))).toBe('boom');
  });

  it('undici fetch failed → 附 cause 链上的真实 code', () => {
    const err = new TypeError('fetch failed', { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) });
    expect(summarizeError(err)).toBe('fetch failed (ECONNRESET)');
  });

  it('SDK 已带状态码前缀 → 剥掉后统一成 HTTP {status} · 形式', () => {
    const err = Anthropic.APIError.generate(429, { message: 'rate limited' }, undefined, new Headers());
    expect(summarizeError(err)).toBe('HTTP 429 · rate limited');
  });
});

describe('isRetryableError', () => {
  it('网络连接错误可重试', () => {
    expect(isRetryableError(new Anthropic.APIConnectionError({ message: 'net' }))).toBe(true);
  });

  it('带 ECONNRESET/ETIMEDOUT code 的错误可重试', () => {
    expect(isRetryableError(Object.assign(new Error('x'), { code: 'ECONNRESET' }))).toBe(true);
    expect(isRetryableError(Object.assign(new Error('x'), { code: 'ETIMEDOUT' }))).toBe(true);
  });

  it('普通错误不可重试', () => {
    expect(isRetryableError(new Error('boom'))).toBe(false);
    expect(isRetryableError(undefined)).toBe(false);
  });

  it('undici fetch failed（code 嵌在 cause 链）→ 可重试', () => {
    // OpenAI 兼容通道裸 fetch 的真实失败形态：TypeError 顶层无 code
    const err = new TypeError('fetch failed', { cause: Object.assign(new Error('reset'), { code: 'ECONNRESET' }) });
    expect(isRetryableError(err)).toBe(true);
  });

  it('undici 裸 fetch failed / terminated（cause 缺 code）→ 可重试', () => {
    expect(isRetryableError(new TypeError('fetch failed'))).toBe(true);
    expect(isRetryableError(new TypeError('terminated'))).toBe(true);
  });

  it('undici 自定义 code（UND_ERR_SOCKET 等，可能多级嵌套）→ 可重试', () => {
    const socket = Object.assign(new Error('socket'), { code: 'UND_ERR_SOCKET' });
    const err = new TypeError('fetch failed', { cause: { cause: socket } });
    expect(isRetryableError(err)).toBe(true);
    expect(isRetryableError(Object.assign(new Error('x'), { code: 'EAI_AGAIN' }))).toBe(true);
  });

  it('非网络类 TypeError（如 invalid URL）→ 不可重试', () => {
    expect(isRetryableError(new TypeError('Invalid URL'))).toBe(false);
    // cause 链上是不可重试的 code 也不算
    expect(isRetryableError(Object.assign(new Error('x'), { code: 'ENOTFOUND' }))).toBe(false);
  });
});

describe('isContextOverflowError', () => {
  it('400 且消息含溢出关键词 → true', () => {
    const err = new Anthropic.APIError(400, undefined, 'prompt is too long: 1200000 tokens > 1048576', undefined);
    expect(isContextOverflowError(err)).toBe(true);
  });

  it('400 但普通消息 → false', () => {
    const err = new Anthropic.APIError(400, undefined, 'invalid model name', undefined);
    expect(isContextOverflowError(err)).toBe(false);
  });

  it('非 APIError（普通 Error）→ false，即便消息含关键词', () => {
    expect(isContextOverflowError(new Error('prompt is too long'))).toBe(false);
  });
});

describe('computeBackoff', () => {
  it('首次退避在 [base, base*1.25] 内', () => {
    const d = computeBackoff(1);
    expect(d).toBeGreaterThanOrEqual(RETRY_BASE_MS);
    expect(d).toBeLessThanOrEqual(RETRY_BASE_MS * 1.25);
  });

  it('随尝试次数增长并封顶在 [max, max*1.25]', () => {
    const big = computeBackoff(20);
    expect(big).toBeGreaterThanOrEqual(RETRY_MAX_MS);
    expect(big).toBeLessThanOrEqual(RETRY_MAX_MS * 1.25);
  });
});

describe('retryAfterMs', () => {
  it('秒数形式的 Retry-After → 换成毫秒', () => {
    const err = new Anthropic.APIError(429, undefined, 'rate limited', new Headers({ 'retry-after': '2' }));
    expect(retryAfterMs(err)).toBe(2000);
  });

  it('HTTP-date 形式的 Retry-After → 相对现在的等待时长', () => {
    const at = new Date(Date.now() + 3000).toUTCString();
    const err = new Anthropic.APIError(429, undefined, 'rate limited', new Headers({ 'retry-after': at }));
    const ms = retryAfterMs(err);
    expect(ms).toBeGreaterThan(0);
    expect(ms).toBeLessThanOrEqual(3000);
  });

  it('超过上限的服务端等待值 → 封顶 RETRY_AFTER_MAX_MS', () => {
    const err = new Anthropic.APIError(429, undefined, 'rate limited', new Headers({ 'retry-after': '600' }));
    expect(retryAfterMs(err)).toBe(RETRY_AFTER_MAX_MS);
  });

  it('缺失 / 畸形 / 非 APIError → undefined（回退本地退避）', () => {
    expect(retryAfterMs(new Anthropic.APIError(429, undefined, 'x', new Headers()))).toBeUndefined();
    expect(
      retryAfterMs(new Anthropic.APIError(429, undefined, 'x', new Headers({ 'retry-after': 'soon' }))),
    ).toBeUndefined();
    expect(
      retryAfterMs(new Anthropic.APIError(429, undefined, 'x', new Headers({ 'retry-after': '-5' }))),
    ).toBeUndefined();
    expect(retryAfterMs(new Anthropic.APIError(429, undefined, 'x', undefined))).toBeUndefined();
    expect(retryAfterMs(new Error('boom'))).toBeUndefined();
  });

  it('computeRetryDelay：Retry-After 优先，缺省走本地退避', () => {
    const withHeader = new Anthropic.APIError(429, undefined, 'x', new Headers({ 'retry-after': '7' }));
    expect(computeRetryDelay(1, withHeader)).toBe(7000);
    const noHeader = new Anthropic.APIError(500, undefined, 'x', undefined);
    const d = computeRetryDelay(1, noHeader);
    expect(d).toBeGreaterThanOrEqual(RETRY_BASE_MS);
    expect(d).toBeLessThanOrEqual(RETRY_BASE_MS * 1.25);
  });
});

describe('isRateLimitError', () => {
  it('429 → true；其他状态 / 非 APIError → false', () => {
    expect(isRateLimitError(new Anthropic.APIError(429, undefined, 'x', undefined))).toBe(true);
    expect(isRateLimitError(new Anthropic.APIError(500, undefined, 'x', undefined))).toBe(false);
    expect(isRateLimitError(new Anthropic.APIError(401, undefined, 'x', undefined))).toBe(false);
    expect(isRateLimitError(new Error('boom'))).toBe(false);
  });
});

describe('errorAdvice', () => {
  it('401/403 → 建议检查 key 配置', () => {
    expect(errorAdvice(new Anthropic.APIError(401, undefined, 'x', undefined))).toContain('STEP_CODE_API_KEY');
    expect(errorAdvice(new Anthropic.APIError(403, undefined, 'x', undefined))).toContain('config.toml');
  });

  it('429 → 建议稍后重试或查配额；其他错误无建议', () => {
    expect(errorAdvice(new Anthropic.APIError(429, undefined, 'x', undefined))).toContain('限流');
    expect(errorAdvice(new Anthropic.APIError(500, undefined, 'x', undefined))).toBeUndefined();
    expect(errorAdvice(new Error('boom'))).toBeUndefined();
  });
});

describe('withRetry 的 Retry-After 优先', () => {
  it('429 带 Retry-After 时，onRetry 拿到的延迟用服务端值', async () => {
    const delays: number[] = [];
    let n = 0;
    const fn = vi.fn(async () => {
      n++;
      if (n < 2) {
        throw new Anthropic.APIError(429, undefined, 'rate limited', new Headers({ 'retry-after': '1' }));
      }
      return 'done';
    });
    await expect(
      withRetry(fn, { maxAttempts: 3, onRetry: (_a, delay) => delays.push(delay) }),
    ).resolves.toBe('done');
    expect(delays).toEqual([1000]);
  });

  it('429 无 Retry-After 时，onRetry 拿到的延迟走本地退避', async () => {
    const delays: number[] = [];
    let n = 0;
    const fn = vi.fn(async () => {
      n++;
      if (n < 2) throw new Anthropic.APIError(429, undefined, 'rate limited', undefined);
      return 'done';
    });
    await expect(
      withRetry(fn, { maxAttempts: 3, onRetry: (_a, delay) => delays.push(delay) }),
    ).resolves.toBe('done');
    expect(delays[0]).toBeGreaterThanOrEqual(RETRY_BASE_MS);
    expect(delays[0]).toBeLessThanOrEqual(RETRY_BASE_MS * 1.25);
  });
});

describe('abortableSleep', () => {
  it('正常按时 resolve', async () => {
    await expect(abortableSleep(10)).resolves.toBeUndefined();
  });

  it('已中止的 signal 立即 reject', async () => {
    const ac = new AbortController();
    ac.abort();
    await expect(abortableSleep(10, ac.signal)).rejects.toThrow();
  });

  it('sleep 中途中止会 reject', async () => {
    const ac = new AbortController();
    const p = abortableSleep(1000, ac.signal);
    ac.abort();
    await expect(p).rejects.toThrow();
  });
});

describe('withRetry', () => {
  it('首次成功不重试', async () => {
    const fn = vi.fn(async () => 'ok');
    await expect(withRetry(fn)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('可重试错误重试后成功', async () => {
    let n = 0;
    const fn = vi.fn(async () => {
      n++;
      if (n < 2) throw Object.assign(new Error('net'), { code: 'ECONNRESET' });
      return 'done';
    });
    await expect(withRetry(fn, { maxAttempts: 3 })).resolves.toBe('done');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('undici fetch failed（裸 fetch 真实失败形态）重试后成功', async () => {
    let n = 0;
    const fn = vi.fn(async () => {
      n++;
      if (n < 2) throw new TypeError('fetch failed', { cause: Object.assign(new Error('x'), { code: 'UND_ERR_SOCKET' }) });
      return 'done';
    });
    await expect(withRetry(fn, { maxAttempts: 3 })).resolves.toBe('done');
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it('不可重试错误立即抛出，只调用一次', async () => {
    const fn = vi.fn(async () => {
      throw new Error('fatal');
    });
    await expect(withRetry(fn, { maxAttempts: 3 })).rejects.toThrow('fatal');
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('已中止的 signal 不执行并抛出', async () => {
    const ac = new AbortController();
    ac.abort();
    const fn = vi.fn(async () => 'ok');
    await expect(withRetry(fn, { signal: ac.signal })).rejects.toThrow();
    expect(fn).not.toHaveBeenCalled();
  });
});
