import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_CATALOG_URL, fetchCatalog, parseCatalog } from '../../src/provider/catalog.js';

/** 精简版目录 fixture：覆盖 openai-compatible / anthropic / 未知 npm 三类与状态过滤。 */
const fixture = {
  acme: {
    id: 'acme',
    api: 'https://api.acme.test/v1',
    env: ['ACME_API_KEY'],
    npm: '@ai-sdk/openai-compatible',
    name: 'Acme',
    models: {
      'm-fast': {
        id: 'm-fast',
        name: 'Fast',
        reasoning: true,
        modalities: { input: ['text', 'image'], output: ['text'] },
        limit: { context: 128000 },
      },
      'm-old': { id: 'm-old', status: 'deprecated', limit: { context: 8000 } },
      'm-alpha': { id: 'm-alpha', status: 'alpha' },
      'm-av': { id: 'm-av', modalities: { input: ['text', 'video', 'audio'] } },
    },
  },
  vendorb: {
    id: 'vendorb',
    npm: '@ai-sdk/anthropic',
    api: 'https://vendorb.test',
    models: { c1: { id: 'c1' } },
  },
  mystery: {
    id: 'mystery',
    npm: '@vendor/proprietary-sdk',
    models: { q1: { id: 'q1', limit: { context: 4096 } } },
  },
  empty: {
    id: 'empty',
    models: { e1: { id: 'e1', status: 'deprecated' } },
  },
};

describe('parseCatalog', () => {
  it('npm 推断协议：openai-compatible→openai、anthropic→anthropic、其他→openai 标待验证', () => {
    const list = parseCatalog(fixture);
    const byId = new Map(list.map((p) => [p.id, p]));
    expect(byId.get('acme')).toMatchObject({ type: 'openai', typeUnverified: false });
    expect(byId.get('vendorb')).toMatchObject({ type: 'anthropic', typeUnverified: false });
    expect(byId.get('mystery')).toMatchObject({ type: 'openai', typeUnverified: true });
  });

  it('api→baseUrl、env[0]→envHint、name 缺失回落 id', () => {
    const list = parseCatalog(fixture);
    const byId = new Map(list.map((p) => [p.id, p]));
    expect(byId.get('acme')?.baseUrl).toBe('https://api.acme.test/v1');
    expect(byId.get('acme')?.envHint).toBe('ACME_API_KEY');
    expect(byId.get('acme')?.name).toBe('Acme');
    expect(byId.get('mystery')?.baseUrl).toBeUndefined();
    expect(byId.get('mystery')?.envHint).toBeUndefined();
    expect(byId.get('mystery')?.name).toBe('mystery');
  });

  it('模型映射：limit.context→context、reasoning→thinking、modalities.input→image/video/audio_in', () => {
    const list = parseCatalog(fixture);
    const acme = list.find((p) => p.id === 'acme')!;
    const fast = acme.models.find((m) => m.id === 'm-fast')!;
    expect(fast).toMatchObject({ name: 'Fast', context: 128000, capabilities: ['thinking', 'image_in'] });
    const av = acme.models.find((m) => m.id === 'm-av')!;
    expect(av.capabilities).toEqual(['video_in', 'audio_in']);
    expect(av.context).toBeUndefined();
  });

  it('deprecated / alpha 模型被过滤；过滤后无模型的供应商整条剔除', () => {
    const list = parseCatalog(fixture);
    const acme = list.find((p) => p.id === 'acme')!;
    expect(acme.models.map((m) => m.id).sort()).toEqual(['m-av', 'm-fast']);
    expect(list.find((p) => p.id === 'empty')).toBeUndefined();
  });

  it('供应商按 id 排序（选择器顺序稳定）', () => {
    const list = parseCatalog(fixture);
    expect(list.map((p) => p.id)).toEqual(['acme', 'mystery', 'vendorb']);
  });

  it('顶层不是对象时抛错（目录形态变化不静默吞）', () => {
    expect(() => parseCatalog(null)).toThrow(/顶层结构非法/);
    expect(() => parseCatalog([])).toThrow(/顶层结构非法/);
    expect(() => parseCatalog('x')).toThrow(/顶层结构非法/);
  });

  it('缺 models 段的供应商跳过；非对象模型条目跳过', () => {
    const list = parseCatalog({
      broken: { id: 'broken' },
      weird: { id: 'weird', models: { bad: 42, good: { id: 'good' } } },
    });
    expect(list.map((p) => p.id)).toEqual(['weird']);
    expect(list[0]!.models.map((m) => m.id)).toEqual(['good']);
  });
});

describe('fetchCatalog', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'stepcode-catalog-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    vi.unstubAllGlobals();
  });

  it('本地文件路径：读取并解析 JSON', async () => {
    const file = join(dir, 'api.json');
    writeFileSync(file, JSON.stringify(fixture));
    const raw = await fetchCatalog(file);
    const list = parseCatalog(raw);
    expect(list.map((p) => p.id)).toEqual(['acme', 'mystery', 'vendorb']);
  });

  it('本地文件不存在：报路径', async () => {
    await expect(fetchCatalog(join(dir, 'nope.json'))).rejects.toThrow(/不存在/);
  });

  it('本地文件非法 JSON：报解析失败', async () => {
    const file = join(dir, 'bad.json');
    writeFileSync(file, '{oops');
    await expect(fetchCatalog(file)).rejects.toThrow(/解析失败/);
  });

  it('http：走全局 fetch（代理约定由启动注入保证，本层不感知）', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => fixture });
    vi.stubGlobal('fetch', fetchMock);
    const raw = await fetchCatalog('https://mirror.test/api.json');
    expect(fetchMock).toHaveBeenCalledWith('https://mirror.test/api.json');
    expect(parseCatalog(raw).map((p) => p.id)).toContain('acme');
  });

  it('http 非 2xx：报状态码', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    await expect(fetchCatalog(DEFAULT_CATALOG_URL)).rejects.toThrow(/HTTP 503/);
  });

  it('http 网络异常：报请求失败与地址', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED')));
    await expect(fetchCatalog(DEFAULT_CATALOG_URL)).rejects.toThrow(/请求 .* 失败/);
  });
});
