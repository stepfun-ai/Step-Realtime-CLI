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

  it('裸 `key` 字段必须脱敏：[search] 段的密钥字段名就叫 key（2026-08-03 实测泄漏）', () => {
    // 实测事故：一个不以 sk- 开头的搜索密钥因字段名是裸 `key` 而未被任何规则命中，
    // 明文写进了 debug-zip，而那个包的用途恰恰是发给他人排查。
    const obj = {
      search: {
        url: 'https://api.stepfun.com/step_plan/v1',
        key: 'A1bC2dE3fG4hI5jK6lM7nO8pQ9rS0tU1vW2xY3z',
        web: { key: 'anotherLongLookingSecretValue123456' },
      },
    };
    redactByKeyName(obj);
    expect(obj.search.key).toBe('[REDACTED]');
    expect(obj.search.web.key).toBe('[REDACTED]');
    // url 不是密钥，必须保留——它对排查有用
    expect(obj.search.url).toBe('https://api.stepfun.com/step_plan/v1');
  });
});

describe('redactSecrets 的裸 key 规则（会话正文/日志路径）', () => {
  it('值像密钥时擦除：非 sk- 前缀的长串也兜住', () => {
    const out = redactSecrets('key = "A1bC2dE3fG4hI5jK6lM7nO8pQ9rS0tU1vW2xY3z"');
    expect(out).toBe('key = "[REDACTED]"');
    expect(out).not.toContain('A1bC2dE3');
  });

  it('值不像密钥时不擦——编程对话里 key = "name" 极常见，误伤会让调试包失去价值', () => {
    for (const clean of ['key = "name"', "key: 'id'", 'const key = value', 'key = 42']) {
      expect(redactSecrets(clean)).toBe(clean);
    }
  });

  it('TOML 与 JSON 两种赋值形态都覆盖', () => {
    expect(redactSecrets('key="Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0Fe"')).toContain('[REDACTED]');
    expect(redactSecrets('"key": "Zx9Yw8Vu7Ts6Rq5Po4Nm3Lk2Ji1Hg0Fe"')).toContain('[REDACTED]');
  });
});
