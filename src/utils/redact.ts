/**
 * best-effort 脱敏工具：把日志与调试导出里最常见的密钥模式擦成 [REDACTED]。
 *
 * 两条边界要说清楚：
 * - `redactSecrets` 对**任意自由文本**做正则擦除（`sk-...`、`Bearer xxx`、`api_key=xxx`
 *   之类）——这是尽力而为，不保证擦干净任意格式的密钥。
 * - `redactByKeyName` 对**字段名已知**的结构化数据（config.toml/mcp.json 解析后的对象）
 *   做确定性擦除——命中敏感 key 名即替换值，可靠性更高。
 *
 * 日志写入与 debug-zip 共用同一份实现。
 */

/** 替换占位符。 */
export const REDACTED = '[REDACTED]';

/** 正文擦除规则：按顺序应用；先擦具体密钥形态，再擦 key=value 结构。 */
const TEXT_RULES: { re: RegExp; replace: string }[] = [
  // OpenAI / StepFun 风格密钥：sk-xxxx（含项目式 sk-proj-xxx）
  { re: /\bsk-[A-Za-z0-9_-]{16,}\b/g, replace: REDACTED },
  // HTTP Authorization: Bearer <token>
  { re: /\bBearer\s+[A-Za-z0-9._~+/-]+=*/gi, replace: `Bearer ${REDACTED}` },
  // key = value / key: value（含引号），仅命中敏感 key 名，保留 key 与引号、只换值
  {
    re: /(\b(?:api[_-]?key|apikey|access[_-]?token|auth[_-]?token|token|secret|password|passwd|authorization)\b\s*[:=]\s*)(["']?)([^\s"',}]+)(\2)/gi,
    replace: `$1$2${REDACTED}$2`,
  },
  // 裸 key = value：字段名只叫 `key` 时（[search] 段就是这样），但**值必须像密钥**才擦。
  // 收窄理由：本规则也作用于会话正文与日志，而编程对话里 `key = "name"`、`key: 'id'` 这类
  // 普通代码极常见，无条件擦会大面积误伤，让调试包失去价值。要求值为长度 ≥ 24 的
  // 无分隔连续串（真实密钥的形态；上面那条 sk- 规则漏掉的非 sk 前缀密钥由此兜住）。
  // key 名后允许闭合引号，以覆盖 JSON 的 "key": "value" 形态。
  {
    re: /(\bkey\b["']?\s*[:=]\s*)(["']?)([A-Za-z0-9._-]{24,})(\2)/gi,
    replace: `$1$2${REDACTED}$2`,
  },
];

/**
 * 对任意文本做 best-effort 密钥擦除。不保证完全脱敏——只挡最容易误入日志的模式。
 */
export function redactSecrets(text: string): string {
  let out = text;
  for (const { re, replace } of TEXT_RULES) {
    out = out.replace(re, replace);
  }
  return out;
}

/**
 * 敏感字段名（大小写不敏感、全匹配）。命中即把该 key 的值整体换成 [REDACTED]。
 *
 * 裸 `key` 必须在列表里：`[search] key` / `[search.web] key` / `[search.image] key` 三处
 * 存的都是真实密钥，字段名恰好就叫 `key`。漏了它的后果实测过——一个不以 `sk-` 开头的
 * 搜索密钥明文进了 debug-zip，而那个包的用途正是「发给我们排查」。
 * 结构化数据（config.toml / mcp.json 解析后）里叫 `key` 的就是密钥，误伤面可忽略；
 * 会话正文那条路径不用本列表，见 TEXT_RULES 里收窄后的裸 key 规则。
 */
const SENSITIVE_KEY =
  /^(api[_-]?key|apikey|key|access[_-]?token|auth[_-]?token|token|secret|client[_-]?secret|password|passwd|authorization|auth)$/i;

/**
 * 对解析后的结构化数据（对象/数组）按 key 名做确定性脱敏：命中敏感 key 名的值——无论
 * 类型——整体替换为 [REDACTED]；其余对象/数组递归处理。原地修改并返回同一引用。
 * 存在环时靠 seen 集合防无限递归。
 */
export function redactByKeyName(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (seen.has(value)) return value;
  seen.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      value[i] = redactByKeyName(value[i], seen);
    }
    return value;
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (SENSITIVE_KEY.test(key)) {
      obj[key] = REDACTED;
    } else {
      obj[key] = redactByKeyName(obj[key], seen);
    }
  }
  return obj;
}
