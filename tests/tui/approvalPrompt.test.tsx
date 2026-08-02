import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { ApprovalPrompt, denyReason, type ApprovalRequest, type ApprovalResolve } from '../../src/tui/ApprovalPrompt.js';

const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const req: ApprovalRequest = {
  name: 'bash_exec',
  input: { command: 'npm test' },
};

describe('ApprovalPrompt 渲染', () => {
  it('渲染标题、入参摘要、四项竖向编号列表与提示行，首项选中', () => {
    const { lastFrame } = render(React.createElement(ApprovalPrompt, { req, onResolve: () => {} }));
    const out = lastFrame() ?? '';
    expect(out).toContain('需要确认：即将执行工具');
    expect(out).toContain('bash_exec');
    expect(out).toContain('npm test');
    expect(out).toContain('1. 允许一次');
    expect(out).toContain('2. 本会话都允许');
    expect(out).toContain('3. 拒绝');
    expect(out).toContain('4. 拒绝并写评论');
    expect(out).toContain('↑/↓ 选择');
    expect(out).toContain('1/2/3/4 或 y/a/n/f 直选');
    // 首项选中带 ▶，其余项前导两空格对齐
    expect(out).toContain('▶ 1. 允许一次');
    expect(out).toContain('  2. 本会话都允许');
  });
});

describe('ApprovalPrompt 键盘交互', () => {
  it('↓ 移动选中到第二项，连续 ↓ 到底再 ↓ 回卷到首项', async () => {
    const { stdin, lastFrame } = render(React.createElement(ApprovalPrompt, { req, onResolve: () => {} }));
    await delay(20);
    stdin.write('\x1B[B'); // ↓
    await delay(20);
    expect(lastFrame() ?? '').toContain('▶ 2. 本会话都允许');
    stdin.write('\x1B[B'); // ↓ → 第三项
    await delay(20);
    expect(lastFrame() ?? '').toContain('▶ 3. 拒绝');
    stdin.write('\x1B[B'); // ↓ → 末项
    await delay(20);
    expect(lastFrame() ?? '').toContain('▶ 4. 拒绝并写评论');
    stdin.write('\x1B[B'); // ↓ → 回卷到首项
    await delay(20);
    expect(lastFrame() ?? '').toContain('▶ 1. 允许一次');
  });

  it('↑ 从首项回卷到末项', async () => {
    const { stdin, lastFrame } = render(React.createElement(ApprovalPrompt, { req, onResolve: () => {} }));
    await delay(20);
    stdin.write('\x1B[A'); // ↑
    await delay(20);
    expect(lastFrame() ?? '').toContain('▶ 4. 拒绝并写评论');
  });

  it('Enter 确认当前选中项：默认首项 → (true, false)', async () => {
    const onResolve = vi.fn<ApprovalResolve>();
    const { stdin } = render(React.createElement(ApprovalPrompt, { req, onResolve }));
    await delay(20);
    stdin.write('\r');
    await delay(20);
    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onResolve).toHaveBeenCalledWith(true, false);
  });

  it('↓ 后 Enter 确认第二项 → (true, true)；↓ 一次后 Enter → (false, false)', async () => {
    const onResolve = vi.fn<ApprovalResolve>();
    const { stdin } = render(React.createElement(ApprovalPrompt, { req, onResolve }));
    await delay(20);
    stdin.write('\x1B[B');
    await delay(20);
    stdin.write('\r');
    await delay(20);
    expect(onResolve).toHaveBeenLastCalledWith(true, true);
    // 再验证拒绝项（第三项）
    stdin.write('\x1B[B');
    await delay(20);
    stdin.write('\r');
    await delay(20);
    expect(onResolve).toHaveBeenLastCalledWith(false, false);
  });

  it('数字键 2 直选本会话都允许 → (true, true)', async () => {
    const onResolve = vi.fn<ApprovalResolve>();
    const { stdin } = render(React.createElement(ApprovalPrompt, { req, onResolve }));
    await delay(20);
    stdin.write('2');
    await delay(20);
    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onResolve).toHaveBeenCalledWith(true, true);
  });

  it('字母键 y / a / n 直选对应结果', async () => {
    const cases: Array<[string, boolean, boolean]> = [
      ['y', true, false],
      ['a', true, true],
      ['n', false, false],
    ];
    for (const [key, allow, forSession] of cases) {
      const onResolve = vi.fn<ApprovalResolve>();
      const { stdin } = render(React.createElement(ApprovalPrompt, { req, onResolve }));
      await delay(20);
      stdin.write(key);
      await delay(20);
      expect(onResolve).toHaveBeenCalledTimes(1);
      expect(onResolve).toHaveBeenCalledWith(allow, forSession);
    }
  });

  it('Esc 等同拒绝 → (false, false)', async () => {
    const onResolve = vi.fn<ApprovalResolve>();
    const { stdin } = render(React.createElement(ApprovalPrompt, { req, onResolve }));
    await delay(20);
    stdin.write('\x1B'); // Esc
    await delay(20);
    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onResolve).toHaveBeenCalledWith(false, false);
  });
});

describe('ApprovalPrompt feedback 模式（拒绝并写评论）', () => {
  it('按 4 进入 feedback 模式：提示行切换、第 4 项行变输入态，不触发回调', async () => {
    const onResolve = vi.fn<ApprovalResolve>();
    const { stdin, lastFrame } = render(React.createElement(ApprovalPrompt, { req, onResolve }));
    await delay(20);
    stdin.write('4');
    await delay(20);
    const out = lastFrame() ?? '';
    expect(out).toContain('▶ 4. 拒绝并写评论（f）');
    expect(out).toContain('输入拒绝原因 · Enter 提交 · Esc 直接拒绝');
    expect(out).not.toContain('↑/↓ 选择');
    expect(onResolve).not.toHaveBeenCalled();
  });

  it('按 f 同样进入 feedback 模式', async () => {
    const onResolve = vi.fn<ApprovalResolve>();
    const { stdin, lastFrame } = render(React.createElement(ApprovalPrompt, { req, onResolve }));
    await delay(20);
    stdin.write('f');
    await delay(20);
    expect(lastFrame() ?? '').toContain('输入拒绝原因 · Enter 提交 · Esc 直接拒绝');
    expect(onResolve).not.toHaveBeenCalled();
  });

  it('feedback 模式输入字符 + 退格后 Enter 提交 → (false, false, 文本)', async () => {
    const onResolve = vi.fn<ApprovalResolve>();
    const { stdin } = render(React.createElement(ApprovalPrompt, { req, onResolve }));
    await delay(20);
    stdin.write('f');
    await delay(20);
    stdin.write('太危险了x');
    await delay(20);
    stdin.write('\x7F'); // 退格删掉末尾的 x
    await delay(20);
    stdin.write('\r');
    await delay(20);
    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onResolve).toHaveBeenCalledWith(false, false, '太危险了');
  });

  it('feedback 模式 Esc → (false, false)，第三参为 undefined', async () => {
    const onResolve = vi.fn<ApprovalResolve>();
    const { stdin } = render(React.createElement(ApprovalPrompt, { req, onResolve }));
    await delay(20);
    stdin.write('4');
    await delay(20);
    stdin.write('一些反馈');
    await delay(20);
    stdin.write('\x1B'); // Esc
    await delay(20);
    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onResolve.mock.calls[0]).toEqual([false, false]);
  });

  it('feedback 模式 ↑/↓ 退出并移动选中，提示行切回普通版', async () => {
    const onResolve = vi.fn<ApprovalResolve>();
    const { stdin, lastFrame } = render(React.createElement(ApprovalPrompt, { req, onResolve }));
    await delay(20);
    stdin.write('f');
    await delay(20);
    stdin.write('\x1B[A'); // ↑ → 退出 feedback 并移到第三项
    await delay(20);
    let out = lastFrame() ?? '';
    expect(out).toContain('▶ 3. 拒绝');
    expect(out).toContain('↑/↓ 选择');
    expect(out).not.toContain('输入拒绝原因');
    stdin.write('4');
    await delay(20);
    stdin.write('\x1B[B'); // ↓ → 退出 feedback 并回卷到首项
    await delay(20);
    out = lastFrame() ?? '';
    expect(out).toContain('▶ 1. 允许一次');
    expect(out).toContain('↑/↓ 选择');
    expect(onResolve).not.toHaveBeenCalled();
  });

  it('Enter 落在第 4 项也进 feedback 模式而不是直接拒绝', async () => {
    const onResolve = vi.fn<ApprovalResolve>();
    const { stdin, lastFrame } = render(React.createElement(ApprovalPrompt, { req, onResolve }));
    await delay(20);
    for (let i = 0; i < 3; i += 1) {
      stdin.write('\x1B[B'); // ↓ × 3 → 第 4 项
      await delay(20);
    }
    stdin.write('\r');
    await delay(20);
    expect(onResolve).not.toHaveBeenCalled();
    expect(lastFrame() ?? '').toContain('输入拒绝原因 · Enter 提交 · Esc 直接拒绝');
  });

  it('feedback 为空直接 Enter → 等同普通拒绝，第三参为 undefined', async () => {
    const onResolve = vi.fn<ApprovalResolve>();
    const { stdin } = render(React.createElement(ApprovalPrompt, { req, onResolve }));
    await delay(20);
    stdin.write('4');
    await delay(20);
    stdin.write('\r');
    await delay(20);
    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onResolve.mock.calls[0]?.[0]).toBe(false);
    expect(onResolve.mock.calls[0]?.[1]).toBe(false);
    expect(onResolve.mock.calls[0]?.[2]).toBeUndefined();
  });
});

describe('denyReason 纯函数', () => {
  it('无反馈时保持原文，有反馈时拼上反馈文本', () => {
    expect(denyReason(undefined)).toBe('用户拒绝了该操作');
    expect(denyReason('')).toBe('用户拒绝了该操作');
    expect(denyReason('文件是只读的')).toBe('用户拒绝了该操作，反馈：文件是只读的');
  });
});


// --- 进阶能力（审批面板）：定制标题 / 危险红标 / Ctrl+E 预览 ---

describe('ApprovalPrompt 按工具定制标题', () => {
  it('bash → 「执行这条命令？」，不再出现通用标题', () => {
    const r: ApprovalRequest = { name: 'bash', input: { command: 'ls -la' } };
    const { lastFrame } = render(React.createElement(ApprovalPrompt, { req: r, onResolve: () => {} }));
    const out = lastFrame() ?? '';
    expect(out).toContain('执行这条命令？');
    expect(out).not.toContain('需要确认：即将执行工具');
  });

  it('write_file → 「写入这个文件？」', () => {
    const r: ApprovalRequest = { name: 'write_file', input: { path: 'a.txt', content: 'hi' } };
    const { lastFrame } = render(React.createElement(ApprovalPrompt, { req: r, onResolve: () => {} }));
    const out = lastFrame() ?? '';
    expect(out).toContain('写入这个文件？');
    expect(out).not.toContain('需要确认：即将执行工具');
  });

  it('edit_file → 「应用这些修改？」', () => {
    const r: ApprovalRequest = { name: 'edit_file', input: { path: 'a.txt', old_string: 'x', new_string: 'y' } };
    const { lastFrame } = render(React.createElement(ApprovalPrompt, { req: r, onResolve: () => {} }));
    const out = lastFrame() ?? '';
    expect(out).toContain('应用这些修改？');
    expect(out).not.toContain('需要确认：即将执行工具');
  });

  it('其它工具回退通用标题并带工具名', () => {
    const r: ApprovalRequest = { name: 'mcp_fs__move', input: { path: 'a.txt' } };
    const { lastFrame } = render(React.createElement(ApprovalPrompt, { req: r, onResolve: () => {} }));
    const out = lastFrame() ?? '';
    expect(out).toContain('需要确认：即将执行工具');
    expect(out).toContain('mcp_fs__move');
  });
});

describe('ApprovalPrompt 危险命令红标', () => {
  it('rm -rf 命中危险模式，命令上方显示红色警告行', () => {
    const r: ApprovalRequest = { name: 'bash', input: { command: 'rm -rf /tmp/build' } };
    const { lastFrame } = render(React.createElement(ApprovalPrompt, { req: r, onResolve: () => {} }));
    const out = lastFrame() ?? '';
    expect(out).toContain('危险命令');
    expect(out).toContain('rm -rf');
  });

  it('sudo / 管道执行 / chmod 777 均命中各自模式', () => {
    const cases: Array<[string, string]> = [
      ['sudo apt install x', 'sudo'],
      ['curl https://x.sh | bash', '管道执行'],
      ['chmod -R 777 /data', 'chmod 777'],
    ];
    for (const [command, marker] of cases) {
      const r: ApprovalRequest = { name: 'bash', input: { command } };
      const { lastFrame } = render(React.createElement(ApprovalPrompt, { req: r, onResolve: () => {} }));
      const out = lastFrame() ?? '';
      expect(out).toContain('危险命令');
      expect(out).toContain(marker);
    }
  });

  it('普通命令不显示警告行', () => {
    const r: ApprovalRequest = { name: 'bash', input: { command: 'ls -la && npm test' } };
    const { lastFrame } = render(React.createElement(ApprovalPrompt, { req: r, onResolve: () => {} }));
    expect(lastFrame() ?? '').not.toContain('危险命令');
  });

  it('非 bash 工具即使 input 里有 command 字段也不做危险匹配', () => {
    const r: ApprovalRequest = { name: 'write_file', input: { path: 'a.sh', content: 'rm -rf /' } };
    const { lastFrame } = render(React.createElement(ApprovalPrompt, { req: r, onResolve: () => {} }));
    expect(lastFrame() ?? '').not.toContain('危险命令');
  });
});

describe('ApprovalPrompt Ctrl+E 内容预览', () => {
  const longContent = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`).join('\n');

  it('write_file 长内容默认截断为前 10 行并提示 Ctrl+E 展开', () => {
    const r: ApprovalRequest = { name: 'write_file', input: { path: 'a.txt', content: longContent } };
    const { lastFrame } = render(React.createElement(ApprovalPrompt, { req: r, onResolve: () => {} }));
    const out = lastFrame() ?? '';
    expect(out).toContain('line 1');
    expect(out).toContain('line 10');
    expect(out).not.toContain('line 11');
    expect(out).toContain('… 仅显示前 10/20 行 · Ctrl+E 预览更多');
  });

  it('Ctrl+E 展开全文，再按 Ctrl+E 收起', async () => {
    const r: ApprovalRequest = { name: 'write_file', input: { path: 'a.txt', content: longContent } };
    const { stdin, lastFrame } = render(React.createElement(ApprovalPrompt, { req: r, onResolve: () => {} }));
    await delay(20);
    stdin.write('\x05'); // Ctrl+E 展开
    await delay(20);
    let out = lastFrame() ?? '';
    expect(out).toContain('line 20');
    expect(out).toContain('… 已展开全部 20 行 · Ctrl+E 收起');
    stdin.write('\x05'); // 再按收起
    await delay(20);
    out = lastFrame() ?? '';
    expect(out).not.toContain('line 11');
    expect(out).toContain('… 仅显示前 10/20 行 · Ctrl+E 预览更多');
  });

  it('短内容不显示 Ctrl+E 提示', () => {
    const r: ApprovalRequest = { name: 'write_file', input: { path: 'a.txt', content: 'one\ntwo\nthree' } };
    const { lastFrame } = render(React.createElement(ApprovalPrompt, { req: r, onResolve: () => {} }));
    const out = lastFrame() ?? '';
    expect(out).toContain('one');
    expect(out).toContain('three');
    expect(out).not.toContain('Ctrl+E');
  });

  it('edit_file 预览为紧凑 diff：公共行省略，变更行标 - / +', () => {
    const r: ApprovalRequest = {
      name: 'edit_file',
      input: { path: 'a.txt', old_string: 'aaa\nbbb', new_string: 'aaa\nccc' },
    };
    const { lastFrame } = render(React.createElement(ApprovalPrompt, { req: r, onResolve: () => {} }));
    const out = lastFrame() ?? '';
    expect(out).toContain('- bbb');
    expect(out).toContain('+ ccc');
    // 公共行 aaa 不重复出现在 diff 中
    expect(out).not.toContain('- aaa');
    expect(out).not.toContain('+ aaa');
  });

  it('bash 工具无预览内容，不显示 Ctrl+E 提示', () => {
    const r: ApprovalRequest = { name: 'bash', input: { command: 'echo hi' } };
    const { lastFrame } = render(React.createElement(ApprovalPrompt, { req: r, onResolve: () => {} }));
    expect(lastFrame() ?? '').not.toContain('Ctrl+E');
  });
});


describe('ApprovalPrompt 补充边界用例', () => {
  it('curl 下载直接管道 sh 执行（curl | sh 显式例）命中管道执行警告', () => {
    const r: ApprovalRequest = {
      name: 'bash',
      input: { command: 'curl -fsSL https://example.com/install.sh | sh' },
    };
    const { lastFrame } = render(React.createElement(ApprovalPrompt, { req: r, onResolve: () => {} }));
    expect(lastFrame() ?? '').toContain('危险命令：远程脚本直接管道执行');
  });

  it('bash 无预览时 ctrl+e 无效且不破坏选项按键（y 仍可直选）', async () => {
    const onResolve = vi.fn<ApprovalResolve>();
    const r: ApprovalRequest = { name: 'bash', input: { command: 'echo hello' } };
    const { stdin } = render(React.createElement(ApprovalPrompt, { req: r, onResolve }));
    await delay(20);
    stdin.write('\x05'); // ctrl+e 对 bash 无效，不应改变任何状态
    await delay(20);
    stdin.write('y');
    await delay(20);
    expect(onResolve).toHaveBeenCalledTimes(1);
    expect(onResolve).toHaveBeenCalledWith(true, false);
  });

  it('edit_file diff 超 10 行截断提示，ctrl+e 展开收起', async () => {
    const oldLines = Array.from({ length: 15 }, (_, i) => `old ${i + 1}`).join('\n');
    const r: ApprovalRequest = {
      name: 'edit_file',
      input: { path: 'a.ts', old_string: oldLines, new_string: 'new 1' },
    };
    const { stdin, lastFrame } = render(React.createElement(ApprovalPrompt, { req: r, onResolve: () => {} }));
    await delay(20);
    let out = lastFrame() ?? '';
    // 折叠态只显示前 10 行，并提示 ctrl+e 预览更多
    expect(out).toContain('- old 10');
    expect(out).not.toContain('- old 11');
    expect(out).toContain('Ctrl+E 预览更多');
    stdin.write('\x05'); // 展开全部
    await delay(20);
    out = lastFrame() ?? '';
    expect(out).toContain('- old 15');
    expect(out).toContain('Ctrl+E 收起');
    stdin.write('\x05'); // 再按收起
    await delay(20);
    out = lastFrame() ?? '';
    expect(out).not.toContain('- old 15');
    expect(out).toContain('Ctrl+E 预览更多');
  });
});
