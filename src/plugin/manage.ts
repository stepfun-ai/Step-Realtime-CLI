import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { loadPlugin } from './manager.js';

/**
 * plugin 安装与启停管理：
 * - 安装 = 本地目录复制到 ~/.step-code/plugins/<id>/（staging + rename 原子替换，重装同 id = 覆盖更新）。
 * - 启停 = ~/.step-code/plugins.json 记录 disabled 集合（不在集合即启用）。
 * 能力合流仍在启动时经 discoverPlugins 重解析清单物化，install/enable/disable 变更需 /new 或重启生效。
 */

/** ~/.step-code/plugins.json 的路径。 */
export function pluginsStatePath(): string {
  return join(homedir(), '.step-code', 'plugins.json');
}

export interface PluginsState {
  /** 被禁用的 plugin id 集合（不在集合即启用）。 */
  disabled: string[];
}

/** 读 plugins.json；不存在或损坏返回空 disabled（不拖垮启动）。 */
export function readPluginsState(path: string): PluginsState {
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
    const disabled = Array.isArray(raw['disabled'])
      ? raw['disabled'].filter((s): s is string => typeof s === 'string')
      : [];
    return { disabled };
  } catch {
    return { disabled: [] };
  }
}

/** 写 plugins.json（目录不存在先建）。 */
export function writePluginsState(path: string, state: PluginsState): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
}

/** 设置某 plugin 的禁用状态（disabled=true 加入集合，false 移出），返回更新后状态。 */
export function setPluginDisabled(path: string, id: string, disabled: boolean): PluginsState {
  const state = readPluginsState(path);
  const set = new Set(state.disabled);
  if (disabled) set.add(id);
  else set.delete(id);
  const next: PluginsState = { disabled: [...set].sort() };
  writePluginsState(path, next);
  return next;
}

export interface PluginOpResult {
  ok: boolean;
  /** 成功时的 plugin id。 */
  id?: string;
  /** 失败时的单行原因。 */
  error?: string;
}

/**
 * 安装 plugin：源目录复制到 <pluginsDir>/<manifest.name>/。
 * staging + rename 原子替换：先完整复制到同级 .staging- 临时目录，再删掉旧目录、rename 就位，
 * 重装同 id 即覆盖更新（不单独做 update）。源目录本身不被改动。
 */
export function installPlugin(srcDir: string, pluginsDir: string): PluginOpResult {
  const src = resolve(srcDir);
  if (!existsSync(src)) return { ok: false, error: `目录不存在：${src}` };
  const plugin = loadPlugin(src);
  if (plugin === null) return { ok: false, error: '缺少 .step-code-plugin/plugin.json 或 manifest 非法' };
  const id = plugin.manifest.name;
  const dest = join(pluginsDir, id);
  const staging = join(pluginsDir, `.staging-${id}-${process.pid}-${Date.now()}`);
  try {
    mkdirSync(pluginsDir, { recursive: true });
    cpSync(src, staging, { recursive: true });
    rmSync(dest, { recursive: true, force: true });
    renameSync(staging, dest);
    return { ok: true, id };
  } catch (e) {
    rmSync(staging, { recursive: true, force: true });
    return { ok: false, error: (e as Error).message };
  }
}

/** 移除 plugin：删除 <pluginsDir>/<id>/ 并从 disabled 集合清除。目录不存在按失败处理。 */
export function uninstallPlugin(pluginsDir: string, statePath: string, id: string): PluginOpResult {
  const dest = join(pluginsDir, id);
  if (!existsSync(dest)) return { ok: false, error: `未安装 plugin「${id}」` };
  try {
    rmSync(dest, { recursive: true, force: true });
    setPluginDisabled(statePath, id, false);
    return { ok: true, id };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}
