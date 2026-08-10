import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadPlugin } from '../../src/plugin/manager.js';
import {
  installPlugin,
  readPluginsState,
  setPluginDisabled,
  uninstallPlugin,
  writePluginsState,
} from '../../src/plugin/manage.js';

let dir: string;
let pluginsDir: string;
let statePath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stepcode-plugin-manage-'));
  pluginsDir = join(dir, 'plugins');
  statePath = join(dir, 'plugins.json');
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makePlugin(root: string, manifest: object, files: Record<string, string> = {}): void {
  mkdirSync(join(root, '.step-code-plugin'), { recursive: true });
  writeFileSync(join(root, '.step-code-plugin', 'plugin.json'), JSON.stringify(manifest));
  for (const [rel, content] of Object.entries(files)) {
    const p = join(root, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, content);
  }
}

describe('installPlugin', () => {
  it('复制源目录到 <pluginsDir>/<manifest.name>/，安装后可加载', () => {
    const src = join(dir, 'src-plugin');
    makePlugin(src, { name: 'demo', version: '1.0.0' }, { 'SKILL.md': '---\nname: demo\ndescription: x\n---\nb' });
    const r = installPlugin(src, pluginsDir);
    expect(r).toEqual({ ok: true, id: 'demo' });
    const installed = loadPlugin(join(pluginsDir, 'demo'));
    expect(installed).not.toBeNull();
    expect(installed!.skillDirs).toHaveLength(1);
    // 源目录不被改动
    expect(existsSync(join(src, '.step-code-plugin', 'plugin.json'))).toBe(true);
  });

  it('重装同 id = 覆盖更新：新文件生效，旧多余文件被清掉', () => {
    const src = join(dir, 'src-plugin');
    makePlugin(src, { name: 'demo' }, { 'old.txt': 'v1' });
    expect(installPlugin(src, pluginsDir).ok).toBe(true);
    expect(existsSync(join(pluginsDir, 'demo', 'old.txt'))).toBe(true);
    // 源目录演进后重装
    rmSync(join(src, 'old.txt'));
    writeFileSync(join(src, 'new.txt'), 'v2');
    expect(installPlugin(src, pluginsDir).ok).toBe(true);
    expect(existsSync(join(pluginsDir, 'demo', 'old.txt'))).toBe(false);
    expect(readFileSync(join(pluginsDir, 'demo', 'new.txt'), 'utf8')).toBe('v2');
    // staging 临时目录不残留
    expect(existsSync(join(pluginsDir, '.staging-demo'))).toBe(false);
  });

  it('源目录不存在 / 非 plugin → 失败且不建目录', () => {
    expect(installPlugin(join(dir, 'nope'), pluginsDir).ok).toBe(false);
    const plain = join(dir, 'plain');
    mkdirSync(plain, { recursive: true });
    const r = installPlugin(plain, pluginsDir);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('plugin.json');
  });
});

describe('plugins.json 启停状态', () => {
  it('setPluginDisabled 持久化 disabled 集合', () => {
    setPluginDisabled(statePath, 'a', true);
    setPluginDisabled(statePath, 'b', true);
    expect(readPluginsState(statePath).disabled).toEqual(['a', 'b']);
    // 文件内容确为 JSON 且落盘
    const raw = JSON.parse(readFileSync(statePath, 'utf8')) as { disabled: string[] };
    expect(raw.disabled).toEqual(['a', 'b']);
    setPluginDisabled(statePath, 'a', false);
    expect(readPluginsState(statePath).disabled).toEqual(['b']);
  });

  it('文件不存在 / 损坏 → 空 disabled（不拖垮启动）', () => {
    expect(readPluginsState(statePath).disabled).toEqual([]);
    writeFileSync(statePath, 'not json');
    expect(readPluginsState(statePath).disabled).toEqual([]);
  });

  it('writePluginsState 在目录不存在时先建目录', () => {
    const deep = join(dir, 'nested', 'plugins.json');
    writePluginsState(deep, { disabled: ['x'] });
    expect(readPluginsState(deep).disabled).toEqual(['x']);
  });
});

describe('uninstallPlugin', () => {
  it('删除目录并从 disabled 集合清除', () => {
    const src = join(dir, 'src-plugin');
    makePlugin(src, { name: 'demo' });
    installPlugin(src, pluginsDir);
    setPluginDisabled(statePath, 'demo', true);
    const r = uninstallPlugin(pluginsDir, statePath, 'demo');
    expect(r.ok).toBe(true);
    expect(existsSync(join(pluginsDir, 'demo'))).toBe(false);
    expect(readPluginsState(statePath).disabled).toEqual([]);
  });

  it('未安装的 id → 失败', () => {
    const r = uninstallPlugin(pluginsDir, statePath, 'ghost');
    expect(r.ok).toBe(false);
  });
});
