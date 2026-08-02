import { describe, expect, it } from 'vitest';
import { resolveSearchBaseUrl } from '../../src/tools/searchBase.js';

describe('resolveSearchBaseUrl', () => {
  it('缺省 fallback 到 api.stepfun.com', () => {
    expect(resolveSearchBaseUrl()).toBe('https://api.stepfun.com');
    expect(resolveSearchBaseUrl('')).toBe('https://api.stepfun.com');
  });

  it('裸域名保持不变', () => {
    expect(resolveSearchBaseUrl('https://api.stepfun.com')).toBe('https://api.stepfun.com');
    expect(resolveSearchBaseUrl('https://api.stepfun.com/')).toBe('https://api.stepfun.com');
  });

  it('去掉 /v1 后缀', () => {
    expect(resolveSearchBaseUrl('https://api.stepfun.com/v1')).toBe('https://api.stepfun.com');
    expect(resolveSearchBaseUrl('https://api.stepfun.com/v1/')).toBe('https://api.stepfun.com');
  });

  it('去掉 /step_plan/v1 后缀', () => {
    expect(resolveSearchBaseUrl('https://api.stepfun.com/step_plan/v1')).toBe('https://api.stepfun.com');
    expect(resolveSearchBaseUrl('https://api.stepfun.com/step_plan/v1/')).toBe('https://api.stepfun.com');
  });

  it('保留其他路径（代理场景）', () => {
    expect(resolveSearchBaseUrl('https://proxy.example.com/api')).toBe('https://proxy.example.com/api');
  });

  it('非法 URL 兜底去尾斜杠', () => {
    expect(resolveSearchBaseUrl('not-a-url/')).toBe('not-a-url');
  });
});
