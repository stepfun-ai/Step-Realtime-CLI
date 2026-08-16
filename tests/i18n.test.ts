import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
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

describe('i18n 表结构守卫（源码级）', () => {
  const i18nSrc = readFileSync(join(__dirname, '..', 'src', 'i18n.ts'), 'utf8');
  /**
   * key 定义行的匹配式。两处覆盖范围都是踩出来的，改动前先看这段：
   *
   * 1. **引号必须同时认单双引号**。2026-08-16 做 i18n 全量扫描时只写了单引号，于是 en 表里
   *    唯一一条用双引号定义的 key（app.think.budgetWarning）被判成「zh 有 en 无」的缺翻译。
   *    实际翻译一直都在，是检索式覆盖不全。
   * 2. **字符类必须含连字符**。紧接着又用 `[\w.]` 漏掉了 `cmd.export-debug-zip`，表现为
   *    「运行时表比源码多一条」。
   *
   * 两次都是同一种错：拿不完备的检索式得出空结果或差值，然后去解释那个差值，而不是先怀疑
   * 检索式。下面那两条 `size > 300` 的断言就是为这个装的——检索式失效时先炸在那里。
   */
  const KEY_LINE = /^\s*['"]([a-zA-Z][\w.-]*)['"]\s*:/gm;

  function keysIn(segment: string): Set<string> {
    return new Set([...segment.matchAll(KEY_LINE)].map((m) => m[1]!));
  }

  it('zh 与 en 的 key 集完全一致（任一侧缺失都会让另一语言露出对面文案）', () => {
    const zhStart = i18nSrc.indexOf('const zh');
    const enStart = i18nSrc.indexOf('const en');
    expect(zhStart, '找不到 zh 表').toBeGreaterThan(-1);
    expect(enStart, '找不到 en 表').toBeGreaterThan(zhStart);
    const zh = keysIn(i18nSrc.slice(zhStart, enStart));
    const en = keysIn(i18nSrc.slice(enStart));
    // 先确认检索式真的抓到了东西——空集比对会恒真
    expect(zh.size, '没抓到 zh key，检索式失效').toBeGreaterThan(300);
    expect(en.size, '没抓到 en key，检索式失效').toBeGreaterThan(300);
    expect([...zh].filter((k) => !en.has(k)).sort(), 'zh 有 en 无').toEqual([]);
    expect([...en].filter((k) => !zh.has(k)).sort(), 'en 有 zh 无').toEqual([]);
    // 运行时表也应与源码一致（防止有人在表外动态塞 key）
    expect(new Set(Object.keys(I18N_TABLES.zh))).toEqual(zh);
    expect(new Set(Object.keys(I18N_TABLES.en))).toEqual(en);
  });

  it('key 定义统一用单引号（混用会让按引号写的检索式漏检）', () => {
    const doubleQuoted = [...i18nSrc.matchAll(/^\s*"([a-zA-Z][\w.-]*)"\s*:/gm)].map((m) => m[1]!);
    expect(doubleQuoted, '这些 key 用了双引号，请改单引号').toEqual([]);
  });

  /**
   * 反向守卫：源码里 t() 调用的 key 必须在表里。
   *
   * t() 找不到 key 时的兜底是 `?? key`（返回 key 本身），所以拼错或漏加不会报错、不会抛异常，
   * 而是把开发者字符串直接画到用户界面上。2026-08-16 实测就撞到了：首次运行向导第一屏的
   * hint 行显示的是字面的 `firstRun.selectHint`，三处（selectHint / keyHint / modelCustomHint）
   * 全是重写 pi 版 FirstRun 时写了表里不存在的名字，而表里一直有等价文案（hint / pasteHint /
   * customModelHint）。
   *
   * 这类缺陷靠肉眼撞见的成本太高——它只在走到那个分支时才可见，而首次运行向导恰好是最少被
   * 走到的路径之一。所以固化成断言。
   */
  it('源码里 t() 调用的 key 全部在表里（拼错会把 key 名画到界面上）', () => {
    const srcDir = join(__dirname, '..', 'src');
    /** t( 左边界：不加会把 get( / toString( / import( 的尾字母 t 也匹配上。 */
    const T_CALL = /(?<![a-zA-Z0-9_$.])t\(\s*'([a-zA-Z][\w.-]*)'/g;
    /** t(`prefix.${x}`) 这类动态 key 无法静态确定，按前缀整段跳过。 */
    const DYN_PREFIX = /(?<![a-zA-Z0-9_$.])t\(\s*(?:`([a-zA-Z][\w.-]*\.)\$\{|'([a-zA-Z][\w.-]*\.)'\s*\+)/g;

    function walk(dir: string): string[] {
      return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
        const p = join(dir, e.name);
        if (e.isDirectory()) return walk(p);
        return e.isFile() && e.name.endsWith('.ts') && p !== join(srcDir, 'i18n.ts') ? [p] : [];
      });
    }

    const defined = new Set(Object.keys(I18N_TABLES.zh));
    const dynPrefixes = new Set<string>();
    const calls: { key: string; file: string }[] = [];
    for (const file of walk(srcDir)) {
      const src = readFileSync(file, 'utf8');
      for (const m of src.matchAll(DYN_PREFIX)) dynPrefixes.add((m[1] ?? m[2])!);
      for (const m of src.matchAll(T_CALL)) calls.push({ key: m[1]!, file: file.slice(srcDir.length + 1) });
    }

    // 检索式自验：抓不到已知存在的调用就说明匹配式坏了，此时「无缺失」是假绿
    expect(calls.length, 't() 调用一处都没抓到，检索式失效').toBeGreaterThan(200);
    expect(calls.some((x) => x.key === 'firstRun.hint'), '抓不到已知的 t() 调用，检索式失效').toBe(true);

    const missing = calls
      .filter((x) => !defined.has(x.key) && ![...dynPrefixes].some((p) => x.key.startsWith(p)))
      .map((x) => `${x.key} @ ${x.file}`)
      .sort();
    expect([...new Set(missing)], '这些 key 被 t() 调用但表里没有，界面会显示 key 名').toEqual([]);

    // 动态前缀的成员也要在表里（这批逃过了上面的静态检查）
    for (const prefix of dynPrefixes) {
      const members = [...defined].filter((k) => k.startsWith(prefix));
      expect(members.length, `动态前缀 ${prefix} 在表里没有任何成员`).toBeGreaterThan(0);
    }
  });
});

describe('t() 查表与插值', () => {
  it('默认 zh：返回中文文案', () => {
    // 值不含热键标注：ChoiceBlock 只用 hotkeys 做键盘匹配、不渲染它，热键在底部 hint 里
    // 统一说明。2026-08-16 按 pi 版组件的实际渲染校准了这批 label。
    expect(t('approval.option.deny')).toBe('拒绝');
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
    expect(t('approval.option.deny')).toBe('Deny');
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

/**
 * en locale 下的中文残留守卫。
 *
 * 2026-08-16 扫描发现：tui-pi 的六个 UI 组件（prompts / pickers / TasksOverlay /
 * ExpandOverlay / ProviderManager / commandText）完全不走 i18n，文案是硬编码中文，
 * 于是英文用户看到的界面基本还是中文——i18n 表里 397 个 key 没有任何调用点。
 *
 * 这组测试直接渲染组件、断言 en 下无 CJK 字符，比「grep 源码有没有中文字面量」更准：
 * 后者拦不住「字面量在 i18n 表里但 en 值忘了译」，前者能。
 * 每接线一个组件就把它加进来，逐个收口。
 */
describe('en locale 下界面无中文残留（逐组件收口）', () => {
  const CJK = /[\u4e00-\u9fa5]/;
  /** 剥 ANSI 后找 CJK：颜色码里不会有中文，但去掉后断言失败信息更可读。 */
  const cjkIn = (lines: readonly string[]): string[] =>
    lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, '')).filter((l) => CJK.test(l));

  it('审批弹层（prompts.ts）：标题 / 选项 / 危险警告 / 提示行全部可翻译', async () => {
    const { InlineApproval, PlanApproval, dangerWarnings } = await import('../src/tui-pi/prompts.js');
    setLocale('en');
    // 危险命令警告是安全信息，英文用户看不懂中文警告等于警告失效
    expect(cjkIn(dangerWarnings('rm -rf /tmp/x'))).toEqual([]);
    expect(cjkIn(dangerWarnings('sudo rm -rf /'))).toEqual([]);

    const ap = new InlineApproval('bash', { command: 'ls -la' }, () => {}, () => {});
    expect(cjkIn(ap.render(80)), '审批弹层渲染出中文').toEqual([]);

    // 未知工具走 approval.title 的插值分支
    const ap2 = new InlineApproval('some_tool', { x: 1 }, () => {}, () => {});
    expect(cjkIn(ap2.render(80))).toEqual([]);

    // 长预览触发 Ctrl+E 折叠提示与展开/收起切换
    const long = Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n');
    const ap3 = new InlineApproval('write_file', { path: 'a.txt', content: long }, () => {}, () => {});
    expect(cjkIn(ap3.render(80)), '折叠提示行出现中文').toEqual([]);

    const plan = new PlanApproval('# Plan\n\n- step one', () => {}, () => {});
    expect(cjkIn(plan.render(80)), '计划确认框出现中文').toEqual([]);
  });

  it('选择器（pickers.ts）：默认 hint / 过滤前缀 / 恢复会话 / 思考深度选项', async () => {
    const { PickerOverlay, thinkItems, modelTabs } = await import('../src/tui-pi/pickers.js');
    setLocale('en');
    const overlay = new PickerOverlay({
      title: 'Title',
      items: [],
      requestRender: () => {},
      onSelect: () => {},
      onCancel: () => {},
    });
    expect(cjkIn(overlay.render(80)), 'PickerOverlay 默认渲染出中文').toEqual([]);

    // 过滤态
    const filtered = new PickerOverlay({
      title: 'Title',
      items: [],
      requestRender: () => {},
      onSelect: () => {},
      onCancel: () => {},
    });
    (filtered as unknown as { filter: string }).filter = 'abc';
    expect(cjkIn(filtered.render(80)), 'PickerOverlay 过滤前缀出中文').toEqual([]);

    // 思考深度选项
    const items = thinkItems();
    expect(cjkIn(items.map((i) => i.description).filter(Boolean) as string[]), 'thinkItems 描述出中文').toEqual([]);

    // modelTabs 的「全部」标签
    const tabs = modelTabs({ models: {}, provider: 'default' } as any);
    expect(tabs[0]?.label).not.toMatch(/[\u4e00-\u9fa5]/);
  });

  it('后台任务弹层（TasksOverlay.ts）：空列表 / 有任务 / 停止确认', async () => {
    const { TasksOverlay } = await import('../src/tui-pi/TasksOverlay.js');
    setLocale('en');
    const mk = (tasks: any[]) => {
      const now = () => Date.now();
      return new TasksOverlay({
        getTasks: () => tasks,
        stopTask: () => true,
        openOutput: () => {},
        requestRender: () => {},
        onClose: () => {},
        now,
      });
    };

    // 空列表（全部 / 过滤后）
    const empty = mk([]);
    expect(cjkIn(empty.render(80)), 'TasksOverlay 空列表出中文').toEqual([]);
    empty.handleInput('tab');
    expect(cjkIn(empty.render(80)), 'TasksOverlay 过滤空列表出中文').toEqual([]);

    // 有任务
    const withTasks = mk([
      { id: 't1', status: 'running', command: 'sleep 1', startedAt: new Date().toISOString(), output: 'hello' },
    ]);
    expect(cjkIn(withTasks.render(80)), 'TasksOverlay 有任务出中文').toEqual([]);

    // 停止确认态
    const stop = mk([
      { id: 't2', status: 'running', command: 'sleep 2', startedAt: new Date().toISOString(), output: '' },
    ]);
    stop.handleInput('s');
    expect(cjkIn(stop.render(80)), 'TasksOverlay 停止确认出中文').toEqual([]);
  });
it('常驻面板（ChromePanels.ts）：TODO 三态计数 / 折叠提示 / 队列预览与取回提示', async () => {
    const { renderTodos, renderQueue } = await import('../src/tui-pi/ChromePanels.js');
    setLocale('en');
    // 覆盖三种状态同时存在 + 超出显示上限触发折叠提示
    const todos = [
      { title: 'a', status: 'in_progress' as const },
      { title: 'b', status: 'pending' as const },
      { title: 'c', status: 'done' as const },
      { title: 'd', status: 'pending' as const },
      { title: 'e', status: 'pending' as const },
      { title: 'f', status: 'pending' as const },
      { title: 'g', status: 'pending' as const },
    ];
    expect(cjkIn(renderTodos(todos, 80)), 'TODO 面板出现中文').toEqual([]);
    // 队列超过 QUEUE_MAX_ITEMS 才会出现「还有 N 条」，所以给足条数
    expect(cjkIn(renderQueue(['q1', 'q2', 'q3', 'q4', 'q5'], 80)), '队列预览出现中文').toEqual([]);
  });

  it('选项块与查看器（ChoiceBlock.ts / ExpandOverlay.ts）：提示行与反馈占位符', async () => {
    const { ChoiceBlock } = await import('../src/tui-pi/ChoiceBlock.js');
    const { ExpandOverlay } = await import('../src/tui-pi/ExpandOverlay.js');
    setLocale('en');
    class Probe extends ChoiceBlock<string> {
      protected onChoose(): void {}
      protected onCancel(): void {}
      protected renderBody(): string[] {
        return ['body'];
      }
      /** 进入反馈模式，覆盖占位符那一行。 */
      enterFeedback(): void {
        this.handleInput('f');
      }
    }
    const cb = new Probe([{ label: 'ok', hotkeys: ['y'], value: 'ok' }, { label: 'no', hotkeys: ['f'], value: 'no', requiresFeedback: true }], () => {});
    expect(cjkIn(cb.render(80)), '选项块提示行出现中文').toEqual([]);
    cb.enterFeedback();
    expect(cjkIn(cb.render(80)), '反馈输入占位符出现中文').toEqual([]);

    const ov = new ExpandOverlay({
      groups: [{ userText: 'hi', entries: [{ index: 0, item: { kind: 'thinking', text: ['a', 'b', 'c', 'd'].join('\n') } }] }],
      width: 80,
      viewportRows: 20,
      entryRenderer: () => ['x'],
      requestRender: () => {},
      onClose: () => {},
    });
    expect(cjkIn(ov.render(80)), '查看器标题或底部键位出现中文').toEqual([]);
  });

  it('commandText.ts：/tasks /memory /goal /team /loop 纯文本生成', async () => {
    const { formatTaskList, formatMemoryList, notWiredText, formatGoalPanel, formatTeamStatus, formatCronJobs } = await import('../src/tui-pi/commandText.js');
    setLocale('en');
    const now = Date.now();
    // /tasks 空态 / 有内容
    expect(cjkIn([formatTaskList([], now)])).toEqual([]);
    expect(cjkIn([formatTaskList([{ status: 'running', id: 't1', kind: 'process', command: 'sleep 1', startedAt: new Date().toISOString(), endedAt: undefined, exitCode: undefined }], now)])).toEqual([]);

    // /memory 关闭 / 开启空 / 开启有条目 / 有 broken
    expect(cjkIn([formatMemoryList('/x', false, now)])).toEqual([]);
    expect(cjkIn([formatMemoryList('/x', true, now)])).toEqual([]);
    // 构造一个有 broken 的 scan 结果比较麻烦，这里只保证 memory.disabled 与空列表无 CJK
    // notWired
    expect(cjkIn([notWiredText('somecmd')])).toEqual([]);

    // /goal 面板
    const goal = { objective: 'test', completionCriterion: 'done', turnsUsed: 1, turnBudget: 10, tokensUsed: 100, tokenBudget: 1000, status: 'active', createdAt: now, terminalReason: undefined as string | undefined };
    expect(cjkIn([formatGoalPanel(goal, now)])).toEqual([]);

    // /team status 空 / 有任务
    expect(cjkIn([formatTeamStatus('main', '.step-code/team', [])])).toEqual([]);
    expect(cjkIn([formatTeamStatus('main', '.step-code/team', [{ id: 'm1', status: 'doing', title: 't', kind: 'code', scope: ['a', 'b'], deps: ['m0'] }])])).toEqual([]);

    // /loop 空 / 有任务
    expect(cjkIn([formatCronJobs([])])).toEqual([]);
    expect(cjkIn([formatCronJobs([{ id: 'j1', cron: '*/5 * * * *', prompt: 'ping', recurring: true, nextFireAt: new Date(now + 100000) }])])).toEqual([]);

    // 上面的渲染断言走不到的分支（memory broken、goal 终态 reason、任务异常态等）用表级
    // 断言兜底：commandText.ts 引用的 key 组在 en 表里逐条查中文。渲染断言只能覆盖被构造
    // 出来的那几条路径，漏掉的分支不会报错——这一条补的就是那部分。
    const { I18N_TABLES } = await import('../src/i18n.js');
    const en = I18N_TABLES.en;
    const prefixes = ['commandText.', 'goalPanel.', 'cronCard.', 'app.memory.', 'app.team.'];
    const keys = Object.keys(en).filter((k) => prefixes.some((p) => k.startsWith(p)));
    expect(keys.length, '应能取到 commandText 引用的 key 组').toBeGreaterThan(30);
    expect(cjkIn(keys.map((k) => en[k] ?? '')), 'en 表里 commandText 相关 key 仍有中文').toEqual([]);
  });

  it('ProviderManager.ts：providerItems 各分支 + wizard 文案在 en 下无 CJK', async () => {
    const { providerItems } = await import('../src/tui-pi/ProviderManager.js');
    const { I18N_TABLES } = await import('../src/i18n.js');
    setLocale('en');
    // 三个分支要一起覆盖：baseUrl 有值 / baseUrl 缺失（走 defaultAddress 兜底）/ 预设渠道。
    // 只给一个 baseUrl 有值的渠道时，defaultAddress 那条根本不执行——实测把它改回硬编码
    // 中文，测试依然全绿。覆盖不足的守卫和恒真守卫一样没有防护力。
    const config = {
      provider: 'mine',
      providers: {
        mine: { type: 'openai', baseUrl: 'https://api.example.com/v1' },
        noUrl: { type: 'anthropic' },
      },
      models: { a1: { model: 'm1', provider: 'mine' } },
    } as any;
    const items = providerItems(config);
    const texts = items.flatMap((i) => [i.label, i.description]);
    expect(cjkIn(texts), 'ProviderManager 列表项出现中文').toEqual([]);
    // 确实走到了 baseUrl 缺失分支（否则上面的断言测不到 defaultAddress）
    expect(items.some((i) => i.value === 'custom:noUrl' || i.value.includes('noUrl'))).toBe(true);
    // 预设渠道分支
    expect(items.some((i) => i.value.startsWith('preset:'))).toBe(true);
    // 新增入口分支
    expect(items.some((i) => i.value === '__add__')).toBe(true);

    // 向导与删除确认的文案只在交互流里出现（askLine / overlay 回调），渲染测不到。
    // 直接查 en 表：这些 key 若忘了译，渲染断言永远发现不了。
    const en = I18N_TABLES.en;
    const interactive = Object.keys(en).filter(
      (k) => k.startsWith('providerWizard.') || k.startsWith('providerManager.'),
    );
    expect(interactive.length, '应能取到这两组 key').toBeGreaterThan(20);
    expect(cjkIn(interactive.map((k) => en[k] ?? '')), 'en 表里仍有中文未译').toEqual([]);
  });
});
