import { describe, expect, it } from 'vitest';
import { busyRoute, helpText, parseSlash, SLASH_COMMANDS } from '../../src/chat/commands.js';

describe('parseSlash', () => {
  it('非斜杠输入返回 null', () => {
    expect(parseSlash('hello world')).toBeNull();
    expect(parseSlash('  普通消息')).toBeNull();
  });

  it('解析命令名与参数', () => {
    expect(parseSlash('/permission auto')).toEqual({ name: 'permission', args: 'auto' });
    expect(parseSlash('/help')).toEqual({ name: 'help', args: '' });
  });

  it('解析别名到规范名', () => {
    expect(parseSlash('/q')?.name).toBe('exit');
    expect(parseSlash('/?')?.name).toBe('help');
    expect(parseSlash('/cron')?.name).toBe('loop');
  });

  it('大小写不敏感、去除首尾空白', () => {
    expect(parseSlash('  /YOLO  ')?.name).toBe('yolo');
  });

  it('未知命令返回空 name', () => {
    expect(parseSlash('/nope')).toEqual({ name: '', args: '' });
  });

  it('解析 /resume 命令与 id 参数', () => {
    expect(parseSlash('/resume abc')).toEqual({ name: 'resume', args: 'abc' });
    expect(parseSlash('/resume')).toEqual({ name: 'resume', args: '' });
  });

  it('解析 /agents 命令（当前会话的子 agent 只读下钻入口）', () => {
    expect(parseSlash('/agents')).toEqual({ name: 'agents', args: '' });
  });

  it('解析 /model 命令与名称参数', () => {
    expect(parseSlash('/model step-2')).toEqual({ name: 'model', args: 'step-2' });
    expect(parseSlash('/model')).toEqual({ name: 'model', args: '' });
  });

  it('解析 /provider 命令与服务商参数', () => {
    expect(parseSlash('/provider anthropic')).toEqual({ name: 'provider', args: 'anthropic' });
    expect(parseSlash('/provider')).toEqual({ name: 'provider', args: '' });
  });

  it('解析 /history 命令与轮数参数，/undo 作为别名归一到同一入口', () => {
    expect(parseSlash('/history 3')).toEqual({ name: 'history', args: '3' });
    expect(parseSlash('/history')).toEqual({ name: 'history', args: '' });
    expect(parseSlash('/undo 3')).toEqual({ name: 'history', args: '3' });
    expect(parseSlash('/undo')).toEqual({ name: 'history', args: '' });
  });

  it('解析 /reload 命令（无参）', () => {
    expect(parseSlash('/reload')).toEqual({ name: 'reload', args: '' });
  });
});

describe('SLASH_COMMANDS 注册表', () => {
  it('包含 model 与 provider 命令', () => {
    const names = SLASH_COMMANDS.map((c) => c.name);
    expect(names).toContain('model');
    expect(names).toContain('provider');
  });

  it('包含 mcp 命令，可解析且 busy 时即时执行', () => {
    const names = SLASH_COMMANDS.map((c) => c.name);
    expect(names).toContain('mcp');
    expect(parseSlash('/mcp')).toEqual({ name: 'mcp', args: '' });
    // 只读查看：无参带参都即时，不排队等回合结束
    expect(busyRoute('mcp', '')).toBe('instant');
    expect(busyRoute('mcp', 'github')).toBe('instant');
  });

  it('包含 skill 命令：无参列清单即时、带参激活排队', () => {
    const names = SLASH_COMMANDS.map((c) => c.name);
    expect(names).toContain('skill');
    expect(parseSlash('/skill')).toEqual({ name: 'skill', args: '' });
    expect(parseSlash('/skill foo a b')).toEqual({ name: 'skill', args: 'foo a b' });
    // 无参只读列清单 → 即时；带参注入正文改动对话 → 排队
    expect(busyRoute('skill', '')).toBe('instant');
    expect(busyRoute('skill', 'foo')).toBe('queue');
  });

  it('包含 plugin 命令：管理子命令不碰对话状态，busy 时均即时', () => {
    const names = SLASH_COMMANDS.map((c) => c.name);
    expect(names).toContain('plugin');
    expect(parseSlash('/plugin')).toEqual({ name: 'plugin', args: '' });
    expect(parseSlash('/plugin install /tmp/x')).toEqual({ name: 'plugin', args: 'install /tmp/x' });
    expect(busyRoute('plugin', '')).toBe('instant');
    expect(busyRoute('plugin', 'disable abc')).toBe('instant');
  });

  it('包含 think 命令：无参查询即时、带参切换排队', () => {
    const names = SLASH_COMMANDS.map((c) => c.name);
    expect(names).toContain('think');
    expect(parseSlash('/think')).toEqual({ name: 'think', args: '' });
    expect(parseSlash('/think high')).toEqual({ name: 'think', args: 'high' });
    // 无参只读（busy 时退化为文本展示）→ 即时；带参切换会话级状态 → 排队
    expect(busyRoute('think', '')).toBe('instant');
    expect(busyRoute('think', 'high')).toBe('queue');
  });

  it('extraNames 解析 plugin 命名空间命令（<pluginId>:<commandName>）', () => {
    const extra = new Set(['myplugin:review']);
    expect(parseSlash('/myplugin:review a b', extra)).toEqual({ name: 'myplugin:review', args: 'a b' });
    // 不传 extraNames 时按未知命令处理
    expect(parseSlash('/myplugin:review a b')).toEqual({ name: '', args: 'a b' });
    // 执行会注入模板改动对话 → busy 时排队
    expect(busyRoute('myplugin:review', 'a')).toBe('queue');
  });
});

describe('helpText', () => {
  it('包含所有已注册命令', () => {
    const text = helpText();
    for (const cmd of SLASH_COMMANDS) {
      expect(text).toContain(`/${cmd.name}`);
    }
  });
});

describe('busyRoute', () => {
  it('只读/纯 UI 命令 busy 时即时执行', () => {
    for (const name of ['help', 'goal', 'loop']) {
      expect(busyRoute(name, '')).toBe('instant');
    }
  });

  it('/lang 查询与切换都不碰对话，busy 时均即时', () => {
    expect(busyRoute('lang', '')).toBe('instant');
    expect(busyRoute('lang', 'en')).toBe('instant');
  });

  it('双态命令无参查询即时、带参变更排队', () => {
    for (const name of ['model', 'provider', 'permission']) {
      expect(busyRoute(name, '')).toBe('instant');
      expect(busyRoute(name, 'x')).toBe('queue');
    }
  });

  it('改动 turn 前提的命令 busy 时排队', () => {
    for (const name of ['yolo', 'auto', 'plan', 'fork', 'new', 'compact', 'history', 'reflect', 'export-debug-zip', 'reload', 'exit']) {
      expect(busyRoute(name, '')).toBe('queue');
    }
    // /resume 无参只打开会话选择器（只读 UI），busy 时即时；带参才涉及状态变更，排队
    expect(busyRoute('resume', '')).toBe('instant');
    expect(busyRoute('resume', 'abc')).toBe('queue');
    // history 带参无参都是状态变更（回退历史与附带状态），一律排队到回合边界
    expect(busyRoute('history', '3')).toBe('queue');
    // reload 重建 provider、改 ctx、换 hookEngine——全部是在途 turn 依赖的运行时前提，排队到回合边界
    expect(busyRoute('reload', '')).toBe('queue');
  });

  it('未知命令即时提示，不等回合结束', () => {
    expect(busyRoute('', 'nope')).toBe('instant');
  });

  it('注册表内每条命令都有确定的分流', () => {
    for (const cmd of SLASH_COMMANDS) {
      expect(['instant', 'queue']).toContain(busyRoute(cmd.name, ''));
      expect(['instant', 'queue']).toContain(busyRoute(cmd.name, 'arg'));
    }
  });
});
