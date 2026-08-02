import { describe, expect, it } from 'vitest';
import { redactByKeyName, redactSecrets } from '../../src/utils/redact.js';

describe('redactSecrets', () => {
  it('擦除 sk- 风格密钥', () => {
    const out = redactSecrets('key is sk-abcdEFGH1234567890xyz end');
    expect(out).not.toContain('sk-abcdEFGH1234567890xyz');
    expect(out).toContain('[REDACTED]');
  });

  it('擦除 Bearer token 但保留 Bearer 前缀', () => {
    const out = redactSecrets('request header uses Bearer abc.def-123_XYZ here');
    expect(out).toContain('Bearer [REDACTED]');
    expect(out).not.toContain('abc.def-123_XYZ');
  });

  it('Authorization 头部整体脱敏（key 名命中即擦，安全优先）', () => {
    const out = redactSecrets('Authorization: Bearer abc.def-123_XYZ');
    expect(out).not.toContain('abc.def-123_XYZ');
    expect(out).toContain('[REDACTED]');
  });

  it('擦除 api_key=xxx / token: xxx，保留 key 名', () => {
    expect(redactSecrets('api_key=SECRETVALUE123')).toBe('api_key=[REDACTED]');
    expect(redactSecrets('token: myToken9988')).toBe('token: [REDACTED]');
    expect(redactSecrets('secret="hunter2plaintext"')).toBe('secret="[REDACTED]"');
  });

  it('不误伤普通文本', () => {
    const clean = 'this is a normal log line about sk (not a key) and tokens generally';
    expect(redactSecrets(clean)).toBe(clean);
  });
});

describe('redactByKeyName', () => {
  it('命中敏感 key 名整体替换值（含嵌套与数组）', () => {
    const obj = {
      model: 'step-3.7-flash',
      api_key: 'sk-realkey',
      nested: { token: 'abc', keep: 'ok' },
      servers: [{ authorization: 'Bearer x', name: 'srv' }],
    };
    redactByKeyName(obj);
    expect(obj.api_key).toBe('[REDACTED]');
    expect(obj.nested.token).toBe('[REDACTED]');
    expect(obj.nested.keep).toBe('ok');
    expect(obj.servers[0]!.authorization).toBe('[REDACTED]');
    expect(obj.servers[0]!.name).toBe('srv');
    expect(obj.model).toBe('step-3.7-flash');
  });

  it('非敏感 key 与非对象值原样保留', () => {
    const obj = { a: 1, b: 'x', c: [1, 2, 3] };
    redactByKeyName(obj);
    expect(obj).toEqual({ a: 1, b: 'x', c: [1, 2, 3] });
  });
});
