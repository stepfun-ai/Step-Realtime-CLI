import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { SessionPicker } from '../../src/tui/SessionPicker.js';
import type { SessionMeta } from '../../src/session/store.js';

const delay = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

function meta(id: string, title: string, preview?: string): SessionMeta {
  const now = new Date().toISOString();
  return { id, cwd: 'C:/x', model: 'm', createdAt: now, updatedAt: now, messageCount: 3, title, preview };
}

describe('SessionPicker', () => {
  it('渲染显示各会话标题', () => {
    const { lastFrame } = render(
      React.createElement(SessionPicker, {
        sessions: [meta('id1', '第一个会话'), meta('id2', '第二个会话')],
        onSelect: () => {},
      }),
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('第一个会话');
    expect(out).toContain('第二个会话');
    expect(out).toContain('选择要恢复的会话');
  });

  it('下箭头 + 回车选中第二条，onSelect 带正确 id', async () => {
    const onSelect = vi.fn();
    const { stdin } = render(
      React.createElement(SessionPicker, {
        sessions: [meta('id1', 'a'), meta('id2', 'b')],
        onSelect,
      }),
    );
    await delay();
    stdin.write('\u001B[B'); // 下箭头
    await delay();
    stdin.write('\r'); // 回车
    await delay();
    expect(onSelect).toHaveBeenCalledWith('id2');
  });

  it('回车（不移动）选中第一条', async () => {
    const onSelect = vi.fn();
    const { stdin } = render(
      React.createElement(SessionPicker, {
        sessions: [meta('id1', 'a'), meta('id2', 'b')],
        onSelect,
      }),
    );
    await delay();
    stdin.write('\r');
    await delay();
    expect(onSelect).toHaveBeenCalledWith('id1');
  });

  it('Esc 触发 onSelect(null)', async () => {
    const onSelect = vi.fn();
    const { stdin } = render(
      React.createElement(SessionPicker, {
        sessions: [meta('id1', 'a')],
        onSelect,
      }),
    );
    await delay();
    stdin.write('\u001B'); // Esc
    await delay();
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it('输入过滤标题：只显示匹配项', async () => {
    const { lastFrame, stdin } = render(
      React.createElement(SessionPicker, {
        sessions: [meta('id1', '第一个会话'), meta('id2', '第二个会话')],
        onSelect: () => {},
      }),
    );
    await delay();
    stdin.write('第二');
    await delay();
    const out = lastFrame() ?? '';
    expect(out).toContain('第二个会话');
    expect(out).not.toContain('第一个会话');
  });

  it('preview 参与搜索匹配', async () => {
    const { lastFrame, stdin } = render(
      React.createElement(SessionPicker, {
        sessions: [meta('id1', 'aaa', '讨论 prompt cache 的会话'), meta('id2', 'bbb', '无关内容')],
        onSelect: () => {},
      }),
    );
    await delay();
    stdin.write('cache');
    await delay();
    const out = lastFrame() ?? '';
    expect(out).toContain('aaa');
    expect(out).not.toContain('bbb');
  });

  it('多词空格 AND：两个词都命中才保留', async () => {
    const { lastFrame, stdin } = render(
      React.createElement(SessionPicker, {
        sessions: [
          meta('id1', 'foo 项目', '讲了 bar 方案'),
          meta('id2', 'foo 其他', '没有第二个词'),
          meta('id3', 'bar 开头', '缺少目标词'),
        ],
        onSelect: () => {},
      }),
    );
    await delay();
    stdin.write('foo bar');
    await delay();
    const out = lastFrame() ?? '';
    expect(out).toContain('foo 项目');
    expect(out).not.toContain('foo 其他');
    expect(out).not.toContain('bar 开头');
  });

  it('无匹配时显示空态提示', async () => {
    const { lastFrame, stdin } = render(
      React.createElement(SessionPicker, {
        sessions: [meta('id1', 'a')],
        onSelect: () => {},
      }),
    );
    await delay();
    stdin.write('zzz');
    await delay();
    expect(lastFrame() ?? '').toContain('无匹配的会话');
  });

  it('过滤后回车选中匹配项', async () => {
    const onSelect = vi.fn();
    const { stdin } = render(
      React.createElement(SessionPicker, {
        sessions: [meta('id1', 'alpha'), meta('id2', 'beta')],
        onSelect,
      }),
    );
    await delay();
    stdin.write('beta');
    await delay();
    stdin.write('\r');
    await delay();
    expect(onSelect).toHaveBeenCalledWith('id2');
  });

  it('Backspace 删除搜索词字符，恢复全量列表', async () => {
    const { lastFrame, stdin } = render(
      React.createElement(SessionPicker, {
        sessions: [meta('id1', 'alpha'), meta('id2', 'beta')],
        onSelect: () => {},
      }),
    );
    await delay();
    stdin.write('beta');
    await delay();
    expect(lastFrame() ?? '').not.toContain('alpha');
    for (let i = 0; i < 4; i++) stdin.write('\x7f'); // Backspace ×4 清空 query
    await delay();
    const out = lastFrame() ?? '';
    expect(out).toContain('alpha');
    expect(out).toContain('beta');
  });

  it('Ctrl+D 发起删除确认，y 确认调用 onDelete 带高亮 id', async () => {
    const onDelete = vi.fn(() => true);
    const { lastFrame, stdin } = render(
      React.createElement(SessionPicker, {
        sessions: [meta('id1', '第一个会话'), meta('id2', '第二个会话')],
        onDelete,
        onSelect: () => {},
      }),
    );
    await delay();
    stdin.write('\x04'); // Ctrl+D 对高亮（第一条）发起删除
    await delay();
    expect(lastFrame() ?? '').toContain('删除会话'); // 进入二次确认态
    stdin.write('y'); // 确认
    await delay();
    expect(onDelete).toHaveBeenCalledWith('id1');
  });

  it('Delete 键发起删除确认，n 取消不调用 onDelete', async () => {
    const onDelete = vi.fn(() => true);
    const { lastFrame, stdin } = render(
      React.createElement(SessionPicker, {
        sessions: [meta('id1', 'a'), meta('id2', 'b')],
        onDelete,
        onSelect: () => {},
      }),
    );
    await delay();
    stdin.write('\u001B[3~'); // Delete 键
    await delay();
    expect(lastFrame() ?? '').toContain('删除会话');
    stdin.write('n'); // 取消
    await delay();
    expect(onDelete).not.toHaveBeenCalled();
    // 取消后回到列表，仍可见两条
    const out = lastFrame() ?? '';
    expect(out).toContain('a');
    expect(out).toContain('b');
  });

  it('确认态下 Esc 取消删除', async () => {
    const onDelete = vi.fn(() => true);
    const onSelect = vi.fn();
    const { stdin } = render(
      React.createElement(SessionPicker, {
        sessions: [meta('id1', 'a')],
        onDelete,
        onSelect,
      }),
    );
    await delay();
    stdin.write('\x04'); // Ctrl+D 进入确认
    await delay();
    stdin.write('\u001B'); // Esc 取消删除（不应触发 onSelect(null)）
    await delay();
    expect(onDelete).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('高亮为当前会话时拒绝删除并给提示', async () => {
    const onDelete = vi.fn(() => true);
    const { lastFrame, stdin } = render(
      React.createElement(SessionPicker, {
        sessions: [meta('id1', 'a'), meta('id2', 'b')],
        currentId: 'id1',
        onDelete,
        onSelect: () => {},
      }),
    );
    await delay();
    stdin.write('\x04'); // 高亮第一条（当前会话）发起删除
    await delay();
    expect(lastFrame() ?? '').toContain('无法删除当前正在使用的会话');
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('当前会话在列表中显示「当前」标记', () => {
    const { lastFrame } = render(
      React.createElement(SessionPicker, {
        sessions: [meta('id1', 'alpha'), meta('id2', 'beta')],
        currentId: 'id2',
        onSelect: () => {},
      }),
    );
    expect(lastFrame() ?? '').toContain('当前');
  });

  it('删除后列表刷新：移除该项后仅剩其余会话', async () => {
    const remaining = [meta('id1', 'alpha'), meta('id2', 'beta')];
    // 模拟上层删除：onDelete 返回 true，测试通过重渲染 sessions 验证组件消费新数组
    const onDelete = vi.fn((id: string) => {
      const idx = remaining.findIndex((m) => m.id === id);
      if (idx >= 0) remaining.splice(idx, 1);
      return true;
    });
    const { lastFrame, stdin, rerender } = render(
      React.createElement(SessionPicker, { sessions: remaining, onDelete, onSelect: () => {} }),
    );
    await delay();
    stdin.write('\x04'); // 删除高亮（alpha）
    await delay();
    stdin.write('y');
    await delay();
    expect(onDelete).toHaveBeenCalledWith('id1');
    rerender(React.createElement(SessionPicker, { sessions: remaining, onDelete, onSelect: () => {} }));
    await delay();
    const out = lastFrame() ?? '';
    expect(out).not.toContain('alpha');
    expect(out).toContain('beta');
  });

  it('展示口径 name ?? title：有自定义名显示名字，无则回退标题', () => {
    const named = { ...meta('id1', '派生标题'), name: '自定义名' };
    const { lastFrame } = render(
      React.createElement(SessionPicker, {
        sessions: [named, meta('id2', '只有标题')],
        onSelect: () => {},
      }),
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('自定义名');
    expect(out).not.toContain('派生标题');
    expect(out).toContain('只有标题');
  });

  it('自定义名参与搜索匹配', async () => {
    const named = { ...meta('id1', 'aaa'), name: '发布 checklist' };
    const { lastFrame, stdin } = render(
      React.createElement(SessionPicker, {
        sessions: [named, meta('id2', 'bbb')],
        onSelect: () => {},
      }),
    );
    await delay();
    stdin.write('checklist');
    await delay();
    const out = lastFrame() ?? '';
    expect(out).toContain('发布 checklist');
    expect(out).not.toContain('bbb');
  });

  it('r 进入重命名编辑态：可打印字符进名字草稿而非搜索词，Enter 保存', async () => {
    const onRename = vi.fn(() => true);
    const { lastFrame, stdin } = render(
      React.createElement(SessionPicker, {
        sessions: [meta('id1', '旧标题'), meta('id2', '其他')],
        onRename,
        onSelect: () => {},
      }),
    );
    await delay();
    stdin.write('r'); // 对高亮（第一条）进入重命名编辑态
    await delay();
    const editing = lastFrame() ?? '';
    expect(editing).toContain('重命名');
    // 编辑态下字符进名字草稿（草稿预填了标题，先退格清掉再输入）
    for (let i = 0; i < 3; i++) stdin.write('\x7f'); // 清掉「旧标题」
    await delay();
    stdin.write('新名字');
    await delay();
    // 搜索词没有吃到这些字符：列表未被过滤（「其他」仍可见）
    expect(lastFrame() ?? '').toContain('其他');
    stdin.write('\r'); // Enter 保存
    await delay();
    expect(onRename).toHaveBeenCalledWith('id1', '新名字');
  });

  it('重命名编辑态 Esc 取消：不保存、也不触发 onSelect(null)', async () => {
    const onRename = vi.fn(() => true);
    const onSelect = vi.fn();
    const { stdin } = render(
      React.createElement(SessionPicker, {
        sessions: [meta('id1', 'a')],
        onRename,
        onSelect,
      }),
    );
    await delay();
    stdin.write('r');
    await delay();
    stdin.write('xyz');
    await delay();
    stdin.write('\u001B'); // Esc 取消编辑
    await delay();
    expect(onRename).not.toHaveBeenCalled();
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('重命名保存空名 = 清除自定义名（onRename 收到空串）', async () => {
    const onRename = vi.fn(() => true);
    const named = { ...meta('id1', '标题'), name: '已有名字' };
    const { stdin } = render(
      React.createElement(SessionPicker, {
        sessions: [named],
        onRename,
        onSelect: () => {},
      }),
    );
    await delay();
    stdin.write('r'); // 草稿预填当前自定义名「已有名字」
    await delay();
    for (let i = 0; i < 4; i++) stdin.write('\x7f'); // 清空草稿
    await delay();
    stdin.write('\r'); // 空名保存
    await delay();
    expect(onRename).toHaveBeenCalledWith('id1', '');
  });

  it('未提供 onRename 时 r 落入搜索词（保持旧行为）', async () => {
    const { lastFrame, stdin } = render(
      React.createElement(SessionPicker, {
        sessions: [meta('id1', 'rocket 项目'), meta('id2', '其他')],
        onSelect: () => {},
      }),
    );
    await delay();
    stdin.write('r');
    await delay();
    const out = lastFrame() ?? '';
    // r 作为搜索词过滤：命中含 r 的标题
    expect(out).toContain('rocket 项目');
    expect(out).not.toContain('其他');
  });
});

describe('SessionPicker 子 agent 会话区', () => {
  it('渲染子会话区：来源标记（agentType · status）与区头可见', async () => {
    const sub: SessionMeta = { ...meta('sub1', '子会话标题'), agentType: 'explore', status: 'done' };
    const { lastFrame } = render(
      React.createElement(SessionPicker, {
        sessions: [meta('m1', '主会话')],
        subagents: [sub],
        onSelect: () => {},
      }),
    );
    await delay();
    const out = lastFrame() ?? '';
    expect(out).toContain('子 agent 会话');
    expect(out).toContain('子会话标题');
    expect(out).toContain('explore');
    expect(out).toContain('done');
  });

  it('下移到子会话区回车：onSelect 返回子会话 id（由上层区分下钻与恢复）', async () => {
    const onSelect = vi.fn();
    const sub: SessionMeta = { ...meta('sub1', '子会话'), agentType: 'general', status: 'done' };
    const { stdin } = render(
      React.createElement(SessionPicker, {
        sessions: [meta('m1', '主会话')],
        subagents: [sub],
        onSelect,
      }),
    );
    await delay();
    stdin.write('\u001B[B'); // 下箭头：主会话区 → 子会话区
    await delay();
    stdin.write('\r');
    await delay();
    expect(onSelect).toHaveBeenCalledWith('sub1');
  });

  it('子会话区不提供删除（Delete 落在子会话行上无反应）', async () => {
    const onDelete = vi.fn();
    const sub: SessionMeta = { ...meta('sub1', '子会话'), agentType: 'general', status: 'done' };
    const { stdin } = render(
      React.createElement(SessionPicker, {
        sessions: [meta('m1', '主会话')],
        subagents: [sub],
        onSelect: () => {},
        onDelete,
      }),
    );
    await delay();
    stdin.write('\u001B[B'); // 移到子会话行
    await delay();
    stdin.write('\u0004'); // Ctrl+D
    await delay();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it('子会话超过 5 条时游标可走到第 6 条及以后（滑动窗口跟随，待办 #25）', async () => {
    const onSelect = vi.fn();
    const subs = Array.from({ length: 8 }, (_, i) => ({
      ...meta(`sub${i}`, `子会话${i}`),
      agentType: 'general',
      status: 'done',
    }));
    const { stdin, lastFrame } = render(
      React.createElement(SessionPicker, {
        sessions: [meta('m1', '主会话')],
        subagents: subs,
        onSelect,
      }),
    );
    await delay();
    // 初始窗口只显示前 5 条
    expect(lastFrame() ?? '').toContain('子会话0');
    expect(lastFrame() ?? '').not.toContain('子会话5');
    // 下移 6 次：主会话(1) → 子区第 6 条
    for (let i = 0; i < 6; i++) {
      stdin.write('[B');
      await delay();
    }
    // 窗口已滑动：第 6 条可见且被高亮（› 指针），最早条目滑出窗口
    const out = lastFrame() ?? '';
    expect(out).toContain('› 子会话5');
    expect(out).not.toContain('子会话0');
    // 回车选中第 6 条——此前它永远不可达
    stdin.write('\r');
    await delay();
    expect(onSelect).toHaveBeenCalledWith('sub5');
  });

  it('子会话超 5 条时区头带窗口区间指示，且不额外占行', async () => {
    const subs = Array.from({ length: 12 }, (_, i) => ({
      ...meta(`sub${i}`, `子会话${i}`),
      agentType: 'general',
      status: 'done',
    }));
    const { lastFrame } = render(
      React.createElement(SessionPicker, {
        sessions: [meta('m1', '主会话')],
        subagents: subs,
        onSelect: () => {},
      }),
    );
    await delay();
    const out = lastFrame() ?? '';
    expect(out).toContain('1-5/12');
  });
});
