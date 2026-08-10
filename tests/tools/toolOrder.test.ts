import { z } from 'zod';
import { afterEach, describe, expect, it } from 'vitest';
import {
  toAnthropicTools,
  registerDynamicTool,
  clearDynamicTools,
} from '../../src/tools/index.js';
import type { ToolDef } from '../../src/tools/types.js';

/**
 * tools 数组顺序保险：prompt cache 的 tools 断点打在「最后一个 tool」上，缓存整段 tools 前缀。
 * 一旦 tools 顺序或内容在两轮请求间无意改变，tools 前缀缓存就会被击穿。这些测试钉住：
 * 顺序确定、静态前缀稳定、动态工具只追加在尾部、白名单过滤保持相对顺序。
 */
function fakeTool(name: string): ToolDef<Record<string, never>> {
  return {
    name,
    description: `fake ${name}`,
    schema: z.object({}),
    async execute() {
      return { content: 'ok', isError: false };
    },
  };
}

describe('toAnthropicTools 顺序稳定性（prompt cache 前缀保护）', () => {
  afterEach(() => {
    clearDynamicTools();
  });

  it('无参调用：多次结果的名字序列完全一致（确定性）', () => {
    const a = toAnthropicTools().map((t) => t.name);
    const b = toAnthropicTools().map((t) => t.name);
    expect(a).toEqual(b);
    expect(a.length).toBeGreaterThan(0);
  });

  it('动态工具只追加在尾部，静态前缀原样不变', () => {
    const before = toAnthropicTools().map((t) => t.name);
    registerDynamicTool(fakeTool('zzz_dynamic_tool'));
    const after = toAnthropicTools().map((t) => t.name);
    // 前缀 == 注册前的完整静态序列
    expect(after.slice(0, before.length)).toEqual(before);
    // 新工具落在末尾
    expect(after[after.length - 1]).toBe('zzz_dynamic_tool');
  });

  it('多个动态工具按注册顺序追加在尾部', () => {
    const baseLen = toAnthropicTools().length;
    registerDynamicTool(fakeTool('dyn_a'));
    registerDynamicTool(fakeTool('dyn_b'));
    const names = toAnthropicTools().map((t) => t.name);
    expect(names.slice(baseLen)).toEqual(['dyn_a', 'dyn_b']);
  });

  it('与静态工具同名的动态工具不重复出现（以静态为准）', () => {
    const names = toAnthropicTools().map((t) => t.name);
    const anyStatic = names[0]!;
    registerDynamicTool(fakeTool(anyStatic));
    const after = toAnthropicTools().map((t) => t.name);
    expect(after.filter((n) => n === anyStatic)).toHaveLength(1);
    expect(after).toEqual(names); // 顺序与内容均不变
  });

  it('白名单过滤保持工具在全量中的相对顺序（非白名单入参顺序）', () => {
    const full = toAnthropicTools().map((t) => t.name);
    const pick = [full[3]!, full[1]!]; // 故意逆序传入
    const filtered = toAnthropicTools(pick).map((t) => t.name);
    // 结果按全量相对顺序，而非入参顺序
    expect(filtered).toEqual([full[1]!, full[3]!]);
  });
});
