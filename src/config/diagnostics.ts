/**
 * config.toml 的结构化诊断：一份检查规则，两个入口（`step doctor config` 与启动自检）共用。
 *
 * 为什么产出结构化 code 而不是成品文案：两个入口的文案要求不同——doctor 是 headless
 * 中文输出（`warn: <描述>`，tests/configDoctor.test.ts 断言该前缀），TUI 必须走 i18n
 * 双表。若这里直接拼中文串，TUI 侧就只能显示不可翻译的文本。
 *
 * 为什么两个入口必须共用本模块：措辞审核脚本曾因 replay-check 手抄一份规则表（10 条
 * vs 25 条）而在阳性样本上报零命中，把「我的表缺这条」误判成「规则失效」。结论是
 * 「验证工具的规则集必须与被验证的规则集是同一份」。doctor 与启动自检是同一判断的
 * 两个入口，各写一份必然漂移成「doctor 说通过、启动却报警告」。
 */
import { HOOK_EVENTS, PROVIDER_PRESETS } from './config.js';

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
  'continuation',
  'background',
  'thinking',
  'memory',
  'search',
  'tools',
  'language',
  'permission_mode',
  'proxy',
  'agents_paths',
  'agents_md_max_bytes',
  'media_keep_recent',
  'extra_skill_dirs',
  'disabled_skills',
  'skill_listing_budget',
  'models',
  'providers',
  'hooks',
  'tui',
] as const;

/**
 * 警告类型全集。新增成员时，doctor 的中文模板表与 i18n 双表都必须同步补渲染，
 * tests/config/diagnostics.test.ts 有双向覆盖断言钉住这件事。
 */
export const CONFIG_WARNING_CODES = [
  'unknownTopLevelKey',
  'providerTypeInvalid',
  'aliasChannelMissing',
  'aliasChannelIsPreset',
  'aliasChannelInvalid',
  'hookEventInvalid',
] as const;

export type ConfigWarningCode = (typeof CONFIG_WARNING_CODES)[number];

export interface ConfigWarning {
  code: ConfigWarningCode;
  /** 渲染文案用的插值参数（doctor 中文模板与 i18n 双表共用同一批键名）。 */
  params: Record<string, string | number>;
}

/** 取对象型 TOML 段；非对象（含数组、null）返回 undefined。 */
function asTable(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * 收集一份已解析 TOML 的全部警告级问题（不含致命错误——语法错误在解析阶段就已失败）。
 *
 * 覆盖的都是 loadConfig **静默**跳过/降级的项：这类「配了但不生效且无提示」的失效
 * 极难排查，与 resolveModels 里 capabilities 白名单转向报错时记录的理由一致。
 *
 * 纯函数，不读文件、不发请求，成本是一次对象遍历，可安全放在启动路径上。
 * @param toml 已解析的 config.toml 顶层表。
 */
export function collectConfigWarnings(toml: Record<string, unknown>): ConfigWarning[] {
  const warnings: ConfigWarning[] = [];

  // 未知顶层键：loadConfig 静默忽略，多半是拼写错误（langauge / default_yolo 之类）
  for (const key of Object.keys(toml)) {
    if (!(CONFIG_TOP_LEVEL_KEYS as readonly string[]).includes(key)) {
      warnings.push({ code: 'unknownTopLevelKey', params: { key } });
    }
  }

  // [providers.<id>] type 缺失或非法 → resolveProviders 直接 continue，整条渠道消失
  const providers = asTable(toml['providers']);
  /** 有效渠道 id 集合（= resolveProviders 之后真正存在的那些），别名引用检查依赖它。 */
  const validChannels = new Set<string>();
  if (providers !== undefined) {
    for (const [id, value] of Object.entries(providers)) {
      const type = asTable(value)?.['type'];
      if (typeof type !== 'string' || PROVIDER_PRESETS[type] === undefined) {
        warnings.push({
          code: 'providerTypeInvalid',
          params: { id, allowed: Object.keys(PROVIDER_PRESETS).join(' / ') },
        });
        continue;
      }
      if (id !== '') validChannels.add(id);
    }
  }

  // [models.<别名>] provider 指向的渠道不可用 → resolveModelEntry 返回 null，别名被静默
  // 降级为裸模型 id 打到顶层渠道，而 TUI 照常显示「模型已切换」。三种成因分开报，
  // 因为修法不同：改别名 / 改渠道 type / 补声明渠道。
  const models = asTable(toml['models']);
  if (models !== undefined) {
    for (const [alias, value] of Object.entries(models)) {
      const channel = asTable(value)?.['provider'];
      if (typeof channel !== 'string' || channel === '') continue; // 未指定 → 继承顶层，合法
      if (validChannels.has(channel)) continue; // 正常
      if (providers?.[channel] !== undefined) {
        // 声明了但因 type 非法被 resolveProviders 跳过：该修的是渠道，不是别名
        warnings.push({ code: 'aliasChannelInvalid', params: { alias, channel } });
      } else if (PROVIDER_PRESETS[channel] !== undefined) {
        // 引用了内置协议预设名（anthropic / openai / ...）。这是最容易踩的变体：名字
        // 确实是合法协议名，但别名的 provider 字段只认 [providers.*] 声明的渠道 id。
        warnings.push({ code: 'aliasChannelIsPreset', params: { alias, channel } });
      } else {
        warnings.push({ code: 'aliasChannelMissing', params: { alias, channel } });
      }
    }
  }

  // [[hooks]] event 非法 → resolveHooks 跳过该条
  if (Array.isArray(toml['hooks'])) {
    for (const [i, item] of (toml['hooks'] as unknown[]).entries()) {
      const event = asTable(item)?.['event'];
      if (typeof event !== 'string' || !(HOOK_EVENTS as readonly string[]).includes(event)) {
        warnings.push({
          code: 'hookEventInvalid',
          params: { index: i + 1, allowed: HOOK_EVENTS.join(' / ') },
        });
      }
    }
  }

  return warnings;
}

/**
 * doctor 的中文模板（headless 输出，不走 i18n——与该文件既有输出风格一致）。
 * i18n 侧的对应键是 `config.warn.<code>`，两表由 tests/config/diagnostics.test.ts 双向钉住。
 */
const ZH_TEMPLATES: Record<ConfigWarningCode, (p: Record<string, string | number>) => string> = {
  unknownTopLevelKey: (p) => `未知顶层键 "${p['key']}"（loadConfig 会忽略它；若为拼写错误请改正）`,
  providerTypeInvalid: (p) => `[providers.${p['id']}] type 缺失或非法（应为 ${p['allowed']}），该渠道会被忽略`,
  aliasChannelMissing: (p) =>
    `[models.${p['alias']}] provider = "${p['channel']}" 未在 [providers] 中声明，该别名整体失效（会退回顶层渠道发送裸模型名）`,
  aliasChannelIsPreset: (p) =>
    `[models.${p['alias']}] provider = "${p['channel']}" 是内置协议名而非渠道 id，该别名整体失效；请先声明 [providers.${p['channel']}] 再引用`,
  aliasChannelInvalid: (p) =>
    `[models.${p['alias']}] 引用的渠道 [providers.${p['channel']}] 因 type 非法被忽略，该别名连带失效`,
  hookEventInvalid: (p) => `[[hooks]] 第 ${p['index']} 条 event 缺失或非法（应为 ${p['allowed']}），该条会被忽略`,
};

/** 把结构化警告渲染成 doctor 的中文单行描述。 */
export function formatWarningZh(w: ConfigWarning): string {
  return ZH_TEMPLATES[w.code](w.params);
}
