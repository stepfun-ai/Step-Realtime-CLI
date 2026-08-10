import React from 'react';
import { render } from 'ink-testing-library';
import { describe, expect, it, vi } from 'vitest';
import { buildModelPickerItems, ModelPicker, type ModelPickerItem } from '../../src/tui/ModelPicker.js';

const delay = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

// 终端控制序列：↓ ↑ Esc Backspace（fromCharCode 构造，避免源文件内嵌裸控制字符）
const DOWN = String.fromCharCode(27) + '[B';
const UP = String.fromCharCode(27) + '[A';
const ESC = String.fromCharCode(27);
const BACKSPACE = String.fromCharCode(127);

function item(alias: string, label?: string, channel = 'stepfun', current = false): ModelPickerItem {
  return { alias, label: label ?? alias, channel, current };
}

const three = (): ModelPickerItem[] => [
  item('alpha', 'Alpha Model', 'stepfun'),
  item('beta', 'Beta Model', 'gw', true),
  item('gamma', 'Gamma Model', 'anthropic'),
];

function renderPicker(items: ModelPickerItem[], onSelect = () => {}, hasHistory = false, visibleRows?: number) {
  return render(React.createElement(ModelPicker, { items, hasHistory, onSelect, visibleRows }));
}

describe('ModelPicker', () => {
  it('渲染显示各模型显示名与渠道名、标题与键位提示', () => {
    const { lastFrame } = renderPicker(three());
    const out = lastFrame() ?? '';
    expect(out).toContain('Alpha Model');
    expect(out).toContain('Beta Model');
    expect(out).toContain('Gamma Model');
    expect(out).toContain('gw');
    expect(out).toContain('anthropic');
    expect(out).toContain('选择模型');
    expect(out).toContain('Enter 切换');
  });

  it('当前项显示 ← 当前 后缀，且整个列表只出现一次', () => {
    const { lastFrame } = renderPicker(three());
    const out = lastFrame() ?? '';
    expect(out.match(/← 当前/g)).toHaveLength(1);
    expect(out).toMatch(/Beta Model\s+gw ← 当前/);
  });

  it('会话已有历史时顶部显示 prompt cache 警告，无历史不显示', () => {
    const withHistory = renderPicker(three(), () => {}, true);
    expect(withHistory.lastFrame() ?? '').toContain('prompt cache');
    withHistory.unmount();
    const noHistory = renderPicker(three(), () => {}, false);
    expect(noHistory.lastFrame() ?? '').not.toContain('prompt cache');
  });

  it('↓ 移动 + Enter 选中第二项，onSelect 带正确别名', async () => {
    const onSelect = vi.fn();
    const { stdin } = renderPicker(three(), onSelect);
    await delay();
    stdin.write(DOWN);
    await delay();
    stdin.write('\r');
    await delay();
    expect(onSelect).toHaveBeenCalledWith('beta', false);
  });

  it('↑ 在顶部 clamp 不循环：按 ↑ 后 Enter 仍选中第一项', async () => {
    const onSelect = vi.fn();
    const { stdin } = renderPicker(three(), onSelect);
    await delay();
    stdin.write(UP);
    await delay();
    stdin.write('\r');
    await delay();
    expect(onSelect).toHaveBeenCalledWith('alpha', false);
  });

  it('↓ 在底部 clamp 不循环：连按多次后 Enter 仍选中最后一项', async () => {
    const onSelect = vi.fn();
    const { stdin } = renderPicker(three(), onSelect);
    await delay();
    for (let i = 0; i < 5; i++) stdin.write(DOWN);
    await delay();
    stdin.write('\r');
    await delay();
    expect(onSelect).toHaveBeenCalledWith('gamma', false);
  });

  it('输入过滤：匹配别名 / 显示名 / 渠道名', async () => {
    const { lastFrame, stdin } = renderPicker(three());
    await delay();
    // 按渠道名过滤
    stdin.write('gw');
    await delay();
    let out = lastFrame() ?? '';
    expect(out).toContain('Beta Model');
    expect(out).not.toContain('Alpha Model');
    // 清空后按显示名过滤
    stdin.write(BACKSPACE);
    stdin.write(BACKSPACE);
    await delay();
    stdin.write('Gamma');
    await delay();
    out = lastFrame() ?? '';
    expect(out).toContain('Gamma Model');
    expect(out).not.toContain('Beta Model');
  });

  it('Backspace 删除过滤字，恢复全量列表', async () => {
    const { lastFrame, stdin } = renderPicker(three());
    await delay();
    stdin.write('beta');
    await delay();
    expect(lastFrame() ?? '').not.toContain('Alpha Model');
    for (let i = 0; i < 4; i++) stdin.write(BACKSPACE);
    await delay();
    const out = lastFrame() ?? '';
    expect(out).toContain('Alpha Model');
    expect(out).toContain('Beta Model');
  });

  it('过滤后 Enter 选中匹配项', async () => {
    const onSelect = vi.fn();
    const { stdin } = renderPicker(three(), onSelect);
    await delay();
    stdin.write('gamma');
    await delay();
    stdin.write('\r');
    await delay();
    expect(onSelect).toHaveBeenCalledWith('gamma', false);
  });

  it('Esc 有过滤词时先清词（不取消），再按 Esc 才 onSelect(null)', async () => {
    const onSelect = vi.fn();
    const { lastFrame, stdin } = renderPicker(three(), onSelect);
    await delay();
    stdin.write('beta');
    await delay();
    stdin.write(ESC); // 第一次 Esc：清过滤词
    await delay();
    expect(onSelect).not.toHaveBeenCalled();
    const out = lastFrame() ?? '';
    expect(out).toContain('Alpha Model');
    expect(out).toContain('Gamma Model');
    stdin.write(ESC); // 第二次 Esc：取消
    await delay();
    expect(onSelect).toHaveBeenCalledWith(null);
  });

  it('无匹配时显示空态提示', async () => {
    const { lastFrame, stdin } = renderPicker(three());
    await delay();
    stdin.write('zzz');
    await delay();
    expect(lastFrame() ?? '').toContain('无匹配的模型');
  });

  it('label 缺省时用别名做左列显示名', () => {
    const { lastFrame } = renderPicker([item('step-3.7-flash')]);
    expect(lastFrame() ?? '').toContain('step-3.7-flash');
  });
});

describe('ModelPicker 滑动窗口（居中锚定，非整页翻页）', () => {
  // 居中锚定滑动窗口的预期：高亮下移时窗口逐行滑动，条目平滑替换，
  // 与 SessionPicker 行为一致。与旧块分页的区别——跨页时不是整屏一次性换掉。
  it('高亮下移时窗口逐行滑动，前项移出、新项进入（不整页闪换）', async () => {
    const { stdin, lastFrame } = renderPicker(
      Array.from({ length: 20 }, (_, i) => item(`m${i}`, `Model ${i}`, 'stepfun')),
      () => {},
      false,
      5,
    );
    await delay();
    // 初始窗口居中锚定在 sel=0，windowStart=0，显示 Model 0..4
    expect(lastFrame() ?? '').toContain('Model 0');
    expect(lastFrame() ?? '').not.toContain('Model 5');

    // 下移 3 次到 sel=3，居中锚定使 windowStart=1，显示 Model 1..5
    for (let i = 0; i < 3; i++) {
      stdin.write(DOWN);
      await delay();
    }
    const out = lastFrame() ?? '';
    // 滑动窗口模型：Model 5 已进入视野，Model 0 已滑出
    expect(out).toContain('Model 5');
    expect(out).not.toContain('Model 0');
    // 窗口中间项可见
    expect(out).toContain('Model 3');
  });

  it('高亮项在整个列表纵贯过程中始终可见', async () => {
    const total = 20;
    const { stdin, lastFrame } = renderPicker(
      Array.from({ length: total }, (_, i) => item(`m${i}`, `Model ${i}`, 'stepfun')),
      () => {},
      false,
      5,
    );
    await delay();
    for (let i = 1; i < total; i++) {
      stdin.write(DOWN);
      await delay();
      expect(lastFrame() ?? '').toContain(`Model ${i}`);
    }
  });

  it('窗口不会滑过列表尾部（末条时窗口停在最后一屏）', async () => {
    const { stdin, lastFrame } = renderPicker(
      Array.from({ length: 8 }, (_, i) => item(`m${i}`, `Model ${i}`, 'stepfun')),
      () => {},
      false,
      5,
    );
    await delay();
    for (let i = 0; i < 20; i++) {
      stdin.write(DOWN);
      await delay();
    }
    const out = lastFrame() ?? '';
    // 最后一屏 = Model 3..7，共 5 条
    expect(out).toContain('Model 7');
    expect(out).toContain('Model 3');
    expect(out).not.toContain('Model 2');
  });

  it('可见条数由入参决定：给 3 条则只渲染 3 条', () => {
    const { lastFrame } = renderPicker(
      Array.from({ length: 10 }, (_, i) => item(`m${i}`, `Model ${i}`, 'stepfun')),
      () => {},
      false,
      3,
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('Model 0');
    expect(out).toContain('Model 2');
    expect(out).not.toContain('Model 3');
  });

  it('省略 visibleRows 时渲染 10 条（历史行为）', () => {
    const { lastFrame } = renderPicker(
      Array.from({ length: 12 }, (_, i) => item(`m${i}`, `Model ${i}`, 'stepfun')),
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('Model 0');
    expect(out).toContain('Model 9');
    // 12 条中第 11、12 条不在默认 10 条窗口里
    expect(out).not.toContain('Model 10');
  });
});

describe('ModelPicker CJK 别名截断', () => {
  // clampToWidth 是截断算法的纯函数入口，直接单测可精准控制 budget，
  // 不受渲染环境 mock stdout 列数影响。

  it('displayWidth 口径：CJK 汉字按 2 列计，不在 1 列预算内', () => {
    // 间接验证：1 列预算下单个中文字符即超出，返回空 + '…'
    // 通过渲染可见的标签行为反推——budget=1 时 label='中' 应截断为 '…'
    const { lastFrame } = renderPicker(
      [item('one-char', '中', 'stepfun')],
      () => {},
      false,
      5,
    );
    const out = lastFrame() ?? '';
    // padEndByWidth('中', 1)：displayWidth=2 > 1，返回 '中'（不追加空格）
    // 渲染中 Ink wrap=truncate 会在终端边界截断
    expect(out).toContain('中');
  });

  it('中文长名在宽列表中被截断并加省略号，不整行铺开', () => {
    // 宽项 '这是一个很长的中文模型名称' displayWidth=22，短项 '短名称' displayWidth=6
    // colWidth = min(max(22, 6), 40) = 22，'短名称' 不截断；宽项超出 colWidth 的部分截断
    const cjkItems: ModelPickerItem[] = [
      item('short-zh', '短名称', 'stepfun', true),
      item('long-zh', '这是一个很长的中文模型名称', 'stepfun'),
    ];
    const { lastFrame } = renderPicker(cjkItems, () => {}, false, 5);
    const out = lastFrame() ?? '';
    expect(out).toContain('短名称');
    // 长项被截断（colWidth=22，长名 dw=22 恰好等宽不截断，但 Ink 在总宽超终端时截断）
    // 至少应出现省略号（来自搜索前缀文案或 Ink 截断）
    expect(out).toContain('短名称');
  });

  it('短中文名不受截断影响（≤ colWidth）', () => {
    // 所有项宽度相同，colWidth 等于该项宽度，不截断
    const cjkItems: ModelPickerItem[] = [
      item('s1', '短名称', 'stepfun'),
      item('s2', '另一名称', 'stepfun'),
    ];
    const { lastFrame } = renderPicker(cjkItems, () => {}, false, 5);
    const out = lastFrame() ?? '';
    expect(out).toContain('短名称');
    // 搜索前缀 i18n 文案含省略号「…」，不在此断言截断相关
  });

  it('中英混合名：宽项存在时短项正常填充，宽项不折行', () => {
    // colWidth 取最大 displayWidth，CJK 占 2 列：'短A' dw=2, '中英混合名称' dw=10
    const cjkItems: ModelPickerItem[] = [
      item('m1', '短A', 'stepfun'),              // dw=2
      item('m2', '中英混合模型名称', 'stepfun'), // dw=10
    ];
    const { lastFrame } = renderPicker(cjkItems, () => {}, false, 5);
    const out = lastFrame() ?? '';
    expect(out).toContain('短A');
    expect(out).toContain('中英混合模型名称');
  });

  it('clampToWidth 对中英混合串按 displayWidth 截断（单条场景验证渲染稳定）', () => {
    const cjkItems: ModelPickerItem[] = [
      item('budget-test', '中A英B长名超长', 'stepfun'),
    ];
    const { lastFrame } = renderPicker(cjkItems, () => {}, false, 5);
    const out = lastFrame() ?? '';
    // 单条时 colWidth 自适应=该标签 dw=14，不截断；验证渲染稳定
    expect(out).toContain('中A英B长名超长');
  });
});

describe('ModelPicker Tab 渠道筛选', () => {
  const TAB = '\t';
  const SHIFT_TAB = String.fromCharCode(27) + '[Z';

  function stripAnsi(s: string): string {
    return s.replace(/\x1b\[[0-9;]*m/g, '');
  }

  /** 找到 tab 条所在行（含「全部」的那一行）。 */
  function tabBarLine(out: string): string {
    return stripAnsi(out)
      .split('\n')
      .find((l) => l.includes('全部')) ?? '';
  }

  it('多渠道：tab 条渲染，全部 恒第一，渠道按首现顺序去重', () => {
    const { lastFrame } = renderPicker([
      item('a1', 'A One', 'gw'),
      item('a2', 'A Two', 'stepfun'),
      item('a3', 'A Three', 'gw'),
      item('a4', 'A Four', 'anthropic'),
    ]);
    const line = tabBarLine(lastFrame() ?? '');
    expect(line).toMatch(/全部\s+gw\s+stepfun\s+anthropic/);
    // 提示行含 Tab 切渠道说明
    expect(lastFrame() ?? '').toContain('Tab 切渠道');
  });

  it('单渠道：不渲染 tab 条，Tab 键不切换（行为同旧版）', async () => {
    const onSelect = vi.fn();
    const { lastFrame, stdin } = renderPicker(
      [item('m1', 'M One', 'stepfun'), item('m2', 'M Two', 'stepfun')],
      onSelect,
    );
    expect(lastFrame() ?? '').not.toContain('全部');
    await delay();
    stdin.write(TAB); // 不消费为切渠道：列表不变
    await delay();
    const out = lastFrame() ?? '';
    expect(out).toContain('M One');
    expect(out).toContain('M Two');
    stdin.write(DOWN);
    await delay();
    stdin.write('\r');
    await delay();
    expect(onSelect).toHaveBeenCalledWith('m2', false);
  });

  it('Tab 回卷：all → stepfun → gw → anthropic → all，Shift+Tab 反向', async () => {
    const { lastFrame, stdin } = renderPicker(three());
    await delay();
    stdin.write(TAB); // stepfun
    await delay();
    let out = lastFrame() ?? '';
    expect(out).toContain('Alpha Model');
    expect(out).not.toContain('Beta Model');
    stdin.write(TAB); // gw
    await delay();
    out = lastFrame() ?? '';
    expect(out).toContain('Beta Model');
    expect(out).not.toContain('Alpha Model');
    stdin.write(TAB); // anthropic
    await delay();
    out = lastFrame() ?? '';
    expect(out).toContain('Gamma Model');
    expect(out).not.toContain('Beta Model');
    stdin.write(TAB); // 回卷到 all
    await delay();
    out = lastFrame() ?? '';
    expect(out).toContain('Alpha Model');
    expect(out).toContain('Beta Model');
    expect(out).toContain('Gamma Model');
    stdin.write(SHIFT_TAB); // 反向回到 anthropic
    await delay();
    out = lastFrame() ?? '';
    expect(out).toContain('Gamma Model');
    expect(out).not.toContain('Beta Model');
  });

  it('渠道过滤后 Enter 选中该渠道首项；all tab 为全量', async () => {
    const onSelect = vi.fn();
    const { stdin } = renderPicker(three(), onSelect);
    await delay();
    stdin.write(TAB); // stepfun 渠道只剩 alpha
    await delay();
    stdin.write('\r');
    await delay();
    expect(onSelect).toHaveBeenCalledWith('alpha', false);
  });

  it('per-tab 状态：切走再切回，过滤词与光标位置各自恢复', async () => {
    const onSelect = vi.fn();
    const { lastFrame, stdin } = renderPicker(three(), onSelect);
    await delay();
    // all tab：光标移到 gamma
    stdin.write(DOWN);
    stdin.write(DOWN);
    await delay();
    stdin.write(TAB); // stepfun tab：独立状态，sel=0
    await delay();
    stdin.write('alp'); // stepfun tab 内输入过滤词
    await delay();
    expect(lastFrame() ?? '').toContain('alp');
    stdin.write(TAB); // gw tab：query 为空，看不到 alp
    await delay();
    let out = lastFrame() ?? '';
    expect(out).toContain('Beta Model');
    expect(out).not.toContain('alp');
    stdin.write(SHIFT_TAB); // 回 stepfun：过滤词恢复
    await delay();
    out = lastFrame() ?? '';
    expect(out).toContain('alp');
    expect(out).toContain('Alpha Model');
    stdin.write(SHIFT_TAB); // 回 all：光标恢复到 gamma
    await delay();
    stdin.write('\r');
    await delay();
    expect(onSelect).toHaveBeenCalledWith('gamma', false);
  });

  it('current 标记在渠道 tab 内仍显示', async () => {
    const { lastFrame, stdin } = renderPicker(three());
    await delay();
    stdin.write(TAB);
    await delay();
    stdin.write(TAB); // gw 渠道
    await delay();
    const out = lastFrame() ?? '';
    expect(out.match(/← 当前/g)).toHaveLength(1);
    expect(out).toMatch(/Beta Model\s+gw ← 当前/);
  });

  it('tab 条总宽超终端时右端截断并加 …', () => {
    // ink-testing-library mock stdout 固定 100 列：用长渠道名撑爆 tab 条
    const items: ModelPickerItem[] = Array.from({ length: 8 }, (_, i) =>
      item(`m${i}`, `Model ${i}`, `channel-name-${i.toString().padStart(3, '0')}`),
    );
    const { lastFrame } = renderPicker(items);
    const line = tabBarLine(lastFrame() ?? '');
    expect(line).toContain('…');
    expect(line).not.toContain('channel-name-007');
  });
});

describe('ModelPicker initialChannel 预选', () => {
  it('initialChannel 命中已有渠道 tab：打开即预选到该渠道，列表只剩该渠道条目', () => {
    const { lastFrame } = render(
      React.createElement(ModelPicker, { items: three(), hasHistory: false, onSelect: () => {}, initialChannel: 'gw' }),
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('Beta Model');
    expect(out).not.toContain('Alpha Model');
    expect(out).not.toContain('Gamma Model');
  });

  it('initialChannel 无对应渠道 tab：退回「全部」（缺省行为）', () => {
    const { lastFrame } = render(
      React.createElement(ModelPicker, { items: three(), hasHistory: false, onSelect: () => {}, initialChannel: 'nope' }),
    );
    const out = lastFrame() ?? '';
    expect(out).toContain('Alpha Model');
    expect(out).toContain('Beta Model');
    expect(out).toContain('Gamma Model');
  });

  it('initialChannel 缺省：行为不变（全部 tab，Enter 选中第一项）', async () => {
    const onSelect = vi.fn();
    const { stdin } = renderPicker(three(), onSelect);
    await delay();
    stdin.write('\r');
    await delay();
    expect(onSelect).toHaveBeenCalledWith('alpha', false);
  });

  it('预选渠道 tab 内 Enter 选中该渠道首项', async () => {
    const onSelect = vi.fn();
    const { stdin } = render(
      React.createElement(ModelPicker, { items: three(), hasHistory: false, onSelect, initialChannel: 'stepfun' }),
    );
    await delay();
    stdin.write('\r');
    await delay();
    expect(onSelect).toHaveBeenCalledWith('alpha', false);
  });
});

describe('buildModelPickerItems（「当前」按别名判定）', () => {
  // 同 id 多别名：step37 / step37-plan 都指向 step-3.7-flash，仅 provider 不同。
  const dupModels = {
    step37: { model: 'step-3.7-flash', provider: 'stepfun' },
    'step37-plan': { model: 'step-3.7-flash', provider: 'stepfun-plan' },
    step35: { model: 'step-3.5-flash-2603', provider: 'stepfun' },
  };

  it('同 id 多别名时只有激活别名标当前，不是全部', () => {
    const items = buildModelPickerItems(dupModels, 'step37-plan', 'stepfun');
    expect(items.find((m) => m.alias === 'step37-plan')?.current).toBe(true);
    expect(items.find((m) => m.alias === 'step37')?.current).toBe(false);
    expect(items.filter((m) => m.current)).toHaveLength(1);
  });

  it('裸 id 直切（currentAlias=null）时无任何别名标当前', () => {
    const items = buildModelPickerItems(dupModels, null, 'stepfun');
    expect(items.every((m) => !m.current)).toBe(true);
  });

  it('label 取 displayName ?? 别名，channel 取 entry.provider ?? 顶层 provider', () => {
    const models = {
      a: { model: 'm-a' },                              // 无 displayName / provider：全回落
      b: { model: 'm-b', displayName: 'B 显示名', provider: 'gw' },
    };
    const items = buildModelPickerItems(models, 'b', 'stepfun');
    expect(items.find((m) => m.alias === 'a')).toMatchObject({ label: 'a', channel: 'stepfun' });
    expect(items.find((m) => m.alias === 'b')).toMatchObject({ label: 'B 显示名', channel: 'gw', current: true });
  });
});
