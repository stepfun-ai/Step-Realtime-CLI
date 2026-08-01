import { PROVIDER_PRESETS, type StepCodeConfig } from '../config/config.js';

/**
 * /provider <id> 文本直切与渠道管理面板 Enter 共用的解析结果。
 * - alias：命中自定义渠道且渠道下有模型别名 → 走 applyModelAlias（与 /model 选择器同一路径）。
 * - noAlias：命中自定义渠道但无别名 → 不切换，提示。
 * - preset：命中内置预设名 → 走预设重建路径。
 * - unknown：都不命中 → 报错并列出可用渠道（自定义 + 预设）。
 */
export type ProviderSwitchTarget =
  | { kind: 'alias'; providerId: string; alias: string }
  | { kind: 'noAlias'; providerId: string }
  | { kind: 'preset'; name: string }
  | { kind: 'unknown'; available: string[] };

/** 渠道在 [models] 中按配置文件顺序的第一个别名（Object.entries 保序）；无别名返回 undefined。 */
export function firstAliasOf(config: StepCodeConfig, providerId: string): string | undefined {
  for (const [alias, entry] of Object.entries(config.models ?? {})) {
    if (entry.provider === providerId) return alias;
  }
  return undefined;
}

/**
 * 解析 /provider 的切换目标：自定义渠道 id（精确匹配）> 内置预设名（小写归一）> 报错清单。
 * 自定义渠道 id 与预设同名时自定义优先（与面板合并视图的遮蔽口径一致）。
 */
export function resolveProviderTarget(config: StepCodeConfig, arg: string): ProviderSwitchTarget {
  const providers = config.providers ?? {};
  if (Object.hasOwn(providers, arg)) {
    const alias = firstAliasOf(config, arg);
    return alias !== undefined ? { kind: 'alias', providerId: arg, alias } : { kind: 'noAlias', providerId: arg };
  }
  const presetName = arg.toLowerCase();
  if (PROVIDER_PRESETS[presetName] !== undefined) return { kind: 'preset', name: presetName };
  const available = [
    ...Object.keys(providers),
    ...Object.keys(PROVIDER_PRESETS).filter((n) => !Object.hasOwn(providers, n)),
  ];
  return { kind: 'unknown', available };
}
