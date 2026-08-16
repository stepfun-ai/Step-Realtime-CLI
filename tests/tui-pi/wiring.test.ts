/**
 * PiChat 的**接线**防漂移测试。
 *
 * 为什么需要这么一个「读源码找字符串」的糙测试：2026-08-16 一次系统排查在 PiChat 里
 * 找出十来处迁移遗漏，形态完全一致——**依赖在、函数在、类型在，就是没人调用它**。
 * 举几个：`onSettle` 没挂（后台任务跑完既不提示也不注入，用户只能自己去 /tasks 翻）、
 * `SessionStart` hook 没有执行点（配了 hook 也不跑）、`maxAutoContinues` 没传
 * （loop 侧默认 0 = 自动续写整个功能关闭）、memory 段没拼进 system（记忆对主 agent 失效）。
 *
 * 这类缺口逃过了全部 2400 多个用例，因为：
 * 1. 纯逻辑层测试测的是被调用的那些函数**自身**，它们都是好的；
 * 2. PiChat 本体无法实例化（构造函数里 `new ProcessTerminal()` 摸真实 tty），
 *    所以没有任何测试覆盖「PiChat 有没有去调它们」。
 *
 * 于是退一步，直接对源码文本断言关键调用点存在。这测不出调用是否正确，但能挡住
 * 「整块消失」——而实测下来，漏掉的全是整块消失，不是调错。
 *
 * 维护约定：这里的每一条都对应一个曾经真的漏掉过的东西，不要因为「看起来是重复的
 * 断言」而删。要改接线方式（比如把某段搬到别的文件）时，同步改这里的检索串。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const piChat = readFileSync(join(repoRoot, 'src', 'tui-pi', 'PiChat.ts'), 'utf8');
const cli = readFileSync(join(repoRoot, 'src', 'cli.ts'), 'utf8');

/** 断言辅助：给出人能读懂的失败信息，而不是「expected true to be false」。 */
function wired(source: string, needle: string, what: string): void {
  expect(source.includes(needle), `接线丢失：${what}（源码里找不到 ${needle}）`).toBe(true);
}

describe('PiChat 接线：后台任务通知链路', () => {
  it('BackgroundManager 挂了 onSettle（不只是 onSettleEvent 日志）', () => {
    wired(piChat, 'onSettle:', '任务终态回调');
    wired(piChat, 'onBackgroundSettle', '终态处理方法');
  });

  it('终态处理里有终端通知、注入路由、待投递队列排空三件事', () => {
    wired(piChat, 'emitTerminalNotification', '终端铃响/桌面通知');
    wired(piChat, 'decideNotifyRoute', 'busy/idle 注入路由');
    wired(piChat, 'drainSettled', '待投递通知取出');
  });

  it('启动与切会话都做后台任务对账', () => {
    wired(piChat, 'reconcileBackground', '对账方法');
    // 两个调用点：start() 与 resumeSession()
    const calls = piChat.match(/this\.reconcileBackground\(/g) ?? [];
    expect(calls.length, '对账应有两个调用点（启动 + 切会话）').toBeGreaterThanOrEqual(2);
  });

  it('启动会话就绑好后台管理器（不能只在 new/fork/resume 时 rebind）', () => {
    // 字段初始化是 `new BackgroundManager()`（无参占位：没有 tasksDir、没有回调）。
    // 只有三处切会话调 rebind 时，**启动会话**用的一直是那个占位实例——真机实测症状是
    // 状态栏 bg:1 徽章正常出现、8 秒后终态通知不出现。构造里必须也绑一次。
    const rebinds = piChat.match(/this\.rebindBackground\(\)/g) ?? [];
    expect(rebinds.length, '构造 + new + fork + resume 共 4 处').toBeGreaterThanOrEqual(4);
    // 构造函数体内要有一次：取 constructor 到第一个方法定义之间的片段来判断
    const ctorStart = piChat.indexOf('constructor(deps: PiChatDeps)');
    const ctorEnd = piChat.indexOf('/** 启动 TUI', ctorStart);
    expect(ctorStart, 'constructor 应存在').toBeGreaterThan(0);
    expect(
      piChat.slice(ctorStart, ctorEnd).includes('this.rebindBackground()'),
      '构造函数里必须绑一次，否则启动会话的 onSettle 没挂上',
    ).toBe(true);
  });

  it('回合收尾 finally 里有思考兜底 settle（防跨回合滞留）', () => {
    // drain() 只吐 StreamBuffer 缓冲；thinking_delta 到 applyEvent 里仍只累积不落块。
    // 本回合最后一批事件是思考时（流断在思考中、生成器早退没发 turn_done），accum 会
    // 滞留到下一轮，思考块落在新一轮 user 之后。块序测试在 streamOrder.test.ts，
    // 这里守的是「那句兜底在 finally 里、且排在 drain 之后」这个位置本身。
    const finallyStart = piChat.indexOf('} finally {', piChat.indexOf('this.streamBuffer.ingest(ev)'));
    expect(finallyStart, '回合的 finally 块应存在').toBeGreaterThan(0);
    const tail = piChat.slice(finallyStart, finallyStart + 1800);
    const drainAt = tail.indexOf('this.streamBuffer.drain()');
    const settleAt = tail.indexOf('settleThinking(this.transcript, this.thinkingAccum)');
    expect(drainAt, 'finally 里应先 drain').toBeGreaterThanOrEqual(0);
    expect(settleAt, 'finally 里应有兜底 settleThinking').toBeGreaterThanOrEqual(0);
    expect(settleAt, '兜底必须在 drain 之后（否则漏掉缓冲里最后那截思考）').toBeGreaterThan(drainAt);
  });

  it('persist 补写 delivered 事件（与消息本体同刻落盘）', () => {
    wired(piChat, 'pendingDeliveredEvents', 'delivered 补写');
  });

  it('Esc 丢弃系统注入时落 delivered（丢弃即送达，否则下次对账重复投递）', () => {
    wired(piChat, 'notifyDedupKeyFromOrigin', '幂等键计算');
    wired(piChat, 'background.notify_delivered', 'delivered 事件类型');
  });

  it('补投消息带幂等键进 history（prepared 通道，不重新 stored）', () => {
    wired(piChat, 'buildSettleMessage', '通知消息装配');
    wired(piChat, 'prepared', 'prepared 通道');
  });
});

describe('PiChat 接线：system prompt 的各段', () => {
  it('用 composeSystem 组装（段序集中在一处，可被单测覆盖）', () => {
    wired(piChat, 'composeSystem', 'system 组装');
  });

  it('memory 观察池段注入主控 system', () => {
    wired(piChat, 'memorySection', 'memory 段');
    wired(piChat, 'scanMemory', 'memory 目录扫描');
  });

  it('SessionStart hook 有执行点，stdout 落进 sessionContext', () => {
    wired(piChat, "run('SessionStart'", 'SessionStart 执行');
    wired(piChat, 'this.sessionContext', 'hook 输出承接字段');
  });

  it('skill 清单按配置预算裁剪（不是用内置缺省）', () => {
    wired(piChat, 'skillListingBudget', 'skill 清单预算');
  });
});

describe('PiChat 接线：runAgent 与子 agent 的参数透传', () => {
  it('自动续写次数从配置来（不传等于 0 = 功能关闭）', () => {
    wired(piChat, 'maxAutoContinues', '自动续写上限');
  });

  it('压缩预检拿到真实 usage 基准与它覆盖的历史下标', () => {
    wired(piChat, 'initialUsage', 'usage 基准');
    wired(piChat, 'measuredLen', 'usage 覆盖下标');
  });

  it('子 agent 并发上限从配置来（不传会退到硬编码 4）', () => {
    wired(piChat, 'subagentMaxConcurrent', '子 agent 并发上限');
  });

  it('渠道名透传（/think 门控据此判定）', () => {
    wired(piChat, 'providerName', '渠道名');
    wired(cli, 'providerName: config.provider', 'cli 侧注入渠道名');
  });

  it('压缩的用户消息预算透传给 runAgent 与子 agent', () => {
    const hits = piChat.match(/userMessageBudget/g) ?? [];
    expect(hits.length, 'runAgent 与 createSubagentRunner 两处都要传').toBeGreaterThanOrEqual(2);
  });

  it('媒体限额随主控透传给子 agent', () => {
    wired(piChat, 'imageMaxEdgePx: this.deps.ctx.imageMaxEdgePx', '图片长边上限');
    wired(piChat, 'imageBudgetBytes: this.deps.ctx.imageBudgetBytes', '图片字节预算');
    wired(piChat, 'videoBudgetBytes: this.deps.ctx.videoBudgetBytes', '视频字节预算');
  });
});

describe('PiChat 接线：会话切换的清理与恢复', () => {
  it('/resume 走 store.resume（含事件重放与悬空 tool_use 闭合），不是 load', () => {
    wired(piChat, 'this.deps.store.resume(', 'resume 恢复路径');
    expect(piChat.includes('this.deps.store.load(this.deps.ctx.cwd, id)'), '/resume 不应再走 load 快照路径').toBe(
      false,
    );
  });

  it('切会话清掉上个会话加载的动态工具', () => {
    wired(piChat, 'clearDynamicTools', '动态工具清理');
  });

  it('会话标题 AI 生成有触发点', () => {
    wired(piChat, 'maybeGenerateTitle', '标题生成');
    wired(piChat, 'generateSessionTitle', '标题生成实现');
  });

  it('终端 tab 标题在会话切换的各挂点同步', () => {
    const syncs = piChat.match(/this\.syncTerminalTitle\(\)/g) ?? [];
    // 构造 + new + fork + resume + rename + 标题生成后 = 6 处以上
    expect(syncs.length, 'tab 标题同步点不应少于 5 处').toBeGreaterThanOrEqual(5);
  });

  it('中断回合时暂停 active goal（否则收尾点会把续接又发出去）', () => {
    wired(piChat, 'abortTurn', '中断方法');
    // Esc 与 Ctrl+C 都走它，不再各自直接 abort
    expect(piChat.includes('this.controller?.abort();\n      return true;'), 'Esc/Ctrl+C 应走 abortTurn').toBe(false);
  });
});
