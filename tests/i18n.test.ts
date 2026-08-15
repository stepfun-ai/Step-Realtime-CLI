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
import { resolveLanguage, saveDefaultModel, saveDefaultProvider, saveDefaultThinkingLevel, saveLanguage } from '../src/config/config.js';
import { SLASH_COMMANDS } from '../src/chat/commands.js';

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

describe('文案不得复活已被实测推翻的结论', () => {
  /**
   * 这组断言防的是一类反复发生的问题：某个结论被实测推翻、代码也改了，
   * 但当初照着旧结论写的用户文案漏改，于是界面继续传播错误信息。
   *
   * 已发生两次：
   * 1. 「空响应通常是网关瞬时故障，请重新发送」——归因无依据，实际最常见成因是
   *    思考吃满输出预算，重发必然复现。这句话让排查方向偏了整整一个阶段。
   * 2. 「降低思考档位无效，各档思考量相近」——该结论测于一个 bug 之上（档位参数
   *    发错字段位置、服务端静默忽略，所以各档当然一样）。参数修正后降档是首选手段，
   *    实测可压掉约 85% 思考量。但这条错误说法在 4 条 i18n 文案里存活到了 2026-08-03，
   *    期间会主动劝用户放弃唯一有效的手段。
   *
   * 新增此类护栏的判断标准：某个说法被实测推翻，且它出现在**面向用户的文案**里。
   * 只在代码注释里讲历史不算（注释就该记录被推翻的过程）。
   */
  const FORBIDDEN: Array<{ pattern: RegExp; why: string }> = [
    {
      pattern: /降低思考档位无效|降档无效|各档.{0,6}思考.{0,6}(相近|没有差别|无差别)/,
      why: '「降档无效」测于档位参数发错位置的 bug 之上，已被推翻；降档现在是首选手段（压掉约 85% 思考量）',
    },
    {
      pattern: /lowering the thinking level does not help|nearly identical across levels/i,
      why: 'same as above: the "lowering the level does not help" claim was measured on top of a bug',
    },
    {
      pattern: /通常是网关或服务端的瞬时故障/,
      why: '空响应归因无证据支撑，实测最常见成因是思考吃满输出预算，重发必然复现',
    },
    {
      pattern: /usually a transient (gateway|server)/i,
      why: 'same as above: the transient-failure attribution for empty responses is unsupported',
    },
  ];

  for (const locale of ['zh', 'en'] as const) {
    it(`${locale} 表不含已推翻的结论`, () => {
      for (const [key, text] of Object.entries(I18N_TABLES[locale])) {
        for (const { pattern, why } of FORBIDDEN) {
          expect(pattern.test(text!), `${locale}.${key} 复活了已推翻的结论：${why}\n  文案：${text}`).toBe(
            false,
          );
        }
      }
    });
  }

  it('思考耗尽预算的提示必须给出降档这个手段', () => {
    // 正面断言：不只是「别说错的」，还要「必须说对的」。
    // 这条提示是用户遇到空响应时唯一的行动指引，漏掉降档等于只给了一半的解法。
    for (const key of ['loop.maxTokens.thinkingExhausted', 'loop.maxTokens.thinkingExhaustedWithLimit']) {
      expect(I18N_TABLES.zh[key], `zh.${key} 应提到 /think 降档`).toMatch(/\/think/);
      expect(I18N_TABLES.en[key], `en.${key} 应提到 /think 降档`).toMatch(/\/think/);
      // 同时保留调大 max_tokens 这条（两个手段都有效，不该只给一个）
      expect(I18N_TABLES.zh[key], `zh.${key} 应提到 max_tokens`).toMatch(/max_tokens/);
      expect(I18N_TABLES.en[key], `en.${key} 应提到 max_tokens`).toMatch(/max_tokens/);
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

describe('saveDefaultThinkingLevel（/think 切换写回 [thinking] default_level）', () => {
  let dir: string;
  let tomlPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'stepcode-think-'));
    fakeHome = dir;
    tomlPath = join(dir, '.step-code', 'config.toml');
    mkdirSync(join(dir, '.step-code'), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('新建 [thinking] 段并写入 default_level', () => {
    writeFileSync(tomlPath, 'model = "flash"\n');
    saveDefaultThinkingLevel('high');
    // section 追加在末尾，字段带 2 空格缩进
    expect(readFileSync(tomlPath, 'utf8')).toBe('model = "flash"\n\n[thinking]\n  default_level = "high"\n');
  });

  it('已有 [thinking] 段时只改 default_level 行，其余字段保留', () => {
    writeFileSync(tomlPath, '[thinking]\nenabled = true\ndefault_level = "low"\n');
    saveDefaultThinkingLevel('high');
    // section 内字段统一加 2 空格缩进（saveSectionKey 规范）
    expect(readFileSync(tomlPath, 'utf8')).toBe('[thinking]\nenabled = true\n  default_level = "high"\n');
  });

  it('幂等：当前值相同则不写文件', () => {
    writeFileSync(tomlPath, '[thinking]\ndefault_level = "medium"\n');
    const before = readFileSync(tomlPath, 'utf8');
    saveDefaultThinkingLevel('medium');
    expect(readFileSync(tomlPath, 'utf8')).toBe(before);
  });

  it("'off' 被静默忽略，不写文件", () => {
    writeFileSync(tomlPath, '[thinking]\ndefault_level = "medium"\n');
    const before = readFileSync(tomlPath, 'utf8');
    saveDefaultThinkingLevel('off');
    expect(readFileSync(tomlPath, 'utf8')).toBe(before);
  });

  it('文件不存在时创建最小内容并写入', () => {
    saveDefaultThinkingLevel('low');
    const text = readFileSync(tomlPath, 'utf8');
    // saveSectionKey 新建 section 时尾部追加：前面有一个空行分隔，section 内字段带 2 空格缩进
    expect(text).toBe('\n[thinking]\n  default_level = "low"\n');
  });
});

describe('saveDefaultProvider（/provider 切换写回顶层 provider）', () => {
  let dir: string;
  let tomlPath: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'stepcode-provider-'));
    fakeHome = dir;
    tomlPath = join(dir, '.step-code', 'config.toml');
    mkdirSync(join(dir, '.step-code'), { recursive: true });
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('改写顶层 provider 行，其余内容逐字保留', () => {
    writeFileSync(tomlPath, 'provider = "stepfun"\nmodel = "step-3.7-flash"\n');
    saveDefaultProvider('anthropic');
    expect(readFileSync(tomlPath, 'utf8')).toBe('provider = "anthropic"\nmodel = "step-3.7-flash"\n');
  });

  it('[providers.*] 段内的 provider 字段不被误改', () => {
    writeFileSync(tomlPath, '[providers.foo]\ntype = "openai"\nprovider = "bar"\n');
    saveDefaultProvider('anthropic');
    const text = readFileSync(tomlPath, 'utf8');
    expect(text).toBe('provider = "anthropic"\n[providers.foo]\ntype = "openai"\nprovider = "bar"\n');
  });

  it('幂等：传入 current 与新值相同则不写文件', () => {
    writeFileSync(tomlPath, 'provider = "stepfun"\n');
    const before = readFileSync(tomlPath, 'utf8');
    saveDefaultProvider('stepfun', 'stepfun');
    expect(readFileSync(tomlPath, 'utf8')).toBe(before);
  });

  it('current 不同则写入', () => {
    writeFileSync(tomlPath, 'provider = "stepfun"\n');
    saveDefaultProvider('anthropic', 'stepfun');
    expect(readFileSync(tomlPath, 'utf8')).toBe('provider = "anthropic"\n');
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
