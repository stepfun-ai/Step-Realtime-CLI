/**
 * 无头（脱离 Ink/TTY）的 `step doctor config <path>` 子命令逻辑。
 *
 * 用途：配置文件覆盖写入前的独立校验（内置 update-config skill 变更协议的第 4 步），
 * 以及用户自查。只读，不改任何文件；退出码 0 = 通过（可有警告），非 0 = 失败。
 *
 * 与 loadConfig 的关系：loadConfig 从固定路径（~/.step-code/config.toml）读取且
 * 静默吞掉 TOML 语法错误（返回 {}），无法充当校验器。本模块对指定路径自行做
 * TOML 解析（语法错误即失败），语义校验复用 config.ts 导出的校验件：
 * resolveThinkingConfig 与 resolvePermissionMode 是 loadConfig 会抛配置错误的环节，原样复用其报错；
 * 其余 resolver 对非法值静默跳过/钳制，这里降级为警告（未知顶层键、非法渠道
 * type、hooks 非法 event 等），不改变既有加载行为。
 */
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parse as parseToml } from 'smol-toml';
import { HOOK_EVENTS, PROVIDER_PRESETS, resolvePermissionMode, resolveProxy, resolveThinkingConfig } from './config.js';

/**
 * config.toml 合法顶层键清单（与 config.ts 的 TomlConfigShape 一一对应）。
 * tests/skill/updateConfigDrift.test.ts 会从 config.ts 源码解析 TomlConfigShape
 * 并断言与本清单一致——config.ts 加/删顶层键时必须同步此处，否则测试变红。
 */
export const CONFIG_TOP_LEVEL_KEYS = [
  'provider',
  'base_url',
  'model',
  'max_context_size',
  'max_tokens',
  'subagent',
  'compaction',
  'background',
  'thinking',
  'language',
  'permission_mode',
  'proxy',
  'agents_paths',
  'agents_md_max_bytes',
  'extra_skill_dirs',
  'disabled_skills',
  'models',
  'providers',
  'hooks',
] as const;

export interface DoctorConfigResult {
  /** 进程退出码：0 通过（可有警告），1 失败。 */
  code: 0 | 1;
  /** 通过/警告信息（含结尾换行），供调用点写 stdout。 */
  stdout?: string;
  /** 失败原因（含结尾换行），供调用点写 stderr。 */
  stderr?: string;
}

/** max_tokens 缺省基准（= config.ts 的 DEFAULT_MAX_TOKENS，未导出，此处保持一致）。 */
const DEFAULT_MAX_TOKENS = 65536;

/**
 * 校验一份 config.toml：语法错误 / thinking 语义错误 → code 1；
 * 未知顶层键、非法渠道 type、hooks 非法 event 等 → 警告（code 0，逐条列出）。
 * @param path 要校验的文件路径；缺省为 ~/.step-code/config.toml
 */
export function runDoctorConfig(path?: string): DoctorConfigResult {
  const target = path ?? join(homedir(), '.step-code', 'config.toml');
  if (!existsSync(target)) {
    return { code: 1, stderr: `error: 配置文件不存在：${target}\n` };
  }
  let toml: unknown;
  try {
    toml = parseToml(readFileSync(target, 'utf8'));
  } catch (e) {
    return { code: 1, stderr: `error: TOML 解析失败：${(e as Error).message}\n` };
  }
  if (typeof toml !== 'object' || toml === null || Array.isArray(toml)) {
    return { code: 1, stderr: `error: 配置文件顶层必须是 TOML 表：${target}\n` };
  }
  const t = toml as Record<string, unknown>;
  const warnings: string[] = [];

  // 未知顶层键：loadConfig 会静默忽略，多半是拼写错误（如 default_yolo），值得点名
  for (const key of Object.keys(t)) {
    if (!(CONFIG_TOP_LEVEL_KEYS as readonly string[]).includes(key)) {
      warnings.push(`未知顶层键 "${key}"（loadConfig 会忽略它；若为拼写错误请改正）`);
    }
  }

  // thinking 语义校验：复用 loadConfig 的抛错路径（budget 余量、default_level 命中）
  try {
    const maxTokens =
      typeof t['max_tokens'] === 'number' && Number.isFinite(t['max_tokens'])
        ? (t['max_tokens'] as number)
        : DEFAULT_MAX_TOKENS;
    resolveThinkingConfig(t['thinking'], maxTokens);
    // permission_mode 非法值同属 loadConfig 抛错路径（安全相关配置，不降级为警告）
    resolvePermissionMode(t['permission_mode']);
    // proxy 形态非法同属 loadConfig 抛错路径
    resolveProxy(t['proxy']);
  } catch (e) {
    return { code: 1, stderr: `error: ${(e as Error).message}\n` };
  }

  // [providers.<id>] type 非法 → loadConfig 静默跳过整条渠道，降级为警告
  if (typeof t['providers'] === 'object' && t['providers'] !== null && !Array.isArray(t['providers'])) {
    for (const [id, value] of Object.entries(t['providers'] as Record<string, unknown>)) {
      const type =
        typeof value === 'object' && value !== null && !Array.isArray(value)
          ? (value as Record<string, unknown>)['type']
          : undefined;
      if (typeof type !== 'string' || PROVIDER_PRESETS[type] === undefined) {
        warnings.push(`[providers.${id}] type 缺失或非法（应为 ${Object.keys(PROVIDER_PRESETS).join(' / ')}），该渠道会被忽略`);
      }
    }
  }

  // [[hooks]] event 非法 → loadConfig 静默跳过该条，降级为警告
  if (Array.isArray(t['hooks'])) {
    for (const [i, item] of (t['hooks'] as unknown[]).entries()) {
      const event =
        typeof item === 'object' && item !== null && !Array.isArray(item)
          ? (item as Record<string, unknown>)['event']
          : undefined;
      if (typeof event !== 'string' || !(HOOK_EVENTS as readonly string[]).includes(event)) {
        warnings.push(`[[hooks]] 第 ${i + 1} 条 event 缺失或非法（应为 ${HOOK_EVENTS.join(' / ')}），该条会被忽略`);
      }
    }
  }

  const lines = [`ok: ${target} 解析与校验通过`];
  for (const w of warnings) lines.push(`warn: ${w}`);
  return { code: 0, stdout: `${lines.join('\n')}\n` };
}
