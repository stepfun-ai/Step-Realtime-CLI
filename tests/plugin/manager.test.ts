import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  discoverPluginEntries,
  discoverPlugins,
  expandPluginCommand,
  loadPlugin,
  parsePluginManifest,
} from '../../src/plugin/manager.js';

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'stepcode-plugin-'));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function makePlugin(root: string, manifest: object, skillFiles: Record<string, string> = {}): void {
  mkdirSync(join(root, '.step-code-plugin'), { recursive: true });
  writeFileSync(join(root, '.step-code-plugin', 'plugin.json'), JSON.stringify(manifest));
  for (const [rel, content] of Object.entries(skillFiles)) {
    const p = join(root, rel);
    mkdirSync(join(p, '..'), { recursive: true });
    writeFileSync(p, content);
  }
}

describe('parsePluginManifest', () => {
  it('解析合法 manifest', () => {
    const m = parsePluginManifest(
      JSON.stringify({ name: 'my-plugin', version: '1.0.0', description: 'd', skills: ['./skills'] }),
    );
    expect(m).not.toBeNull();
    expect(m!.name).toBe('my-plugin');
    expect(m!.skills).toEqual(['./skills']);
  });

  it('缺 name / name 非法 → null', () => {
    expect(parsePluginManifest(JSON.stringify({ version: '1.0' }))).toBeNull();
    expect(parsePluginManifest(JSON.stringify({ name: 'Bad Name!' }))).toBeNull();
    expect(parsePluginManifest('not json')).toBeNull();
  });
});

describe('loadPlugin', () => {
  it('加载 plugin 并解析 skill 目录', () => {
    const root = join(dir, 'p1');
    makePlugin(root, { name: 'p1', skills: ['./skills'] }, { 'skills/foo/SKILL.md': '---\nname: foo\ndescription: x\n---\nbody' });
    const p = loadPlugin(root);
    expect(p).not.toBeNull();
    expect(p!.id).toBe('p1');
    expect(p!.skillDirs).toHaveLength(1);
  });

  it('manifest 无 skills 但根目录有 SKILL.md → 根本身当 skill', () => {
    const root = join(dir, 'p2');
    makePlugin(root, { name: 'p2' }, { 'SKILL.md': '---\nname: p2\ndescription: x\n---\nbody' });
    const p = loadPlugin(root);
    expect(p).not.toBeNull();
    expect(p!.skillDirs).toHaveLength(1);
  });

  it('路径逃逸（../）被拒绝', () => {
    const root = join(dir, 'p3');
    makePlugin(root, { name: 'p3', skills: ['../outside'] });
    const p = loadPlugin(root);
    expect(p).not.toBeNull();
    expect(p!.skillDirs).toHaveLength(0); // 逃逸路径被过滤
  });

  it('执行型字段被记录为 ignoredFields（hooks/mcpServers/commands 已支持，不再计入）', () => {
    const root = join(dir, 'p4');
    makePlugin(root, { name: 'p4', skills: ['./skills'], tools: [], apps: {}, inject: './x', configFile: './y', bootstrap: './z' });
    const p = loadPlugin(root);
    expect(p!.ignoredFields).toEqual(['tools', 'apps', 'inject', 'configFile', 'bootstrap']);
  });

  it('无 plugin.json → null', () => {
    expect(loadPlugin(join(dir, 'nonexistent'))).toBeNull();
  });
});

describe('discoverPlugins', () => {
  it('发现目录下所有合法 plugin', () => {
    makePlugin(join(dir, 'a'), { name: 'a', skills: ['./skills'] });
    makePlugin(join(dir, 'b'), { name: 'b' }, { 'SKILL.md': '---\nname: b\ndescription: x\n---\nb' });
    const found = discoverPlugins(dir);
    expect(found.map((p) => p.manifest.name).sort()).toEqual(['a', 'b']);
  });

  it('空目录 / 不存在 → 空数组', () => {
    expect(discoverPlugins(join(dir, 'empty'))).toEqual([]);
  });
});

describe('parsePluginManifest 新字段', () => {
  it('解析 mcpServers / hooks / commands', () => {
    const m = parsePluginManifest(
      JSON.stringify({
        name: 'p',
        mcpServers: { s: { command: 'npx', args: ['-y', 'srv'] } },
        hooks: [{ event: 'PreToolUse', matcher: '^bash$', command: 'echo hi', timeout: 5 }],
        commands: ['./commands/review.md'],
      }),
    );
    expect(m).not.toBeNull();
    expect(m!.mcpServers?.['s']?.command).toBe('npx');
    expect(m!.hooks).toHaveLength(1);
    expect(m!.commands).toEqual(['./commands/review.md']);
  });

  it('hooks 非对象条目被过滤；mcpServers 非对象被忽略', () => {
    const m = parsePluginManifest(
      JSON.stringify({ name: 'p', hooks: [{ event: 'Stop', command: 'x' }, 'bad', 42], mcpServers: ['not-object'] }),
    );
    expect(m!.hooks).toHaveLength(1);
    expect(m!.mcpServers).toBeUndefined();
  });
});

describe('loadPlugin 能力面：MCP', () => {
  it('server 名强制 <pluginId>:<serverName> 前缀', () => {
    const root = join(dir, 'pm');
    makePlugin(root, { name: 'pm', mcpServers: { github: { command: 'npx', args: ['-y', 'srv'] } } });
    const p = loadPlugin(root);
    expect(Object.keys(p!.mcpServers)).toEqual(['pm:github']);
    expect(p!.mcpServers['pm:github']!.args).toEqual(['-y', 'srv']);
  });

  it('stdio command 为 PATH 命令时原样透传', () => {
    const root = join(dir, 'pp');
    makePlugin(root, { name: 'pp', mcpServers: { s: { command: 'uvx' } } });
    const p = loadPlugin(root);
    expect(p!.mcpServers['pp:s']!.command).toBe('uvx');
  });

  it('stdio command 为绝对路径 / 带分隔符的非 ./ 路径 → 整条 server 丢弃', () => {
    const root = join(dir, 'pa');
    makePlugin(root, {
      name: 'pa',
      mcpServers: {
        abs: { command: '/usr/local/bin/srv' },
        win: { command: 'C:\\tools\\srv.exe' },
        rel: { command: 'bin/srv' },
        ok: { command: 'npx' },
      },
    });
    const p = loadPlugin(root);
    expect(Object.keys(p!.mcpServers)).toEqual(['pa:ok']);
  });

  it('stdio command 为 ./ 相对路径时解析到插件根内；逃逸（./../）拒绝', () => {
    const root = join(dir, 'pr');
    makePlugin(
      root,
      { name: 'pr', mcpServers: { local: { command: './bin/srv.js' }, escape: { command: './../outside.js' } } },
      { 'bin/srv.js': '// srv' },
    );
    const p = loadPlugin(root);
    expect(Object.keys(p!.mcpServers)).toEqual(['pr:local']);
    expect(p!.mcpServers['pr:local']!.command).toBe(realpathSync(join(root, 'bin', 'srv.js')));
  });

  it('cwd 给了就必须 ./ 且解析进插件根，否则整条 server 丢弃', () => {
    const root = join(dir, 'pc');
    makePlugin(
      root,
      {
        name: 'pc',
        mcpServers: {
          good: { command: 'npx', cwd: './sub' },
          bad: { command: 'npx', cwd: '/tmp' },
        },
      },
      { 'sub/.keep': '' },
    );
    const p = loadPlugin(root);
    expect(Object.keys(p!.mcpServers)).toEqual(['pc:good']);
    expect(p!.mcpServers['pc:good']!.cwd).toBe(realpathSync(join(root, 'sub')));
  });
});

describe('loadPlugin 能力面：hooks', () => {
  it('合法 hook 并入：cwd 固定插件根、注入 STEP_CODE_PLUGIN_ROOT、matcher 已编译', () => {
    const root = join(dir, 'ph');
    makePlugin(root, {
      name: 'ph',
      hooks: [{ event: 'PreToolUse', matcher: '^bash$', command: 'echo hi', timeout: 5 }],
    });
    const p = loadPlugin(root);
    expect(p!.hooks).toHaveLength(1);
    const h = p!.hooks[0]!;
    expect(h.event).toBe('PreToolUse');
    expect(h.matcher).toBeInstanceOf(RegExp);
    expect(h.timeout).toBe(5);
    expect(h.cwd).toBe(realpathSync(root));
    expect(h.env).toEqual({ STEP_CODE_PLUGIN_ROOT: realpathSync(root) });
  });

  it('非法 event / 非法 matcher / 空 command 的 hook 整条跳过', () => {
    const root = join(dir, 'ph2');
    makePlugin(root, {
      name: 'ph2',
      hooks: [
        { event: 'BadEvent', command: 'x' },
        { event: 'Stop', command: 'y', matcher: '[' },
        { event: 'Stop', command: '' },
        { event: 'Stop', command: 'ok' },
      ],
    });
    const p = loadPlugin(root);
    expect(p!.hooks).toHaveLength(1);
    expect(p!.hooks[0]!.command).toBe('ok');
  });

  it('timeout 缺省 30，越界 clamp 到 [1,600]', () => {
    const root = join(dir, 'ph3');
    makePlugin(root, {
      name: 'ph3',
      hooks: [
        { event: 'Stop', command: 'a' },
        { event: 'Stop', command: 'b', timeout: 9999 },
        { event: 'Stop', command: 'c', timeout: 0 },
      ],
    });
    const p = loadPlugin(root);
    expect(p!.hooks.map((h) => h.timeout)).toEqual([30, 600, 1]);
  });
});

describe('loadPlugin 能力面：commands', () => {
  it('注册名强制 <pluginId>: 命名空间；frontmatter 覆盖 name/description', () => {
    const root = join(dir, 'pc2');
    makePlugin(
      root,
      { name: 'pc2', commands: ['./commands/review.md'] },
      { 'commands/review.md': '---\nname: check\ndescription: 审查代码\n---\n审查 $ARGUMENTS' },
    );
    const p = loadPlugin(root);
    expect(p!.commands).toHaveLength(1);
    expect(p!.commands[0]!.name).toBe('pc2:check');
    expect(p!.commands[0]!.description).toBe('审查代码');
    expect(p!.commands[0]!.content).toBe('审查 $ARGUMENTS');
  });

  it('frontmatter 无 name 时取文件名兜底；无 frontmatter 整篇为正文', () => {
    const root = join(dir, 'pc3');
    makePlugin(
      root,
      { name: 'pc3', commands: ['./commands/review.md', './commands/plain.md'] },
      {
        'commands/review.md': '---\ndescription: d\n---\n正文',
        'commands/plain.md': '只有正文 $ARGUMENTS',
      },
    );
    const p = loadPlugin(root);
    expect(p!.commands.map((c) => c.name)).toEqual(['pc3:review', 'pc3:plain']);
    expect(p!.commands[1]!.content).toBe('只有正文 $ARGUMENTS');
  });

  it('commands 路径逃逸（../）被拒绝', () => {
    const root = join(dir, 'pc4');
    makePlugin(root, { name: 'pc4', commands: ['../outside.md'] });
    const p = loadPlugin(root);
    expect(p!.commands).toHaveLength(0);
  });

  it('空正文 / 坏 frontmatter 的命令文件跳过', () => {
    const root = join(dir, 'pc5');
    makePlugin(
      root,
      { name: 'pc5', commands: ['./c/empty.md', './c/bad.md', './c/ok.md'] },
      {
        'c/empty.md': '---\nname: empty\n---\n',
        'c/bad.md': '---\n{a:\n---\nbody',
        'c/ok.md': '---\nname: ok\ndescription: d\n---\nbody',
      },
    );
    const p = loadPlugin(root);
    expect(p!.commands.map((c) => c.name)).toEqual(['pc5:ok']);
  });
});

describe('expandPluginCommand', () => {
  it('$ARGUMENTS 全部替换，参数中的 $ 特殊序列保持字面', () => {
    expect(expandPluginCommand('a $ARGUMENTS b $ARGUMENTS', 'x$&y')).toBe('a x$&y b x$&y');
  });

  it('无参数时替换为空串', () => {
    expect(expandPluginCommand('run $ARGUMENTS!', '')).toBe('run !');
  });
});

describe('discoverPlugins disabled 过滤', () => {
  it('disabled 集合内的 plugin 不合流', () => {
    makePlugin(join(dir, 'a'), { name: 'a' });
    makePlugin(join(dir, 'b'), { name: 'b' });
    const found = discoverPlugins(dir, new Set(['a']));
    expect(found.map((p) => p.id)).toEqual(['b']);
  });
});

describe('discoverPluginEntries 坏插件诊断', () => {
  it('manifest 解析失败 → errors 列出，合法 plugin 不受影响（不拖垮启动）', () => {
    makePlugin(join(dir, 'good'), { name: 'good' });
    mkdirSync(join(dir, 'bad', '.step-code-plugin'), { recursive: true });
    writeFileSync(join(dir, 'bad', '.step-code-plugin', 'plugin.json'), 'not json');
    const { plugins, errors } = discoverPluginEntries(dir);
    expect(plugins.map((p) => p.id)).toEqual(['good']);
    expect(errors).toHaveLength(1);
    expect(errors[0]!.id).toBe('bad');
    expect(errors[0]!.reason).toBe('invalid-manifest');
  });

  it('无 plugin.json 的子目录视为非插件，跳过不进 errors', () => {
    mkdirSync(join(dir, 'random'), { recursive: true });
    const { plugins, errors } = discoverPluginEntries(dir);
    expect(plugins).toEqual([]);
    expect(errors).toEqual([]);
  });
});
