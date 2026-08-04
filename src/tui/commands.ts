import { t } from '../i18n.js';

/** 一条斜杠命令的元信息。describe 为 i18n key（cmd.*），渲染时走 t() 查表。 */
export interface SlashCommand {
  name: string;
  aliases?: string[];
  describe: string;
}

/** 已注册的斜杠命令。实际行为在 App 里分发。 */
export const SLASH_COMMANDS: SlashCommand[] = [
  { name: 'help', aliases: ['?'], describe: 'cmd.help' },
  { name: 'model', describe: 'cmd.model' },
  { name: 'think', describe: 'cmd.think' },
  { name: 'permission', describe: 'cmd.permission' },
  { name: 'yolo', describe: 'cmd.yolo' },
  { name: 'auto', describe: 'cmd.auto' },
  { name: 'plan', describe: 'cmd.plan' },
  { name: 'provider', describe: 'cmd.provider' },
  { name: 'goal', describe: 'cmd.goal' },
  { name: 'loop', aliases: ['cron'], describe: 'cmd.loop' },
  { name: 'fork', describe: 'cmd.fork' },
  { name: 'new', describe: 'cmd.new' },
  { name: 'compact', describe: 'cmd.compact' },
  { name: 'history', aliases: ['undo'], describe: 'cmd.history' },
  { name: 'reflect', describe: 'cmd.reflect' },
  { name: 'export-debug-zip', describe: 'cmd.export-debug-zip' },
  { name: 'usage', describe: 'cmd.usage' },
  { name: 'resume', aliases: ['sessions'], describe: 'cmd.resume' },
  { name: 'lang', describe: 'cmd.lang' },
  { name: 'mcp', describe: 'cmd.mcp' },
  { name: 'skill', describe: 'cmd.skill' },
  { name: 'reload', describe: 'cmd.reload' },
  { name: 'plugin', describe: 'cmd.plugin' },
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
const INSTANT_WHEN_BUSY: ReadonlySet<string> = new Set(['help', 'goal', 'loop', 'lang', 'mcp', 'plugin', 'tasks', 'usage']);

/**
 * 双态命令：无参是只读查询（即时），带参是状态变更（排队）。
 * skill：无参列清单（只读），带参激活技能会注入正文改动对话，故排队到回合边界。
 * think：无参显示当前档位（busy 时退化为文本展示），带参切换会话级思考深度，故排队到回合边界。
 */
const QUERY_WHEN_NO_ARGS: ReadonlySet<string> = new Set(['model', 'provider', 'permission', 'skill', 'think', 'resume']);

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
