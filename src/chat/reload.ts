import { resolveModelEntry, type StepCodeConfig } from '../config/config.js';
import { createProvider } from '../provider/factory.js';
import type { ChatProvider } from '../provider/types.js';

/**
 * /reload 的纯函数层：配置 diff 与 provider 重建决策。
 * 全部逻辑下沉到此模块，App 的 case 'reload' 只做接线（换引用、同步派生 state、打反馈），
 * main 的 reloadConfig 只做薄壳（loadConfig + catch + 换引用）。
 */

/** 一条字段级配置变化。path 用 toml 风格名（max_context_size / models.big / thinking.default_level）。 */
export interface ConfigChange {
  kind: 'added' | 'removed' | 'changed';
  /** toml 风格字段路径。 */
  path: string;
  /** 变更前展示值（added 或无值可示时缺省）。 */
  oldText?: string;
  /** 变更后展示值（removed 或无值可示时缺省）。 */
  newText?: string;
  /** true = 该字段本轮不热重载（一次性固化），需重启才生效；App 展示时追加提示后缀。 */
  restart?: boolean;
}

/** 把一条变化格式化成展示行：`+ path[: v]` / `- path[: v]` / `~ path: old → new`。 */
export function formatConfigChange(c: ConfigChange): string {
  switch (c.kind) {
    case 'added':
      return `+ ${c.path}${c.newText !== undefined ? `: ${c.newText}` : ''}`;
    case 'removed':
      return `- ${c.path}${c.oldText !== undefined ? `: ${c.oldText}` : ''}`;
    case 'changed':
      return c.oldText !== undefined || c.newText !== undefined
        ? `~ ${c.path}: ${c.oldText ?? ''} → ${c.newText ?? ''}`
        : `~ ${c.path}`;
  }
}

function fmtScalar(v: string | number | boolean): string {
  return typeof v === 'boolean' ? (v ? 'true' : 'false') : String(v);
}

/** 标量字段 diff：undefined 表示键不存在（缺省），按 added/removed/changed 归类。 */
function diffScalar(
  out: ConfigChange[],
  path: string,
  oldV: string | number | boolean | undefined,
  newV: string | number | boolean | undefined,
  opts?: { restart?: boolean; masked?: boolean },
): void {
  if (oldV === newV) return;
  const restart = opts?.restart === true ? true : undefined;
  const oldText = opts?.masked === true || oldV === undefined ? undefined : fmtScalar(oldV);
  const newText = opts?.masked === true || newV === undefined ? undefined : fmtScalar(newV);
  if (oldV === undefined) out.push({ kind: 'added', path, newText, restart });
  else if (newV === undefined) out.push({ kind: 'removed', path, oldText, restart });
  else out.push({ kind: 'changed', path, oldText, newText, restart });
}

/** 字符串数组字段 diff（agents_paths / extra_skill_dirs / disabled_skills），按整体比较。 */
function diffStringArray(
  out: ConfigChange[],
  path: string,
  oldArr: string[] | undefined,
  newArr: string[] | undefined,
  opts?: { restart?: boolean },
): void {
  const o = oldArr ?? [];
  const n = newArr ?? [];
  if (o.length === n.length && o.every((v, i) => v === n[i])) return;
  const restart = opts?.restart === true ? true : undefined;
  const oldText = o.length > 0 ? o.join(', ') : undefined;
  const newText = n.length > 0 ? n.join(', ') : undefined;
  if (oldArr === undefined && newArr !== undefined) out.push({ kind: 'added', path, newText, restart });
  else if (oldArr !== undefined && newArr === undefined) out.push({ kind: 'removed', path, oldText, restart });
  else out.push({ kind: 'changed', path, oldText, newText, restart });
}

/** 表项级 diff（[models] / [providers]）：逐键 added/removed/changed（changed 为整项深比，不展开字段）。 */
function diffTable<T>(
  out: ConfigChange[],
  prefix: string,
  oldT: Record<string, T> | undefined,
  newT: Record<string, T> | undefined,
): void {
  const o = oldT ?? {};
  const n = newT ?? {};
  for (const k of Object.keys(o)) {
    if (!(k in n)) out.push({ kind: 'removed', path: `${prefix}.${k}` });
  }
  for (const k of Object.keys(n)) {
    if (!(k in o)) out.push({ kind: 'added', path: `${prefix}.${k}` });
    else if (JSON.stringify(o[k]) !== JSON.stringify(n[k])) out.push({ kind: 'changed', path: `${prefix}.${k}` });
  }
}

/** 数值表项级 diff（[thinking.levels]）：逐键 added/removed/changed，changed 带旧值 → 新值。 */
function diffNumberTable(
  out: ConfigChange[],
  prefix: string,
  oldT: Record<string, number>,
  newT: Record<string, number>,
): void {
  for (const k of Object.keys(oldT)) {
    if (!(k in newT)) out.push({ kind: 'removed', path: `${prefix}.${k}`, oldText: String(oldT[k]) });
  }
  for (const k of Object.keys(newT)) {
    if (!(k in oldT)) out.push({ kind: 'added', path: `${prefix}.${k}`, newText: String(newT[k]) });
    else if (oldT[k] !== newT[k]) {
      out.push({ kind: 'changed', path: `${prefix}.${k}`, oldText: String(oldT[k]), newText: String(newT[k]) });
    }
  }
}

/**
 * 字段级配置 diff：列出旧配置到新配置的全部变化（无变化返回空数组）。
 * api_key 类敏感值只报变更不回显内容（masked）；agents_paths / agents_md_max_bytes /
 * background.bash_task_timeout_s / permission_mode 属一次性固化字段，标 restart 供展示层追加「需重启生效」。
 * hooks 按规整后整体比较（matcher 取正则源码），只报条数变化不展开。
 */
export function diffConfig(oldCfg: StepCodeConfig, newCfg: StepCodeConfig): ConfigChange[] {
  const out: ConfigChange[] = [];
  diffScalar(out, 'provider', oldCfg.provider, newCfg.provider);
  diffScalar(out, 'api_key', oldCfg.apiKey, newCfg.apiKey, { masked: true });
  diffScalar(out, 'base_url', oldCfg.baseUrl, newCfg.baseUrl);
  diffScalar(out, 'model', oldCfg.model, newCfg.model);
  diffScalar(out, 'max_context_size', oldCfg.maxContextSize, newCfg.maxContextSize);
  diffScalar(out, 'max_tokens', oldCfg.maxTokens, newCfg.maxTokens);
  diffScalar(out, 'language', oldCfg.language ?? 'zh', newCfg.language ?? 'zh');
  // 权限模式默认值只在启动/新会话时读取（运行态模式是 App 的会话 state，/reload 不动它）→ 一次性固化字段
  diffScalar(out, 'permission_mode', oldCfg.permissionMode, newCfg.permissionMode, { restart: true });
  // proxy 只在启动时注入 HTTPS_PROXY（环境变量 > config > 直连）→ 一次性固化字段
  diffScalar(out, 'proxy', oldCfg.proxy, newCfg.proxy, { restart: true });
  diffScalar(out, 'agents_md_max_bytes', oldCfg.agentsMdMaxBytes, newCfg.agentsMdMaxBytes, { restart: true });
  diffStringArray(out, 'agents_paths', oldCfg.agentsPaths, newCfg.agentsPaths, { restart: true });
  diffStringArray(out, 'extra_skill_dirs', oldCfg.extraSkillDirs, newCfg.extraSkillDirs);
  diffStringArray(out, 'disabled_skills', oldCfg.disabledSkills, newCfg.disabledSkills);

  diffTable(out, 'models', oldCfg.models, newCfg.models);
  diffTable(out, 'providers', oldCfg.providers, newCfg.providers);

  const ot = oldCfg.thinking;
  const nt = newCfg.thinking;
  diffScalar(out, 'thinking.enabled', ot?.enabled, nt?.enabled);
  // budget_tokens 已从配置移除（档位名是唯一用户接口），故不再 diff 该键。
  diffScalar(out, 'thinking.default_level', ot?.defaultLevel, nt?.defaultLevel);
  diffNumberTable(out, 'thinking.levels', ot?.levels ?? {}, nt?.levels ?? {});

  const oc = oldCfg.compaction;
  const nc = newCfg.compaction;
  diffScalar(out, 'compaction.trigger_ratio', oc.triggerRatio, nc.triggerRatio);
  diffScalar(out, 'compaction.reserved_tokens', oc.reservedTokens, nc.reservedTokens);
  diffScalar(out, 'compaction.model', oc.model, nc.model);
  diffScalar(out, 'compaction.user_message_max_tokens', oc.userMessageMaxTokens, nc.userMessageMaxTokens);
  diffScalar(out, 'compaction.user_message_head_tokens', oc.userMessageHeadTokens, nc.userMessageHeadTokens);

  diffScalar(out, 'subagent.max_depth', oldCfg.subagent.maxDepth, newCfg.subagent.maxDepth);
  diffScalar(out, 'subagent.max_steps', oldCfg.subagent.maxSteps, newCfg.subagent.maxSteps);
  diffScalar(out, 'subagent.max_concurrent', oldCfg.subagent.maxConcurrent, newCfg.subagent.maxConcurrent);
  // retention 在部分测试/旧配置里可能缺省，与 background 一样用 ?? {} 防御，避免空指针
  const oret = oldCfg.subagent.retention ?? {};
  const nret = newCfg.subagent.retention ?? {};
  diffScalar(out, 'subagent.retention.delete_with_parent', oret.deleteWithParent, nret.deleteWithParent);
  diffScalar(out, 'subagent.retention.max_sessions', oret.maxSessions, nret.maxSessions);
  diffScalar(out, 'subagent.retention.ttl_days', oret.ttlDays, nret.ttlDays);

  const ob = oldCfg.background ?? {};
  const nb = newCfg.background ?? {};
  diffScalar(out, 'background.bash_auto_background_on_timeout', ob.bashAutoBackgroundOnTimeout, nb.bashAutoBackgroundOnTimeout);
  diffScalar(out, 'background.bash_task_timeout_s', ob.bashTaskTimeoutS, nb.bashTaskTimeoutS, { restart: true });
  diffScalar(out, 'background.notify_on_complete', ob.notifyOnComplete, nb.notifyOnComplete);
  diffScalar(out, 'background.notify_terminal', ob.notifyTerminal, nb.notifyTerminal);

  const normHooks = (cfg: StepCodeConfig): string =>
    JSON.stringify(
      (cfg.hooks ?? []).map((h) => ({ event: h.event, command: h.command, timeout: h.timeout, matcher: h.matcher?.source })),
    );
  if (normHooks(oldCfg) !== normHooks(newCfg)) {
    out.push({
      kind: 'changed',
      path: 'hooks',
      oldText: String((oldCfg.hooks ?? []).length),
      newText: String((newCfg.hooks ?? []).length),
    });
  }
  return out;
}

/** provider 重建决策：rebuild = 用新配置重建并同步派生 state；keep = 保留旧 provider（reason 供反馈文案）。 */
export type ProviderReloadPlan =
  | {
      kind: 'rebuild';
      provider: ChatProvider;
      /** 新 provider 的渠道名（预设名或渠道 type），同步 providerNameRef 用。 */
      providerName: string;
      /** 生效的真实模型 id（别名路径可能随配置改动而变化）。 */
      model: string;
      maxContextSize: number;
      /** 状态栏展示名（displayName 反查，无则真实 id）。 */
      modelLabel: string;
    }
  | {
      kind: 'keep';
      /**
       * unchanged：provider 构造输入新旧一致，重建是恒等操作，跳过（避免「provider 已重建」的假反馈）；
       * aliasRemoved：当前别名在新配置中被删，沿用旧 provider（设计 3.3-2：不回落顶层，决策权交回用户）；
       * aliasInvalid：别名在新配置中无法解析（provider 指向无效渠道/预设），沿用旧 provider；
       * buildFailed：createProvider 前置校验抛错（如 provider type 非法），沿用旧 provider（对齐三处先例容错口径）。
       */
      reason: 'unchanged' | 'aliasRemoved' | 'aliasInvalid' | 'buildFailed';
      /** aliasRemoved / aliasInvalid 时的别名。 */
      alias?: string;
      /** buildFailed 时 createProvider 抛出的错误消息。 */
      message?: string;
    };

/** provider 构造输入切片：createProvider 只读这些字段，用于新旧一致判定（unchanged 短路）。 */
function providerSlice(cfg: StepCodeConfig): string {
  return JSON.stringify({
    provider: cfg.provider,
    apiKey: cfg.apiKey,
    baseUrl: cfg.baseUrl,
    model: cfg.model,
    maxTokens: cfg.maxTokens,
    thinking: cfg.thinking,
  });
}

/**
 * /reload 后当前模型的能力标记重解析：模型是会话级状态（reload 不动它），
 * 但能力声明是配置级——用户在别名里加了能力（如 image_in）后 /reload 应当即生效，
 * 不等下次 /model 切换。裸模型无别名绑定，返回 undefined（与原口径一致）。
 */
export function resolveCapabilitiesOnReload(
  cfg: StepCodeConfig,
  currentAlias: string | null,
): string[] | undefined {
  if (currentAlias === null) return undefined;
  return cfg.models?.[currentAlias]?.capabilities;
}

/** 轻量刷新时按当前别名解析图片输入上限（别名语义同 {@link resolveCapabilitiesOnReload}）。 */
export function resolveImageLimitsOnReload(
  cfg: StepCodeConfig,
  currentAlias: string | null,
): { imageMaxEdgePx?: number; imageBudgetBytes?: number; videoBudgetBytes?: number } {
  const entry = currentAlias === null ? undefined : cfg.models?.[currentAlias];
  return {
    imageMaxEdgePx: entry?.imageMaxEdgePx,
    imageBudgetBytes: entry?.imageBudgetBytes,
    videoBudgetBytes: entry?.videoBudgetBytes,
  };
}

/** 状态栏展示名：别名路径取 displayName；裸 id 按「别名解析出的真实 id 命中」反查 displayName，无则用真实 id。 */
function displayNameOf(cfg: StepCodeConfig, model: string, alias: string | null): string {
  if (alias !== null) {
    const entry = cfg.models?.[alias];
    if (entry?.displayName !== undefined) return entry.displayName;
    return model;
  }
  for (const [a, entry] of Object.entries(cfg.models ?? {})) {
    if ((entry.model ?? a) === model && entry.displayName !== undefined) return entry.displayName;
  }
  return model;
}

/**
 * /reload 的 provider 重建决策（设计 3.3 四路）：
 * 1. 当前模型是别名绑定且别名在新配置中仍存在 → resolveModelEntry(newCfg, alias) 重建；
 * 2. 别名在新配置中被删 → keep（沿用旧 provider，不回落顶层——别名渠道可能指向完全不同端点）；
 * 3. 当前模型无别名绑定（裸 id）→ 用新顶层配置重建（{...newCfg, model: currentModel}）；
 * 4. resolveModelEntry 返回 null 或 createProvider 抛错 → keep（对齐三处重建先例的容错口径）。
 * 短路：新旧 provider 构造输入一致时返回 keep/unchanged（重建是恒等操作）。
 */
export function planProviderReload(
  oldCfg: StepCodeConfig,
  newCfg: StepCodeConfig,
  currentModel: string,
  currentAlias: string | null,
): ProviderReloadPlan {
  let nextCfg: StepCodeConfig;
  let sliceOfOld: string;
  if (currentAlias !== null) {
    if (newCfg.models?.[currentAlias] === undefined) {
      return { kind: 'keep', reason: 'aliasRemoved', alias: currentAlias };
    }
    const resolved = resolveModelEntry(newCfg, currentAlias);
    if (resolved === null) {
      return { kind: 'keep', reason: 'aliasInvalid', alias: currentAlias };
    }
    nextCfg = resolved;
    const prevResolved = resolveModelEntry(oldCfg, currentAlias);
    sliceOfOld = prevResolved !== null ? providerSlice(prevResolved) : '';
  } else {
    nextCfg = { ...newCfg, model: currentModel };
    sliceOfOld = providerSlice({ ...oldCfg, model: currentModel });
  }
  if (sliceOfOld === providerSlice(nextCfg)) {
    return { kind: 'keep', reason: 'unchanged' };
  }
  try {
    const provider = createProvider(nextCfg);
    return {
      kind: 'rebuild',
      provider,
      providerName: nextCfg.provider,
      model: nextCfg.model,
      maxContextSize: nextCfg.maxContextSize,
      modelLabel: displayNameOf(newCfg, nextCfg.model, currentAlias),
    };
  } catch (e) {
    return { kind: 'keep', reason: 'buildFailed', message: (e as Error).message };
  }
}
