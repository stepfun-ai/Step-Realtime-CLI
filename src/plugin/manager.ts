import { existsSync, readdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import { parse as parseYaml } from 'yaml';
import { HOOK_EVENTS, type HookEventName } from '../config/config.js';
import type { HookEngineEntry } from '../agent/hooks/engine.js';
import type { McpServerConfig } from '../mcp/manager.js';

/**
 * step-code plugin：plugin = 目录 + `.step-code-plugin/plugin.json`，纯声明式资源包，
 * 宿主从不执行插件代码。能力面：skills + MCP（mcpServers）+ hooks + markdown 命令（commands），
 * 全部复用各子系统已有机制合流；显式拒绝 tools/apps/inject/configFile/bootstrap 等执行型字段。
 * 路径安全：manifest 内相对路径强制 ./ 开头、realpath 后必须仍在 plugin root 内；
 * MCP stdio command 必须是 PATH 命令或 ./ 相对路径，拒绝绝对路径。
 */

/** manifest 里 hook 条目的原始形态（JSON 无法承载编译后 RegExp，matcher 为正则串）。 */
export interface PluginHookManifestEntry {
  event: string;
  matcher?: string;
  command: string;
  timeout?: number;
}

export interface PluginManifest {
  name: string;
  version?: string;
  description?: string;
  /** skill 目录相对路径（./ 开头）。 */
  skills?: string[];
  /** MCP server 配置表（复用全局 mcp.json 的 mcpServers 形态，stdio）。 */
  mcpServers?: Record<string, McpServerConfig>;
  /** hooks（复用 [[hooks]] 四字段 event/matcher/command/timeout）。 */
  hooks?: PluginHookManifestEntry[];
  /** 命令 markdown 模板的相对路径（./ 开头）。 */
  commands?: string[];
}

/** 已知但不支持的执行型字段（忽略，加载时记入 ignoredFields 供 info 展示）。 */
const UNSUPPORTED_FIELDS = ['tools', 'apps', 'mcp', 'inject', 'configFile', 'bootstrap'] as const;

/** 一条解析完成的 plugin 命令模板（markdown 正文，$ARGUMENTS 占位执行时展开）。 */
export interface PluginCommand {
  /** 命名空间化命令名 <pluginId>:<commandName>，与内置/skill 命令不冲突。 */
  name: string;
  description: string;
  /** 模板正文（body）。 */
  content: string;
}

/** 坏插件诊断：目录存在、plugin.json 存在但解析失败（列出但不拖垮启动）。 */
export interface PluginLoadError {
  /** 目录名（作为标识）。 */
  id: string;
  root: string;
  reason: 'invalid-manifest';
}

export interface LoadedPlugin {
  /** plugin id（目录名）。 */
  id: string;
  /** plugin 根目录绝对路径。 */
  root: string;
  manifest: PluginManifest;
  /** 解析后的 skill 目录绝对路径（已校验在 root 内）。 */
  skillDirs: string[];
  /** 解析后的 MCP server 配置（key 已加 <pluginId>:<serverName> 前缀，command 已校验）。 */
  mcpServers: Record<string, McpServerConfig>;
  /** 解析后的 hooks（matcher 已编译；cwd 固定插件根，env 注入 STEP_CODE_PLUGIN_ROOT）。 */
  hooks: HookEngineEntry[];
  /** 解析后的命令模板（name 已加 <pluginId>: 前缀）。 */
  commands: PluginCommand[];
  /** 被忽略的执行型字段。 */
  ignoredFields: string[];
}

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;

/** hook timeout 的默认与上下限（与 config.toml [[hooks]] 语义一致）。 */
const HOOK_TIMEOUT_DEFAULT = 30;
const HOOK_TIMEOUT_MIN = 1;
const HOOK_TIMEOUT_MAX = 600;

/** 校验并解析 plugin.json。非法返回 null。 */
export function parsePluginManifest(content: string): PluginManifest | null {
  let raw: unknown;
  try {
    raw = JSON.parse(content);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  const name = obj['name'];
  if (typeof name !== 'string' || !NAME_RE.test(name)) return null;
  const manifest: PluginManifest = { name };
  if (typeof obj['version'] === 'string') manifest.version = obj['version'];
  if (typeof obj['description'] === 'string') manifest.description = obj['description'];
  if (Array.isArray(obj['skills'])) {
    manifest.skills = obj['skills'].filter((s): s is string => typeof s === 'string');
  }
  if (typeof obj['mcpServers'] === 'object' && obj['mcpServers'] !== null && !Array.isArray(obj['mcpServers'])) {
    manifest.mcpServers = obj['mcpServers'] as Record<string, McpServerConfig>;
  }
  if (Array.isArray(obj['hooks'])) {
    manifest.hooks = obj['hooks'].filter(
      (h): h is PluginHookManifestEntry => typeof h === 'object' && h !== null && !Array.isArray(h),
    );
  }
  if (Array.isArray(obj['commands'])) {
    manifest.commands = obj['commands'].filter((s): s is string => typeof s === 'string');
  }
  return manifest;
}

/** 校验相对路径：必须 ./ 开头、realpath 后在 plugin root 内。返回绝对路径或 null。 */
function resolvePathInRoot(root: string, rel: string): string | null {
  if (!rel.startsWith('./')) return null;
  const abs = resolve(root, rel);
  try {
    const real = realpathSync(abs);
    const realRoot = realpathSync(root);
    if (real === realRoot || real.startsWith(realRoot + sep)) return real;
    return null;
  } catch {
    return null;
  }
}

/**
 * 校验 MCP stdio command：PATH 命令（无路径分隔符）原样透传；./ 相对路径
 * 解析为插件根内绝对路径；绝对路径与其余带分隔符的形态一律拒绝（返回 null）。
 */
function resolveMcpCommand(root: string, command: string): string | null {
  if (command.startsWith('./')) return resolvePathInRoot(root, command);
  if (isAbsolute(command) || command.includes('/') || command.includes('\\')) return null;
  return command;
}

/** 解析单个 MCP server 配置：command 合法才保留；cwd 给了就必须能解析进插件根。非法返回 null。 */
function resolveMcpServer(root: string, raw: unknown): McpServerConfig | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const obj = raw as Record<string, unknown>;
  if (typeof obj['command'] !== 'string' || obj['command'] === '') return null;
  const command = resolveMcpCommand(root, obj['command']);
  if (command === null) return null;
  const cfg: McpServerConfig = { command };
  if (Array.isArray(obj['args'])) {
    cfg.args = obj['args'].filter((a): a is string => typeof a === 'string');
  }
  if (typeof obj['env'] === 'object' && obj['env'] !== null && !Array.isArray(obj['env'])) {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(obj['env'] as Record<string, unknown>)) {
      if (typeof v === 'string') env[k] = v;
    }
    cfg.env = env;
  }
  if (typeof obj['cwd'] === 'string') {
    const cwd = resolvePathInRoot(root, obj['cwd']);
    if (cwd === null) return null; // cwd 给了却解析不进插件根：整条 server 丢弃
    cfg.cwd = cwd;
  }
  if (typeof obj['enabled'] === 'boolean') cfg.enabled = obj['enabled'];
  if (typeof obj['startupTimeoutMs'] === 'number' && Number.isFinite(obj['startupTimeoutMs'])) {
    cfg.startupTimeoutMs = obj['startupTimeoutMs'];
  }
  return cfg;
}

/** 解析单条 plugin hook：event 合法、command 非空、matcher 可编译才保留；非法返回 null。 */
function resolveHook(raw: PluginHookManifestEntry): HookEngineEntry | null {
  if (!(HOOK_EVENTS as readonly string[]).includes(raw.event)) return null;
  if (typeof raw.command !== 'string' || raw.command === '') return null;
  const timeoutRaw = raw.timeout;
  const timeout =
    typeof timeoutRaw === 'number' && Number.isFinite(timeoutRaw)
      ? Math.min(HOOK_TIMEOUT_MAX, Math.max(HOOK_TIMEOUT_MIN, Math.trunc(timeoutRaw)))
      : HOOK_TIMEOUT_DEFAULT;
  const entry: HookEngineEntry = { event: raw.event as HookEventName, command: raw.command, timeout };
  if (typeof raw.matcher === 'string') {
    try {
      entry.matcher = new RegExp(raw.matcher);
    } catch {
      return null; // 非法正则：整条 hook 跳过
    }
  }
  return entry;
}

/** 解析一份命令 markdown（frontmatter 可覆盖 name/description，body 为模板正文）。非法返回 null。 */
function parseCommandMd(content: string, fallbackName: string): { name: string; description: string; body: string } | null {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(content);
  let fm: Record<string, unknown> = {};
  let body: string;
  if (m !== null) {
    try {
      fm = (parseYaml(m[1]!) as Record<string, unknown>) ?? {};
    } catch {
      return null;
    }
    body = (m[2] ?? '').trim();
  } else {
    // 无 frontmatter：整篇即正文，名称取文件名兜底
    body = content.trim();
  }
  if (body === '') return null;
  const name =
    typeof fm['name'] === 'string' && NAME_RE.test(fm['name'])
      ? fm['name']
      : NAME_RE.test(fallbackName)
        ? fallbackName
        : null;
  if (name === null) return null;
  return { name, description: typeof fm['description'] === 'string' ? fm['description'] : '', body };
}

/**
 * 展开命令模板：$ARGUMENTS 替换为参数串。
 * 用函数式替换，避免参数里的 `$` 特殊序列被二次解释。
 */
export function expandPluginCommand(content: string, args: string): string {
  return content.replace(/\$ARGUMENTS/g, () => args);
}

/** 从 plugin 根目录加载 plugin（读 .step-code-plugin/plugin.json）。失败返回 null。 */
export function loadPlugin(root: string): LoadedPlugin | null {
  const manifestPath = join(root, '.step-code-plugin', 'plugin.json');
  if (!existsSync(manifestPath)) return null;
  const manifest = parsePluginManifest(readFileSync(manifestPath, 'utf8'));
  if (manifest === null) return null;

  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<string, unknown>;
  } catch {
    // 已 parse 过一次，忽略
  }
  const ignoredFields = UNSUPPORTED_FIELDS.filter((f) => f in raw);

  const id = root.split(/[\\/]/).filter(Boolean).pop() ?? manifest.name;

  const skillDirs: string[] = [];
  for (const rel of manifest.skills ?? []) {
    const abs = resolvePathInRoot(root, rel);
    if (abs !== null) skillDirs.push(abs);
  }
  // manifest 没写 skills 但根目录有 SKILL.md → 把 plugin 根本身当一个 skill
  if (skillDirs.length === 0 && existsSync(join(root, 'SKILL.md'))) {
    skillDirs.push(realpathSync(root));
  }

  // MCP：服务名强制 <pluginId>:<serverName> 前缀隔离（杜绝跨插件/全局同名冲突）
  const mcpServers: Record<string, McpServerConfig> = {};
  for (const [serverName, serverRaw] of Object.entries(manifest.mcpServers ?? {})) {
    const cfg = resolveMcpServer(root, serverRaw);
    if (cfg !== null) mcpServers[`${id}:${serverName}`] = cfg;
  }

  // hooks：command 的 cwd 固定为插件根，注入 STEP_CODE_PLUGIN_ROOT 环境变量
  const realRoot = realpathSync(root);
  const hooks: HookEngineEntry[] = [];
  for (const rawHook of manifest.hooks ?? []) {
    const entry = resolveHook(rawHook);
    if (entry === null) continue;
    entry.cwd = realRoot;
    entry.env = { STEP_CODE_PLUGIN_ROOT: realRoot };
    hooks.push(entry);
  }

  // commands：markdown 模板，注册名强制 <pluginId>:<commandName> 命名空间
  const commands: PluginCommand[] = [];
  for (const rel of manifest.commands ?? []) {
    const abs = resolvePathInRoot(root, rel);
    if (abs === null) continue;
    let parsed: { name: string; description: string; body: string } | null = null;
    try {
      const fallback = basename(abs).replace(/\.md$/i, '');
      parsed = parseCommandMd(readFileSync(abs, 'utf8'), fallback);
    } catch {
      // 读不到的命令文件跳过
    }
    if (parsed !== null) {
      commands.push({ name: `${id}:${parsed.name}`, description: parsed.description, content: parsed.body });
    }
  }

  return { id, root, manifest, skillDirs, mcpServers, hooks, commands, ignoredFields };
}

/** 默认 plugin 目录。 */
export function defaultPluginsDir(): string {
  return join(homedir(), '.step-code', 'plugins');
}

/** 发现目录下所有 plugin（每个含 .step-code-plugin/plugin.json 的子目录）。disabled 集合内的跳过。 */
export function discoverPlugins(dir: string, disabled?: ReadonlySet<string>): LoadedPlugin[] {
  if (!existsSync(dir)) return [];
  const out: LoadedPlugin[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    if (disabled?.has(entry.name) === true) continue;
    const plugin = loadPlugin(join(dir, entry.name));
    if (plugin !== null) out.push(plugin);
  }
  return out;
}

/**
 * 发现目录下全部 plugin 条目（含坏插件诊断）：
 * 有 plugin.json 但解析失败 → errors（标 error 列出，不拖垮启动）；
 * 无 plugin.json 的子目录视为非插件，跳过。
 */
export function discoverPluginEntries(dir: string): { plugins: LoadedPlugin[]; errors: PluginLoadError[] } {
  const plugins: LoadedPlugin[] = [];
  const errors: PluginLoadError[] = [];
  if (!existsSync(dir)) return { plugins, errors };
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory() || entry.name.startsWith('.')) continue;
    const root = join(dir, entry.name);
    if (!existsSync(join(root, '.step-code-plugin', 'plugin.json'))) continue;
    const plugin = loadPlugin(root);
    if (plugin !== null) plugins.push(plugin);
    else errors.push({ id: entry.name, root, reason: 'invalid-manifest' });
  }
  return { plugins, errors };
}
