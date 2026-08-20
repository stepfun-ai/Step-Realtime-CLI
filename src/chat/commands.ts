import { t } from '../i18n.js';

/** 参数补全的注入上下文（避免 commands 直接依赖 config 结构）。 */
export interface ArgumentCompletionContext {
  models: Record<string, { model?: string; displayName?: string }>;
  thinkChoices: readonly string[];
  /** 内置预设名 + 自定义渠道 id 列表；空数组表示无动态数据。 */
  providers?: readonly string[];
  /** 已发现的 plugin id 列表；空数组表示无动态数据。 */
  pluginIds?: readonly string[];
}

/** 一个参数补全候选。 */
export interface ArgumentCompletion {
  /** 补全进输入框的值。 */
  value: string;
  /** 次要说明。 */
  description?: string;
}

/** 一条斜杠命令的元信息。describe 为 i18n key（cmd.*），渲染时走 t() 查表。 */
export interface SlashCommand {
  name: string;
  aliases?: string[];
  describe: string;
  /** 参数补全：输入 `/<name> <partial>` 时给出候选。缺省表示该命令无参数补全。 */
  getArgumentCompletions?: (partial: string, ctx: ArgumentCompletionContext) => ArgumentCompletion[];
}

/** 已注册的斜杠命令。实际行为在 App 里分发。 */
export const SLASH_COMMANDS: SlashCommand[] = [
  { name: 'help', aliases: ['?'], describe: 'cmd.help' },
  {
    name: 'model',
    describe: 'cmd.model',
    getArgumentCompletions: (partial, ctx) => {
      const q = partial.toLowerCase();
      return Object.entries(ctx.models)
        .filter(([alias, entry]) => q === '' || alias.toLowerCase().includes(q) || (entry.model ?? '').toLowerCase().includes(q))
        .map(([alias, entry]) => ({
          value: alias,
          description: entry.displayName ?? entry.model,
        }));
    },
  },
  {
    name: 'think',
    describe: 'cmd.think',
    getArgumentCompletions: (partial, ctx) => {
      const q = partial.toLowerCase();
      return ctx.thinkChoices
        .filter((c) => q === '' || c.toLowerCase().startsWith(q))
        .map((c) => ({ value: c }));
    },
  },
  {
    name: 'permission',
    describe: 'cmd.permission',
    getArgumentCompletions: (partial) => {
      const q = partial.toLowerCase();
      return ['manual', 'auto', 'yolo']
        .filter((m) => q === '' || m.startsWith(q))
        .map((m) => ({ value: m, description: t('cmd.permission.mode.' + m) }));
    },
  },
  { name: 'yolo', describe: 'cmd.yolo' },
  { name: 'auto', describe: 'cmd.auto' },
  { name: 'plan', describe: 'cmd.plan' },
  {
    name: 'provider',
    describe: 'cmd.provider',
    getArgumentCompletions: (partial, ctx) => {
      const q = partial.toLowerCase();
      // 静态子命令 + 内置预设 + 运行时注入的自定义渠道 id
      const presetKeys = (ctx.providers ?? []).filter((id) => {
        // 区分预设（小写单段，如 stepfun）与自定义渠道 id（通常含点或路径）
        return !id.includes('.') && !id.includes('/') && !id.includes('\\');
      });
      const customIds = (ctx.providers ?? []).filter((id) => {
        return id.includes('.') || id.includes('/') || id.includes('\\');
      });
      const staticSubs = [
        { value: 'add', description: t('cmd.provider.sub.add') },
        { value: 'list', description: t('cmd.provider.sub.list') },
      ];
      const presets = presetKeys.map((k) => ({ value: k, description: t('cmd.provider.sub.preset') }));
      const customs = customIds.map((id) => ({ value: id, description: t('cmd.provider.sub.custom') }));
      return [...staticSubs, ...presets, ...customs].filter((c) => q === '' || c.value.toLowerCase().startsWith(q));
    },
  },
  {
    name: 'memory',
    describe: 'cmd.memory',
    getArgumentCompletions: (partial) => {
      const q = partial.toLowerCase();
      return [
        { value: 'on', description: t('cmd.memory.sub.on') },
        { value: 'off', description: t('cmd.memory.sub.off') },
      ].filter((c) => q === '' || c.value.startsWith(q));
    },
  },
  {
    name: 'goal',
    describe: 'cmd.goal',
    getArgumentCompletions: (partial) => {
      const q = partial.toLowerCase();
      return [
        { value: 'status', description: t('cmd.goal.sub.status') },
        { value: 'pause', description: t('cmd.goal.sub.pause') },
        { value: 'resume', description: t('cmd.goal.sub.resume') },
        { value: 'cancel', description: t('cmd.goal.sub.cancel') },
      ].filter((c) => q === '' || c.value.startsWith(q));
    },
  },
  {
    name: 'team',
    describe: 'cmd.team',
    getArgumentCompletions: (partial) => {
      const q = partial.toLowerCase();
      return [
        { value: 'init', description: t('cmd.team.sub.init') },
        { value: 'status', description: t('cmd.team.sub.status') },
        { value: 'exit', description: t('cmd.team.sub.exit') },
        { value: 'teardown', description: t('cmd.team.sub.teardown') },
      ].filter((c) => q === '' || c.value.startsWith(q));
    },
  },
  { name: 'loop', aliases: ['cron'], describe: 'cmd.loop' },
  { name: 'fork', describe: 'cmd.fork' },
  { name: 'new', describe: 'cmd.new' },
  { name: 'compact', describe: 'cmd.compact' },
  {
    name: 'compact-model',
    describe: 'cmd.compactModel',
    getArgumentCompletions: (partial, ctx) => {
      const q = partial.toLowerCase();
      const subs = q === '' || 'reset'.startsWith(q) ? [{ value: 'reset', description: t('cmd.compactModel.sub.reset') }] : [];
      const aliases = Object.entries(ctx.models)
        .filter(([alias, entry]) => q === '' || alias.toLowerCase().includes(q) || (entry.model ?? '').toLowerCase().includes(q))
        .map(([alias, entry]) => ({ value: alias, description: entry.displayName ?? entry.model }));
      return [...subs, ...aliases];
    },
  },
  {
    name: 'history',
    aliases: ['undo'],
    describe: 'cmd.history',
    getArgumentCompletions: (partial) => {
      const q = partial.toLowerCase();
      // 仅当输入纯数字前缀时给出提示（不做语义判定，留足灵活性）
      return q === '' || /^\d+$/.test(q)
        ? [{ value: 'N', description: t('cmd.history.sub.n') }]
        : [];
    },
  },
  { name: 'restore', describe: 'cmd.restore' },
  { name: 'reflect', describe: 'cmd.reflect' },
  { name: 'export-debug-zip', describe: 'cmd.export-debug-zip' },
  { name: 'usage', describe: 'cmd.usage' },
  { name: 'resume', aliases: ['sessions'], describe: 'cmd.resume' },
  { name: 'rename', describe: 'cmd.rename' },
  { name: 'agents', describe: 'cmd.agents' },
  {
    name: 'lang',
    describe: 'cmd.lang',
    getArgumentCompletions: (partial) => {
      const q = partial.toLowerCase();
      return ['zh', 'en']
        .filter((l) => q === '' || l.startsWith(q))
        .map((l) => ({ value: l, description: t('cmd.lang.' + l) }));
    },
  },
  {
    name: 'mcp',
    describe: 'cmd.mcp',
    getArgumentCompletions: (partial) => {
      // /mcp 无子命令，仅在空 partial 时提示用户无需参数
      if (partial !== '') return [];
      return [{ value: '', description: t('cmd.mcp.sub.none') }];
    },
  },
  { name: 'skill', describe: 'cmd.skill' },
  { name: 'reload', describe: 'cmd.reload' },
  {
    name: 'plugin',
    describe: 'cmd.plugin',
    getArgumentCompletions: (partial, ctx) => {
      const q = partial.toLowerCase();
      // 静态子命令 + 运行时发现的 plugin id
      const staticSubs = [
        { value: 'list', description: t('cmd.plugin.sub.list') },
        { value: 'install', description: t('cmd.plugin.sub.install') },
        { value: 'enable', description: t('cmd.plugin.sub.enable') },
        { value: 'disable', description: t('cmd.plugin.sub.disable') },
        { value: 'remove', description: t('cmd.plugin.sub.remove') },
        { value: 'info', description: t('cmd.plugin.sub.info') },
      ];
      const dynamicIds = (ctx.pluginIds ?? []).map((id) => ({
        value: id,
        description: t('cmd.plugin.sub.dynamic', { id }),
      }));
      return [...staticSubs, ...dynamicIds].filter((c) => q === '' || c.value.toLowerCase().startsWith(q));
    },
  },
  { name: 'tasks', describe: 'cmd.tasks' },
  { name: 'exit', aliases: ['quit', 'q'], describe: 'cmd.exit' },
];

export interface ParsedSlash {
  /** 规范化后的主命令名（已解析别名）。 */
  name: string;
  /** 命令参数（去掉命令名后的剩余部分，已 trim）。 */
  args: string;
}

/** busy 时可即时执行的只读/纯 UI 命令：不碰对话历史、会话本体、模型与权限等在途 turn 依赖的状态。 */
const INSTANT_WHEN_BUSY: ReadonlySet<string> = new Set(['help', 'goal', 'team', 'loop', 'lang', 'mcp', 'plugin', 'tasks', 'usage']);

/**
 * 双态命令：无参是只读查询（即时），带参是状态变更（排队）。
 * skill：无参列清单（只读），带参激活技能会注入正文改动对话，故排队到回合边界。
 * think：无参显示当前档位（busy 时退化为文本展示），带参切换会话级思考深度，故排队到回合边界。
 * compact-model：无参查询当前压缩绑定（只读），带参切换会话级压缩模型，故排队到回合边界。
 */
const QUERY_WHEN_NO_ARGS: ReadonlySet<string> = new Set(['model', 'provider', 'permission', 'skill', 'think', 'resume', 'compact-model']);

/**
 * busy 时的命令分流（判据：是否改动当前 turn 依赖的状态）。
 * - instant：只读/纯 UI，立即执行；未知命令（name === ''）也即时，立即提示不用等回合结束。
 * - queue：改动 turn 前提（历史/会话/模型/provider/权限/plan/退出），排队到回合边界。
 */
export function busyRoute(name: string, args: string): 'instant' | 'queue' {
  if (name === '') return 'instant';
  if (INSTANT_WHEN_BUSY.has(name)) return 'instant';
  if (QUERY_WHEN_NO_ARGS.has(name)) return args === '' ? 'instant' : 'queue';
  return 'queue';
}

const NAME_BY_ALIAS: Map<string, string> = (() => {
  const m = new Map<string, string>();
  for (const cmd of SLASH_COMMANDS) {
    m.set(cmd.name, cmd.name);
    for (const a of cmd.aliases ?? []) m.set(a, cmd.name);
  }
  return m;
})();

/**
 * 解析一行输入是否为斜杠命令。
 * 返回 null 表示不是命令（应作为普通消息发给模型）。
 * 返回 { name: '', args } 的空 name 表示是斜杠开头但命令未知。
 * @param extraNames 额外的动态命令名集合（plugin 命令的 <pluginId>:<commandName> 命名空间），
 *   命中时按原名返回（未走别名表，调用方自行分发）。
 */
export function parseSlash(input: string, extraNames?: ReadonlySet<string>): ParsedSlash | null {
  const trimmed = input.trim();
  if (!trimmed.startsWith('/')) return null;
  const body = trimmed.slice(1);
  const spaceIdx = body.search(/\s/);
  const rawName = (spaceIdx === -1 ? body : body.slice(0, spaceIdx)).toLowerCase();
  const args = spaceIdx === -1 ? '' : body.slice(spaceIdx + 1).trim();
  const canonical = NAME_BY_ALIAS.get(rawName);
  if (canonical !== undefined) return { name: canonical, args };
  if (extraNames?.has(rawName) === true) return { name: rawName, args };
  return { name: '', args };
}

/** 生成 /help 的文本（describe 为 i18n key，这里查表拼接）。 */
export function helpText(): string {
  return SLASH_COMMANDS.map((c) => {
    const alias =
      c.aliases && c.aliases.length > 0 ? t('cmd.helpText.aliasSuffix', { aliases: c.aliases.join(' /') }) : '';
    return t('cmd.helpText.line', { name: c.name, alias, describe: t(c.describe) });
  }).join('\n');
}
