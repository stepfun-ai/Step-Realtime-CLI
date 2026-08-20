/**
 * 首次运行引导（pi-tui 版）。
 *
 * 与 Ink 版 `FirstRunSetup.tsx` 同一流程与同一落盘语义：
 * 选接入方式 → （自定义时）输 base_url → 粘贴 key → 选默认模型 → 完成。
 *
 * 落盘动作逐条对齐 Ink 版，这里不重新设计：
 * - key 步骤确认时写 `[providers.<渠道>]` 的 base_url 与 api_key；
 * - model 步骤确认时写 `[models.<别名>]` 并把顶层 model 设成该别名。
 *   第二步不能省：顶层 model 是别名，别名必须指向 [models.*] 段，否则会出现
 *   「配了 A 渠道但默认模型走 B 渠道」。
 *
 * 全程只开一个 TuiMainScreen，步骤之间换内容而不是换屏：主屏接管 stdin 与光标，
 * 多个屏并存会争输入。
 */
import { ProcessTerminal, TuiMainScreen } from '@earendil-works/pi-tui';
import type { TUI } from '@earendil-works/pi-tui';
import { saveDefaultModel, saveModelAlias, saveProviderKey } from '../config/config.js';
import { t } from '../i18n.js';
import { Banner, askLine, showPicker } from './pickers.js';
import { c } from './theme.js';

export type FirstRunResult =
  | { kind: 'configured'; apiKey: string; provider: string; model: string }
  /**
   * 用户选了「查看文档，稍后手动配置」。与 cancel 分开：这条路径要在退出后把文档链接
   * 打到终端上，否则 TUI 一清屏，用户刚选的那个链接就消失了（先前两者都返回 cancel，
   * 于是进程静默退出，选这一项等于什么也没得到）。
   */
  | { kind: 'docs'; url: string }
  | { kind: 'cancel' };

interface ProviderOption {
  /** 写进 [providers.<name>] 的渠道名。 */
  name: string;
  /** 显示名的 i18n key。存 key 而非文案：模块级常量在 import 时求值会把语言固化。 */
  labelKey: string;
  baseUrl: string;
  models: { alias: string; modelId: string; displayName: string }[];
}

const PROVIDER_OPTIONS: ProviderOption[] = [
  {
    name: 'stepfun-plan',
    labelKey: 'firstRun.optionPlan',
    baseUrl: 'https://api.stepfun.com/step_plan/v1',
    models: [
      { alias: 'router', modelId: 'step-router-v1', displayName: 'Step Router V1' },
      { alias: 'step37', modelId: 'step-3.7-flash', displayName: 'Step 3.7 Flash' },
    ],
  },
  {
    name: 'stepfun',
    labelKey: 'firstRun.optionApi',
    baseUrl: 'https://api.stepfun.com/v1',
    models: [
      { alias: 'step37', modelId: 'step-3.7-flash', displayName: 'Step 3.7 Flash' },
      { alias: 'step35', modelId: 'step-3.5-flash-2603', displayName: 'Step 3.5 Flash 2603' },
    ],
  },
  { name: 'custom', labelKey: 'firstRun.optionCustom', baseUrl: 'https://', models: [] },
];

const DOCS_VALUE = '__docs__';
const DOCS_URL =
  'https://github.com/li-xiu-qi/Step-Realtime-CLI/blob/step-code-explore/docs/zh/quickstart.md#2-%E9%85%8D%E7%BD%AE-api-key';
/** 自定义渠道的模型别名与默认上下文窗口。 */
const CUSTOM_ALIAS = 'custom';
const DEFAULT_MAX_CONTEXT = 262144;

/** 屏幕上方的静态说明区（标题 + 已选信息）。 */
/**
 * 跑一遍引导。返回 configured 时配置已落盘，调用方只需重载配置。
 *
 * 步骤流转用循环而不是递归：Esc 回退是常态路径（用户想改上一步的选择），
 * 递归实现会让回退变成栈增长。
 */
export async function runFirstRunPi(): Promise<FirstRunResult> {
  const tui = new TuiMainScreen(new ProcessTerminal());
  const banner = new Banner();
  banner.setLines([c.accent(t('firstRun.title')), '']);
  tui.addChild(banner);
  tui.start();
  tui.requestRender();
  try {
    return await wizard(tui, banner);
  } finally {
    tui.stop();
  }
}

async function wizard(tui: TUI, banner: Banner): Promise<FirstRunResult> {
  let chosen: ProviderOption | null = null;
  let apiKey = '';
  let selectedModel: { alias: string; modelId: string; displayName: string } | null = null;
  let step: 'select' | 'baseUrl' | 'key' | 'model' | 'confirm' = 'select';

  const setBanner = (...extra: string[]): void => {
    banner.setLines([c.accent(t('firstRun.title')), ...extra, '']);
    tui.requestRender();
  };

  for (;;) {
    if (step === 'select') {
      setBanner();
      const picked = await showPicker(tui, {
        title: t('firstRun.title'),
        subtitle: t('firstRun.hint'),
        items: [
          ...PROVIDER_OPTIONS.map((o) => ({ value: o.name, label: t(o.labelKey), description: o.baseUrl })),
          { value: DOCS_VALUE, label: t('firstRun.optionDocs'), description: DOCS_URL },
        ],
      });
      if (picked === null) return { kind: 'cancel' };
      if (picked === DOCS_VALUE) {
        // 文档出口：不落盘，退出后由 cli 打印链接（stderr 在 tui.stop 之后才可靠）
        return { kind: 'docs', url: DOCS_URL };
      }
      chosen = { ...PROVIDER_OPTIONS.find((o) => o.name === picked)! };
      step = chosen.name === 'custom' ? 'baseUrl' : 'key';
      continue;
    }

    if (step === 'baseUrl') {
      setBanner(c.dim(t('firstRun.confirmProvider', { label: chosen!.name })), c.accent(t('firstRun.baseUrlTitle')));
      const url = await askLine(tui, t('firstRun.baseUrlHint'), 'https://', t('firstRun.pasteEscHint'));
      if (url === null) {
        step = 'select';
        continue;
      }
      if (url.trim() === '') continue;
      chosen = { ...chosen!, baseUrl: url.trim() };
      step = 'key';
      continue;
    }

    if (step === 'key') {
      setBanner(
        c.dim(
          `${t('firstRun.confirmProvider', { label: chosen!.name })} · ${t('firstRun.confirmBaseUrl', { url: chosen!.baseUrl })}`,
        ),
        c.accent(t('firstRun.pasteTitle')),
      );
      const key = await askLine(tui, t('firstRun.pasteHint'), undefined, t('firstRun.pasteEscHint'));
      if (key === null) {
        step = chosen!.name === 'custom' ? 'baseUrl' : 'select';
        continue;
      }
      if (key.trim() === '') continue;
      apiKey = key.trim();
      // 渠道段先落盘：模型别名在下一步写
      saveProviderKey(chosen!.name, 'base_url', chosen!.baseUrl);
      saveProviderKey(chosen!.name, 'api_key', apiKey);
      step = 'model';
      continue;
    }

    // step === 'model'
    setBanner(
      c.dim(`${t('firstRun.confirmProvider', { label: chosen!.name })} · ${t('firstRun.keySaved')}`),
      c.accent(t('firstRun.customModelTitle')),
    );
    if (chosen!.models.length === 0) {
      const modelId = await askLine(tui, t('firstRun.customModelHint'), undefined, t('firstRun.pasteEscHint'));
      if (modelId === null) {
        step = 'key';
        continue;
      }
      if (modelId.trim() === '') continue;
      saveModelAlias(CUSTOM_ALIAS, {
        provider: chosen!.name,
        model: modelId.trim(),
        max_context_size: DEFAULT_MAX_CONTEXT,
        display_name: modelId.trim(),
      });
      saveDefaultModel(CUSTOM_ALIAS);
      return { kind: 'configured', apiKey, provider: chosen!.name, model: CUSTOM_ALIAS };
    }
    const picked = await showPicker(tui, {
      title: t('firstRun.modelTitle'),
      subtitle: t('firstRun.modelHint'),
      hint: t('firstRun.modelEscHint'),
      items: chosen!.models.map((m) => ({ value: m.alias, label: m.displayName, description: m.modelId })),
    });
    if (picked === null) {
      step = 'key';
      continue;
    }
    const model = chosen!.models.find((m) => m.alias === picked)!;
    // 记住选择，不立即落盘——到 confirm 步骤确认后再统一保存
    selectedModel = { alias: model.alias, modelId: model.modelId, displayName: model.displayName };
    step = 'confirm';
    continue;

  // confirm 步骤：汇总所有选择让用户最后核对一遍，确认后才落盘
  if (step === 'confirm') {
    const masked = apiKey.slice(0, 4) + '...' + apiKey.slice(-4);
    setBanner(
      c.ok(t('firstRun.confirmTitle')),
      c.dim(t('firstRun.confirmProvider', { label: chosen!.name })),
      c.dim(t('firstRun.confirmBaseUrl', { url: chosen!.baseUrl })),
      c.dim(t('firstRun.confirmKey', { key: masked })),
      c.dim(t('firstRun.confirmModel', { model: selectedModel!.displayName })),
      '',
    );
    const answer = await askLine(tui, t('firstRun.confirmHint'), undefined, t('firstRun.confirmEscHint'));
    if (answer !== null) {
      const trimmed = answer!.trim().toLowerCase();
      if (trimmed === 'y' || trimmed === '') {
        // 确认落盘
        const model = selectedModel!;
        saveModelAlias(model.alias, {
          provider: chosen!.name,
          model: model.modelId,
          max_context_size: DEFAULT_MAX_CONTEXT,
          display_name: model.displayName,
        });
        saveDefaultModel(model.alias);
        return { kind: 'configured', apiKey, provider: chosen!.name, model: model.alias };
      }
    }
    // answer === null（Esc）或非 y 非空 → 返回模型选择步骤
    step = 'model';
    continue;
  }
}
}

/** 单行输入。Enter 提交，Esc 返回 null（调用方决定回退到哪一步）。
 *
 * 用 Editor 而不是 Input：Editor 支持 bracketed paste，而 key 这一步几乎总是粘贴进来的
 * （手打 API key 不现实），Input 对粘贴的处理是逐字符插入，长 key 会明显卡顿。
 */
