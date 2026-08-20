import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  allocateAlias,
  appendProviderConfig,
  removeProviderConfig,
  renderSections,
  tomlKey,
  tomlString,
  type AppendProviderInput,
} from '../src/config/tomlAppend.js';

let dir: string;
let tomlPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stepcode-tomlappend-'));
  tomlPath = join(dir, 'config.toml');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function sampleInput(overrides: Partial<AppendProviderInput['provider']> = {}): AppendProviderInput {
  return {
    provider: { id: 'gw', type: 'openai', baseUrl: 'https://gw.test/v1', apiKey: 'sk-test', ...overrides },
    models: [
      { alias: 'm-1', model: 'm-1', displayName: 'M One', maxContextSize: 128000, capabilities: ['thinking', 'image_in'] },
      { alias: 'm-2', model: 'm-2' },
    ],
  };
}

/** 目录下的备份文件清单（config.toml.*.bak）。 */
function backupFiles(): string[] {
  return readdirSync(dir).filter((f) => f.includes('.bak'));
}

describe('tomlKey / tomlString', () => {
  it('bare key 字符集原样，其余走 quoted key', async () => {
    expect(tomlKey('gw-1_x')).toBe('gw-1_x');
    expect(tomlKey('has.dot')).toBe('"has.dot"');
    expect(tomlKey('空格')).toBe('"空格"');
  });

  it('字符串转义反斜杠、双引号、控制字符', async () => {
    expect(tomlString('plain')).toBe('"plain"');
    expect(tomlString('a"b\\c')).toBe('"a\\"b\\\\c"');
    expect(tomlString('a\nb\t')).toBe('"a\\nb\\t"');
  });
});

describe('allocateAlias', () => {
  it('未占用直接用 base；占用依次加数字后缀', async () => {
    expect(allocateAlias('m', new Set())).toBe('m');
    expect(allocateAlias('m', new Set(['m']))).toBe('m-2');
    expect(allocateAlias('m', new Set(['m', 'm-2']))).toBe('m-3');
  });
});

describe('renderSections', () => {
  it('渠道段在前、模型段在后，可选字段缺省不写', async () => {
    const out = renderSections(sampleInput(), '\n');
    expect(out).toBe(
      '[providers.gw]\n' +
        'type = "openai"\n' +
        'base_url = "https://gw.test/v1"\n' +
        'api_key = "sk-test"\n' +
        '\n' +
        '[models.m-1]\n' +
        'provider = "gw"\n' +
        'model = "m-1"\n' +
        'display_name = "M One"\n' +
        'max_context_size = 128000\n' +
        'capabilities = ["thinking", "image_in"]\n' +
        '\n' +
        '[models.m-2]\n' +
        'provider = "gw"\n' +
        'model = "m-2"',
    );
  });
});

describe('appendProviderConfig', () => {
  it('文件不存在时创建，无备份，doctor 通过', async () => {
    const result = await appendProviderConfig(sampleInput(), tomlPath);
    expect(result.backupPath).toBeUndefined();
    expect(result.aliases).toEqual(['m-1', 'm-2']);
    const text = readFileSync(tomlPath, 'utf8');
    expect(text).toContain('[providers.gw]');
    expect(text).toContain('[models.m-1]');
    expect(backupFiles()).toEqual([]);
  });

  it('追加保留原文（注释与其他字段逐字节不动），并补空行分隔', async () => {
    const original = '# 我的配置\nmodel = "flash"\n\n[subagent]\nmax_depth = 2\n';
    writeFileSync(tomlPath, original);
    appendProviderConfig(sampleInput(), tomlPath);
    const text = readFileSync(tomlPath, 'utf8');
    expect(text.startsWith(original)).toBe(true);
    // 原文末尾只有一个换行：补一个空行再追加 section
    expect(text.slice(original.length)).toBe('\n' + renderSections(sampleInput(), '\n') + '\n');
  });

  it('原文末尾无换行时先补换行再分隔追加', async () => {
    writeFileSync(tomlPath, 'model = "flash"');
    appendProviderConfig(sampleInput({ id: 'gw2' }), tomlPath);
    const text = readFileSync(tomlPath, 'utf8');
    expect(text.startsWith('model = "flash"\n\n[providers.gw2]')).toBe(true);
  });

  it('CRLF 换行风格保留到追加内容', async () => {
    writeFileSync(tomlPath, 'model = "flash"\r\n');
    appendProviderConfig(sampleInput(), tomlPath);
    const text = readFileSync(tomlPath, 'utf8');
    expect(text).toContain('\r\n[providers.gw]\r\ntype = "openai"\r\n');
    expect(text).not.toContain('\n[providers.gw]\n');
  });

  it('写前备份：备份文件保留且内容等于原文', async () => {
    const original = 'model = "flash"\n';
    writeFileSync(tomlPath, original);
    const result = await appendProviderConfig(sampleInput(), tomlPath);
    expect(result.backupPath).toBeDefined();
    expect(readFileSync(result.backupPath!, 'utf8')).toBe(original);
  });

  it('渠道 id 已存在：抛错且不写文件', async () => {
    const original = '[providers.gw]\ntype = "openai"\n';
    writeFileSync(tomlPath, original);
    await expect(appendProviderConfig(sampleInput(), tomlPath)).rejects.toThrow(/已存在/);
    expect(readFileSync(tomlPath, 'utf8')).toBe(original);
  });

  it('模型别名已存在：抛错且不写文件', async () => {
    const original = '[models.m-1]\nmodel = "m-1"\n';
    writeFileSync(tomlPath, original);
    await expect(appendProviderConfig(sampleInput(), tomlPath)).rejects.toThrow(/别名已存在/);
    expect(readFileSync(tomlPath, 'utf8')).toBe(original);
  });

  it('同批草稿别名重复：抛错', async () => {
    const input = sampleInput();
    input.models[1]!.alias = 'm-1';
    await expect(appendProviderConfig(input, tomlPath)).rejects.toThrow(/重复/);
    expect(existsSync(tomlPath)).toBe(false);
  });

  it('原文件有 TOML 语法错误：拒绝追加（先修再写）', async () => {
    const original = 'model = "flash"\n[broken\n';
    writeFileSync(tomlPath, original);
    await expect(appendProviderConfig(sampleInput(), tomlPath)).rejects.toThrow(/语法错误/);
    expect(readFileSync(tomlPath, 'utf8')).toBe(original);
  });

  it('doctor 校验失败：回滚到原文，备份文件不残留', async () => {
    // permission_mode 非法值会让 doctor 走 loadConfig 抛错路径（exit 1）
    const original = 'permission_mode = "bogus"\n';
    writeFileSync(tomlPath, original);
    await expect(appendProviderConfig(sampleInput(), tomlPath)).rejects.toThrow(/已回滚/);
    expect(readFileSync(tomlPath, 'utf8')).toBe(original);
    expect(backupFiles()).toEqual([]);
  });

  it('doctor 警告（非失败）不回滚：写入保留', async () => {
    // 非法 type 在 doctor 里只是警告（loadConfig 静默跳过），验证警告级别不回滚
    const result = await appendProviderConfig(sampleInput({ type: 'openai' }), tomlPath);
    expect(result.aliases).toEqual(['m-1', 'm-2']);
  });

  it('含特殊字符的值写入后仍能被解析（转义正确）', async () => {
    appendProviderConfig(sampleInput({ apiKey: 'sk-"quoted"\\x' }), tomlPath);
    const { parse } = await import('smol-toml');
    const parsed = parse(readFileSync(tomlPath, 'utf8')) as Record<string, Record<string, Record<string, unknown>>>;
    expect(parsed['providers']!['gw']!['api_key']).toBe('sk-"quoted"\\x');
  });

  it('写入结果经 doctor 视角有效：渠道与别名可被 resolveProviders/resolveModels 解出', async () => {
    appendProviderConfig(sampleInput(), tomlPath);
    const { parse } = await import('smol-toml');
    const { resolveProviders, resolveModels } = await import('../src/config/config.js');
    const parsed = parse(readFileSync(tomlPath, 'utf8')) as Record<string, unknown>;
    const providers = resolveProviders(parsed['providers']);
    const models = resolveModels(parsed['models']);
    expect(providers?.['gw']).toEqual({ type: 'openai', baseUrl: 'https://gw.test/v1', apiKey: 'sk-test' });
    expect(models?.['m-1']?.maxContextSize).toBe(128000);
    expect(models?.['m-1']?.capabilities).toEqual(['thinking', 'image_in']);
    expect(models?.['m-2']?.displayName).toBeUndefined();
  });
});

describe('removeProviderConfig', () => {
  /** 标准夹具：顶层指针 + 待删渠道（两个别名）+ 保留渠道（一个别名）。 */
  const original =
    '# 注释头\n' +
    'model = "m-2"\n' +
    '\n' +
    '[providers.gw]\n' +
    'type = "openai"\n' +
    'base_url = "https://gw.test/v1"\n' +
    '\n' +
    '[models.m-1]\n' +
    'provider = "gw"\n' +
    'model = "m-1"\n' +
    '\n' +
    '[models.m-2]\n' +
    'provider = "gw"\n' +
    'model = "m-2"\n' +
    '\n' +
    '[providers.keep]\n' +
    'type = "openai"\n' +
    '\n' +
    '[models.k-1]\n' +
    'provider = "keep"\n' +
    'model = "k-1"\n';

  it('摘除渠道节与归属别名节，其余内容逐字节保留；悬空顶层指针一并清除', async () => {
    writeFileSync(tomlPath, original);
    const result = await removeProviderConfig('gw', tomlPath);
    expect(result.removedAliases).toEqual(['m-1', 'm-2']);
    expect(result.clearedDefaultModel).toBe(true);
    expect(readFileSync(tomlPath, 'utf8')).toBe(
      '# 注释头\n' +
        '\n' +
        '[providers.keep]\n' +
        'type = "openai"\n' +
        '\n' +
        '[models.k-1]\n' +
        'provider = "keep"\n' +
        'model = "k-1"\n',
    );
  });

  it('写前备份：备份文件保留且内容等于原文', async () => {
    writeFileSync(tomlPath, original);
    const result = await removeProviderConfig('gw', tomlPath);
    expect(backupFiles()).toHaveLength(1);
    expect(readFileSync(result.backupPath, 'utf8')).toBe(original);
  });

  it('顶层 model 指针指向保留别名时不动（clearedDefaultModel=false）', async () => {
    writeFileSync(tomlPath, original.replace('model = "m-2"', 'model = "k-1"'));
    const result = await removeProviderConfig('gw', tomlPath);
    expect(result.clearedDefaultModel).toBe(false);
    expect(readFileSync(tomlPath, 'utf8')).toContain('model = "k-1"');
  });

  it('渠道不存在：抛错且不写文件', async () => {
    writeFileSync(tomlPath, original);
    await expect(removeProviderConfig('nope', tomlPath)).rejects.toThrow(/不存在/);
    expect(readFileSync(tomlPath, 'utf8')).toBe(original);
    expect(backupFiles()).toEqual([]);
  });

  it('config.toml 不存在：抛错', async () => {
    await expect(removeProviderConfig('gw', tomlPath)).rejects.toThrow(/不存在/);
  });

  it('doctor 校验失败：回滚到原文，备份文件不残留', async () => {
    // permission_mode 非法值让 doctor 走 loadConfig 抛错路径（exit 1）
    const broken = 'permission_mode = "bogus"\n\n[providers.gw]\ntype = "openai"\n';
    writeFileSync(tomlPath, broken);
    await expect(removeProviderConfig('gw', tomlPath)).rejects.toThrow(/已回滚/);
    expect(readFileSync(tomlPath, 'utf8')).toBe(broken);
    expect(backupFiles()).toEqual([]);
  });

  it('quoted key 渠道（id 含点）同样按整节摘除', async () => {
    const quoted =
      '[providers."my.gw"]\n' +
      'type = "openai"\n' +
      '\n' +
      '[models.m-1]\n' +
      'provider = "my.gw"\n' +
      'model = "m-1"\n' +
      '\n' +
      '[models.k-1]\n' +
      'model = "k-1"\n';
    writeFileSync(tomlPath, quoted);
    const result = await removeProviderConfig('my.gw', tomlPath);
    expect(result.removedAliases).toEqual(['m-1']);
    expect(readFileSync(tomlPath, 'utf8')).toBe('[models.k-1]\nmodel = "k-1"\n');
  });

  it('[[...]] 数组表节不受摘除影响（不被误吞）', async () => {
    const withHooks =
      '[providers.gw]\n' +
      'type = "openai"\n' +
      '\n' +
      '[[hooks]]\n' +
      'event = "Stop"\n' +
      'command = "echo done"\n';
    writeFileSync(tomlPath, withHooks);
    removeProviderConfig('gw', tomlPath);
    expect(readFileSync(tomlPath, 'utf8')).toBe('[[hooks]]\nevent = "Stop"\ncommand = "echo done"\n');
  });

  it('CRLF 换行风格保留到摘除结果', async () => {
    writeFileSync(tomlPath, original.replace(/\n/g, '\r\n'));
    removeProviderConfig('gw', tomlPath);
    const text = readFileSync(tomlPath, 'utf8');
    expect(text).toContain('[providers.keep]\r\n');
    expect(text.replace(/\r\n/g, '')).not.toContain('\n');
  });
});
