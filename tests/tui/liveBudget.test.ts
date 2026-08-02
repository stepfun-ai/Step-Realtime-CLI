import { describe, expect, it } from 'vitest';
import { computeLiveBudget, displayWidth, type ChromeBlocks } from '../../src/tui/liveBudget.js';
import { computePromptRows, matchSlashCommands } from '../../src/tui/PromptInput.js';

describe('computeLiveBudget 动态区高度预算', () => {
  const base: ChromeBlocks = { statusRows: 2, promptRows: 4 };

  it('常态：live 预算 = 终端行数 − 1 行余量 − chrome 行数', () => {
    const b = computeLiveBudget(30, { ...base, todoRows: 7 });
    expect(b.chromeRows).toBe(13);
    expect(b.liveMaxRows).toBe(16);
    expect(b.degraded).toBe(false);
    // 不变量：chrome + live ≤ rows − 1（Windows 上帧高 ≥ rows 即全清）
    expect(b.chromeRows + (b.liveMaxRows ?? 0)).toBeLessThanOrEqual(30 - 1);
  });

  it('终端行数未知（非 TTY / 测试 mock）时不窗口化、不降级', () => {
    const b = computeLiveBudget(undefined, { ...base, todoRows: 7, queueRows: 5, thinkingRows: 4 });
    expect(b.liveMaxRows).toBeUndefined();
    expect(b.showTodos).toBe(true);
    expect(b.showQueue).toBe(true);
    expect(b.thinkingRows).toBe(4);
    expect(b.degraded).toBe(false);
  });

  it('降级顺序：先丢 QueuePreview，再丢 TodoPanel', () => {
    // chrome = 2+4+7+5+4 = 22；rows 20 → chrome 上限 18 → 丢 queue（5）后 17 ≤ 18
    const b = computeLiveBudget(20, { ...base, todoRows: 7, queueRows: 5, thinkingRows: 4 });
    expect(b.showQueue).toBe(false);
    expect(b.showTodos).toBe(true);
    expect(b.thinkingRows).toBe(4);
    expect(b.chromeRows).toBe(17);
    expect(b.liveMaxRows).toBe(2);
    expect(b.degraded).toBe(true);

    // rows 14 → chrome 上限 12 → 丢 queue 后 17 仍超，再丢 todos 后 10 ≤ 12
    const b2 = computeLiveBudget(14, { ...base, todoRows: 7, queueRows: 5, thinkingRows: 4 });
    expect(b2.showQueue).toBe(false);
    expect(b2.showTodos).toBe(false);
    expect(b2.thinkingRows).toBe(4);
    expect(b2.chromeRows).toBe(10);
    expect(b2.liveMaxRows).toBe(3);
  });

  it('思考预览缩减：保留标题 + 尽可能多的正文行，不足 2 行整块隐藏', () => {
    // chrome = 2+4+7+5+4 = 22；rows 10 → 上限 8 → 丢 queue/todos 后 10 仍超，
    // 思考预览给 2 行（标题+1 正文），chrome = 8
    const b = computeLiveBudget(10, { ...base, todoRows: 7, queueRows: 5, thinkingRows: 4 });
    expect(b.thinkingRows).toBe(2);
    expect(b.chromeRows).toBe(8);
    expect(b.liveMaxRows).toBe(1);

    // rows 8 → 上限 6 → 丢完面板后 fixed 6，思考预览给不出 2 行 → 整块隐藏
    const b2 = computeLiveBudget(8, { ...base, todoRows: 7, queueRows: 5, thinkingRows: 4 });
    expect(b2.thinkingRows).toBe(0);
    expect(b2.chromeRows).toBe(6);
    expect(b2.liveMaxRows).toBe(1);
  });

  it('AgentGroup 与固定 chrome 不参与降级', () => {
    const b = computeLiveBudget(10, { ...base, agentRows: 6, queueRows: 5, todoRows: 7 });
    expect(b.showQueue).toBe(false);
    expect(b.showTodos).toBe(false);
    expect(b.chromeRows).toBe(12); // 固定部分原样保留
    expect(b.liveMaxRows).toBe(1);
  });

  it('WorkingStatus（workingRows）计入固定 chrome，不参与降级', () => {
    // base 固定 6（status2+prompt4）+ workingRows 3 = 9；queue/todo 可降级项被砍
    const b = computeLiveBudget(10, { ...base, workingRows: 3, queueRows: 5, todoRows: 7 });
    expect(b.showQueue).toBe(false);
    expect(b.showTodos).toBe(false);
    expect(b.chromeRows).toBe(9);
    expect(b.liveMaxRows).toBe(1);
  });

  it('固定 chrome 超限：live 保底 1 行（不为 0/负数），degraded 标记供调试日志暴露', () => {
    const b = computeLiveBudget(6, base); // chrome 6 ≥ rows
    expect(b.liveMaxRows).toBe(1);
    expect(b.chromeRows).toBe(6);
  });

  it('resize 重算：纯函数无状态，rows 变小预算同步变小', () => {
    const blocks: ChromeBlocks = { ...base, todoRows: 7 };
    expect(computeLiveBudget(30, blocks).liveMaxRows).toBe(16);
    expect(computeLiveBudget(20, blocks).liveMaxRows).toBe(6);
  });
});

describe('displayWidth 终端显示宽度', () => {
  it('ASCII 1 列、CJK/全角 2 列、混合累加', () => {
    expect(displayWidth('hello')).toBe(5);
    expect(displayWidth('你好')).toBe(4);
    expect(displayWidth('a你b')).toBe(4);
    expect(displayWidth('')).toBe(0);
  });
});

describe('matchSlashCommands 斜杠命令匹配', () => {
  it('前缀匹配命令名与别名；含空格或非 / 开头不匹配', () => {
    // /mo 仅前缀命中 model（permission 的 o 在位置 8，超出跨度限制）
    expect(matchSlashCommands('/mo').map((c) => c.name)).toEqual(['model']);
    expect(matchSlashCommands('/q').map((c) => c.name)).toEqual(['exit']); // quit 别名
    expect(matchSlashCommands('/model x')).toEqual([]);
    expect(matchSlashCommands('hello')).toEqual([]);
    expect(matchSlashCommands('/zzz')).toEqual([]);
  });
  it('短查询（≤3 字符）降级到子序列匹配，前缀命中优先于子序列命中', () => {
    // cp → compact（子序列：c→p）、mcp（子序列：c→p），两条子序列命中按注册序
    expect(matchSlashCommands('/cp').map((c) => c.name)).toEqual(['compact', 'mcp']);
    // se → resume（子序列匹配 sessions 别名：s→e）
    expect(matchSlashCommands('/se').map((c) => c.name)).toEqual(['resume']);
    // re → reflect（前缀）、resume（前缀）、reload（前缀），provider 的 e 在位置 6 超出跨度限制
    expect(matchSlashCommands('/re').map((c) => c.name)).toEqual(['reflect', 'resume', 'reload']);
    // pl → plan（前缀）、plugin（前缀），两个都前缀命中按注册序
    expect(matchSlashCommands('/pl').map((c) => c.name)).toEqual(['plan', 'plugin']);
  });
  it('≥4 字符不做子串降级，避免误命中', () => {
    // sess → resume（仅 sessions 别名前缀匹配；compact 含 ss 但 4 字符不降级）
    expect(matchSlashCommands('/sess').map((c) => c.name)).toEqual(['resume']);
    expect(matchSlashCommands('/comp').map((c) => c.name)).toEqual(['compact']);
  });
});

describe('computePromptRows 输入区实测行数', () => {
  it('常态空闲 = 输入框 3 行（边框 2 + 内容 1）', () => {
    expect(computePromptRows('', { busy: false, columns: 80 })).toBe(3);
  });

  it('空闲 primed/exitPrimed 各加提示行；busy 不再加 tip 行（移到独立 WorkingStatus）', () => {
    expect(computePromptRows('', { busy: true, columns: 80 })).toBe(3);
    expect(computePromptRows('', { busy: false, primed: true, columns: 80 })).toBe(4);
    expect(computePromptRows('', { busy: false, exitPrimed: true, columns: 80 })).toBe(4);
  });

  it('斜杠菜单可见时计入菜单行数（边框 2 + 窗口条数 + 页码行）', () => {
    // / 匹配全部 21 条 → 2 + 6 + 1 = 9 行菜单 + 输入框 3 = 12
    expect(computePromptRows('/', { busy: false, columns: 80 })).toBe(12);
    // /mo 匹配 1 条 → 2 + 1 = 3 行菜单 + 输入框 3 = 6
    expect(computePromptRows('/mo', { busy: false, columns: 80 })).toBe(6);
    // busy 期间敲 / 也不漏算：12（busy 不加 tip 行，tip 归 WorkingStatus）
    expect(computePromptRows('/', { busy: true, columns: 80 })).toBe(12);
  });

  it('长输入按终端宽度折行计入（含 CJK 宽字符）', () => {
    // 内容区可用宽度 = 80 − 6 = 74；75 列 → 2 行
    expect(computePromptRows('a'.repeat(75), { busy: false, columns: 80 })).toBe(4);
    // CJK 38 字 = 76 列 → 2 行
    expect(computePromptRows('你'.repeat(38), { busy: false, columns: 80 })).toBe(4);
    // 窄终端：40 列 → 可用 34，40 个 ASCII → 2 行
    expect(computePromptRows('a'.repeat(40), { busy: false, columns: 40 })).toBe(4);
  });

  it('粘贴带入的多行值按行数计入（逐段折行求和，不把 \n 当普通字符）', () => {
    // 两行短文本 → 2 行内容 + 边框 2 = 4
    expect(computePromptRows('abc\ndef', { busy: false, columns: 80 })).toBe(4);
    // 三行，末行超宽折 2 行 → 4 行内容 + 边框 2 = 6
    expect(computePromptRows(`a\nb\n${'c'.repeat(75)}`, { busy: false, columns: 80 })).toBe(6);
    // 空行也占 1 行
    expect(computePromptRows('a\n\nb', { busy: false, columns: 80 })).toBe(5);
  });
});
