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

/** vendor 级别占位符：知识库文件内容。 */
export const VAULT_CONTENT = '[VAULT_CONTENT]';
/** vendor 级别占位符：AGENTS.md 内容。 */
export const SYSTEM_CONFIG = '[SYSTEM_CONFIG]';
/** vendor 级别占位符：知识库路径。 */
export const VAULT_PATH = '[VAULT_PATH]';

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

// ── vendor 级别：内容与路径脱敏 ──────────────────────────────────

// 本地知识库目录名与父目录名。标识本地环境的目录结构，
// 应从本地配置注入，不宜硬编码到公开仓库。
// 当前硬编码是因为 debug 脱敏只在本地运行，且 fork 仓库为 private。
const VAULT_DIR = ['pkm', 'hub'].join('-');
const VAULT_PARENT = ['obsidian', 'projects'].join('_');
const AGENTS_DIST = VAULT_DIR + '-agents-md 分发';

function escRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}


/**
 * 路径脱敏规则：把知识库路径替换为占位符。
 *
 * 按顺序匹配，先长后短：
 * 1. Windows 完整路径（含用户名）
 * 2. Git Bash 路径
 * 3. 含知识库根目录的长路径
 * 4. 裸路径段
 */
const PATH_RULES: { re: RegExp; replace: string }[] = [
  // Windows 完整路径（含用户名）
  { re: new RegExp('C:\\\\Users\\\\[^\\\\]+\\\\Documents\\\\projects\\\\' + escRe(VAULT_PARENT) + '\\\\' + escRe(VAULT_DIR) + '[^\\s"' + "'" + '\\]]*', 'gi'), replace: VAULT_PATH },
  // Git Bash / MSYS 路径
  { re: new RegExp('\/c\/Users\/[^/]+\/Documents\/projects\/' + escRe(VAULT_PARENT) + '\/' + escRe(VAULT_DIR) + '[^\s"' + "'" + '\]]*', 'g'), replace: VAULT_PATH },
  // 其它 C: 开头的知识库相关路径
  { re: /C:\\Users\\[^\\]+\\.step-code\b/g, replace: 'C:\\Users\\USER\\.step-code' },
  { re: /C:\\Users\\[^\\]+\\.pi\b/g, replace: 'C:\\Users\\USER\\.pi' },
  // 知识库系列目录名
  { re: new RegExp('\\b' + escRe(VAULT_DIR) + '(?:-skills|-agents-md|-runtime|-recon|-wealth|-books|-lab|-archive)\\b', 'g'), replace: 'VAULT' },
  // 裸知识库根目录名
  { re: new RegExp('\\b' + escRe(VAULT_DIR) + '\\b', 'g'), replace: 'VAULT' },
  // 知识库父目录
  { re: new RegExp('\\b' + escRe(VAULT_PARENT) + '\\b', 'g'), replace: 'vault_projects' },
];

/**
 * AGENTS.md 内容指纹：检测文本是否包含 AGENTS.md 特征标记。
 *
 * 选这些标记的理由：
 * - `## 输出约束`：AGENTS.md 核心章节，知识库其他文件不会出现
 * - `## 项目体系`：AGENTS.md 独有
 * - `## 前置 Skill 加载`：AGENTS.md 独有
 * - 分发标记：文件头注释，唯一
 *
 * 命中任意一个即判定为 AGENTS.md 内容。误报面极小——这些标题组合在普通文档里不会同时出现。
 */
const AGENTS_MARKERS = [
  '## 输出约束',
  '## 项目体系',
  '## 前置 Skill 加载',
  AGENTS_DIST,
];

/**
 * vendor 级别：对文本做路径替换。
 * 只替换路径，不动内容结构——tool_result 的代码内容对排查有价值。
 */
export function redactPaths(text: string): string {
  let out = text;
  for (const { re, replace } of PATH_RULES) {
    out = out.replace(re, replace);
  }
  return out;
}

/**
 * 检测一段文本是否是 AGENTS.md 内容（内容指纹匹配）。
 */
export function looksLikeAgentsMd(text: string): boolean {
  return AGENTS_MARKERS.some((m) => text.includes(m));
}

/**
 * 判断路径是否属于知识库。
 */
function isVaultPath(p: string): boolean {
  const lower = p.toLowerCase();
  return (
    lower.includes(VAULT_DIR) ||
    lower.includes(VAULT_PARENT) ||
    lower.includes('agents.md') ||
    lower.includes(VAULT_DIR + '-skills') ||
    lower.includes(VAULT_DIR + '-agents-md')
  );
}

/**
 * wire.jsonl 行级结构化脱敏（vendor 级别）。
 *
 * 解析每行 JSON，对 context.append_message 的 tool_result 做指纹检测：
 * - 来源是 AGENTS.md → 内容替换为 [SYSTEM_CONFIG]
 * - 来源是知识库文件 → 内容替换为 [VAULT_CONTENT]
 *
 * 检测来源的方法：看同一条消息里 tool_use 块的 input 是否包含
 * 知识库路径或 agents.md。如果 wire 里只有 tool_result 没有 tool_use，
 * 退回到内容指纹检测。
 *
 * 非 append_message 行做纯路径脱敏。
 */
export function redactWireLineVendor(line: string): string {
  try {
    const obj = JSON.parse(line) as Record<string, unknown>;
    if (obj.type !== 'context.append_message') return redactSecrets(redactPaths(line));

    const msg = (obj.message as Record<string, unknown>) ?? {};
    const inner = (msg.message as Record<string, unknown>) ?? {};
    const content = inner.content;
    if (!Array.isArray(content)) {
      // content 是字符串（如 user 消息）——结构化脱敏不适用，退回密钥 + 路径脱敏
      return redactSecrets(redactPaths(line));
    }

    // 先收集这条消息里所有 tool_use 的路径
    const toolPaths: string[] = [];
    for (const block of content) {
      if (typeof block !== 'object' || block === null) continue;
      const b = block as Record<string, unknown>;
      if (b.type === 'tool_use') {
        const input = b.input as Record<string, unknown> | undefined;
        const path = (input?.path ?? input?.file_path ?? input?.file) as string | undefined;
        if (path !== undefined) toolPaths.push(path);
      }
    }

    // 对 tool_result 做脱敏
    let resultIdx = 0;
    for (let i = 0; i < content.length; i++) {
      const block = content[i];
      if (typeof block !== 'object' || block === null) continue;
      const b = block as Record<string, unknown>;
      if (b.type !== 'tool_result') continue;

      const text = typeof b.content === 'string' ? b.content : JSON.stringify(b.content ?? '');
      // 1. AGENTS.md 指纹检测（最优先）
      if (looksLikeAgentsMd(text)) {
        content[i] = { ...b, content: SYSTEM_CONFIG };
        continue;
      }
      // 2. tool_use 路径匹配
      const sourcePath = toolPaths[resultIdx] ?? '';
      if (sourcePath !== '' && isVaultPath(sourcePath)) {
        content[i] = { ...b, content: VAULT_CONTENT };
      }
      resultIdx++;
    }

    // JSON.stringify 会把字符串里的 \ 转义成 \\，导致 redactPaths 的正则匹配不上。
    // 所以在序列化之前，先对所有 string 值跑路径脱敏。
    redactPathsInObject(obj);
    return redactSecrets(redactPaths(JSON.stringify(obj)));
  } catch {
    // 解析失败，退回纯文本脱敏
    return redactSecrets(redactPaths(line));
  }
}

/**
 * 递归遍历对象，对所有 string 值应用 redactPaths。
 * 在 JSON.stringify 之前调用，避免反斜杠被双重转义导致路径正则失配。
 */
function redactPathsInObject(obj: unknown, seen: WeakSet<object> = new WeakSet()): void {
  if (obj === null || typeof obj !== 'object') return;
  if (seen.has(obj)) return;
  seen.add(obj);
  if (Array.isArray(obj)) {
    for (let i = 0; i < obj.length; i++) {
      if (typeof obj[i] === 'string') {
        obj[i] = redactPaths(obj[i] as string);
      } else if (typeof obj[i] === 'object' && obj[i] !== null) {
        redactPathsInObject(obj[i], seen);
      }
    }
    return;
  }
  const record = obj as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    const val = record[key];
    if (typeof val === 'string') {
      record[key] = redactPaths(val);
    } else if (typeof val === 'object' && val !== null) {
      redactPathsInObject(val, seen);
    }
  }
}
