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
import { PROVIDER_PRESETS, type StepCodeConfig } from '../config/config.js';
import { appendProviderConfig, removeProviderConfig, type ModelDraft, type ProviderDraft } from '../config/tomlAppend.js';
import { askLine, showPicker } from './pickers.js';
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
 * 新增渠道向导：逐项问 id → 协议 → base_url → 密钥 → 模型 id → 别名 → 窗口大小。
 * 任一步 Esc 取消整个流程（中途取消不写盘，配置保持原样）。
 */
export async function runProviderWizard(
  tui: TUI,
  config: StepCodeConfig,
  notify: (text: string) => void,
): Promise<ProviderPickResult> {
  const id = await askLine(tui, t('providerWizard.ask.id'));
  if (id === null || id.trim() === '') return { kind: 'cancelled' };
  if ((config.providers ?? {})[id.trim()] !== undefined) {
    notify(t('providerWizard.err.idExists', { id: id.trim() }));
    return { kind: 'cancelled' };
  }
  const type = await showPicker(tui, {
    title: t('providerWizard.ask.type'),
    items: Object.keys(PROVIDER_PRESETS).map((name) => ({
      value: name,
      label: name,
      description: t('providerWizard.type.presetDesc', { name }),
    })),
    hint: t('providerWizard.hint.select'),
  });
  if (type === null) return { kind: 'cancelled' };
  const baseUrl = await askLine(tui, t('providerWizard.ask.baseUrl'), 'https://');
  if (baseUrl === null) return { kind: 'cancelled' };
  const apiKey = await askLine(tui, t('providerWizard.ask.apiKey'));
  if (apiKey === null) return { kind: 'cancelled' };
  const model = await askLine(tui, t('providerWizard.ask.modelId'));
  if (model === null || model.trim() === '') return { kind: 'cancelled' };
  const alias = await askLine(tui, t('providerWizard.ask.displayName', { model: model.trim() }));
  if (alias === null) return { kind: 'cancelled' };
  const ctxText = await askLine(tui, t('providerWizard.ask.maxContext'));
  if (ctxText === null) return { kind: 'cancelled' };

  const provider: ProviderDraft = {
    id: id.trim(),
    type,
    ...(baseUrl.trim() !== '' && baseUrl.trim() !== 'https://' ? { baseUrl: baseUrl.trim() } : {}),
    ...(apiKey.trim() !== '' ? { apiKey: apiKey.trim() } : {}),
  };
  const maxContextSize = Number.parseInt(ctxText.trim(), 10);
  const draft: ModelDraft = {
    alias: alias.trim() === '' ? model.trim() : alias.trim(),
    model: model.trim(),
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
