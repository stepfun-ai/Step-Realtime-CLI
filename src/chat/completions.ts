import { SLASH_COMMANDS, type SlashCommand } from './commands.js';

/**
 * 输入框统一补全引擎：斜杠命令、命令参数、@ 文件引用三类候选收敛为一套
 * 「补全项」模型，供 PromptInput 的菜单渲染、选择、行高预算共用。
 *
 * 设计要点：
 * - 纯函数、无 React 依赖，便于单测钉住匹配/排序语义。
 * - 命令名匹配沿用既有「前缀优先 + 2 字符子序列回退」语义（不破坏现有行为与测试）。
 * - 参数补全：输入 `/<cmd> <partial>`（含空格）时，调该命令的 getArgumentCompletions。
 * - 文件引用：输入 `@<partial>` 时，对注入的文件索引做子串匹配（大小写不敏感），
 *   按「路径越短越靠前、命中位置越靠前越靠前」排序，截断到上限。
 */

/** 一个补全候选项（菜单的一行）。 */
export interface CompletionItem {
  /** 类别：斜杠命令 / 命令参数 / 文件引用。 */
  kind: 'command' | 'argument' | 'file';
  /** 主显示文本（命令名 / 参数值 / 文件路径）。 */
  display: string;
  /** 选中后补全进输入框的值（命令为 `/<name> `，参数为 `<cmd> <value> `，文件为 `@<path> `）。 */
  insertText: string;
  /** 次要描述（命令 describe 的 i18n key、参数说明、文件目录）。 */
  description?: string;
}

/**
 * 子序列匹配：query 的字符按顺序出现在 str 中即可，不需连续。
 * 额外约束：每个匹配字符在 str 中的位置不得超过 len(query) * 2，
 * 防止长跨度误匹配（如 /re 命中 provider 的 r→e 跨度 5）。
 * 与 PromptInput 原 matchSlashCommands 的语义逐字一致（行为不变是底线）。
 */
function isSubsequence(query: string, str: string): boolean {
  if (query.length === 0) return true;
  const limit = query.length * 2;
  let qi = 0;
  for (let i = 0; i < str.length && qi < query.length; i++) {
    if (str[i] === query[qi] && i <= limit) qi++;
  }
  return qi === query.length;
}

/**
 * 命令名匹配（沿用既有语义）：仅当输入以 / 开头且无空格。
 * 前缀命中优先（rank 0），2 字符查询启用子序列回退（rank 1），其余丢弃。
 * 导出供 PromptInput 的 matchSlashCommands（测试钉住的公共入口）委托复用，避免两处逻辑漂移。
 */
export function matchCommandNames(query: string): SlashCommand[] {
  const q = query.toLowerCase();
  const isAbbrev = q.length === 2;
  return SLASH_COMMANDS.map((c) => {
    const name = c.name.toLowerCase();
    const aliases = (c.aliases ?? []).map((a) => a.toLowerCase());
    const all = [name, ...aliases];
    const prefixHit = all.some((s) => s.startsWith(q));
    const seqHit = isAbbrev && all.some((s) => isSubsequence(q, s));
    const rank = prefixHit ? 0 : seqHit ? 1 : 2;
    return { cmd: c, rank };
  })
    .filter(({ rank }) => rank < 2)
    .sort((a, b) => a.rank - b.rank)
    .map(({ cmd }) => cmd);
}

/** 文件索引的注入形态：相对 cwd 的路径列表。 */
export type FileIndex = readonly string[];

/** 文件引用匹配上限。 */
const FILE_MATCH_MAX = 100;

function matchFiles(query: string, files: FileIndex): CompletionItem[] {
  const q = query.toLowerCase();
  const hits: Array<{ path: string; pos: number }> = [];
  for (const path of files) {
    const pos = path.toLowerCase().indexOf(q);
    if (pos >= 0) hits.push({ path, pos });
  }
  // 命中位置靠前优先，其次路径短优先（更具体的结果排前）
  hits.sort((a, b) => a.pos - b.pos || a.path.length - b.path.length || a.path.localeCompare(b.path));
  return hits.slice(0, FILE_MATCH_MAX).map(({ path }) => ({
    kind: 'file',
    display: path,
    insertText: `@${path} `,
    description: undefined,
  }));
}

export interface CompletionContext {
  /** 命令参数补全所需的上下文（模型别名表、思考档位等），由调用方注入。 */
  models?: Record<string, { model?: string; displayName?: string }>;
  thinkChoices?: readonly string[];
  /** 内置预设名 + 自定义渠道 id 列表；供 /provider 参数补全使用。 */
  providers?: readonly string[];
  /** 已发现的 plugin id 列表；供 /plugin 参数补全使用。 */
  pluginIds?: readonly string[];
  /** @ 文件引用的文件索引（相对 cwd 路径）。缺省则无文件补全。 */
  files?: FileIndex;
}

/**
 * 计算当前输入的补全候选。
 * - `@<partial>` → 文件引用（含空查询 `@`）。
 * - `/<cmd>` 无空格 → 命令名匹配（既有语义）。
 * - `/<cmd> <partial>` 含空格 → 该命令的参数补全（若该命令声明了 getArgumentCompletions）。
 * - 其余 → 空。
 */
export function computeCompletions(value: string, ctx: CompletionContext): CompletionItem[] {
  // @ 文件引用：以 @ 开头（允许含空查询与路径分隔符，但不允许空格——路径含空格场景暂不补全）
  if (value.startsWith('@') && !/\s/.test(value)) {
    if (ctx.files === undefined) return [];
    return matchFiles(value.slice(1), ctx.files);
  }

  if (!value.startsWith('/')) return [];

  const hasSpace = /\s/.test(value);
  if (!hasSpace) {
    // 命令名匹配（既有行为）
    return matchCommandNames(value.slice(1)).map((c) => ({
      kind: 'command',
      display: `/${c.name}`,
      insertText: `/${c.name} `,
      description: c.describe, // i18n key，渲染时 t()
    }));
  }

  // 命令参数补全：/cmd <partial>
  const spaceIdx = value.search(/\s/);
  const cmdName = value.slice(1, spaceIdx).toLowerCase();
  const partial = value.slice(spaceIdx + 1);
  const cmd = SLASH_COMMANDS.find(
    (c) => c.name.toLowerCase() === cmdName || (c.aliases ?? []).some((a) => a.toLowerCase() === cmdName),
  );
  if (cmd?.getArgumentCompletions === undefined) return [];
  const args = cmd.getArgumentCompletions(partial, {
    models: ctx.models ?? {},
    thinkChoices: ctx.thinkChoices ?? [],
    providers: ctx.providers,
    pluginIds: ctx.pluginIds,
  });
  return args.map((a) => ({
    kind: 'argument',
    display: a.value,
    insertText: `/${cmd.name} ${a.value} `,
    description: a.description,
  }));
}
