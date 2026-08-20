/**
 * `/provider` 的渠道管理与新增向导。
 *
 * 对应 Ink 版 ProviderManager + ProviderWizard 两个组件，这里合成一条流程：
 * 列表选择器（SelectList overlay）承担查看与切换，d 删除（二次确认）、a 新增（多步问答）。
 *
 * 与 Ink 版的差异：Ink 的向导有「目录导入」路径（fetch 远端 catalog → 选供应商 → 全量导入
 * 别名）。这里只做手动录入——目录导入依赖外部 catalog 端点的可用性，而它当前只覆盖少数
 * 供应商；手动录入是任何渠道都走得通的那条路。目录导入记入差异清单，需要时再补。
 *
 * 写盘走既有的 appendProviderConfig（备份 + doctor 校验 + 失败回滚），本文件不碰文件格式。
 */
import type { TUI } from '@earendil-works/pi-tui';
import { PROVIDER_PRESETS, type ProviderEntry, type StepCodeConfig } from '../config/config.js';
import { appendProviderConfig, removeProviderConfig, type ModelDraft, type ProviderDraft } from '../config/tomlAppend.js';
import { askLine, askValidated, showPicker } from './pickers.js';
import { t } from '../i18n.js';

/** 列表项：自定义渠道 + 内置预设 + 新增入口。 */
export function providerItems(config: StepCodeConfig): { value: string; label: string; description: string }[] {
  const providers = config.providers ?? {};
  const models = config.models ?? {};
  const items: { value: string; label: string; description: string }[] = [];
  for (const [id, ch] of Object.entries(providers)) {
    const aliases = Object.entries(models).filter(([, m]) => m.provider === id).length;
    const current = config.provider === id ? '● ' : '';
    items.push({
      value: `custom:${id}`,
      label: `${current}${id}`,
      description: t('providerManager.itemDescription', {
        type: ch.type,
        baseUrl: ch.baseUrl ?? t('providerManager.defaultAddress'),
        count: aliases,
      }),
    });
  }
  for (const name of Object.keys(PROVIDER_PRESETS)) {
    // 预设不可删（它们不在 config.toml 里），标出来避免用户对着预设按 d
    items.push({ value: `preset:${name}`, label: name, description: t('providerManager.builtinDesc') });
  }
  items.push({ value: '__add__', label: t('providerManager.cta'), description: t('providerManager.addDescription') });
  return items;
}

export interface ProviderPickResult {
  kind: 'switch' | 'added' | 'deleted' | 'cancelled';
  /** switch 时为目标 id 或预设名（含 custom:/preset: 前缀已剥离）。 */
  target?: string;
  /** added 时写入的别名。 */
  aliases?: string[];
  message?: string;
}

/**
 * 打开渠道管理弹层。返回用户最终做了什么，由调用方落副作用
 * （切换要重建 provider、删除与新增要触发 /reload 语义的配置重读）。
 */
export async function openProviderManager(
  tui: TUI,
  config: StepCodeConfig,
  notify: (text: string) => void,
): Promise<ProviderPickResult> {
  const picked = await showPicker(tui, {
    title: t('providerManager.title'),
    items: providerItems(config),
    hint: t('providerManager.hint'),
    onKey: (data, selected, overlay) => {
      if (data !== 'd' || selected === null) return false;
      if (!selected.value.startsWith('custom:')) {
        notify(t('providerManager.cannotDeleteBuiltin'));
        return true;
      }
      const id = selected.value.slice(7);
      void (async () => {
        const answer = await askLine(tui, t('providerManager.deleteConfirm', { id }));
        if (answer !== null && answer.trim().toLowerCase() === 'y') {
          try {
            const res = await removeProviderConfig(id);
            notify(t('providerManager.deleted', { id, backup: res.backupPath ?? t('app.provider.noBaseUrl') }));
          } catch (e) {
            notify(t('app.provider.deleteFailed', { message: (e as Error).message }));
          }
        }
        tui.setFocus(overlay);
        tui.requestRender();
      })();
      return true;
    },
  });
  if (picked === null) return { kind: 'cancelled' };
  if (picked === '__add__') return runProviderWizard(tui, config, notify);
  if (picked.startsWith('custom:')) return { kind: 'switch', target: picked.slice(7) };
  return { kind: 'switch', target: picked.slice(7) };
}

/**
 * 各协议的 base_url 约定说明。写成显式表而不是拼 `type.${protocol}Desc`：
 * 字面量能被 i18n 孤儿扫描认出「在用」，动态拼接会让这三条看起来像没人调用。
 *
 * 键是 PROVIDER_PRESETS 里的 protocol（不是 preset 名）——stepfun 走 anthropic 协议，
 * 说明也该是 anthropic 那条。base_url 带不带 /v1 是这一步最容易配错的地方，值得逐条说清。
 */
const PROTOCOL_DESC_KEY: Record<string, string> = {
  anthropic: 'providerWizard.type.anthropicDesc',
  openai: 'providerWizard.type.openaiDesc',
  openai_responses: 'providerWizard.type.openaiResponsesDesc',
};

/**
 * 新增渠道向导：逐项问 id → 协议 → base_url → 密钥 → 模型 id → 别名 → 窗口大小。
 * 任一步 Esc 取消整个流程（中途取消不写盘，配置保持原样）。
 */
export async function runProviderWizard(
  tui: TUI,
  config: StepCodeConfig,
  notify: (text: string) => void,
): Promise<ProviderPickResult> {
  const existing = config.providers ?? {};

  // ⑤ 从已有渠道复制：有现成渠道时先问入口方式。复制模式预填 type/baseUrl，
  // 用户只改差异项（id 必须新取、apiKey 按源渠道惯例重新给）。
  let clone: ProviderEntry | null = null;
  if (Object.keys(existing).length > 0) {
    const mode = await showPicker(tui, {
      title: t('providerWizard.ask.entryMode'),
      items: [
        { value: 'clone', label: t('providerWizard.entry.clone'), description: t('providerWizard.entry.cloneDesc') },
        { value: 'manual', label: t('providerWizard.entry.manual'), description: t('providerWizard.entry.manualDesc') },
      ],
      hint: t('providerWizard.hint.pick'),
    });
    if (mode === null) return { kind: 'cancelled' };
    if (mode === 'clone') {
      const source = await showPicker(tui, {
        title: t('providerWizard.ask.cloneSource'),
        items: Object.entries(existing).map(([id, ch]) => ({
          value: id,
          label: id,
          description: ch.type,
        })),
        hint: t('providerWizard.hint.pick'),
      });
      if (source === null) return { kind: 'cancelled' };
      clone = existing[source]!;
    }
  }

  // id 重复当场重问，而不是 notify 一句就把整个流程取消掉——用户想要的是换个 id 继续
  const id = await askValidated(tui, t('providerWizard.ask.id'), (v) => {
    if (v === '') return t('providerWizard.err.empty');
    if (!/^[a-z0-9_-]+$/.test(v)) return t('providerWizard.err.idChars');
    if (existing[v] !== undefined) return t('providerWizard.err.idExists', { id: v });
    return null;
  });
  if (id === null) return { kind: 'cancelled' };
  // clone 模式跳过 type 选择（源渠道已定协议）；手动模式走正常 picker
  const type =
    clone !== null
      ? clone.type
      : await showPicker(tui, {
          title: t('providerWizard.ask.type'),
          items: Object.keys(PROVIDER_PRESETS).map((name) => {
            const descKey = PROTOCOL_DESC_KEY[PROVIDER_PRESETS[name]!.protocol];
            return {
              value: name,
              label: name,
              description: descKey !== undefined ? t(descKey) : t('providerWizard.type.presetDesc', { name }),
            };
          }),
          hint: t('providerWizard.hint.pick'),
        });
  if (type === null) return { kind: 'cancelled' };
  // base_url 允许留空（此时继承 preset 的默认地址），但一旦填了就必须是合法 URL。
  // clone 模式用源渠道地址作 initial；'https://' 这个初始值等于没填
  const baseUrl = await askValidated(
    tui,
    t('providerWizard.ask.baseUrl'),
    (v) => (v === '' || v === 'https://' || /^https?:\/\//i.test(v) ? null : t('providerWizard.err.url')),
    { initial: clone?.baseUrl !== undefined && clone.baseUrl !== '' ? clone.baseUrl : 'https://' },
  );
  if (baseUrl === null) return { kind: 'cancelled' };
  // 密钥可留空：pi 版还没做 keyMode 三选，空值等价于「暂不配置」，运行时按 type 的惯例环境变量找
  const apiKey = await askLine(tui, t('providerWizard.ask.apiKey'), undefined, t('providerWizard.hint.text'));
  if (apiKey === null) return { kind: 'cancelled' };
  const model = await askValidated(tui, t('providerWizard.ask.modelId'), (v) =>
    v === '' ? t('providerWizard.err.empty') : null,
  );
  if (model === null) return { kind: 'cancelled' };
  const alias = await askLine(
    tui,
    t('providerWizard.ask.displayName', { model }),
    undefined,
    t('providerWizard.hint.text'),
  );
  if (alias === null) return { kind: 'cancelled' };
  const ctxText = await askValidated(tui, t('providerWizard.ask.maxContext'), (v) =>
    v === '' || (/^\d+$/.test(v) && Number(v) > 0) ? null : t('providerWizard.err.number'),
  );
  if (ctxText === null) return { kind: 'cancelled' };

  // askValidated 返回的已是 trim 后的值；askLine 的两个（apiKey/alias）仍需自己 trim
  const provider: ProviderDraft = {
    id,
    type,
    ...(baseUrl !== '' && baseUrl !== 'https://' ? { baseUrl } : {}),
    ...(apiKey.trim() !== '' ? { apiKey: apiKey.trim() } : {}),
  };
  const maxContextSize = Number.parseInt(ctxText, 10);
  const draft: ModelDraft = {
    alias: alias.trim() === '' ? model : alias.trim(),
    model,
    ...(Number.isFinite(maxContextSize) && maxContextSize > 0 ? { maxContextSize } : {}),
  };
  try {
    const res = await appendProviderConfig({ provider, models: [draft] });
    const backupSuffix = res.backupPath !== undefined ? t('providerManager.addedBackup', { backup: res.backupPath }) : '';
    notify(
      t('providerManager.added', {
        id: provider.id,
        aliases: res.aliases.join(', '),
        configPath: res.configPath,
        backup: backupSuffix,
      }),
    );
    return { kind: 'added', aliases: res.aliases };
  } catch (e) {
    notify(t('providerManager.addFailed', { message: (e as Error).message }));
    return { kind: 'cancelled' };
  }
}
