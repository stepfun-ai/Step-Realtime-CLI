import { describe, expect, it } from 'vitest';
import { accessConflict, type ToolAccess } from '../../src/tools/access.js';
import { resolvePath } from '../../src/tools/fsutil.js';
import { toolAccessOf } from '../../src/tools/index.js';
import type { ToolContext } from '../../src/tools/types.js';

const none: ToolAccess = { kind: 'none' };
const all: ToolAccess = { kind: 'all' };
const read = (path: string): ToolAccess => ({ kind: 'read', path });
const write = (path: string): ToolAccess => ({ kind: 'write', path });

const ctx: ToolContext = { cwd: process.cwd() };

describe('accessConflict 两两组合', () => {
  it('all 与一切冲突（含 none / read / write / all）', () => {
    expect(accessConflict(all, all)).toBe(true);
    expect(accessConflict(all, none)).toBe(true); // all 最高优先级：general 子 agent 与只读任务互斥
    expect(accessConflict(none, all)).toBe(true);
    expect(accessConflict(all, read('/x'))).toBe(true);
    expect(accessConflict(write('/x'), all)).toBe(true);
  });

  it('none 与非 all 的一切不冲突', () => {
    expect(accessConflict(none, none)).toBe(false);
    expect(accessConflict(none, read('/x'))).toBe(false);
    expect(accessConflict(read('/x'), none)).toBe(false);
    expect(accessConflict(none, write('/x'))).toBe(false);
    expect(accessConflict(write('/x'), none)).toBe(false);
  });

  it('read-read 不冲突（含同路径）', () => {
    expect(accessConflict(read('/x/a'), read('/x/a'))).toBe(false);
    expect(accessConflict(read('/x/a'), read('/y/b'))).toBe(false);
  });

  it('write 与同路径的任何非 none 冲突', () => {
    expect(accessConflict(write('/x/a'), read('/x/a'))).toBe(true);
    expect(accessConflict(read('/x/a'), write('/x/a'))).toBe(true);
    expect(accessConflict(write('/x/a'), write('/x/a'))).toBe(true);
  });

  it('write 与不同路径不冲突', () => {
    expect(accessConflict(write('/x/a'), write('/x/b'))).toBe(false);
    expect(accessConflict(write('/x/a'), read('/y/b'))).toBe(false);
  });
});

describe('accessConflict 路径前缀重叠', () => {
  it('前缀重叠（目录包含）冲突', () => {
    expect(accessConflict(write('/x'), read('/x/a'))).toBe(true);
    expect(accessConflict(read('/x/a'), write('/x'))).toBe(true);
    expect(accessConflict(write('/x'), write('/x/a/b'))).toBe(true);
  });

  it('目录边界误命中不算重叠：/x/foo 与 /x/foobar 不冲突', () => {
    expect(accessConflict(write('/x/foo'), read('/x/foobar'))).toBe(false);
    expect(accessConflict(write('/x/foobar'), write('/x/foo'))).toBe(false);
  });

  it('统一分隔符与尾部斜杠后比较', () => {
    expect(accessConflict(write('C:\\repo\\a'), read('C:/repo/a'))).toBe(true);
    expect(accessConflict(write('/x/'), read('/x'))).toBe(true);
  });
});

describe('toolAccessOf 工具声明', () => {
  it('路径类工具按入参产出 read / write', () => {
    expect(toolAccessOf('read_file', { path: 'src/a.ts' }, ctx)).toEqual({
      kind: 'read',
      path: resolvePath(process.cwd(), 'src/a.ts'),
    });
    expect(toolAccessOf('write_file', { path: 'out.txt', content: 'x' }, ctx).kind).toBe('write');
    expect(toolAccessOf('edit_file', { path: 'a', old_string: 'x', new_string: 'y' }, ctx).kind).toBe('write');
    expect(toolAccessOf('grep', { pattern: 'x' }, ctx).kind).toBe('read');
    expect(toolAccessOf('glob', { pattern: '*.ts' }, ctx).kind).toBe('read');
    expect(toolAccessOf('list_dir', {}, ctx).kind).toBe('read');
  });

  it('web 类声明 none', () => {
    expect(toolAccessOf('web_search', { query: 'x' }, ctx)).toEqual({ kind: 'none' });
    expect(toolAccessOf('web_image_search', { query: 'x' }, ctx)).toEqual({ kind: 'none' });
  });

  it('spawn_agent 按 subagent_type 动态：explore=none，general（含缺省）=all', () => {
    expect(toolAccessOf('spawn_agent', { prompt: 'p', subagent_type: 'explore' }, ctx)).toEqual({ kind: 'none' });
    expect(toolAccessOf('spawn_agent', { prompt: 'p', subagent_type: 'general' }, ctx)).toEqual({ kind: 'all' });
    expect(toolAccessOf('spawn_agent', { prompt: 'p' }, ctx)).toEqual({ kind: 'all' });
  });

  it('未声明的工具（bash 等）缺省 all', () => {
    expect(toolAccessOf('bash', { command: 'ls' }, ctx)).toEqual({ kind: 'all' });
    expect(toolAccessOf('todo_list', { items: [] }, ctx)).toEqual({ kind: 'all' });
  });

  it('未知工具 / 入参非法 → 安全退化 all', () => {
    expect(toolAccessOf('nonexistent_tool', {}, ctx)).toEqual({ kind: 'all' });
    expect(toolAccessOf('read_file', { no_path: 1 }, ctx)).toEqual({ kind: 'all' });
  });
});
