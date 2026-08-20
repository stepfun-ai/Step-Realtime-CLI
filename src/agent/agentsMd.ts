/**
 * AGENTS.md 自动加载。
 *
 * 收集用户级（~/.step-code、~/.agents）与项目级（.git 根到 cwd 逐层）的 AGENTS.md，
 * 每层候选优先级：.step-code/AGENTS.md → AGENTS.override.md → AGENTS.md → agents.md
 * （AGENTS.override.md 是个人本地覆盖约定，不入库即可压住同层团队规范）。
 * 每份前加 `<!-- From: <绝对路径> -->` 注释头后拼接，供 system prompt 尾部注入。
 * 总量预算默认 32KB（config.toml agents_md_max_bytes 可调，0 = 禁用加载），
 * 叶子优先分配（离 cwd 越近越先分），超限 UTF-8 安全截断。
 * 截断/丢弃明细随返回值带出，供启动时一次性提示用户。
 * config.toml 的 agents_paths 可完全覆盖上述收集。
 * 会话启动时加载一次，不做 watcher。
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

/** AGENTS.md 默认总字节预算（按 UTF-8 字节数计） */
export const DEFAULT_AGENTS_MD_BUDGET_BYTES = 32 * 1024;

/** 截断后在末尾追加的省略标记 */
const TRUNCATED_MARK = '\n…';

/** 一份被预算裁掉的文件明细：keptBytes = 0 表示整篇丢弃（连注释头都放不下或预算已耗尽）。 */
export interface AgentsMdTruncation {
  path: string;
  originalBytes: number;
  keptBytes: number;
}

/** loadAgentsMd 的返回：拼接文本 + 截断/丢弃明细（未发生裁减时为空数组）。 */
export interface AgentsMdResult {
  text: string;
  truncated: AgentsMdTruncation[];
}

/** 收集到的一份文件：绝对路径 + 正文 */
interface AgentsMdEntry {
  path: string;
  content: string;
}

/** 从 cwd 向上找第一个含 .git（文件或目录均可）的目录作为项目根；找不到退回 cwd 本身。 */
function findProjectRoot(cwd: string): string {
  const start = resolve(cwd);
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, '.git'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

/** 读取单个候选文件；不存在或读取失败返回 null。 */
function readEntry(path: string): AgentsMdEntry | null {
  if (!existsSync(path)) return null;
  try {
    return { path, content: readFileSync(path, 'utf8') };
  } catch {
    // 读取失败（权限等）按不存在处理，不阻塞启动
    return null;
  }
}

/** 目录层内按优先级取第一个命中：.step-code/AGENTS.md，再 AGENTS.override.md（个人本地覆盖约定），再 AGENTS.md / agents.md。 */
function readLayerEntry(dir: string): AgentsMdEntry | null {
  return (
    readEntry(join(dir, '.step-code', 'AGENTS.md')) ??
    readEntry(join(dir, 'AGENTS.override.md')) ??
    readEntry(join(dir, 'AGENTS.md')) ??
    readEntry(join(dir, 'agents.md'))
  );
}

/** 用户级条目（输出在最前）：~/.step-code 与 ~/.agents 各取一个，override 优先，再 AGENTS.md（退 agents.md）。 */
function userEntries(homeDir: string): AgentsMdEntry[] {
  const out: AgentsMdEntry[] = [];
  const stepCode =
    readEntry(join(homeDir, '.step-code', 'AGENTS.override.md')) ??
    readEntry(join(homeDir, '.step-code', 'AGENTS.md'));
  if (stepCode !== null) out.push(stepCode);
  const agents =
    readEntry(join(homeDir, '.agents', 'AGENTS.override.md')) ??
    readEntry(join(homeDir, '.agents', 'AGENTS.md')) ??
    readEntry(join(homeDir, '.agents', 'agents.md'));
  if (agents !== null) out.push(agents);
  return out;
}

/** 解析配置里的路径条目：`~` 展开为 homeDir，相对路径按 cwd 解析为绝对路径。 */
function resolveConfigPath(p: string, cwd: string, homeDir: string): string {
  const expanded =
    p === '~' ? homeDir : p.startsWith('~/') || p.startsWith('~\\') ? join(homeDir, p.slice(2)) : p;
  return resolve(cwd, expanded);
}

/** 读取一个自定义条目：是目录取 AGENTS.override.md → AGENTS.md → agents.md 第一个命中，否则按文件直读。 */
function readCustomEntry(path: string): AgentsMdEntry | null {
  try {
    if (existsSync(path) && statSync(path).isDirectory()) {
      return (
        readEntry(join(path, 'AGENTS.override.md')) ??
        readEntry(join(path, 'AGENTS.md')) ??
        readEntry(join(path, 'agents.md'))
      );
    }
  } catch {
    // stat 失败按文件直读处理
  }
  return readEntry(path);
}

/** 按 UTF-8 字节数截断字符串，不在多字节字符中间切断。 */
function utf8Truncate(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, 'utf8');
  if (buf.length <= maxBytes) return s;
  let end = maxBytes;
  // 截断点落在字符中间（紧随的字节是 continuation 10xxxxxx）时，回退到该字符的起始字节
  while (end > 0 && (buf[end] & 0xc0) === 0x80) end--;
  return buf.toString('utf8', 0, end);
}

/**
 * 加载并拼接 AGENTS.md。homeDir 可注入便于测试，默认 os.homedir()。
 * 输出顺序：用户级在前，项目级从根到叶；全都没有返回空串。
 * customPaths（config.toml agents_paths）非空时走覆盖模式：跳过默认收集，
 * 只按配置顺序读取（文件直读，目录取 AGENTS.md / agents.md），越靠后的条目预算越优先。
 * budgetBytes（config.toml agents_md_max_bytes）默认 32KB；0 或负数 = 禁用加载（返回空，不算截断）。
 * 发生截断/整篇丢弃时明细记入返回值的 truncated，供调用方提示用户。
 */
export function loadAgentsMd(
  cwd: string,
  homeDir: string = homedir(),
  customPaths?: string[],
  budgetBytes: number = DEFAULT_AGENTS_MD_BUDGET_BYTES,
): AgentsMdResult {
  const empty: AgentsMdResult = { text: '', truncated: [] };
  // 0 / 负数 = 禁用加载
  const budget = Math.floor(budgetBytes);
  if (budget <= 0) return empty;
  let entries: AgentsMdEntry[];
  if (customPaths !== undefined && customPaths.length > 0) {
    entries = [];
    for (const p of customPaths) {
      const e = readCustomEntry(resolveConfigPath(p, cwd, homeDir));
      if (e !== null) entries.push(e);
    }
  } else {
    const root = findProjectRoot(cwd);
    // 项目级：cwd 到根逐层收集后反转，得到根 → 叶
    const dirs: string[] = [];
    let dir = resolve(cwd);
    for (;;) {
      dirs.push(dir);
      if (dir === root) break;
      dir = dirname(dir);
    }
    dirs.reverse();

    entries = [...userEntries(homeDir)];
    for (const d of dirs) {
      const e = readLayerEntry(d);
      if (e !== null) entries.push(e);
    }
  }
  if (entries.length === 0) return empty;

  // 叶子优先分配预算：倒序决定每份能拿到的字节数，输出顺序不变
  // 计入预算的含注释头、正文与条目间的 \n\n 连接符（除首个收录条目外每个 +2 字节）
  const parts: (string | null)[] = new Array<string | null>(entries.length).fill(null);
  const truncated: AgentsMdTruncation[] = [];
  let remaining = budget;
  let included = 0;
  for (let i = entries.length - 1; i >= 0; i--) {
    const originalBytes = Buffer.byteLength(entries[i].content, 'utf8');
    if (remaining <= 0) {
      // 预算已耗尽：更上层的文件整篇丢弃（不注入残文），但记入明细提示用户
      truncated.push({ path: entries[i].path, originalBytes, keptBytes: 0 });
      continue;
    }
    const sepBytes = included > 0 ? 2 : 0;
    const header = `<!-- From: ${entries[i].path} -->\n`;
    const headerBytes = Buffer.byteLength(header, 'utf8');
    if (headerBytes + originalBytes + sepBytes <= remaining) {
      parts[i] = header + entries[i].content;
      remaining -= headerBytes + originalBytes + sepBytes;
      included++;
    } else {
      // 预算不足：给省略标记预留字节后对正文做 UTF-8 安全截断；连头都放不下则整篇丢弃
      const contentBudget = remaining - headerBytes - Buffer.byteLength(TRUNCATED_MARK, 'utf8') - sepBytes;
      if (contentBudget > 0) {
        const kept = utf8Truncate(entries[i].content, contentBudget);
        parts[i] = header + kept + TRUNCATED_MARK;
        truncated.push({ path: entries[i].path, originalBytes, keptBytes: Buffer.byteLength(kept, 'utf8') });
        included++;
      } else {
        truncated.push({ path: entries[i].path, originalBytes, keptBytes: 0 });
      }
      remaining = 0;
    }
  }
  // 明细按输出顺序（根 → 叶）返回，与拼接文本的阅读顺序一致
  truncated.reverse();
  return { text: parts.filter((p): p is string => p !== null).join('\n\n'), truncated };
}
