import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import React from 'react';
import { render } from 'ink-testing-library';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// 向导写入器落盘 ~/.step-code/config.toml：把 homedir 指到临时目录，避免碰真实配置。
let fakeHome = '';
vi.mock('node:os', async (importOriginal) => {
  const orig = await importOriginal<typeof import('node:os')>();
  return { ...orig, homedir: () => fakeHome };
});

import { ProviderWizard, type ProviderWizardResult } from '../../src/tui/ProviderWizard.js';

const delay = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));
const DOWN = String.fromCharCode(27) + '[B';
const ESC = String.fromCharCode(27);

/** 精简版目录 fixture（与 tests/provider/catalog.test.ts 同构）。 */
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
      'm-old': { id: 'm-old', status: 'deprecated' },
      'm-av': { id: 'm-av', modalities: { input: ['text', 'audio'] } },
    },
  },
};

let dir: string;
let tomlPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stepcode-wizard-'));
  fakeHome = dir;
  tomlPath = join(dir, '.step-code', 'config.toml');
});

afterEach(() => {
  fakeHome = '';
  rmSync(dir, { recursive: true, force: true });
});

function renderWizard(props: Partial<React.ComponentProps<typeof ProviderWizard>> = {}) {
  const onDone = vi.fn();
  const app = render(
    React.createElement(ProviderWizard, {
      existingProviders: [],
      existingAliases: [],
      onDone,
      ...props,
    }),
  );
  return { ...app, onDone };
}

function readConfig(): string {
  return readFileSync(tomlPath, 'utf8');
}

// 长链路测试（十几次按键往返）：全量并发跑时 ink 渲染变慢，默认 5s 超时不够，放宽到 20s。
const itLong = (name: string, fn: () => Promise<void>): void => {
  it(name, fn, 20000);
};

/** 手动路径公共前缀：path（Enter 手动）→ id。 */
async function enterManualId(stdin: NodeJS.WritableStream, id: string): Promise<void> {
  stdin.write('\r'); // path：手动录入（首项）
  await delay();
  stdin.write(id);
  await delay();
}

describe('ProviderWizard 手动录入路径', () => {
  itLong('全流程：id → type → base_url → 直接填 key → 模型 → 能力多选 → 写入成功', async () => {
    const { stdin, onDone } = renderWizard();
    await delay();
    await enterManualId(stdin, 'gw1');
    stdin.write('\r'); // id 提交 → type
    await delay();
    stdin.write('\r'); // type：openai（首项）
    await delay();
    stdin.write('\r'); // base_url：接受预填
    await delay();
    stdin.write('\r'); // keyMode：直接填写（首项）
    await delay();
    stdin.write('sk-test');
    await delay();
    stdin.write('\r'); // → modelId
    await delay();
    stdin.write('m-1');
    await delay();
    stdin.write('\r'); // → displayName
    await delay();
    stdin.write('\r'); // displayName 留空 → maxContext
    await delay();
    stdin.write('128000');
    await delay();
    stdin.write('\r'); // → caps
    await delay();
    stdin.write(' '); // 勾选 thinking（首项）
    await delay();
    stdin.write('\r'); // caps 提交 → 写入
    await delay();
    expect(onDone).toHaveBeenCalledWith({ kind: 'added', providerId: 'gw1', aliasCount: 1 } satisfies ProviderWizardResult);
    const text = readConfig();
    expect(text).toContain('[providers.gw1]');
    expect(text).toContain('type = "openai"');
    expect(text).toContain('api_key = "sk-test"');
    expect(text).toContain('[models.m-1]');
    expect(text).toContain('max_context_size = 128000');
    expect(text).toContain('capabilities = ["thinking"]');
  });

  itLong('api_key_env 分支：只写环境变量名，密钥不落盘', async () => {
    const { stdin, onDone } = renderWizard();
    await delay();
    await enterManualId(stdin, 'gw2');
    stdin.write('\r'); // id → type
    await delay();
    stdin.write(DOWN); // type：anthropic
    await delay();
    stdin.write('\r');
    await delay();
    stdin.write('\r'); // base_url 接受预填
    await delay();
    stdin.write(DOWN); // keyMode：指定环境变量名
    await delay();
    stdin.write('\r');
    await delay();
    stdin.write('GW2_API_KEY');
    await delay();
    stdin.write('\r'); // → modelId
    await delay();
    stdin.write('m-2');
    await delay();
    stdin.write('\r'); // → displayName
    await delay();
    stdin.write('\r'); // → maxContext
    await delay();
    stdin.write('\r'); // maxContext 留空 → caps
    await delay();
    stdin.write('\r'); // caps 全不选 → 写入
    await delay();
    expect(onDone).toHaveBeenCalledWith({ kind: 'added', providerId: 'gw2', aliasCount: 1 });
    const text = readConfig();
    expect(text).toContain('type = "anthropic"');
    expect(text).toContain('api_key_env = "GW2_API_KEY"');
    expect(text).not.toContain('api_key =');
    expect(text).not.toContain('capabilities');
    expect(text).not.toContain('max_context_size');
  });

  it('渠道 id 冲突：行内报错，留在当前步不写入', async () => {
    const { stdin, lastFrame, onDone } = renderWizard({ existingProviders: ['gw1'] });
    await delay();
    await enterManualId(stdin, 'gw1');
    stdin.write('\r');
    await delay();
    expect(lastFrame() ?? '').toContain('渠道 id 已存在');
    expect(onDone).not.toHaveBeenCalled();
  });

  it('id 非法字符：行内报错', async () => {
    const { stdin, lastFrame } = renderWizard();
    await delay();
    await enterManualId(stdin, 'GW!');
    stdin.write('\r');
    await delay();
    expect(lastFrame() ?? '').toContain('只允许小写字母');
  });

  itLong('maxContext 非数字：行内报错', async () => {
    const { stdin, lastFrame, onDone } = renderWizard();
    await delay();
    await enterManualId(stdin, 'gw3');
    stdin.write('\r'); // id → type
    await delay();
    stdin.write('\r'); // type → baseUrl
    await delay();
    stdin.write('\r'); // baseUrl → keyMode
    await delay();
    stdin.write(DOWN);
    stdin.write(DOWN); // keyMode：暂不配置
    await delay();
    stdin.write('\r'); // → modelId
    await delay();
    stdin.write('m-3');
    await delay();
    stdin.write('\r'); // → displayName
    await delay();
    stdin.write('\r'); // → maxContext
    await delay();
    stdin.write('abc');
    await delay();
    stdin.write('\r');
    await delay();
    expect(lastFrame() ?? '').toContain('正整数');
    expect(onDone).not.toHaveBeenCalled();
  });

  it('Esc 取消：onDone 收到 cancel，不写文件', async () => {
    const { stdin, onDone } = renderWizard();
    await delay();
    stdin.write(ESC);
    await delay();
    expect(onDone).toHaveBeenCalledWith({ kind: 'cancel' });
  });
});

describe('ProviderWizard 目录导入路径', () => {
  function catalogFile(): string {
    const file = join(dir, 'api.json');
    writeFileSync(file, JSON.stringify(fixture));
    return file;
  }

  /** 进入 pick 步：path 选目录导入 → 等拉取完成。 */
  async function enterPick(stdin: NodeJS.WritableStream): Promise<void> {
    stdin.write(DOWN); // path：目录导入
    await delay();
    stdin.write('\r');
    await delay(150); // fetch + parse（本地文件，异步 promise 链）
  }

  itLong('全流程：拉目录 → 选供应商 → 填 key → 全部模型导入为别名（deprecated 过滤）', async () => {
    const { stdin, lastFrame, onDone } = renderWizard({ catalogUrl: catalogFile() });
    await delay();
    await enterPick(stdin);
    expect(lastFrame() ?? '').toContain('acme');
    stdin.write('\r'); // 选中 acme → catalogKey
    await delay();
    expect(lastFrame() ?? '').toContain('将写入');
    stdin.write('sk-x');
    await delay();
    stdin.write('\r');
    await delay();
    expect(onDone).toHaveBeenCalledWith({ kind: 'added', providerId: 'acme', aliasCount: 2 });
    const text = readConfig();
    expect(text).toContain('[providers.acme]');
    expect(text).toContain('base_url = "https://api.acme.test/v1"');
    expect(text).toContain('api_key = "sk-x"');
    expect(text).toContain('[models.m-fast]');
    expect(text).toContain('display_name = "Fast"');
    expect(text).toContain('max_context_size = 128000');
    expect(text).toContain('capabilities = ["thinking", "image_in"]');
    expect(text).toContain('[models.m-av]');
    expect(text).toContain('capabilities = ["audio_in"]');
    expect(text).not.toContain('m-old'); // deprecated 被过滤
  });

  itLong('API key 留空：写入 api_key_env（目录 env[0] 惯例变量名）', async () => {
    const { stdin, onDone } = renderWizard({ catalogUrl: catalogFile() });
    await delay();
    await enterPick(stdin);
    stdin.write('\r'); // 选中 acme
    await delay();
    stdin.write('\r'); // key 留空
    await delay();
    expect(onDone).toHaveBeenCalledWith({ kind: 'added', providerId: 'acme', aliasCount: 2 });
    const text = readConfig();
    expect(text).toContain('api_key_env = "ACME_API_KEY"');
    expect(text).not.toContain('api_key =');
  });

  itLong('别名与现有冲突：数字后缀去重', async () => {
    const { stdin, onDone } = renderWizard({ catalogUrl: catalogFile(), existingAliases: ['m-fast'] });
    await delay();
    await enterPick(stdin);
    stdin.write('\r');
    await delay();
    stdin.write('sk-x');
    await delay();
    stdin.write('\r');
    await delay();
    expect(onDone).toHaveBeenCalledWith({ kind: 'added', providerId: 'acme', aliasCount: 2 });
    const text = readConfig();
    expect(text).toContain('[models.m-fast-2]');
    expect(text).not.toContain('[models.m-fast]');
  });

  it('渠道已存在：选择时报错，不进入下一步', async () => {
    const { stdin, lastFrame, onDone } = renderWizard({ catalogUrl: catalogFile(), existingProviders: ['acme'] });
    await delay();
    await enterPick(stdin);
    stdin.write('\r');
    await delay();
    expect(lastFrame() ?? '').toContain('已存在');
    expect(onDone).not.toHaveBeenCalled();
  });

  it('拉取失败：给出可操作提示，Esc 取消', async () => {
    const { stdin, lastFrame, onDone } = renderWizard({ catalogUrl: join(dir, 'missing.json') });
    await delay();
    stdin.write(DOWN);
    await delay();
    stdin.write('\r');
    await delay(150);
    const out = lastFrame() ?? '';
    expect(out).toContain('目录拉取失败');
    expect(out).toContain('HTTPS_PROXY');
    expect(out).toContain('--url');
    stdin.write(ESC);
    await delay();
    expect(onDone).toHaveBeenCalledWith({ kind: 'cancel' });
  });

  it('拉取失败后按 r 重试：成功进入选择步', async () => {
    const file = join(dir, 'api.json');
    const { stdin, lastFrame } = renderWizard({ catalogUrl: file });
    await delay();
    stdin.write(DOWN);
    await delay();
    stdin.write('\r');
    await delay(150);
    expect(lastFrame() ?? '').toContain('目录拉取失败');
    writeFileSync(file, JSON.stringify(fixture)); // 补上文件再重试
    stdin.write('r');
    await delay(150);
    expect(lastFrame() ?? '').toContain('acme');
  });
});
