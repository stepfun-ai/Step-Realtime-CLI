import { Box, Text, useInput } from 'ink';
import { useEffect, useState } from 'react';
import { t } from '../i18n.js';
import { PROVIDER_PRESETS } from '../config/config.js';
import { allocateAlias, appendProviderConfig, type AppendProviderInput } from '../config/tomlAppend.js';
import { DEFAULT_CATALOG_URL, fetchCatalog, parseCatalog, type CatalogProvider } from '../provider/catalog.js';
import { insertText, normalizePastedText, resolveEditAction, type PromptEditState } from './promptEdit.js';

/** 向导结局：added = 写入成功；failed = 写入/校验失败（写入器已回滚）；cancel = 用户 Esc 取消。 */
export type ProviderWizardResult =
  | { kind: 'added'; providerId: string; aliasCount: number }
  | { kind: 'failed'; message: string }
  | { kind: 'cancel' };

/** 协议类型选项（顺序即选择器顺序；desc 走 providerWizard.type.* i18n）。 */
const TYPE_OPTIONS = [
  { id: 'openai', descKey: 'providerWizard.type.openaiDesc' },
  { id: 'anthropic', descKey: 'providerWizard.type.anthropicDesc' },
  { id: 'openai_responses', descKey: 'providerWizard.type.openaiResponsesDesc' },
] as const;

/** 能力标记选项（每项一行说明，界面即自文档）。 */
const CAP_OPTIONS = [
  { id: 'thinking', descKey: 'providerWizard.cap.thinkingDesc' },
  { id: 'image_in', descKey: 'providerWizard.cap.imageInDesc' },
  { id: 'video_in', descKey: 'providerWizard.cap.videoInDesc' },
  { id: 'audio_in', descKey: 'providerWizard.cap.audioInDesc' },
] as const;

/** 目录供应商清单每页条数（对齐 ModelPicker）。 */
const PAGE_SIZE = 10;

type Step =
  | 'path'
  | 'id'
  | 'type'
  | 'baseUrl'
  | 'keyMode'
  | 'apiKey'
  | 'apiKeyEnv'
  | 'modelId'
  | 'displayName'
  | 'maxContext'
  | 'caps'
  | 'fetch'
  | 'fetchError'
  | 'pick'
  | 'catalogKey';

const TEXT_STEPS: ReadonlySet<Step> = new Set(['id', 'baseUrl', 'apiKey', 'apiKeyEnv', 'modelId', 'displayName', 'maxContext', 'catalogKey']);
const SELECT_STEPS: ReadonlySet<Step> = new Set(['path', 'type', 'keyMode']);

/** 手动录入路径累计的草稿（逐步填写，最后一步组装写入）。 */
interface ManualDraft {
  providerId: string;
  type: string;
  baseUrl: string;
  apiKey?: string;
  apiKeyEnv?: string;
  modelId: string;
  displayName?: string;
  maxContext?: number;
}

/**
 * /provider add 渠道向导（替换输入区的弹层，同 ModelPicker 挂载模式）。
 * 双路径：手动录入（逐项提问）与 models.dev 目录导入（拉目录 → 选供应商 →
 * 元数据预填 → 只问 API key → 全部模型导入为别名），两条路径共用
 * appendProviderConfig 写入器（末尾追加 + 备份 + doctor 校验 + 失败回滚）。
 * 组件自持 useInput；宿主（App）在向导打开期间让出全部按键。
 */
export function ProviderWizard({
  catalogUrl,
  existingProviders,
  existingAliases,
  onDone,
}: {
  /** 目录地址覆盖（/provider add --url <地址>）；undefined 用默认目录。 */
  catalogUrl?: string;
  /** 已存在的渠道 id 清单（冲突判定）。 */
  existingProviders: string[];
  /** 已存在的模型别名清单（别名去重）。 */
  existingAliases: string[];
  onDone: (result: ProviderWizardResult) => void;
}): React.ReactElement {
  const [step, setStep] = useState<Step>('path');
  const [sel, setSel] = useState(0);
  // 文本步的输入缓冲与光标（code point 索引）；换步时整体重置
  const [buf, setBuf] = useState('');
  const [cursor, setCursor] = useState(0);
  // 能力多选的勾选集（CAP_OPTIONS 下标）
  const [checked, setChecked] = useState<Set<number>>(new Set());
  // 目录导入路径的状态：供应商清单、拉取失败原因、选中的供应商
  const [catalog, setCatalog] = useState<CatalogProvider[]>([]);
  const [fetchError, setFetchError] = useState('');
  const [picked, setPicked] = useState<CatalogProvider | null>(null);
  // 供应商选择步的过滤词
  const [query, setQuery] = useState('');
  // 行内校验错误（红字显示在当前步下方，不清输入现场）
  const [error, setError] = useState('');
  // 手动路径草稿（useState 即可：只在步进提交时改写，无高频更新）
  const [draft, setDraft] = useState<ManualDraft>({ providerId: '', type: '', baseUrl: '', modelId: '' });

  const source = catalogUrl ?? DEFAULT_CATALOG_URL;

  /** 进入文本步：重置输入缓冲（可带预填值，光标落末尾）与行内错误。 */
  const gotoText = (s: Step, initial = ''): void => {
    setBuf(initial);
    setCursor(Array.from(initial).length);
    setError('');
    setStep(s);
  };

  /** 进入选择步：光标回首项，清行内错误。 */
  const gotoSelect = (s: Step): void => {
    setSel(0);
    setError('');
    setStep(s);
  };

  /** 拉目录：进入 fetch 步即触发；取消/卸载经 cancelled 闸丢弃迟到结果。 */
  useEffect(() => {
    if (step !== 'fetch') return;
    let cancelled = false;
    fetchCatalog(catalogUrl)
      .then((raw) => parseCatalog(raw))
      .then((list) => {
        if (cancelled) return;
        setCatalog(list);
        setQuery('');
        setError('');
        setSel(0);
        setStep('pick');
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        setFetchError((e as Error).message);
        setStep('fetchError');
      });
    return () => {
      cancelled = true;
    };
  }, [step, catalogUrl]);

  /** 共用写入出口：成功/失败都经 onDone 上报（写入器内部已备份 + doctor 校验 + 失败回滚）。 */
  const finish = (input: AppendProviderInput): void => {
    try {
      const result = appendProviderConfig(input);
      onDone({ kind: 'added', providerId: input.provider.id, aliasCount: result.aliases.length });
    } catch (e) {
      onDone({ kind: 'failed', message: (e as Error).message });
    }
  };

  /** 手动路径最后一步（能力多选确认）后的组装写入。 */
  const finishManual = (caps: string[]): void => {
    const alias = allocateAlias(draft.modelId, new Set(existingAliases));
    finish({
      provider: {
        id: draft.providerId,
        type: draft.type,
        baseUrl: draft.baseUrl,
        apiKey: draft.apiKey,
        apiKeyEnv: draft.apiKeyEnv,
      },
      models: [
        {
          alias,
          model: draft.modelId,
          displayName: draft.displayName,
          maxContextSize: draft.maxContext,
          capabilities: caps.length > 0 ? caps : undefined,
        },
      ],
    });
  };

  /** 目录路径（catalogKey 步确认）后的组装写入：全部模型导入为别名，重名加数字后缀。 */
  const finishCatalog = (apiKey: string): void => {
    if (picked === null) return;
    const taken = new Set(existingAliases);
    const models = picked.models.map((m) => {
      const alias = allocateAlias(m.id, taken);
      taken.add(alias);
      return {
        alias,
        model: m.id,
        displayName: m.name,
        maxContextSize: m.context,
        capabilities: m.capabilities.length > 0 ? m.capabilities : undefined,
      };
    });
    finish({
      provider: {
        id: picked.id,
        type: picked.type,
        baseUrl: picked.baseUrl,
        // 留空 → 写 api_key_env（目录 env[0] 惯例变量名），密钥不落盘
        apiKey: apiKey !== '' ? apiKey : undefined,
        apiKeyEnv: apiKey === '' ? picked.envHint : undefined,
      },
      models,
    });
  };

  /** 文本步提交：按步校验并推进；校验失败只置行内错误，不清输入现场。 */
  const submitText = (): void => {
    const v = buf.trim();
    switch (step) {
      case 'id': {
        if (v === '') return setError(t('providerWizard.err.empty'));
        if (!/^[a-z0-9_-]+$/.test(v)) return setError(t('providerWizard.err.idChars'));
        if (existingProviders.includes(v)) return setError(t('providerWizard.err.idExists'));
        setDraft((d) => ({ ...d, providerId: v }));
        gotoSelect('type');
        return;
      }
      case 'baseUrl': {
        if (v === '') return setError(t('providerWizard.err.empty'));
        if (!/^https?:\/\//i.test(v)) return setError(t('providerWizard.err.url'));
        setDraft((d) => ({ ...d, baseUrl: v }));
        gotoSelect('keyMode');
        return;
      }
      case 'apiKey': {
        if (v === '') return setError(t('providerWizard.err.empty'));
        setDraft((d) => ({ ...d, apiKey: v }));
        gotoText('modelId');
        return;
      }
      case 'apiKeyEnv': {
        if (v === '') return setError(t('providerWizard.err.empty'));
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(v)) return setError(t('providerWizard.err.envName'));
        setDraft((d) => ({ ...d, apiKeyEnv: v }));
        gotoText('modelId');
        return;
      }
      case 'modelId': {
        if (v === '') return setError(t('providerWizard.err.empty'));
        setDraft((d) => ({ ...d, modelId: v }));
        gotoText('displayName');
        return;
      }
      case 'displayName': {
        setDraft((d) => ({ ...d, displayName: v !== '' ? v : undefined }));
        gotoText('maxContext');
        return;
      }
      case 'maxContext': {
        if (v !== '' && (!/^\d+$/.test(v) || Number(v) <= 0)) return setError(t('providerWizard.err.number'));
        setDraft((d) => ({ ...d, maxContext: v !== '' ? Number(v) : undefined }));
        setChecked(new Set());
        gotoSelect('caps');
        return;
      }
      case 'catalogKey': {
        finishCatalog(v);
        return;
      }
      default:
        return;
    }
  };

  /** 选择步确认：按步取当前光标项并推进。 */
  const submitSelect = (): void => {
    switch (step) {
      case 'path': {
        if (sel === 0) {
          gotoText('id');
        } else {
          setError('');
          setStep('fetch');
        }
        return;
      }
      case 'type': {
        const chosen = TYPE_OPTIONS[sel]!;
        setDraft((d) => ({ ...d, type: chosen.id }));
        // 预填协议默认 base_url，可编辑
        gotoText('baseUrl', PROVIDER_PRESETS[chosen.id]?.baseUrl ?? '');
        return;
      }
      case 'keyMode': {
        if (sel === 0) gotoText('apiKey');
        else if (sel === 1) gotoText('apiKeyEnv');
        else gotoText('modelId');
        return;
      }
      default:
        return;
    }
  };

  // 供应商选择步的过滤清单（id + 名称小写子串；空格分词 AND，与 ModelPicker 同口径）
  const filteredCatalog = ((): CatalogProvider[] => {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) return catalog;
    return catalog.filter((p) => terms.every((term) => `${p.id} ${p.name}`.toLowerCase().includes(term)));
  })();
  const clampedSel = Math.min(sel, Math.max(filteredCatalog.length - 1, 0));
  const pageStart = Math.floor(clampedSel / PAGE_SIZE) * PAGE_SIZE;
  const page = filteredCatalog.slice(pageStart, pageStart + PAGE_SIZE);

  useInput((input, key) => {
    // Esc：选择步过滤词非空时先清词（与 ModelPicker 同口径），其余情况取消整个向导
    if (key.escape) {
      if (step === 'pick' && query !== '') {
        setQuery('');
        setSel(0);
        return;
      }
      onDone({ kind: 'cancel' });
      return;
    }
    if (step === 'fetch') return; // 拉取中只响应 Esc（上面已处理）
    if (step === 'fetchError') {
      if (input === 'r') {
        setError('');
        setStep('fetch');
      }
      return;
    }
    if (SELECT_STEPS.has(step)) {
      const count = step === 'path' ? 2 : step === 'type' ? TYPE_OPTIONS.length : 3;
      if (key.upArrow) return setSel((i) => Math.max(i - 1, 0));
      if (key.downArrow) return setSel((i) => Math.min(i + 1, count - 1));
      if (key.return) return submitSelect();
      return;
    }
    if (step === 'caps') {
      if (key.upArrow) return setSel((i) => Math.max(i - 1, 0));
      if (key.downArrow) return setSel((i) => Math.min(i + 1, CAP_OPTIONS.length - 1));
      if (input === ' ') {
        const next = new Set(checked);
        if (next.has(sel)) next.delete(sel);
        else next.add(sel);
        setChecked(next);
        return;
      }
      if (key.return) {
        const caps = CAP_OPTIONS.filter((_, i) => checked.has(i)).map((c) => c.id);
        finishManual(caps);
        return;
      }
      return;
    }
    if (step === 'pick') {
      if (key.upArrow) return setSel((i) => Math.max(i - 1, 0));
      if (key.downArrow) return setSel((i) => Math.min(i + 1, Math.max(filteredCatalog.length - 1, 0)));
      if (key.backspace || key.delete) {
        setQuery((q) => q.slice(0, -1));
        setSel(0);
        return;
      }
      if (key.return) {
        const chosen = filteredCatalog[clampedSel];
        if (chosen === undefined) return;
        if (existingProviders.includes(chosen.id)) {
          setError(t('providerWizard.pickConflict', { id: chosen.id }));
          return;
        }
        setPicked(chosen);
        gotoText('catalogKey');
        return;
      }
      if (input !== '' && !key.ctrl && !key.meta) {
        setQuery((q) => q + input);
        setSel(0);
      }
      return;
    }
    if (TEXT_STEPS.has(step)) {
      if (key.return) return submitText();
      // 编辑键（←→/Home/End/退格/删词）走 promptEdit，可打印字符插光标处
      const editState: PromptEditState = { text: buf, cursor };
      const action = resolveEditAction(input, key);
      if (action) {
        const next = action(editState);
        setBuf(next.text);
        setCursor(next.cursor);
        return;
      }
      if (input !== '' && !key.ctrl && !key.meta) {
        const next = insertText(editState, normalizePastedText(input));
        setBuf(next.text);
        setCursor(next.cursor);
      }
    }
  });

  /** 选项行（选择步/能力步共用渲染）：光标 › + 序号 + 标签 + 灰字说明。 */
  const renderOption = (i: number, active: boolean, label: string, desc?: string, box?: string): React.ReactNode => (
    <Text key={i} color={active ? 'cyan' : 'white'} bold={active}>
      {active ? '› ' : '  '}
      {box ?? ''}
      {`[${i + 1}] ${label}`}
      {desc !== undefined && desc !== '' ? <Text color="gray">{`  — ${desc}`}</Text> : null}
    </Text>
  );

  /** 当前步的题干文案（文本步）。 */
  const textQuestion = ((): string => {
    switch (step) {
      case 'id':
        return t('providerWizard.ask.id');
      case 'baseUrl':
        return t('providerWizard.ask.baseUrl');
      case 'apiKey':
        return t('providerWizard.ask.apiKey');
      case 'apiKeyEnv':
        return t('providerWizard.ask.apiKeyEnv');
      case 'modelId':
        return t('providerWizard.ask.modelId');
      case 'displayName':
        return t('providerWizard.ask.displayName');
      case 'maxContext':
        return t('providerWizard.ask.maxContext');
      case 'catalogKey':
        return picked?.envHint !== undefined
          ? t('providerWizard.ask.catalogKey', { env: picked.envHint })
          : t('providerWizard.ask.catalogKeyNoEnv');
      default:
        return '';
    }
  })();

  const hint = ((): string => {
    if (SELECT_STEPS.has(step)) return t('providerWizard.hint.select');
    if (step === 'caps') return t('providerWizard.hint.multi');
    if (step === 'pick') return t('providerWizard.hint.pick');
    if (step === 'fetchError') return t('providerWizard.hint.fetchError');
    return t('providerWizard.hint.text');
  })();

  return (
    <Box flexDirection="column" marginTop={1} borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text color="cyan" bold>
        {t('providerWizard.title')}
      </Text>
      {step === 'path' && (
        <>
          <Text>{t('providerWizard.ask.path')}</Text>
          {renderOption(0, sel === 0, t('providerWizard.path.manual'), t('providerWizard.path.manualDesc'))}
          {renderOption(1, sel === 1, t('providerWizard.path.catalog'), t('providerWizard.path.catalogDesc'))}
        </>
      )}
      {step === 'type' && (
        <>
          <Text>{t('providerWizard.ask.type')}</Text>
          {TYPE_OPTIONS.map((o, i) => renderOption(i, sel === i, o.id, t(o.descKey)))}
        </>
      )}
      {step === 'keyMode' && (
        <>
          <Text>{t('providerWizard.ask.keyMode')}</Text>
          {renderOption(0, sel === 0, t('providerWizard.keyMode.direct'), t('providerWizard.keyMode.directDesc'))}
          {renderOption(1, sel === 1, t('providerWizard.keyMode.env'), t('providerWizard.keyMode.envDesc'))}
          {renderOption(2, sel === 2, t('providerWizard.keyMode.skip'), t('providerWizard.keyMode.skipDesc'))}
        </>
      )}
      {step === 'caps' && (
        <>
          <Text>{t('providerWizard.ask.caps')}</Text>
          {CAP_OPTIONS.map((o, i) =>
            renderOption(i, sel === i, o.id, t(o.descKey), checked.has(i) ? '[✓] ' : '[ ] '),
          )}
        </>
      )}
      {TEXT_STEPS.has(step) && (
        <>
          {step === 'catalogKey' && picked !== null && (
            <Text color="gray">
              {t('providerWizard.importInfo', {
                id: picked.id,
                type: picked.type,
                unverified: picked.typeUnverified ? t('providerWizard.unverified') : '',
                baseUrl: picked.baseUrl ?? t('app.provider.noBaseUrl'),
                count: picked.models.length,
              })}
            </Text>
          )}
          <Text>{textQuestion}</Text>
          <Text>{renderField(buf, cursor)}</Text>
        </>
      )}
      {step === 'fetch' && <Text>{t('providerWizard.fetching', { url: source })}</Text>}
      {step === 'fetchError' && (
        <>
          <Text color="red">{t('providerWizard.fetchFailed', { message: fetchError })}</Text>
          <Text color="gray">{t('providerWizard.fetchAdvice')}</Text>
        </>
      )}
      {step === 'pick' && (
        <>
          <Text>{t('providerWizard.pick', { count: catalog.length })}</Text>
          <Text>
            {query === '' ? <Text dimColor>{t('providerWizard.pickPlaceholder')}</Text> : <Text color="yellow">{query}</Text>}
          </Text>
          {filteredCatalog.length === 0 ? (
            <Text color="gray">{t('providerWizard.pickEmpty')}</Text>
          ) : (
            page.map((p, i) => {
              const active = pageStart + i === clampedSel;
              return (
                <Text key={p.id} color={active ? 'cyan' : 'white'} inverse={active}>
                  {active ? '› ' : '  '}
                  {p.id}
                  <Text color="gray">{`  ${p.name} · ${p.models.length}`}</Text>
                </Text>
              );
            })
          )}
          {filteredCatalog.length > PAGE_SIZE && (
            <Text color="gray">
              {t('sessionPicker.pageInfo', {
                start: pageStart + 1,
                end: Math.min(pageStart + PAGE_SIZE, filteredCatalog.length),
                total: filteredCatalog.length,
              })}
            </Text>
          )}
        </>
      )}
      {error !== '' && <Text color="red">{error}</Text>}
      <Text color="gray">{hint}</Text>
    </Box>
  );
}

/**
 * 单行文本 + 反色光标渲染（与 QuestionPrompt 的 Other 输入同款，不引入 ink-text-input）：
 * 光标处字符反色，光标在末尾时反色一个占位空格；空文本时反色一个空格作光标。
 */
function renderField(value: string, cursor: number): React.ReactNode {
  if (value === '') {
    return <Text inverse>{' '}</Text>;
  }
  const chars = Array.from(value);
  const at = Math.max(0, Math.min(cursor, chars.length));
  const cursorChar = at < chars.length ? (chars[at] as string) : ' ';
  return (
    <>
      {chars.slice(0, at).join('')}
      <Text inverse>{cursorChar}</Text>
      {at < chars.length ? chars.slice(at + 1).join('') : ''}
    </>
  );
}
