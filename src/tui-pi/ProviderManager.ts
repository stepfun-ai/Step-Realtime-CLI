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
      description: `${ch.type} · ${ch.baseUrl ?? '默认地址'} · ${aliases} 个别名`,
    });
  }
  for (const name of Object.keys(PROVIDER_PRESETS)) {
    // 预设不可删（它们不在 config.toml 里），标出来避免用户对着预设按 d
    items.push({ value: `preset:${name}`, label: name, description: '内置预设（不可删除）' });
  }
  items.push({ value: '__add__', label: '+ 新增渠道', description: '手动录入 id / 协议 / 地址 / 密钥 / 模型' });
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
    title: '渠道管理',
    items: providerItems(config),
    hint: '↑↓ 选择 · Enter 切换 · d 删除自定义渠道 · Esc 取消',
    onKey: (data, selected, overlay) => {
      if (data !== 'd' || selected === null) return false;
      if (!selected.value.startsWith('custom:')) {
        notify('内置预设不在 config.toml 里，删不了（要停用就切到别的渠道）');
        return true;
      }
      const id = selected.value.slice(7);
      void (async () => {
        const answer = await askLine(tui, `删除渠道 ${id} 及其模型别名？输入 y 确认`);
        if (answer !== null && answer.trim().toLowerCase() === 'y') {
          try {
            const res = await removeProviderConfig(id);
            notify(`已删除渠道 ${id}（备份：${res.backupPath ?? '无'}），用 /reload 让改动生效`);
          } catch (e) {
            notify(`删除失败：${(e as Error).message}`);
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
  const id = await askLine(tui, '渠道 id（用于 [providers.<id>]，如 my-openai）');
  if (id === null || id.trim() === '') return { kind: 'cancelled' };
  if ((config.providers ?? {})[id.trim()] !== undefined) {
    notify(`渠道 ${id.trim()} 已存在（要改配置请直接编辑 config.toml）`);
    return { kind: 'cancelled' };
  }
  const type = await showPicker(tui, {
    title: '协议类型',
    items: Object.keys(PROVIDER_PRESETS).map((name) => ({
      value: name,
      label: name,
      description: `按 ${name} 预设的协议与默认地址`,
    })),
    hint: '↑↓ 选择 · Enter 确认 · Esc 取消',
  });
  if (type === null) return { kind: 'cancelled' };
  const baseUrl = await askLine(tui, 'base_url（留空用该协议的默认地址）', 'https://');
  if (baseUrl === null) return { kind: 'cancelled' };
  const apiKey = await askLine(tui, 'API key（直接粘贴；留空则稍后自己填 config.toml）');
  if (apiKey === null) return { kind: 'cancelled' };
  const model = await askLine(tui, '模型 id（真实模型名，如 gpt-4o）');
  if (model === null || model.trim() === '') return { kind: 'cancelled' };
  const alias = await askLine(tui, `别名（/model 里显示的名字，留空用 ${model.trim()}）`);
  if (alias === null) return { kind: 'cancelled' };
  const ctxText = await askLine(tui, '上下文窗口大小（token 数，留空不声明）');
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
    notify(
      `已写入渠道 ${provider.id}（别名：${res.aliases.join(', ')}）到 ${res.configPath}` +
        (res.backupPath !== undefined ? `，备份 ${res.backupPath}` : '') +
        '。用 /reload 让它生效',
    );
    return { kind: 'added', aliases: res.aliases };
  } catch (e) {
    notify(`写入失败，配置未改动：${(e as Error).message}`);
    return { kind: 'cancelled' };
  }
}
