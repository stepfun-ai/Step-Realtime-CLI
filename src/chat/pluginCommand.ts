import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { t } from '../i18n.js';
import { defaultPluginsDir, discoverPluginEntries, loadPlugin, type LoadedPlugin } from '../plugin/manager.js';
import { installPlugin, pluginsStatePath, readPluginsState, setPluginDisabled, uninstallPlugin } from '../plugin/manage.js';

/**
 * /plugin 斜杠命令的子命令分发（list/install/enable/disable/remove/info）。
 * 纯文本产出：返回给转录区展示的 note 文本，状态变更落盘 ~/.step-code/plugins.json 与 plugins 目录。
 * 能力合流只在启动时发生，变更后提示 /new 或重启生效（与 MCP 变更语义一致）。
 */

/** 单个 plugin 的能力计数摘要（只列非零项）。 */
function capsSummary(p: LoadedPlugin): string {
  const parts: string[] = [];
  if (p.skillDirs.length > 0) parts.push(`skills:${p.skillDirs.length}`);
  if (Object.keys(p.mcpServers).length > 0) parts.push(`mcp:${Object.keys(p.mcpServers).length}`);
  if (p.hooks.length > 0) parts.push(`hooks:${p.hooks.length}`);
  if (p.commands.length > 0) parts.push(`commands:${p.commands.length}`);
  return parts.join(' ');
}

/** /plugin list：全部条目（含 error 坏插件），标注启用/禁用状态。 */
function listPlugins(): string {
  const { plugins, errors } = discoverPluginEntries(defaultPluginsDir());
  const disabled = new Set(readPluginsState(pluginsStatePath()).disabled);
  if (plugins.length === 0 && errors.length === 0) return t('app.plugin.list.empty');
  const lines: string[] = [];
  for (const p of plugins) {
    const status = disabled.has(p.id) ? t('app.plugin.status.disabled') : t('app.plugin.status.enabled');
    const caps = capsSummary(p);
    lines.push(
      t('app.plugin.list.line', {
        id: p.id,
        name: p.manifest.name,
        version: p.manifest.version ?? '-',
        status,
        caps: caps !== '' ? ` ${caps}` : '',
      }),
    );
  }
  for (const e of errors) {
    lines.push(t('app.plugin.list.errorLine', { id: e.id }));
  }
  return `${t('app.plugin.list.title')}\n${lines.join('\n')}`;
}

/** /plugin info <id>：manifest 详情 + 能力清单 + 被忽略的执行型字段。 */
function pluginInfo(id: string): string {
  const root = join(defaultPluginsDir(), id);
  if (!existsSync(root)) return t('app.plugin.notFound', { id });
  const p = loadPlugin(root);
  if (p === null) return t('app.plugin.info.error', { id });
  const disabled = new Set(readPluginsState(pluginsStatePath()).disabled);
  const status = disabled.has(p.id) ? t('app.plugin.status.disabled') : t('app.plugin.status.enabled');
  const ignored =
    p.ignoredFields.length > 0 ? t('app.plugin.info.ignored', { fields: p.ignoredFields.join(', ') }) : '';
  const commandNames = p.commands.map((c) => `/${c.name}`).join(' ');
  const commands =
    p.commands.length > 0 ? t('app.plugin.info.commands', { names: commandNames }) : '';
  return t('app.plugin.info', {
    id: p.id,
    name: p.manifest.name,
    version: p.manifest.version ?? '-',
    desc: p.manifest.description ?? '-',
    root: p.root,
    status,
    skills: p.skillDirs.length,
    mcp: Object.keys(p.mcpServers).length,
    hooks: p.hooks.length,
    commands: p.commands.length,
    commandList: commands,
    ignored,
  });
}

/** /plugin 入口：按子命令分发，返回展示文本。 */
export function runPluginCommand(args: string): string {
  const [subRaw, ...rest] = args.split(/\s+/).filter((s) => s !== '');
  const sub = subRaw ?? 'list';
  const operand = rest.join(' ');
  switch (sub) {
    case 'list':
      return listPlugins();
    case 'install': {
      if (operand === '') return t('app.plugin.usage');
      const r = installPlugin(resolve(operand), defaultPluginsDir());
      return r.ok === true
        ? t('app.plugin.installed', { id: r.id ?? '' })
        : t('app.plugin.installFailed', { error: r.error ?? '' });
    }
    case 'enable': {
      if (operand === '') return t('app.plugin.usage');
      setPluginDisabled(pluginsStatePath(), operand, false);
      return t('app.plugin.enabled', { id: operand });
    }
    case 'disable': {
      if (operand === '') return t('app.plugin.usage');
      if (!existsSync(join(defaultPluginsDir(), operand))) return t('app.plugin.notFound', { id: operand });
      setPluginDisabled(pluginsStatePath(), operand, true);
      return t('app.plugin.disabled', { id: operand });
    }
    case 'remove': {
      if (operand === '') return t('app.plugin.usage');
      const r = uninstallPlugin(defaultPluginsDir(), pluginsStatePath(), operand);
      return r.ok === true
        ? t('app.plugin.removed', { id: operand })
        : t('app.plugin.removeFailed', { error: r.error ?? '' });
    }
    case 'info': {
      if (operand === '') return t('app.plugin.usage');
      return pluginInfo(operand);
    }
    default:
      return t('app.plugin.usage');
  }
}
