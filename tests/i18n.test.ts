import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// saveLanguage 写 ~/.step-code/config.toml：把 homedir 指到临时目录，避免碰真实配置。
let fakeHome = '';
vi.mock('node:os', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:os')>();
  return { ...orig, homedir: () => fakeHome };
});

import { getLocale, I18N_TABLES, setLocale, t } from '../src/i18n.js';
import { resolveLanguage, saveDefaultModel, saveLanguage } from '../src/config/config.js';
import { SLASH_COMMANDS } from '../src/tui/commands.js';

afterEach(() => {
  setLocale('zh');
});

describe('t() 查表与插值', () => {
  it('默认 zh：返回中文文案', () => {
    expect(t('approval.option.deny')).toBe('拒绝（n）');
    expect(t('todo.title')).toBe('任务清单');
  });

  it('{name} 占位替换（string 与 number）', () => {
    expect(t('sessionPicker.count', { count: 3 })).toBe('3 条');
    expect(t('question.counter', { index: 1, total: 2 })).toBe('(第 1/2 题) ');
  });

  it('未提供的占位保留原样（开发期易发现）', () => {
    expect(t('sessionPicker.count')).toBe('{count} 条');
  });

  it('缺失 key 回退 zh 表；zh 也没有返回 key 本身', () => {
    setLocale('en');
    expect(t('approval.option.deny')).toBe('Deny (n)');
    expect(t('no.such.key')).toBe('no.such.key');
  });

  it('切换 locale 后 t() 取新语言，切回 zh 还原', () => {
    setLocale('en');
    expect(getLocale()).toBe('en');
    expect(t('time.justNow')).toBe('just now');
    setLocale('zh');
    expect(t('time.justNow')).toBe('刚刚');
  });
});

describe('两表 key 一致性', () => {
  it('zh 的每个 key 在 en 中存在，反之亦然', () => {
    const zhKeys = Object.keys(I18N_TABLES.zh).sort();
    const enKeys = Object.keys(I18N_TABLES.en).sort();
    expect(enKeys).toEqual(zhKeys);
    for (const key of zhKeys) {
      expect(I18N_TABLES.en[key], `en 缺 key: ${key}`).toBeTypeOf('string');
      expect(I18N_TABLES.en[key]!.length, `en 空文案: ${key}`).toBeGreaterThan(0);
    }
  });

  it('两表同一 key 的 {placeholder} 集合一致', () => {
    const placeholders = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
    for (const key of Object.keys(I18N_TABLES.zh)) {
      expect(placeholders(I18N_TABLES.en[key]!), `占位不一致: ${key}`).toEqual(
        placeholders(I18N_TABLES.zh[key]!),
      );
    }
  });
});

describe('/lang 命令元信息', () => {
  it('SLASH_COMMANDS 已注册 lang', () => {
    const cmd = SLASH_COMMANDS.find((c) => c.name === 'lang');
    expect(cmd).toBeDefined();
    expect(cmd!.describe.length).toBeGreaterThan(0);
  });
});

describe('resolveLanguage', () => {
  it('合法值原样返回，缺失/非法落 zh', () => {
    expect(resolveLanguage('en')).toBe('en');
    expect(resolveLanguage('zh')).toBe('zh');
    expect(resolveLanguage(undefined)).toBe('zh');
    expect(resolveLanguage('fr')).toBe('zh');
    expect(resolveLanguage(42)).toBe('zh');
  });
});

describe('saveLanguage', () => {
  let dir: string;
  let tomlPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'stepcode-lang-'));
    fakeHome = dir;
    tomlPath = join(dir, '.step-code', 'config.toml');
    mkdirSync(join(dir, '.step-code'), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('文件不存在时创建最小内容', () => {
    saveLanguage('en');
    expect(readFileSync(tomlPath, 'utf8')).toBe('language = "en"\n');
  });

  it('已有 language 行：只改这一行，其余原样保留', () => {
    writeFileSync(tomlPath, '# 我的配置\nlanguage = "zh"\napi_key = "sk-x"\n');
    saveLanguage('en');
    expect(readFileSync(tomlPath, 'utf8')).toBe('# 我的配置\nlanguage = "en"\napi_key = "sk-x"\n');
  });

  it('无 language 行：追加到文件末尾，其余不动', () => {
    writeFileSync(tomlPath, 'api_key = "sk-x"\nmodel = "m"\n');
    saveLanguage('en');
    expect(readFileSync(tomlPath, 'utf8')).toBe('api_key = "sk-x"\nmodel = "m"\nlanguage = "en"\n');
  });

  it('有 [section] 时 language 插到第一个 section 之前（不落进段内）', () => {
    writeFileSync(tomlPath, 'api_key = "sk-x"\n\n[subagent]\nmax_depth = 2\n');
    saveLanguage('en');
    expect(readFileSync(tomlPath, 'utf8')).toBe('api_key = "sk-x"\n\nlanguage = "en"\n[subagent]\nmax_depth = 2\n');
  });

  it('CRLF 换行风格保留', () => {
    writeFileSync(tomlPath, 'language = "zh"\r\napi_key = "sk-x"\r\n');
    saveLanguage('en');
    expect(readFileSync(tomlPath, 'utf8')).toBe('language = "en"\r\napi_key = "sk-x"\r\n');
  });

  it('section 内的 language 字段不被误改', () => {
    writeFileSync(tomlPath, '[other]\nlanguage = "zh"\n');
    saveLanguage('en');
    const text = readFileSync(tomlPath, 'utf8');
    // 顶层新增一行 en；[other] 段内的原样保留
    expect(text).toBe('language = "en"\n[other]\nlanguage = "zh"\n');
  });

  it('写回后能被 smol-toml 正常解析', async () => {
    writeFileSync(tomlPath, 'api_key = "sk-x"\n\n[subagent]\nmax_depth = 2\n');
    saveLanguage('en');
    expect(existsSync(tomlPath)).toBe(true);
    const { parse } = await import('smol-toml');
    const parsed = parse(readFileSync(tomlPath, 'utf8')) as Record<string, unknown>;
    expect(parsed['language']).toBe('en');
    expect((parsed['subagent'] as Record<string, unknown>)['max_depth']).toBe(2);
  });
});

describe('saveDefaultModel（/model 切换写回默认模型指针）', () => {
  let dir: string;
  let tomlPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'stepcode-model-'));
    fakeHome = dir;
    tomlPath = join(dir, '.step-code', 'config.toml');
    mkdirSync(join(dir, '.step-code'), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('改写顶层 model 行，其余内容（含 [models.*] 别名表）逐字保留', () => {
    writeFileSync(
      tomlPath,
      '# 我的配置\nmodel = "flash"\napi_key = "sk-x"\n\n[models.explore]\nmodel = "step-3.7-flash"\nmax_context_size = 1000000\n',
    );
    saveDefaultModel('explore');
    expect(readFileSync(tomlPath, 'utf8')).toBe(
      '# 我的配置\nmodel = "explore"\napi_key = "sk-x"\n\n[models.explore]\nmodel = "step-3.7-flash"\nmax_context_size = 1000000\n',
    );
  });

  it('[models.*] 段内的 model 字段不被误改（顶层与段内同名）', () => {
    writeFileSync(tomlPath, '[models.explore]\nmodel = "step-3.7-flash"\n');
    saveDefaultModel('explore');
    const text = readFileSync(tomlPath, 'utf8');
    // 顶层新增指针；段内的 model = "step-3.7-flash" 原样保留
    expect(text).toBe('model = "explore"\n[models.explore]\nmodel = "step-3.7-flash"\n');
  });

  it('幂等：传入的 current 与新值相同则完全不写文件', () => {
    const before = 'model = "flash"\napi_key = "sk-x"\n';
    writeFileSync(tomlPath, before);
    const mtimeBefore = statSync(tomlPath).mtimeMs;
    saveDefaultModel('flash', 'flash');
    expect(readFileSync(tomlPath, 'utf8')).toBe(before);
    expect(statSync(tomlPath).mtimeMs).toBe(mtimeBefore);
  });

  it('current 不同则写入', () => {
    writeFileSync(tomlPath, 'model = "flash"\n');
    saveDefaultModel('explore', 'flash');
    expect(readFileSync(tomlPath, 'utf8')).toBe('model = "explore"\n');
  });

  it('注释掉的 model 行不被当成已有指针：新插一行，旧注释保留', () => {
    writeFileSync(tomlPath, '# model = "flash"\napi_key = "sk-x"\n');
    saveDefaultModel('explore');
    expect(readFileSync(tomlPath, 'utf8')).toBe('# model = "flash"\napi_key = "sk-x"\nmodel = "explore"\n');
  });

  it('写回后能被 smol-toml 解析，且别名表仍可解出', async () => {
    writeFileSync(tomlPath, 'api_key = "sk-x"\n\n[models.explore]\nmodel = "step-3.7-flash"\n');
    saveDefaultModel('explore');
    const { parse } = await import('smol-toml');
    const parsed = parse(readFileSync(tomlPath, 'utf8')) as Record<string, unknown>;
    expect(parsed['model']).toBe('explore');
    expect((parsed['models'] as Record<string, Record<string, unknown>>)['explore']!['model']).toBe('step-3.7-flash');
  });
});

describe('批次二关键 key：zh 插值与 en 对照', () => {
  it('status.hints 组合插值（imageCount/planMode）', () => {
    expect(
      t('status.hints', { imageCount: '', planMode: '' }),
    ).toBe('Ctrl+C 清空输入框 · Alt+V 贴图 · /plan 计划模式 · Esc 中断 · /help 命令');
    setLocale('en');
    expect(
      t('status.hints', {
        imageCount: t('status.imageCount', { count: 2 }),
        planMode: t('status.planOn'),
      }),
    ).toBe('Ctrl+C clear input · Alt+V paste image (2) · /plan plan mode (on) · Esc abort · /help commands');
  });

  it('turn.retry 多占位插值', () => {
    expect(t('turn.retry', { delay: 500, attempt: 1, max: 4 })).toBe('请求失败，500ms 后重试（第 1/4 次）');
    setLocale('en');
    expect(t('turn.retry', { delay: 500, attempt: 1, max: 4 })).toBe('Request failed, retrying in 500ms (attempt 1/4)');
  });

  it('app.provider.switched 嵌套文案（modelNote 先查表再插值）', () => {
    const note = t('app.provider.switched', { provider: 'anthropic', modelNote: t('app.provider.noPresetModel') });
    expect(note).toBe('服务商已切换为：anthropic，该服务商无预设模型，请用 /model <名称> 指定（下一轮请求生效）');
  });

  it('goal.complete 可选段插值（reason 为空串时无残留）', () => {
    expect(t('goal.complete', { reason: '', turns: 7, elapsed: '4m' })).toBe('✓ 目标完成。共 7 轮，用时 4m。');
    setLocale('en');
    expect(t('goal.complete', { reason: ' — done', turns: 7, elapsed: '4m' })).toBe('✓ Goal complete — done. 7 turns over 4m.');
  });

  it('cmd.helpText.line 拼接 /help 行', () => {
    expect(t('cmd.helpText.line', { name: 'help', alias: t('cmd.helpText.aliasSuffix', { aliases: '?' }), describe: t('cmd.help') })).toBe(
      '/help（/?） — 显示可用命令',
    );
    setLocale('en');
    expect(t('cmd.helpText.line', { name: 'exit', alias: '', describe: t('cmd.exit') })).toBe('/exit — Quit Step Code');
  });

  it('loop.maxIterations / factory.unknownProvider 插值', () => {
    expect(t('loop.maxIterations', { max: 500 })).toBe('已达最大往返轮数（500），中止本次交互。');
    setLocale('en');
    expect(t('factory.unknownProvider', { provider: 'openai', list: 'stepfun | anthropic' })).toBe(
      "Unknown provider provider='openai'. Supported: stepfun | anthropic.",
    );
  });

  it('/loop 帮助文案只描述列出任务，不含创建语义', () => {
    expect(t('cmd.loop')).not.toContain('创建');
    setLocale('en');
    expect(t('cmd.loop')).not.toContain('create');
  });
});
