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

  it('tool_start 为 spawn_agent 提取角色名与简述写进条目（否则卡片只显示裸工具名，分不清 explore/general）', () => {
    // 缺口根因：迁移时只 push 了基础字段，漏掉对照实现里 App.tsx 对
    // subagent_type/description 的提取，导致 blocks.ts 里 it.subagentType
    // 永远 undefined，角色名（explore/general）从不渲染。
    wired(piChat, "ev.name === 'spawn_agent'", 'spawn_agent 分支');
    wired(piChat, 'inp.subagent_type', '提取角色名');
    wired(piChat, 'inp.description', '提取任务简述');
    wired(piChat, 'toolItem.subagentType = st', '角色名写进条目');
    wired(piChat, 'toolItem.description = desc', '简述写进条目');
  });

  it('子 agent start 事件把解析后的真实角色名盖到卡片（模型省略 subagent_type 时也显示默认角色）', () => {
    // tool_start 只能抄到模型入参；模型省略 subagent_type 时卡片无类型标识。
    // start 进度事件带 registry 解析后的真实角色名（含默认 general），盖到卡片上。
    wired(piChat, "ev.kind === 'start'", 'start 分支');
    wired(piChat, 'subagentType: ev.subagentType', '真实角色名盖进条目');
    wired(piChat, 'description: ev.description', '显示描述盖进条目');
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

  it('Esc 双击回退：primed 状态机三个动作 + 两个纯函数都有调用点', () => {
    // 这条对应一个真实缺口：computeBacktrack 与 truncateItemsAtLastUser 两个纯函数
    // 迁移时就在 chat/ 里躺着，各自有测试，但 PiChat 从未调用过——功能整条缺失。
    wired(piChat, 'computeBacktrack', '回退计算');
    wired(piChat, 'truncateItemsAtLastUser', '转录区截断');
    wired(piChat, 'enterBacktrackPrimed', '进入 primed');
    wired(piChat, 'cancelBacktrackPrimed', '解除 primed');
    wired(piChat, 'performBacktrack', '执行回退');
    // 历史与转录区必须一起截断：只改一边会让屏幕上留着已回滚的问答
    expect(
      /this\.history\.push\(\.\.\.result\.history\)/.test(piChat),
      '回退未替换 history',
    ).toBe(true);
    expect(
      /truncateItemsAtLastUser\(this\.transcript\.items\(\)\)/.test(piChat),
      '回退未截断转录区',
    ).toBe(true);
    // 回退后要落盘，否则重启把已撤销的那轮读回来
    expect(/performBacktrack\(\)[\s\S]{0,900}?this\.persist\(\)/.test(piChat), '回退后未 persist').toBe(true);
  });

  it('中断冷静期：abortTurn 记录时间戳，onEscape 在冷静期内不进 backtrack primed', () => {
    // 刚中断完连按 Esc 多半是「确认停了没」，不该被当成回退意图（回退会截断历史）。
    wired(piChat, 'ABORT_COOLDOWN_MS', '冷静期常量');
    wired(piChat, 'lastAbortAt', '中断时间戳');
    wired(piChat, 'this.lastAbortAt = Date.now()', 'abortTurn 记录时间');
    wired(piChat, 'Date.now() - this.lastAbortAt < ABORT_COOLDOWN_MS', 'onEscape 冷静期判定');
  });

  it('工具参数流式预览：tool_forming/args_delta 事件上抛 + 成形卡 reconcile + 中断收尾', () => {
    // 全链路：runTurn 映射事件 → PiChat 挂成形卡 → tool_start 转正（不是重开新卡）→
    // aborted 收尾滞留成形卡。任何一环断开，用户要么看不到成形卡、要么看到重复卡/僵尸卡。
    wired(piChat, "case 'tool_forming'", 'forming 事件入口');
    wired(piChat, "case 'tool_args_delta'", '参数增量入口');
    wired(piChat, 'forming: true', '成形卡标记');
    wired(piChat, 'it.forming === true', 'tool_start reconcile 谓词');
    wired(piChat, "'参数流式期间被中断'", 'aborted 收尾成形卡');
    const runTurn = readFileSync(join(repoRoot, 'src', 'agent', 'runTurn.ts'), 'utf8');
    expect(runTurn.includes("type: 'tool_forming'"), 'runTurn 应上抛 tool_forming').toBe(true);
    expect(runTurn.includes("type: 'tool_args_delta'"), 'runTurn 应上抛 tool_args_delta').toBe(true);
    expect(runTurn.includes("event.delta.type === 'input_json_delta'"), 'runTurn 应消费 input_json_delta').toBe(true);
  });

  it('SIGHUP/死终端紧急出口：cli 注册信号处理，PiChat 提供只恢复终端的 emergencyStop', () => {
    // 终端死掉后继续写 stdout 会 EIO 循环占满 CPU，进程残留把 shell 挂在 raw mode。
    wired(cli, "process.once('SIGHUP'", 'SIGHUP 处理');
    wired(cli, "'EIO'", 'stdout EIO 处理');
    wired(cli, 'chat.emergencyStop()', '紧急停止调用点');
    wired(piChat, 'emergencyStop()', 'emergencyStop 方法');
  });

  it('两个 primed 提示走输入框下方 footer，不进转录区 note', () => {
    wired(piChat, 'footerText', 'footer 绑定');
    wired(piChat, "t('input.backtrackPrimed')", '回退提示文案');
    wired(piChat, "t('input.exitPrimed')", '退出提示文案');
    // 旧实现把「再按一次 Ctrl+C 退出」push 成 note，会永久留在历史里
    expect(piChat.includes("text: '再按一次 Ctrl+C 退出'"), 'exitPrimed 提示应移出转录区').toBe(false);
    // 任意其他键解除两个 primed（否则按了 Esc 又打字，下一次 Esc 会误判成第二击）
    wired(piChat, 'onOtherKey', '按键解除通道');
    wired(piChat, 'cancelExitPrimed', '解除退出 primed');
  });

  it('两个 primed 定时器在退出时都被清理', () => {
    // 未清的 setTimeout 会让 node 事件循环多挂 5 秒才退出
    // 阈值留 1000：exit() 清理项较多（exit/backtrack 两个 primed + ticker + spinner + heapWatch + cron
    // + persist + termTitle + tui.stop），2026-08-19 实测方法体已达 686 字符，原 600 会抓空误报。
    const exitBlock = /private exit\(\): void \{[\s\S]{0,1000}?\n  \}/.exec(piChat)?.[0] ?? '';
    expect(exitBlock, 'exit 里应清 exitPrimedTimer').toContain('exitPrimedTimer');
    expect(exitBlock, 'exit 里应清 backtrackPrimedTimer').toContain('backtrackPrimedTimer');
  });

  it('spinner 与计时器两个 setInterval 在退出时都被清理', () => {
    // spinnerTimer 与 ticker 是两个 setInterval，漏清会让 node 事件循环挂住不退。
    const exitBlock = /private exit\(\): void \{[\s\S]{0,1000}?\n  \}/.exec(piChat)?.[0] ?? '';
    expect(exitBlock, 'exit 里应清 ticker').toContain('this.ticker');
    expect(exitBlock, 'exit 里应清 spinnerTimer').toContain('this.spinnerTimer');
  });

  it('待发队列持久化：变更走 updateQueue，两条恢复路径都接回', () => {
    wired(piChat, 'updateQueue', '队列变更统一出口');
    wired(piChat, "type: 'queue.update'", '队列 wire 事件');
    wired(piChat, 'this.session.queue =', 'persist 写入队列快照');
    // 两条恢复路径：构造器（启动 / --continue）与 resumeSession（应用内 /resume）
    const restores = piChat.match(/this\.queue = (?:\[\.\.\.\((?:deps\.session|data)\.queue \?\? \[\]\)\]|restoredQueue)/g) ?? [];
    expect(restores.length, '队列恢复点应有 2 处（构造器 + resumeSession）').toBe(2);
  });

  it('队列变更不绕过 updateQueue（漏一处就会界面 N 条、重启 M 条）', () => {
    // 反向断言：除 updateQueue 自身的赋值、以及 new/fork 的显式清空外，不允许再有
    // 直接改 this.queue 的写法。这条挡的是「新增一个排队入口时忘了走统一出口」。
    const directWrites = piChat.match(/this\.queue(?:\.push\(|\.pop\(|\.shift\(| = )/g) ?? [];
    // 允许的 4 处：updateQueue 内部赋值 + resumeSession 接回 + 构造器接回 + new/fork 清空各一
    expect(
      directWrites.length,
      `直接改 this.queue 的地方有 ${directWrites.length} 处，超出预期的 5 处白名单——新增排队入口请走 updateQueue`,
    ).toBeLessThanOrEqual(5);
    // push 一律不允许：排队必须走 updateQueue（它负责落 wire 事件）
    expect(piChat.includes('this.queue.push('), 'queue.push 绕过了持久化').toBe(false);
  });
});

describe('PiChat 接线：compaction 后重建 Transcript（OOM 根因修复）', () => {
  /**
   * 2026-08-17 OOM 根因：compaction（自动 + 手动）只压缩 this.history，从不重建 Transcript，
   * blocks 数组持续累积 ItemBlock（各持 cachedLines + Markdown 实例），4GB 堆全活对象而会话
   * 才 240KB。修复：appendWire 收到 context.apply_compaction 时用压缩后的 history 重建转录块。
   *
   * 本条盯的是「接线存在」——compaction 分支里必须有 transcript.reset。单跑 PiChat 测不了
   * 行为（构造函数摸真实 tty），沿用本文件源码扫描的糙测试口径。
   */
  it('appendWire 的 compaction 分支重建了 Transcript', () => {
    // 接线点 1：appendWire 里识别 compaction 事件
    wired(piChat, "event.type === 'context.apply_compaction'", 'compaction 事件识别');
    // 接线点 2：命中后用压缩后 history 重建转录块（旧块失引用即 GC）
    wired(piChat, 'this.transcript.reset(historyToDisplayItems(this.history)', 'compaction 后重建 Transcript');
    // 接线点 3：historyToDisplayItems 已导入（否则上面那行编译不过，但显式守住接线意图）
    wired(piChat, "historyToDisplayItems", 'historyToDisplayItems 导入');
  });

  it('手动 /compact 压缩成功后 emit compaction 事件（走 appendWire 的重建出口）', () => {
    // runCompact 压缩成功后必须 emit context.apply_compaction——appendWire 收到后重建 Transcript。
    // 若有人删掉这行 emit，Transcript 就不会重建，OOM 回归。PiChat 里这处 emit 是手动压缩的出口。
    const emits = piChat.match(/type:\s*'context\.apply_compaction'/g) ?? [];
    expect(emits.length, 'runCompact 应 emit context.apply_compaction，经 appendWire 触发重建').toBeGreaterThanOrEqual(1);
    // 且 emit 紧跟在 history 原地压缩之后（同一分支内），保证 appendWire 重建时 history 已是压缩后
    const compactBranch = piChat.slice(piChat.indexOf('compacted !== this.history'), piChat.indexOf('compacted !== this.history') + 400);
    expect(compactBranch, 'emit 应落在 compacted !== this.history 分支内（history 已压缩）').toContain('context.apply_compaction');
  });
});

describe('PiChat 接线：逐回合折叠旧块（OOM 第二道防线）', () => {
  /**
   * 2026-08-18 加。设计文档 `前端设计-pi版/20260818-Transcript逐回合折叠与块释放设计.md`。
   * finishTurn 每回合边界调用 transcript.foldOldTurns，超闸门时折旧轮 tool/thinking 为摘要释放内存。
   * 本条盯接线存在，沿用本文件源码扫描口径。
   */
  it('finishTurn 调用了 transcript.foldOldTurns', () => {
    wired(piChat, 'this.transcript.foldOldTurns(', 'finishTurn 接线逐回合折叠');
    // 折成摘要依赖 ItemBlock.dispose 释放 markdown；折叠阈值常量在位
    wired(piChat, 'FOLD_KEEP_RECENT_TURNS', '折叠保留轮数常量');
    wired(piChat, 'FOLD_TRIGGER_TURNS', '折叠触发闸门常量');
  });
});

describe('PiChat 接线：busy ↑ 取回排队单条', () => {
  /**
   * 2026-08-18 加。设计文档 `前端设计-pi版/20260817-前端交互对标ink的5项差距与收口.md` 第 2 项。
   * busy + 空输入时 ↑ 取回队列尾部一条进输入框编辑（Ink 版 PromptInput.onRecallQueued）。
   * 系统合成注入不给取回。沿用本文件源码扫描口径。
   */
  it('editor.onUpArrow 绑定了 recallQueuedOne 方法', () => {
    wired(piChat, 'this.editor.onUpArrow = () => this.recallQueuedOne()', '↑ 键绑定取回方法');
    wired(piChat, 'private recallQueuedOne(): boolean', 'recallQueuedOne 方法定义');
  });

  it('recallQueuedOne 有 busy + 空输入 + 队列非空三道闸门', () => {
    wired(piChat, '!this.busy', 'busy 闸门');
    wired(piChat, "this.editor.getText() !== ''", '空输入闸门');
    wired(piChat, 'this.queue.length === 0', '队列非空闸门');
  });

  it('recallQueuedOne 跳过系统合成注入（notifyPrepared）', () => {
    wired(piChat, 'this.notifyPrepared.has(recalled)', '系统注入判定');
  });

  it('ChromePanels 队列预览分 busy/idle 两种取回提示', () => {
    wired(piChat, 'this.chrome.setBusy(this.busy)', 'ChromePanels 接收 busy 态');
  });
});
