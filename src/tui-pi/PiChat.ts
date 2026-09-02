/**
 * PiChat：pi-tui 前端的主控制器。
 *
 * 没有 React hooks，状态是普通字段；改数据后显式 requestRender()，由 pi-tui 逐行 diff。
 * App.tsx 里那批 xxxRef.current（给闭包提供即时值）随之消失，全部退化成普通字段。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Container, ProcessTerminal, TuiMainScreen, matchesKey } from '@earendil-works/pi-tui';
import type { Component, SelectItem } from '@earendil-works/pi-tui';
import type { AgentEvent, SubagentProgressEvent, WorkflowStepEvent } from '../agent/events.js';
import type { LoopHooks } from '../agent/hooks.js';
import { composeLoopHooks, type HookEngine } from '../agent/hooks/engine.js';
import { runAgent } from '../agent/loop.js';
import { stored, type StoredMessage } from '../agent/message.js';
import { notifyDedupKeyFromOrigin, pendingDeliveredEvents } from '../agent/wirelog.js';

import { buildSettleMessage, decideNotifyRoute } from '../agent/background/notify.js';
import { startHeapWatch } from './heapWatch.js';
import { emitTerminalNotification } from '../agent/background/terminal-notify.js';
import { decide, planModeDenyReason, type PermissionMode } from '../agent/permission/mode.js';
import { createSubagentRunner } from '../agent/subagent/runner.js';
import type { SubagentStore } from '../agent/subagent/store.js';
import type { AgentDefinition } from '../agent/subagent/types.js';
import { BackgroundManager, type BackgroundTask } from '../agent/background/manager.js';
import { CronScheduler } from '../agent/cron/scheduler.js';
import { CronJobStore } from '../agent/cron/store.js';
import { assembleGoalInject, decideGoalTurn } from '../agent/goal/drive.js';
import { GoalMode, type GoalChangeEvent } from '../agent/goal/mode.js';
import { initTeam } from '../agent/team/mode.js';
import { TeamMode } from '../agent/team/mode.js';
import { estimateTokens, fullCompact } from '../agent/compaction/compact.js';
import { MEMORY_ONBOARDING_INJECTION, memorySection, scanMemory } from '../agent/memory.js';
import { subagentListing } from '../agent/systemPrompt.js';
import {
  PROVIDER_PRESETS,
  resolveModelEntry,
  saveDefaultModel,
  saveDefaultProvider,
  saveLanguage,
  saveMemoryEnabled,
  type StepCodeConfig,
} from '../config/config.js';
import { getLocale, setLocale, t } from '../i18n.js';
import type { McpManager } from '../mcp/manager.js';
import { formatMcpStatus } from '../mcp/status.js';
import { createProvider } from '../provider/factory.js';
import type { ChatProvider } from '../provider/types.js';
import { basename } from 'node:path';
import { resolveCompactionBinding, type CompactionBinding } from '../provider/compaction.js';
import { exportDebugBundle } from '../session/debugBundle.js';
import { deriveTitle, type SessionData, type SessionStore } from '../session/store.js';
import { canOverwriteTitle, generateSessionTitle } from '../session/title.js';
import { TerminalTitleWriter } from '../chat/terminalTitle.js';
import { aggregateModelUsage } from '../session/usageReport.js';
import type { WireEvent } from '../agent/wirelog.js';
import { renderSkillActivation, skillListing, type SkillRegistry } from '../skill/registry.js';
import { REFLECT_EMPTY_HISTORY, REFLECT_NO_FINDINGS, runReflect } from '../agent/reflect.js';
import { expandPluginCommand, type PluginCommand } from '../plugin/manager.js';
import { runPluginCommand } from '../chat/pluginCommand.js';
import { clearDynamicTools } from '../tools/index.js';
import { restoreFile } from '../tools/checkpoint.js';
import { bashTool } from '../tools/bash.js';
import { resolvePath } from '../tools/fsutil.js';
import type { ToolContext } from '../tools/types.js';
import type { DisplayItem, SubagentToolEvent } from '../chat/types.js';
import { busyRoute, helpText, parseSlash } from '../chat/commands.js';
import { resolveProviderTarget } from '../chat/providerSwitch.js';
import { diffConfig, formatConfigChange, planProviderReload, resolveCapabilitiesOnReload, resolveImageLimitsOnReload } from '../chat/reload.js';
import { computeBacktrack, extractUserText, truncateItemsAtLastUser } from '../chat/backtrack.js';
import { clearUndoSnapshots, computeUndo, popUndoSnapshots, pushUndoSnapshot, type UndoSnapshot } from '../chat/undo.js';
import { historyToDisplayItems } from '../chat/historyReplay.js';
import { planTurnEnd } from '../chat/turnEnd.js';
import { formatDuration } from '../chat/duration.js';
import { formatUsageReport } from '../chat/usagePanel.js';
import { parseThinkArgs, THINK_CHOICES, thinkLevelsOf, thinkStreamParam, type ThinkOverride } from '../chat/thinkCommand.js';
import { scanFileIndex } from '../chat/fileIndex.js';
import { applyCtrlB } from '../chat/ctrlB.js';
import { versionLine } from '../buildInfo.js';
import {
  collectUndoTurns,
  formatCronJobs,
  formatGoalPanel,
  formatMemoryList,
  formatTaskList,
  formatTeamStatus,
  NOT_WIRED,
  notWiredText,
} from './commandText.js';
import { computeCtrlSSteer } from './steer.js';
import { ChatAutocompleteProvider } from './completion.js';
import { clipboardToolHint, readClipboardImage } from '../chat/clipboardImage.js';
import { countHistoryImages, extractImageContent, ImageAttachmentStore } from '../chat/imageAttachment.js';
import { askLine, modelItems, modelTabs, showPicker, sessionItems, thinkItems, type PickerOverlay } from './pickers.js';
import { StreamBuffer } from '../chat/streamBuffer.js';
import { appendText, settleThinking } from '../chat/streamReducer.js';
import { TableHoldback } from '../chat/tableHoldback.js';
import { composeSystem } from '../chat/composeSystem.js';
import { InlineApproval, PlanApproval, QuestionPrompt, type ApprovalOutcome, type PlanOutcome } from './prompts.js';
import type { AskUserRequest, QuestionAnswers } from '../tools/askUser.js';
import { ChatEditor } from './ChatEditor.js';
import { ActivityLine, StatusLine } from './StatusLine.js';
import { Transcript } from './Transcript.js';
import { ChromePanels } from './ChromePanels.js';
import { TasksOverlay } from './TasksOverlay.js';
import { AgentsOverlay } from './AgentsOverlay.js';
import { openProviderManager, runProviderWizard } from './ProviderManager.js';
import { allTodosDone } from '../chat/chromePanels.js';
import { ItemBlock, summarizeInput } from './blocks.js';
import { openExpandViewer } from './ExpandOverlay.js';
import { c, editorTheme } from './theme.js';

/** PiChat 的构造依赖。 */
export interface PiChatDeps {
  provider: ChatProvider;
  systemPrefix: string;
  agentsMd: string;
  skillsRef: { current: SkillRegistry };
  subagentRegistry: Map<string, AgentDefinition>;
  reloadSkills: (force?: boolean) => unknown;
  ctx: ToolContext;
  model: string;
  config: StepCodeConfig;
  initialMode: PermissionMode;
  /** 当前渠道名（config.provider）：/think 门控与 loop 的思考参数判定要用。 */
  providerName?: string;
  /**
   * 恢复会话时已落盘的 delivered 通知幂等键。启动对账据此判断哪些后台任务终态
   * 「已终态但通知没送到」，需要补投。缺省空集（全新会话没有历史通知）。
   */
  resumeDelivered?: ReadonlySet<string>;
  store: SessionStore;
  session: SessionData;
  maxContextSize: number;
  hookEngineRef: { current: HookEngine | undefined };
  subagentStore: SubagentStore;
  /** MCP 管理器：/mcp 只读状态面板用。未注入时按无配置处理。 */
  mcp?: McpManager;
  /**
   * 重载配置（/reload）。组合根注入：重跑 loadConfig 并换掉模块级 config/ctx/hookEngine 引用，
   * 失败时保证一步不落（旧配置整体保留），这里只负责把结果反馈到界面。
   */
  reloadConfig?: () => { config: StepCodeConfig } | { error: string };
  /** plugin 贡献的命令模板（name 已带 <pluginId>: 前缀）。 */
  pluginCommands?: PluginCommand[];
  /** 已发现的 plugin id 列表（供 /plugin 参数补全）。 */
  pluginIds?: readonly string[];
  configStartupNotice?: string;
}

/** 退出信息：交给 cli 打印 resume 提示。 */
export interface PiChatExit {
  sessionId: string;
  hasContent: boolean;
}

const HINTS = 'Enter 发送 · Esc 中断 · Ctrl+C 退出 · /help 命令';

/** /compact 保留的最近消息条数（与 fullCompact 的 keepRecent 默认值一致，两处必须同值）。 */
const COMPACT_KEEP_RECENT = 6;

/**
 * Transcript 逐回合折叠参数（OOM 第二道防线，设计文档 `前端设计-pi版/20260818-Transcript逐回合折叠与块释放设计.md`）。
 *
 * - FOLD_KEEP_RECENT_TURNS：折叠后保留的最近完整轮数。30 与参考方案同口径。
 * - FOLD_TRIGGER_TURNS：触发闸门。折叠顶部旧块会改行号、可能触发一次全屏重绘+清 scrollback，
 *   故不每回合折——只在 turn 数超过此值时才折一次，把代价摊薄。
 *   迟滞 = FOLD_TRIGGER - FOLD_KEEP：超阈值才折、折完回落到保留数附近，避免每回合都动。
 *   初值 200 过于保守（日常长跑根本到不了，等于空窗，20260819 竞品调研对照后下调）：
 *   某同技术栈竞品是 15+5。30+5 让我方保留更多上下文（用户最常回看最近几十轮）的同时，
 *   让折叠在 ~35 轮就必然发生，从源头压住块数组增长。单次只折超出的那几轮，代价很低。
 */
const FOLD_KEEP_RECENT_TURNS = 30;
const FOLD_TRIGGER_TURNS = 35;

/**
 * 子 agent 单卡事件窗口：一个 spawn_agent 卡片运行期间，最多保留最近这么多条子工具事件。
 * 渲染只取最近 3 条，但保留 50 条让流式中能看到更多近期进度；超过即丢弃最旧的。
 * 不设上限的话，一个调几百次工具的子 agent 会让单卡事件数组无界增长，且每次 tool 事件
 * 是 O(n) 的整数组 spread 重建 → 长任务里变成 O(n²)。总调用数由 tool_end 的
 * subagentToolUses 单独落定，不受此窗口影响。
 */
const SUBAGENT_EVENT_CAP = 50;

/**
 * primed 态（双击确认）的超时：Esc 双击回退与 Ctrl+C 双击退出共用同一档。
 * 两处取同值是有意的——用户不该记两个不同的窗口长度。
 */
const PRIMED_TIMEOUT_MS = 5000;
/** 中断后的回退冷静期：中断（Esc/Ctrl+C）后这段时间内 Esc 不触发 backtrack primed。 */
const ABORT_COOLDOWN_MS = 1000;

export class PiChat {
  private readonly deps: PiChatDeps;
  private readonly tui: TuiMainScreen;
  private readonly transcript = new Transcript();
  private readonly activity = new ActivityLine();
  private readonly status: StatusLine;
  private readonly editor: ChatEditor;
  private readonly completion: ChatAutocompleteProvider;
  /** 输入区容器：选择器内联替换模式时，选择器与 editor 在此互换。 */
  private readonly inputSlot = new Container();

  /**
   * 内联选择器：把 PickerOverlay 挂进 inputSlot 替换 editor，关闭时恢复 editor。
   */
  private async showInlinePicker(
    opts: Omit<Parameters<typeof showPicker>[1], 'container' | 'onRestore'>,
  ): Promise<string | null> {
    return showPicker(this.tui, {
      ...opts,
      container: this.inputSlot,
      onRestore: () => {
        this.inputSlot.addChild(this.editor);
        this.tui.setFocus(this.editor);
      },
    });
  }
  /** 输入框上方的常驻面板：待办清单 + 发送队列预览（无数据时零行）。 */
  private readonly chrome = new ChromePanels();
  /** 流式表格扣留：见 chat/tableHoldback.ts。 */
  private readonly tableHold = new TableHoldback();
  /**
   * Ctrl+S 主动插队的共享数组：handleCtrlS 把队列草稿+输入框文本塞进来，
   * runAgent 在 step 边界取走注入（不等整个 run 结束）。数组就地 splice 清空。
   */
  private readonly activeSteer: string[] = [];
  /** 有 overlay 需要按秒重渲（任务弹层的用时）时置真，由 ticker 读。 */
  private overlayNeedsTick = false;
  private overlayTickCount = 0;
  /**
   * per-turn 附带状态快照栈（todos / plan 模式 / prePlanMode）。
   * 这些状态是「整体替换、无历史」的，回退 history 之后无法从现状反推第 N 轮之前的值，
   * 必须在每轮首次改动 history 前压栈。没有它的话 /history 回退只回消息、
   * 待办与 plan 模式停在回退后的现状，界面与历史不自洽。
   */
  private readonly undoStack: UndoSnapshot[] = [];

  private readonly history: StoredMessage[] = [];
  private session: SessionData;
  /** 运行期可变：/new 与 /fork 换绑到新会话的任务目录。 */
  private background = new BackgroundManager();
  private readonly todos: { items: import('../tools/types.js').TodoStore['items'] } = { items: [] };
  private readonly sessionApprovals = new Set<string>();
  /** 自主目标（会话级）：跨轮持有，active 时回合收尾自动续跑。 */
  private readonly goal = new GoalMode();
  /**
   * 定时任务（**会话级**，不是 cwd 级）。
   *
   * 调度器是纯内存引擎，持久化叠在这一层：create/delete 走 onJobChange 落盘，
   * 触发后 recurring 补写新游标、一次性任务直接清盘。每个 job 打上创建它的 sessionId，
   * 装配层只装回本会话的任务——旧会话的 cron 不能在新会话触发（P0：cron 跨 session 串台）。
   * 切会话（/new、/resume）时经 reloadCron 重绑 sessionId 并重装，否则旧任务残留触发、
   * 新任务被打上陈旧 sessionId 下次加载不到。
   */
  private readonly cronStore: CronJobStore;
  private readonly cron: CronScheduler;
  /** plugin 命令表：`<pluginId>:<name>` → 模板。这些名字不在 SLASH_COMMANDS 里，要单独喂给 parseSlash。 */
  private readonly pluginCommandMap: Map<string, PluginCommand>;
  /** 团队模式（会话级）：档案目录快照随会话落盘。 */
  private readonly team = new TeamMode();
  /**
   * goal 运行期间用户的普通留言。
   *
   * 不进发送队列：队列里的消息会作为独立一轮发出，而 goal 正在自主推进，
   * 插一轮会打断它。这些留言拼进下一个自主轮的注入文本，让模型在继续目标的
   * 同时看到用户的话。
   */
  private steers: string[] = [];
  /**
   * 图片附件池（Ctrl+V 贴进来的图）。
   *
   * 图片以占位符文本的形式待在输入框里，用户用退格删掉占位符就等于移除那张图，
   * 不需要额外的「取消附件」交互。提交时 extractImageContent 把仍在的占位符
   * 展开成 image block。
   */
  private readonly images = new ImageAttachmentStore();
  /** 本轮 run 给出的续接文本（goal 续跑或 Stop hook 兜底），回合收尾时派发。 */
  private continuation: string | null = null;
  private readonly subagentCounter = { spawned: 0 };
  /** 子 agent 浏览快照：只读查看子会话历史时保存原 transcript，Esc 恢复。null = 不在浏览态。 */
  private subagentBrowsing: { saved: DisplayItem[] } | null = null;

  private busy = false;
  /** 运行期可变（/model 切换会重建）：provider 与它绑定的模型 id、别名、上下文窗口。 */
  private provider: ChatProvider;
  private model: string;
  private modelLabel: string;
  private currentAlias: string | undefined;
  private maxContextSize: number;
  private thinkOverride: ThinkOverride | undefined;
  /** 配置里当前的默认模型指针（写回时用来跳过无变化的写入）。 */
  private defaultModelPointer: string | undefined;
  private mode: PermissionMode;
  private planMode = false;
  /** 进 plan 模式前的权限模式，批准计划后恢复。 */
  private prePlanMode: PermissionMode | null = null;
  private queue: string[] = [];
  private controller: AbortController | null = null;
  private streamBuffer: StreamBuffer;
  /**
   * 压缩摘要的 provider 实例缓存（键为别名）。没有这层缓存时每轮 runTurn 与每次 /compact
   * 都会重解绑定并新建一个 SDK 客户端——迁移时漏了它，pi 版一直在做这份无谓工作。
   */
  private readonly compactionProviderCache = new Map<string, ChatProvider>();
  /**
   * `/compact-model` 的会话级覆盖：非 undefined 时优先于 `config.compaction.model`。
   * 不落盘，/new 与重启后回到 config（与 /model 的会话级语义一致）；/reload 重解时保留。
   */
  private compactionModelOverride: string | undefined;
  /** 当前压缩绑定（构造 / reload / compact-model 三处重解，其余地方只读）。 */
  private compactionBinding: CompactionBinding;
  /**
   * 终端 tab 标题写入器（OSC 0）。能力探测只在构造时做一次，不支持的终端后续调用是空操作。
   * 标题口径与会话列表一致（name ?? title ?? cwd 目录名），退出时清空让终端回落自身默认。
   */
  private readonly termTitle: TerminalTitleWriter;
  /** 已尝试过 AI 标题生成的会话 id：每会话只试一次，失败不重试（生成是锦上添花，不值得重试预算）。 */
  private readonly titleGenTried = new Set<string>();
  /**
   * 已落盘 delivered 事件的通知幂等键。写入集中在 persist 补写，本集合防重复写导致
   * wire 日志膨胀；崩溃后对账靠磁盘上的 delivered 事件，不靠这个内存集合。
   */
  private deliveredWritten = new Set<string>();
  /**
   * SessionStart hook 的 stdout。会话创建/恢复后触发一次，拼在 system 尾部（仅本进程生效）。
   * 此前整块没接：hook 配了也不会被执行，用户以为注入了上下文其实是空的。
   */
  private sessionContext = '';
  /**
   * 补投通知的正文 → 已装配消息的映射。队列里存的是正文字符串（与用户消息同构，
   * 才能走同一条排空逻辑），但通知消息带 taskId 与 notificationId 幂等键，重新 stored
   * 会丢掉它们。排空时按正文取回原消息，取不到则按普通注入处理。
   */
  private readonly notifyPrepared = new Map<string, StoredMessage>();
  private thinkingAccum = '';
  /** thinking 预览尾部留的行数。比 StatusLine.PREVIEW_LINES(3) 多取几行，折行后仍够预览用。 */
  private static readonly PREVIEW_TAIL_LINES = 5;
  /** preview 只传 accum 尾部若干行，避免 Text 组件每 chunk 重折全量串。 */
  private previewTail(accum: string): string {
    return accum.split('\n').slice(-PiChat.PREVIEW_TAIL_LINES).join('\n');
  }
  private baseTokens = 0;
  /**
   * `baseTokens` 覆盖到历史的哪个下标（usage 事件的 measuredLength）。压缩预检要用它
   * 把「真实 usage + 之后新增消息的估算」拼起来；此前这个字段被整个丢掉，预检只能走
   * 纯字符估算（不含 system 与 tools，实测低估一半），单回合纯对话轮于是永远判不出该压缩。
   */
  private measuredLen = 0;
  private exitPrimed = false;
  private exitPrimedTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * backtrack primed 态：第一次 Esc 进入，第二次 Esc 执行回退，5 秒无操作或按下任意
   * 其他键则解除。与 exitPrimed 同构，两者的提示都画在输入框下方（footerText）。
   */
  private backtrackPrimed = false;
  private backtrackPrimedTimer: ReturnType<typeof setTimeout> | undefined;
  /** `!` bash 命令的卡片序号（id 唯一性用，不持久化）。 */
  private bangCounter = 0;
  /** 最近一次中断（Esc/Ctrl+C）的时间戳：回退冷静期判据。 */
  private lastAbortAt = 0;
  private ticker: ReturnType<typeof setInterval> | undefined;
  /**
   * spinner 独立定时器。与计时器 ticker 解耦：spinner 需要稳帧（约 12fps）才不卡，
   * 而计时器的秒级更新（用时/goal/overlay）没必要跑那么快。共用一条 ticker 时，
   * spinner 帧率被计时器的保守频率拖慢，表现为"卡卡的"。拆开后各自按需跑。
   */
  private spinnerTimer: ReturnType<typeof setInterval> | undefined;
  /** 堆水位看护的停止函数（见 heapWatch.ts：接近上限时预警并留一份快照）。 */
  private stopHeapWatch: (() => void) | undefined;
  private resolveExit: ((info: PiChatExit) => void) | undefined;
  /** 弹层（审批/计划/提问）激活中：暂停 spinner，用户此时在读弹层，动画只是噪声与无谓重绘。 */
  private promptActive = false;

  constructor(deps: PiChatDeps) {
    this.deps = deps;
    this.session = deps.session;
    this.provider = deps.provider;
    this.model = deps.model;
    this.maxContextSize = deps.maxContextSize;
    // 恢复会话时 session.model 存的是「别名 ?? 裸 id」，命中别名则按它重建
    const sessionAlias = deps.config.models?.[deps.session.model] !== undefined ? deps.session.model : undefined;
    this.currentAlias = sessionAlias;
    this.modelLabel = (sessionAlias !== undefined ? deps.config.models?.[sessionAlias]?.displayName : undefined) ?? deps.model;
    this.thinkOverride = deps.session.thinkOverride;
    this.defaultModelPointer = deps.config.modelAlias ?? deps.config.model;
    this.mode = deps.initialMode;
    this.planMode = deps.session.planMode ?? false;
    // 待发队列随会话恢复：上次退出时排着队没发出去的内容，接回来等本轮结束照常自动发送。
    // 不在这里立刻起回合——启动这一刻用户可能正要输别的（与后台通知补投同一考虑）。
    this.queue = [...(deps.session.queue ?? [])];
    this.history = [...deps.session.messages];

    this.tui = new TuiMainScreen(new ProcessTerminal());
    // 内容变短不清屏：开启会让每次折叠/裁剪都清一次 scrollback（实测结论第二条）
    this.tui.setClearOnShrink(false);

    this.status = new StatusLine({
      mode: this.mode,
      planMode: this.planMode,
      model: this.modelLabel,
      thinking: this.thinkOverride,
      busy: false,
      cwd: deps.ctx.cwd,
      usedTokens: 0,
      maxContextSize: deps.maxContextSize,
      hints: HINTS,
      backgroundCount: 0,
      queueLen: 0,
    });

    this.editor = new ChatEditor(this.tui, editorTheme);
    // 补全：/命令 与 @文件。models/providers 取启动快照（运行期不变），
    // thinkChoices 含 'off'（关闭思考也是合法档位），文件索引启动后异步回填。
    this.completion = new ChatAutocompleteProvider({
      models: deps.config.models ?? {},
      thinkChoices: [...THINK_CHOICES, 'off'],
      providers: [...Object.keys(PROVIDER_PRESETS), ...Object.keys(deps.config.providers ?? {})],
      pluginIds: [],
    });
    this.editor.setAutocompleteProvider(this.completion);
    this.editor.onSubmit = (text) => {
      void this.onSubmit(text);
    };
    this.editor.onEscapeKey = () => this.onEscape();
    this.editor.onCtrlC = () => this.onCtrlC();
    this.editor.onCtrlS = () => this.handleCtrlS();
    // 任意其他键解除两个 primed 态：不这么做的话，用户按了 Esc 又去打字，5 秒内的
    // 下一次 Esc 会被当成「双击的第二下」，把上一条消息意外回退掉。
    this.editor.onOtherKey = () => {
      this.cancelBacktrackPrimed();
      this.cancelExitPrimed();
    };
    // 提示符着色跟随 busy。
    // 绑一个读 this.busy 的函数，而不是在 6 处 setBusy 调用点各改一次——那种写法
    // 漏一处就出现「回合在跑但提示符还是灰的」这类状态不同步。
    this.editor.promptStyle = (s) => {
      // bash 模式（! 开头）提示符变色：命令将在本地执行而不是发给模型，这个区别必须一眼可见
      if (this.editor.getText().startsWith('!')) return c.bold(c.accent(s));
      return this.busy ? c.bold(c.warn(s)) : c.bold(c.dim(s));
    };
    // 空输入时的占位文案。busy 那句是行为说明（此时打字会进发送队列而不是立刻发出），
    // 与提示符同样绑成读 this.busy 的函数，两者状态天然一致。
    this.editor.placeholderStyle = (s) => c.dim(s);
    this.editor.placeholderText = () => t(this.busy ? 'input.placeholder.busy' : 'input.placeholder.idle');
    // primed 提示行（Esc 双击回退 / Ctrl+C 双击退出 / bash 模式）。绑成读状态的函数：
    // 两个 primed 各有进入、超时、按键解除三条出口，逐处回写文案必漏。
    // primed 提示只在空闲时显示——busy 态下 Esc 是中断、Ctrl+C 是清空/中断；
    // bash 模式（! 开头）的提示不受此限，busy 时按 Enter 是排队，用户同样需要知道。
    this.editor.footerStyle = (s) => (this.editor.getText().startsWith('!') ? c.dim(s) : c.warn(s));
    this.editor.footerText = () => {
      // bash 模式提示：只要输入以 ! 开头就显示（busy 时也显示——此时按 Enter 是排队）
      if (this.editor.getText().startsWith('!')) return t('input.bangHint');
      if (this.busy) return '';
      if (this.backtrackPrimed) return t('input.backtrackPrimed');
      if (this.exitPrimed) return t('input.exitPrimed');
      return '';
    };
    // Ctrl+V / Alt+V 读剪贴板图片。busy 时也允许：只往输入框草稿追加占位符，不碰在跑的回合
    // （提交走排队路径，drain 时统一展开成图）。
    // 两个键位同一动作：Alt+V 是主仓原键位（用户肌肉记忆），Ctrl+V 兜住 Alt 被终端/窗口管理器吃掉的场景。
    const attach = (): boolean => {
      void this.attachClipboardImage();
      return true;
    };
    this.editor.onCtrlV = attach;
    this.editor.onAltV = attach;
    // ↑ 取回队列尾部一条进输入框编辑：busy + 空输入时生效。
    // 发送从头部消费（drainQueue shift），编辑从尾部取回（pop），两个方向不冲突。
    // 系统合成注入（后台通知 / cron / skill 正文）不给取回——正文是给模型看的 XML，
    // 用户改完提交会以真人身份进历史。取回即从 notifyPrepared 摘除。
    this.editor.onUpArrow = () => this.recallQueuedOne();
    // Ctrl+B 转后台：busy 且有前台任务时全部 detach（进程继续跑、终态自动通知）；
    // 空闲或无前台任务时返回 null → 不消费按键，交回编辑器。
    this.editor.onCtrlB = () => {
      const detached = applyCtrlB(this.busy, this.background);
      if (detached === null) return false;
      if (detached > 0) {
        this.push({ kind: 'note', text: t('background.detached', { count: detached }) });
        this.syncStatus();
      }
      return true;
    };
    // Ctrl+O 全屏查看器：收集最近 ≤10 条被折叠的工具输出 / 长 thinking，没内容时不消费按键
    this.editor.onCtrlO = () => this.openExpandViewer();
    // Ctrl+G 外部编辑器：把当前输入框内容丢进 $EDITOR 编辑，保存后回填。
    // busy 时也允许——编辑的是草稿，不碰在跑的回合。终端输入框写长 prompt 是痛点，
    // 主流 CLI 编辑器普遍提供此能力。找不到编辑器时返回 false（不消费按键）。
    this.editor.onCtrlG = () => this.openExternalEditor();

    // cron 装配：到点把 prompt 静默注入跑一轮；isIdle 闸门保证回合进行中不触发
    // （错过的会在下个空闲 tick 合并补投，coalesced 计数进卡片）。
    this.pluginCommandMap = new Map((deps.pluginCommands ?? []).map((c) => [c.name, c]));
    this.cronStore = new CronJobStore(deps.store, () => {
      // 落盘失败只能忽略：TUI 模式下 console.warn 会写进终端，把渲染帧搅乱
    });
    this.cron = new CronScheduler(
      (job, coalesced) => {
        this.push({
          kind: 'cron',
          data: { id: job.id, cron: job.cron, prompt: job.prompt, recurring: job.recurring, coalesced },
        });
        void this.runTurn(job.prompt, { silent: true });
        // 触发时 nextFireAt 已在 tick 内同步推进，这里补写的是新游标
        if (job.recurring) queueMicrotask(() => void this.cronStore.save(this.deps.ctx.cwd, job));
        else void this.cronStore.remove(this.deps.ctx.cwd, job.id);
      },
      () => !this.busy && !this.promptActive,
      this.session.id,
    );
    this.cron.onJobChange = (kind, job) => {
      if (kind === 'create') void this.cronStore.save(this.deps.ctx.cwd, job);
      else void this.cronStore.remove(this.deps.ctx.cwd, job.id);
    };
    // session 隔离：只装回本会话的 cron 任务（构造与切会话都走 reloadCron，避免旧任务串台）
    this.reloadCron();

    // goal 快照恢复：active 会被降级为 paused（防重启后无人看着就自动续跑）
    this.goal.restore(deps.session.goal);
    this.goal.setOnChange((ev) => this.onGoalChange(ev));
    // team 恢复是异步的（要校验档案目录还在）：档案被删则静默降级为未激活
    void this.team.restore(deps.session.team).then(() => {
      this.status.setState({ teamActive: this.team.active });
      this.tui.requestRender();
    });
    this.team.setOnChange((active) => {
      this.status.setState({ teamActive: active });
      this.tui.requestRender();
    });

    this.streamBuffer = new StreamBuffer((ev) => this.applyEvent(ev));
    // 后台任务管理器绑到当前会话。字段初始化只是给个占位实例（无 tasksDir、无回调），
    // 必须在这里绑一次——此前只有 /new、/fork、/resume 调 rebind，于是**启动会话**用的
    // 一直是那个占位实例：任务落盘目录为空、onSettle 没挂，任务跑完悄无声息（实测：
    // 状态栏 bg:1 徽章正常出现，8 秒后终态通知不出现）。
    this.rebindBackground();
    this.compactionBinding = resolveCompactionBinding(deps.config, this.compactionProviderCache);
    this.termTitle = new TerminalTitleWriter(
      process.env,
      process.stdout.isTTY,
      deps.config.tui?.terminalTitle ?? true,
      (str) => process.stdout.write(str),
    );
    this.syncTerminalTitle();

    this.tui.addChild(this.transcript);
    this.tui.addChild(this.activity);
    // 常驻 chrome（待办 + 队列预览）挂在输入框正上方，不参与高度预算协商——差分渲染无超屏清屏问题，面板按内容占行
    this.tui.addChild(this.chrome);
    // inputSlot 包住 editor：选择器内联模式下，editor 与 PickerOverlay 在此容器内互换，
    // 位置不变
    this.inputSlot.addChild(this.editor);
    this.tui.addChild(this.inputSlot);
    this.tui.addChild(this.status);
    this.tui.setFocus(this.editor);
  }

  /** 启动 TUI，返回的 Promise 在退出时 resolve。 */
  start(): Promise<PiChatExit> {
    // 欢迎框是第一个条目（新建与 resume 都显示），放 replayHistory 之前，恢复会话时它也在历史回放之上。
    this.transcript.push({
      kind: 'welcome',
      data: { cwd: this.deps.ctx.cwd, sessionId: this.session.id, model: this.modelLabel, version: versionLine() },
    });
    this.replayHistory();
    // 恢复会话时 active goal 被降级为 paused（防重启后无人看着就自动续跑）。
    // 这是静默发生的，不明说用户会以为目标还在推进。
    const resumed = this.goal.get();
    if (resumed !== null && (resumed.status === 'active' || resumed.status === 'paused')) {
      this.push({ kind: 'note', text: `本会话有目标「${resumed.objective}」，已暂停，用 /goal resume 继续` });
    }
    // 恢复的 goal（含 paused）也要挂徽标：只发一条 note 的话，用户滚上去就再看不到目标还在
    this.syncGoalBadge();
    if (this.deps.configStartupNotice !== undefined) {
      this.push({ kind: 'note', text: this.deps.configStartupNotice });
    }
    // SessionStart hook：会话创建/恢复后触发一次，stdout 注入 system 尾部。
    // notice 出口先挂上，否则 hook 的可见性提示会静默丢（/reload 时也补挂，见 runReload）。
    const engine = this.deps.hookEngineRef.current;
    if (engine !== undefined) {
      engine.setNoticeSink((m) => this.push({ kind: 'note', text: m }));
      void engine.run('SessionStart', {}).then((r) => {
        if (r.stdout !== '') this.sessionContext = r.stdout;
      });
    }
    // 启动对账：磁盘上 running 但无活进程的判 lost，已终态而通知未送达的补投。
    // 上个进程崩溃或被强杀时，那批任务的 onSettle 从未触发过，只有这里能捞回来。
    this.reconcileBackground(this.deps.resumeDelivered ?? new Set());
    this.tui.start();
    // @ 文件补全的索引：后台扫 cwd，不阻塞首帧。扫完前 @ 补全为空（优雅降级），
    // 失败也降级为空索引，不影响命令补全。
    void scanFileIndex(this.deps.ctx.cwd)
      .then((files) => this.completion.setFiles(files))
      .catch(() => this.completion.setFiles([]));
    // spinner 稳帧：独立 80ms 定时器。只在忙碌且非输入态时推进帧并重渲，
    // 与下方计时器解耦，保证动画不随计时器频率抖动。promptActive 时不转（用户在输入）。
    this.spinnerTimer = setInterval(() => {
      if (this.busy && !this.promptActive) {
        this.activity.tick();
        this.tui.requestRender();
      }
    }, 80);
    // 计时器：用时/goal 徽章/任务弹层秒级更新。只需秒级精度，120ms 一拍够用；
    // overlay 每 8 拍（约 1 秒）重渲一次。spinner 不在这里走，已拆给 spinnerTimer。
    this.ticker = setInterval(() => {
      if (this.overlayNeedsTick) {
        this.overlayTickCount += 1;
        if (this.overlayTickCount % 8 === 0) this.tui.requestRender();
      }
      if (!this.busy || this.promptActive) return;
      // goal 徽标的用时要跟着走秒（只在有 goal 时同步，避免每 120ms 白替换一次状态）
      if (this.goal.get() !== null) this.syncGoalBadge();
      this.tui.requestRender();
    }, 120);
    // 堆水位看护：长会话会持续变重，接近上限前给用户一次「/new 开新会话」的机会，
    // 更高水位时留一份 heap snapshot——崩溃后的堆没法事后检查，只能在崩之前抓。
    this.stopHeapWatch = startHeapWatch({
      notify: (text) => this.push({ kind: 'note', text }),
      dumpDir: join(homedir(), '.step-code'),
    });
    this.tui.requestRender();
    return new Promise<PiChatExit>((resolve) => {
      this.resolveExit = resolve;
    });
  }

  private replayHistory(): void {
    if (this.session.messages.length === 0) return;
    const replay = historyToDisplayItems(this.session.messages);
    const items = [...replay.items];
    items.push({
      kind: 'note',
      text: `已恢复会话 ${this.session.id}（${replay.totalTurns} 轮 / ${this.session.messages.length} 条消息）`,
    });
    this.transcript.reset(items, replay.foldedTurns);
  }

  // ---------------------------------------------------------------- 数据变更

  private push(item: DisplayItem): void {
    this.transcript.push(item);
    this.tui.requestRender();
  }

  private syncStatus(): void {
    const running = this.background.list().filter((t) => t.status === 'running');
    this.status.setState({
      mode: this.mode,
      model: this.modelLabel,
      thinking: this.thinkOverride,
      maxContextSize: this.maxContextSize,
      planMode: this.planMode,
      busy: this.busy,
      queueLen: this.queue.length,
      backgroundCount: running.length,
      // 最近一个 running 任务的命令名：只有 bg:N 数字时用户不知道是哪个任务在占用
      latestBgTask: running.length > 0 ? running[running.length - 1]!.command : undefined,
    });
    this.syncGoalBadge();
    // 常驻面板跟状态同步：todos 由工具改、queue 由排队改，busy 态影响队列取回提示
    this.chrome.setTodos(this.todos.items);
    this.chrome.setQueue(this.queue);
    this.chrome.setBusy(this.busy);
  }

  /**
   * goal 徽标同步：任何非终态 goal 都显示（含 paused / blocked），按状态着色的圆点常驻。
   * 只在 active 时显示数字会让 paused 的目标从界面消失，用户以为它没了。
   */
  private syncGoalBadge(): void {
    const g = this.goal.get();
    this.status.setState({
      goal:
        g === null
          ? undefined
          : {
              status: g.status,
              turnsUsed: g.turnsUsed,
              turnBudget: g.turnBudget,
              elapsedMs: Math.max(0, Date.now() - g.createdAt),
            },
    });
  }

  /**
   * 打开全屏查看器（Ctrl+O）。收集为空时返回 false（不消费按键），并给一条提示——
   * 折叠提示上写着「Ctrl+O 查看」，按了没反应比没有这个键更糟。
   * 弹层活跃期间（审批/选择器）不开：焦点已被占用，再叠一层会打断正在进行的确认。
   */
  private openExpandViewer(): boolean {
    if (this.promptActive) return false;
    // 打开期间把焦点从编辑器移交给 overlay，关闭时归还——不归还的话按键会掉进空档
    const opened = openExpandViewer(
      this.tui,
      this.transcript.items(),
      (item, width) => ItemBlock.renderExpanded(item, width),
      () => this.tui.setFocus(this.editor),
    );
    if (opened === null) {
      this.push({ kind: 'note', text: '没有可展开的内容（工具输出与思考过程被折叠时才需要展开查看）' });
      return true;
    }
    return true;
  }

  /**
   * 打开 `/tasks` 交互弹层。任务数据每帧现取（运行中任务的用时与输出在变），
   * 1 秒 tick 靠 PiChat 的 ticker 带动重渲。选中任务按 o/Enter 时把它的完整输出
   * 送进全屏查看器——那边已经有滚动与键位，不重复实现第二套。
   */
  private openTasksOverlay(): void {
    if (this.promptActive) return;
    const overlay = new TasksOverlay({
      getTasks: () => this.background.list(),
      stopTask: (id) => {
        const ok = this.background.stop(id);
        this.push({ kind: 'note', text: ok ? `已终止任务 ${id}` : `任务 ${id} 无法终止（可能已结束）` });
        this.syncStatus();
        return ok;
      },
      openOutput: (task) => {
        // 输出全文进转录区：查看器只收集转录区里的条目，这里先落一条 tool 形态的条目
        // 会污染历史，所以直接推 note——用户要的是「看到全文」，不是「多一条工具卡片」
        handle.hide();
        this.overlayNeedsTick = false;
        this.tui.setFocus(this.editor);
        this.push({
          kind: 'note',
          text: `任务 ${task.id}（${task.status}）输出：
${task.output === '' ? '（暂无输出）' : task.output}`,
        });
      },
      requestRender: () => this.tui.requestRender(),
      onClose: () => {
        handle.hide();
        this.overlayNeedsTick = false;
        this.tui.setFocus(this.editor);
        this.tui.requestRender();
      },
    });
    const handle = this.tui.showOverlay(overlay, { width: '90%', maxHeight: '80%', anchor: 'center' });
    handle.focus();
    this.overlayNeedsTick = true;
    this.tui.requestRender();
  }

  /**
   * ④ `/agents` 分组面板：当前会话派生的子 agent 总览。
   *
   * 数据源：SubagentStore.list 过滤 parentId === 当前会话 id。运行中子 agent 靠 runner
   * 每轮 saveSnapshot 刷新索引，延迟 ≤ 1 轮。选中后进 browseSubagentSession（只读浏览）。
   */
  private openAgentsOverlay(): void {
    if (this.promptActive) return;
    const sessionId = this.session.id;
    const overlay = new AgentsOverlay({
      getAgents: () => this.deps.subagentStore.list(this.deps.ctx.cwd).filter((m) => m.parentId === sessionId),
      onBrowse: (id) => {
        handle.hide();
        this.overlayNeedsTick = false;
        this.tui.setFocus(this.editor);
        this.browseSubagentSession(id);
      },
      requestRender: () => this.tui.requestRender(),
      onClose: () => {
        handle.hide();
        this.overlayNeedsTick = false;
        this.tui.setFocus(this.editor);
        this.tui.requestRender();
      },
    });
    const handle = this.tui.showOverlay(overlay, { width: '90%', maxHeight: '80%', anchor: 'center' });
    handle.focus();
    this.overlayNeedsTick = true;
    this.tui.requestRender();
  }

  /**
   * 把子 agent 进度写进最近一条运行中的 spawn_agent 条目。
   *
   * 只找「运行中」的那条：同一轮可能并行派多个子 agent，但 runner 的 onEvent 不带
   * 工具调用 id（只有 session id），无法精确路由。取最近一条运行中的条目作近似——并行时
   * 进度会挤在最后一条上（如实记在设计档案的差异清单里）。
   */
  private applySubagentProgress(ev: SubagentProgressEvent): void {
    const patch = (
      apply: (it: Extract<DisplayItem, { kind: 'tool' }>) => Extract<DisplayItem, { kind: 'tool' }>,
    ): void => {
      this.transcript.updateLastWhere(
        (it) => it.kind === 'tool' && it.name === 'spawn_agent' && it.status === 'running',
        (it) => apply(it as Extract<DisplayItem, { kind: 'tool' }>),
      );
      this.tui.requestRender();
    };
    if (ev.kind === 'start') {
      // 把解析后的真实角色名（含默认 general）与显示描述盖到卡片上——tool_start 处只抄
      // 模型入参里的 subagent_type，模型省略该参数时卡片没有类型标识，分不清 explore/general。
      patch((it) => ({ ...it, subagentType: ev.subagentType, description: ev.description }));
      return;
    }
    if (ev.kind === 'tool') {
      patch((it) => ({ ...it, subagentToolEvents: [...(it.subagentToolEvents ?? []), { name: ev.name, status: 'running' } as SubagentToolEvent].slice(-SUBAGENT_EVENT_CAP) }));
      return;
    }
    if (ev.kind === 'tool_end') {
      patch((it) => {
        const events = [...(it.subagentToolEvents ?? [])];
        // 从后往前找同名的运行中项收尾（同一工具可能被连续调用多次）
        for (let i = events.length - 1; i >= 0; i--) {
          if (events[i]!.name === ev.name && events[i]!.status === 'running') {
            events[i] = { name: ev.name, status: ev.isError ? 'error' : 'ok' };
            break;
          }
        }
        return { ...it, subagentToolEvents: events.slice(-SUBAGENT_EVENT_CAP) };
      });
      return;
    }
    if (ev.kind === 'usage') {
      patch((it) => ({ ...it, subagentTokens: ev.tokens }));
      return;
    }
    if (ev.kind === 'end') {
      patch((it) => ({ ...it, subagentToolUses: ev.toolUses, subagentDurationMs: ev.durationMs }));
    }
  }

  /**
   * dynamic_workflow 阶段进度写进最近一条运行中的 dynamic_workflow 条目。
   * phase 事件只有 title（index 为哨兵 -1），所以按 title 追加：新 title 追加一个阶段，
   * 同时把前一个阶段标 done——脚本里 phase() 是顺序推进的，后一个开始即前一个结束。
   */
  private applyWorkflowStep(info: WorkflowStepEvent): void {
    if (info.kind !== 'phase' || info.title === undefined || info.title === '') return;
    const title = info.title;
    this.transcript.updateLastWhere(
      (it) => it.kind === 'tool' && it.name === 'dynamic_workflow' && it.status === 'running',
      (it) => {
        const tool = it as Extract<DisplayItem, { kind: 'tool' }>;
        const panel = tool.dynamicWorkflow ?? { name: summarizeInput(tool.input) || 'workflow', phases: [] };
        if (panel.phases.some((ph) => ph.title === title)) return tool;
        const phases = panel.phases.map((ph) => (ph.status === 'running' ? { ...ph, status: 'done' as const } : ph));
        phases.push({ title, status: 'running' });
        return { ...tool, dynamicWorkflow: { ...panel, phases } };
      },
    );
    this.tui.requestRender();
  }

  /** `/provider` 无参：渠道管理弹层。选中已有渠道即按它切换（走既有 runProvider 解析路径）。 */
  private async openProviderManagerOverlay(): Promise<void> {
    if (this.promptActive) return;
    const res = await openProviderManager(this.tui, this.deps.config, (text) => this.push({ kind: 'note', text }));
    this.tui.setFocus(this.editor);
    if (res.kind === 'switch' && res.target !== undefined) this.runProvider(res.target);
  }

  /** `/provider add`：新增渠道向导（写盘走 appendProviderConfig，带备份与回滚）。 */
  private async openProviderWizard(): Promise<void> {
    if (this.promptActive) return;
    await runProviderWizard(this.tui, this.deps.config, (text) => this.push({ kind: 'note', text }));
    this.tui.setFocus(this.editor);
    this.tui.requestRender();
  }

  /**
   * 队列变更的唯一出口：改内存 → 落 wire 事件 → 刷状态栏与常驻面板。
   *
   * 不允许各处直接改 `this.queue`：变更点有五处（busy 时排队、排队的斜杠命令、后台
   * 通知补投、Esc 取回时清空、回合末消费剩余），任一处漏落盘就会出现「界面显示 N 条、
   * 重启后变 M 条」。走 wire 事件而不是只等 persist 的理由见 wirelog 里 queue.update
   * 的说明：排队发生在 busy 期间，而 persist 集中在回合边界。
   */
  private updateQueue(next: readonly string[]): void {
    this.queue = [...next];
    this.appendWire({
      type: 'queue.update',
      ts: new Date().toISOString(),
      queue: next.length > 0 ? [...next] : undefined,
    });
    this.syncStatus();
  }

  /** 持久化。顺序不变量：先 appendFull 再 save（wireSeq 游标一致性）。 */
  private persist(): void {
    this.session.messages = this.history;
    this.session.todos = [...this.todos.items];
    this.session.mode = this.mode;
    this.session.model = this.currentAlias ?? this.model;
    this.session.thinkOverride = this.thinkOverride;
    this.session.planMode = this.planMode;
    // 空队列写 undefined 而非空数组：与 queue.update 事件的归一口径一致，快照里不留噪音
    this.session.queue = this.queue.length > 0 ? [...this.queue] : undefined;
    // goal 与 team 快照随会话落盘（无值时清掉旧字段，否则 resume 会复活已结束的目标）
    this.session.goal = this.goal.snapshot() ?? undefined;
    this.session.team = this.team.snapshot() ?? undefined;
    try {
      // 顺序是不变量：先 appendFull 后 save。save() 把当前 wire 事件数写进快照当
      // 检查点游标；顺序颠倒会让快照 messages 比游标超前，resume 重放尾段事件时把
      // 已在快照里的消息再追加一次。
      this.deps.store.appendFull(this.session.cwd, this.session.id, this.history);
      // delivered 事件在此统一补写：通知消息本体随 appendFull 落盘的同一时刻写送达事件，
      // 两者同生共死——崩溃只可能丢「都还没写」的，对账会正确补投；不允许出现
      // 「事件已落盘、消息没落盘」的中间态（那会让对账误判已送达而丢掉补投机会）。
      const pendingDelivered = pendingDeliveredEvents(this.history, this.deliveredWritten, new Date().toISOString());
      if (pendingDelivered.length > 0) {
        this.deps.store.appendWire(this.session.cwd, this.session.id, pendingDelivered);
      }
      this.deps.store.save(this.session);
    } catch {
      // 持久化失败不打断会话
    }
  }

  /**
   * 追加一条 wire 事件到当前会话的事件日志。
   *
   * 这条日志不是「另一份历史备份」：`/usage` 的 token 统计、`/export-debug-zip` 的
   * 调试包、会话重放都只读它，而 `appendFull` 落的快照里没有 usage 与状态变更。
   * 所以凡是改动会话前提的动作（权限模式、plan、思考深度、压缩应用）都要落一条，
   * 否则那些命令拿到的是空数据（M4 之前 pi 版就是这个状态）。
   */
  private appendWire(event: WireEvent): void {
    try {
      this.deps.store.appendWire(this.session.cwd, this.session.id, [event]);
    } catch {
      // 持久化失败不打断会话
    }
    // 内存泄漏根因修复（2026-08-17）：compaction（自动 + 手动）只压缩 this.history，
    // 原来从不重建 Transcript——blocks 数组持续累积 ItemBlock（各持 cachedLines + Markdown
    // 实例），history 反复压回 ~79 条但渲染快照不解绑，4GB 堆全活对象、会话才 240KB 即此因。
    // context.apply_compaction 到达时 this.history 已被 replaceMessages 原地改成压缩后
    // （同一引用），据此重建转录块，旧块失去引用即被 GC。仅 full 压缩发此事件（micro
    // 不发），且 compaction 只在回合边界、无在途条目，重建安全。
    if (event.type === 'context.apply_compaction') {
      this.transcript.reset(historyToDisplayItems(this.history).items);
    }
  }

  // ---------------------------------------------------------------- 输入路由

  /**
   * Esc 三态：
   *   1. 审批/弹层激活时由弹层自己消费，走不到这里；
   *   2. busy → 中断当前回合；
   *   3. 空闲 + 队列非空 → 取回队列内容进输入框。
   * 返回 true 表示已消费。
   */
  /**
   * ↑ 取回队列尾部一条进输入框编辑（busy + 空输入时 ChatEditor.onUpArrow 调用）。
   * pop 队尾（发送从头部 shift 消费，编辑从尾部 pop 取回，两方向不冲突）；
   * 系统合成注入不给取回（原位放回，不跨过它往前翻，FIFO 顺序不能被打乱）；
   * 取回成功返回 true，队列空或全是系统注入返回 false（让 ↑ 下传）。
   */
  private recallQueuedOne(): boolean {
    if (!this.busy || this.editor.getText() !== '' || this.queue.length === 0) return false;
    const recalled = this.queue[this.queue.length - 1]!;
    if (this.notifyPrepared.has(recalled)) return false; // 系统注入不取回
    this.updateQueue(this.queue.slice(0, -1));
    this.editor.setText(recalled);
    return true;
  }

  private onEscape(): boolean {
    // 子 agent 浏览态：Esc 退出浏览返回主会话现场
    if (this.subagentBrowsing !== null) {
      this.exitSubagentBrowse();
      return true;
    }
    if (this.busy) {
      this.abortTurn();
      return true;
    }
    if (this.queue.length > 0) {
      // 系统合成注入（后台通知信封 / cron prompt / skill 正文）不进输入框草稿：正文是给
      // 模型看的 XML，用户既不该编辑也读不懂，灌进去只会得到一段标签。这些条目随队列一起
      // 丢弃（与本分支的清空语义一致），但单独报数——静默消失比丢弃更糟。
      const dropped = this.queue.filter((s) => this.notifyPrepared.has(s));
      const drafts = this.queue.filter((s) => !this.notifyPrepared.has(s));
      // 被丢弃的通知不再补投，所以在此显式落盘 delivered 事件（丢弃即送达）——它们的消息
      // 本体永远不会进 history，走不到 persist 的统一补写，不落盘就会在下次对账时重复投递。
      for (const text of dropped) {
        const o = this.notifyPrepared.get(text)?.origin;
        if (o?.kind !== 'background_task' || o.notificationId === undefined) continue;
        const key = notifyDedupKeyFromOrigin(o.taskId, o.notificationId);
        if (this.deliveredWritten.has(key)) continue;
        this.deliveredWritten.add(key);
        this.appendWire({
          type: 'background.notify_delivered',
          ts: new Date().toISOString(),
          taskId: o.taskId ?? '',
          status: /^task:.+:([a-z]+)$/.exec(o.notificationId)?.[1] ?? '',
          notificationId: o.notificationId,
        });
      }
      this.updateQueue([]);
      this.notifyPrepared.clear();
      const cur = this.editor.getText();
      const merged = drafts.join('\n');
      if (merged !== '') this.editor.setText(cur === '' ? merged : `${cur}\n${merged}`);
      this.push({
        kind: 'note',
        text:
          dropped.length > 0
            ? `已把排队消息取回输入框（另丢弃 ${dropped.length} 条系统注入）`
            : '已把排队消息取回输入框',
      });
      this.syncStatus();
      return true;
    }
    // 队列空 + 输入框空 + 有可回退的 user 消息：双击 Esc 回退编辑上一条
    if (this.editor.getText() === '' && computeBacktrack(this.history) !== null) {
      // 中断冷静期：刚按 Esc/Ctrl+C 中断完回合的 1s 内，连按 Esc 多半是「确认停了没」，
      // 不该被当成回退意图（参照成熟实现的 rewind 冷静期）。
      if (Date.now() - this.lastAbortAt < ABORT_COOLDOWN_MS) return true;
      if (this.backtrackPrimed) this.performBacktrack();
      else this.enterBacktrackPrimed();
      return true;
    }
    return false;
  }

  /** 进入 backtrack primed：5 秒无第二次 Esc 自动解除。 */
  private enterBacktrackPrimed(): void {
    this.backtrackPrimed = true;
    if (this.backtrackPrimedTimer !== undefined) clearTimeout(this.backtrackPrimedTimer);
    this.backtrackPrimedTimer = setTimeout(() => {
      this.backtrackPrimed = false;
      this.backtrackPrimedTimer = undefined;
      // 超时解除必须主动重绘：没有按键事件驱动这一帧，不请求的话提示行会一直挂在屏幕上
      this.tui.requestRender();
    }, PRIMED_TIMEOUT_MS);
    this.tui.requestRender();
  }

  /** 解除 backtrack primed（第二次 Esc 执行前、或按下任意其他键时）。 */
  private cancelBacktrackPrimed(): void {
    if (!this.backtrackPrimed) return;
    this.backtrackPrimed = false;
    if (this.backtrackPrimedTimer !== undefined) {
      clearTimeout(this.backtrackPrimedTimer);
      this.backtrackPrimedTimer = undefined;
    }
    this.tui.requestRender();
  }

  /** 解除 exit primed（按下任意非 Ctrl+C 键时）。 */
  private cancelExitPrimed(): void {
    if (!this.exitPrimed) return;
    this.exitPrimed = false;
    if (this.exitPrimedTimer !== undefined) {
      clearTimeout(this.exitPrimedTimer);
      this.exitPrimedTimer = undefined;
    }
    this.tui.requestRender();
  }

  /**
   * 第二次 Esc：回滚最近一条 user 消息及其之后的全部历史，转录区同步截断，
   * 消息文本 prefill 回输入框。
   *
   * 历史与转录区必须一起截断：只改 history 会让屏幕上还留着已被回滚的问答，用户以为
   * 模型还记得那一轮。两个纯函数（computeBacktrack / truncateItemsAtLastUser）迁移时
   * 就在 chat/ 里躺着，一直没有调用点。
   */
  private performBacktrack(): void {
    this.cancelBacktrackPrimed();
    const result = computeBacktrack(this.history);
    if (result === null) return;
    this.history.length = 0;
    this.history.push(...result.history);
    this.transcript.reset(truncateItemsAtLastUser(this.transcript.items()));
    // 回滚后的历史要落盘，否则重启又把已撤销的那轮读回来
    this.persist();
    this.editor.setText(result.prefill);
    // 用量基准跟着回退：不重算的话状态栏还显示回滚前的 context 占用
    this.measuredLen = Math.min(this.measuredLen, this.history.length);
    this.syncStatus();
    this.tui.requestRender();
  }

  /**
   * Ctrl+C 三态：busy 且输入框有内容 → 先清空；busy 且空 → 中断；
   * 空闲首次 → 清空 + primed（5 秒内再按退出）；空闲已 primed → 退出。
   */
  private onCtrlC(): boolean {
    if (this.busy) {
      if (this.editor.getText() !== '') {
        this.editor.setText('');
        this.tui.requestRender();
        return true;
      }
      this.abortTurn();
      return true;
    }
    if (this.exitPrimed) {
      this.exit();
      return true;
    }
    if (this.editor.getText() !== '') this.editor.setText('');
    this.exitPrimed = true;
    // 提示走输入框下方的瞬时行，不进转录区：note 会永久留在历史里，用户翻回去看到一堆
    // 「再按一次 Ctrl+C 退出」的残骸，而当下那条早滚上去看不见了。
    this.exitPrimedTimer = setTimeout(() => {
      this.exitPrimed = false;
      this.exitPrimedTimer = undefined;
      this.tui.requestRender();
    }, PRIMED_TIMEOUT_MS);
    this.tui.requestRender();
    return true;
  }

  /**
   * 同步终端 tab 标题：口径与会话列表一致（name 优先，其次 title），
   * 两者都没有时用 cwd 文件夹名（新会话的初始标题，AI 标题生成后再覆盖）。
   * 每个切换会话 / 生成标题 / rename 的挂点都调一次；不支持的终端在 writer 内部空操作。
   */
  private syncTerminalTitle(): void {
    const s = this.session;
    const display =
      (s.name !== undefined && s.name.trim() !== '' ? s.name.trim() : undefined) ??
      (s.title !== undefined && s.title.trim() !== '' ? s.title.trim() : undefined) ??
      basename(s.cwd);
    this.termTitle.set(display);
  }

  /**
   * 会话标题 AI 生成：第一轮回答后异步触发一次（fire-and-forget，不阻塞回合收尾）。
   * 覆盖纪律见 session/title.ts——用户 rename 过、或标题被外部改过的会话不动。
   *
   * 迁移时整块漏掉了，pi 版此前所有会话的标题都停在 deriveTitle 的首句截断上。
   */
  private maybeGenerateTitle(): void {
    const sess = this.session;
    if (this.titleGenTried.has(sess.id)) return;
    if (!canOverwriteTitle(sess, deriveTitle(sess.messages))) return;
    this.titleGenTried.add(sess.id);
    void (async () => {
      const generated = await generateSessionTitle(this.provider, this.history, {});
      if (generated === undefined) return;
      // 写回前重新加载再判一次：生成期间用户可能已 rename 或改过标题
      const latest = this.deps.store.load(sess.cwd, sess.id);
      if (latest === null) return;
      if (!canOverwriteTitle(latest, deriveTitle(latest.messages))) return;
      this.deps.store.updateTitle(sess.cwd, sess.id, generated);
      // 只在会话未被切走时同步 tab（生成是 fire-and-forget，期间可能 /new 或 /resume）
      if (this.session.id === sess.id) {
        this.session.title = generated;
        this.syncTerminalTitle();
      }
    })();
  }

  /**
   * `/compact-model`：会话级切换压缩摘要模型。
   *
   * 三态：无参弹选择器（与 `/model` 对齐）、`reset` 清除覆盖、带参直接切换。
   * 覆盖不落盘——与 `/model` 同口径，持久化靠 config.toml 加热重载。
   */
  private runCompactModel(arg: string): void {
    // reset：清除覆盖按 config 重解。缓存不清——键是别名，重解同别名复用实例
    if (arg === 'reset') {
      if (this.compactionModelOverride === undefined) {
        this.push({ kind: 'note', text: t('app.compactModel.noOverride') });
        return;
      }
      this.compactionModelOverride = undefined;
      this.compactionBinding = resolveCompactionBinding(this.deps.config, this.compactionProviderCache);
      this.push({ kind: 'note', text: t('app.compactModel.resetDone') });
      return;
    }
    this.applyCompactModel(arg);
  }

  /** 应用压缩模型覆盖（别名切换逻辑，picker 与命令行共用）。 */
  private applyCompactModel(arg: string): void {
    this.compactionModelOverride = arg;
    const binding = resolveCompactionBinding(this.deps.config, this.compactionProviderCache, arg);
    this.compactionBinding = binding;
    if (binding.provider !== undefined) {
      this.push({ kind: 'note', text: t('app.compactModel.switchedAlias', { name: arg, model: binding.model ?? arg }) });
    } else if (binding.model !== undefined) {
      this.push({ kind: 'note', text: t('app.compactModel.switchedBare', { model: binding.model }) });
    } else {
      // 别名渠道构造失败 → 空绑定 = 跟随主会话模型，不能说「切换成功」。
      // 覆盖保留（与 config 里配了坏别名的行为一致），reset 可清除。
      this.push({ kind: 'note', text: t('app.compactModel.fallback', { name: arg }) });
    }
  }

  /** 压缩模型选择器：与 /model 同款 picker，当前压缩模型标 ●。 */
  private async pickCompactModel(): Promise<void> {
    const items = modelItems(this.deps.config, this.compactionModelOverride ?? this.deps.config.compaction.model);
    if (items.length === 0) {
      this.push({ kind: 'note', text: '配置里没有 [models.*] 别名，先用 /compact-model <模型 id> 直切' });
      return;
    }
    const tabs = modelTabs(this.deps.config);
    const picked = await this.showInlinePicker({
      title: '选择压缩模型',
      items,
      hint: '↑↓ 选择 · Enter 确认 · 输入过滤 · Esc 取消',
      tabs,
      itemsForTab: (tabId) => modelItems(this.deps.config, this.compactionModelOverride ?? this.deps.config.compaction.model, tabId),
    });
    if (picked !== null) this.applyCompactModel(picked);
  }

  /**
   * Ctrl+S 主动插队：把队列里的用户草稿（系统注入除外）与输入框文本塞进 activeSteer，
   * runAgent 在下一个 step 边界取走注入——比队列机制快一个「等 run 结束」。
   * 空闲或无可插队内容时也消费按键（Ctrl+S 在历史终端上是 XOFF 流控键，不能漏出去）。
   */
  private handleCtrlS(): boolean {
    if (!this.busy) return true;
    // 系统注入（后台通知信封/cron prompt 等）留在队列走原机制，不插队——那些是给模型
    // 看的结构化正文，和用户插话的时序语义不同
    const { steer, rest, clearEditor } = computeCtrlSSteer(this.queue, this.notifyPrepared, this.editor.getText());
    if (steer.length === 0) {
      this.push({ kind: 'note', text: t('input.ctrlS.nothing') });
      return true;
    }
    this.activeSteer.push(...steer);
    if (clearEditor) this.editor.setText('');
    this.updateQueue(rest);
    this.push({
      kind: 'note',
      text: t('input.ctrlS.steered', { count: steer.length }),
    });
    this.tui.requestRender();
    return true;
  }

  /**
   * 中断当前回合。中断的意图是「停」，所以 active goal 一并暂停并丢弃待派发的续接——
   * 不暂停的话回合收尾点（finishTurn 的 submit-continuation 分支）会把续接又发出去，
   * 用户按了 Esc 却停不下来的反向 bug。Esc 必须既暂停 goal 又中止当前回合，/goal resume 恢复。
   */
  private abortTurn(): void {
    this.lastAbortAt = Date.now();
    if (this.goal.get()?.status === 'active') {
      this.goal.update('paused');
      this.continuation = null;
      this.syncGoalBadge();
    }
    this.controller?.abort();
  }

  /**
   * 紧急停止：只恢复终端模式，不做任何其他清理。
   * SIGHUP / stdout EIO（终端已死）场景用——那种情况下 persist、通知等任何写操作
   * 都可能抛 EIO 形成写循环占满 CPU，进程残留还会把 shell 挂在 raw mode。
   */
  emergencyStop(): void {
    try {
      this.tui.stop();
    } catch {
      // 终端已死时 stop 自己也可能抛，忽略
    }
  }

  private exit(): void {
    if (this.exitPrimedTimer !== undefined) clearTimeout(this.exitPrimedTimer);
    // backtrack 的定时器同样要清：未清的 setTimeout 会让 node 事件循环多挂 5 秒才退
    if (this.backtrackPrimedTimer !== undefined) clearTimeout(this.backtrackPrimedTimer);
    if (this.ticker !== undefined) clearInterval(this.ticker);
    if (this.spinnerTimer !== undefined) clearInterval(this.spinnerTimer);
    this.stopHeapWatch?.();
    this.cron.stop();
    this.persist();
    // tab 标题清空，让终端回落自身默认（不清会残留到用户后续的其它命令上）
    this.termTitle.reset();
    this.tui.stop();
    this.resolveExit?.({ sessionId: this.session.id, hasContent: this.history.length > 0 });
    this.resolveExit = undefined;
  }

  // ---------------------------------------------------------------- 提交

  private async onSubmit(raw: string): Promise<void> {
    // 粘贴占位符先还原为原文：pi-tui Editor 把大段粘贴折叠成标记，getText 拿到的是折叠形态，
    // 直接发出去模型只会看到「[pasted 120 lines]」这种标记而不是内容。
    const expanded = this.editor.getExpandedText();
    const text = (expanded === '' ? raw : expanded).trim();
    this.editor.setText('');
    if (text === '') return;
    // 浏览子 agent 历史时输入了新内容：先退出浏览恢复主会话视图，再正常发送。
    // 静默恢复（不 push note）——用户刚看完子会话，追问一句话就该直接进主会话上下文。
    if (this.subagentBrowsing !== null) {
      this.transcript.reset(this.subagentBrowsing.saved);
      this.subagentBrowsing = null;
      this.tui.requestRender();
    }
    const isBang = text.startsWith('!') && text.length > 1;
    // 历史隔离：shell 命令不进提示词历史（↑ 取回的是对话草稿，不是一次性命令）
    if (!isBang) this.editor.addToHistory(text);

    if (text.startsWith('/')) {
      await this.handleSlash(text);
      return;
    }
    if (this.busy) {
      // goal 自主推进期间的普通留言走 steer，不进队列：队列消息会作为独立一轮发出，
      // 那样会打断目标推进。steer 拼进下一个自主轮的注入文本，模型继续目标的同时看到留言。
      // bash 命令（! 开头）除外——它是本地执行，不能当留言拼给模型，照常排队。
      if (!isBang && this.goal.get()?.status === 'active') {
        this.steers.push(text);
        this.push({ kind: 'note', text: '已记下，会在目标的下一轮里一起看到' });
        return;
      }
      // busy 时提交进队列，回合收尾自动续发
      this.updateQueue([...this.queue, text]);
      this.push({ kind: 'note', text: `已排队（${this.queue.length} 条），回合结束后自动发送` });
      return;
    }
    await this.dispatchText(text);
  }

  /** 普通文本的统一执行路径：`!` 前缀走本地 shell，其余走模型回合。 */
  private async dispatchText(text: string): Promise<void> {
    if (text.startsWith('!') && text.length > 1) {
      await this.runBangCommand(text.slice(1).trim());
      return;
    }
    await this.runTurn(text);
  }

  /**
   * `!` bash 输入模式：用户自己敲的命令直接本地执行，输出进转录区并注入上下文。
   *
   * 不过审批——亲手敲下命令这个行为本身就是授权（与模型发起 bash 调用是两回事）。
   * 执行复用 bashTool.execute：shell 解析（Git Bash/WSL/PowerShell 回退链）、超时上限、
   * 输出截断与模型侧完全一致，不另起一套语义。
   * 注入上下文用 bash-input/bash-output 标签包裹：模型在后续回合里看得到这条命令
   * 和它的输出（「我刚跑了 X，结果是 Y」），而不是一段凭空出现的文本。
   */
  private async runBangCommand(command: string): Promise<void> {
    if (command === '') return;
    this.transcript.push({ kind: 'user', text: `! ${command}` });
    this.transcript.push({ kind: 'tool', id: `bang-${++this.bangCounter}`, name: 'bash', input: { command }, status: 'running' });
    this.tui.requestRender();
    let result: { content: string; isError: boolean };
    try {
      result = await bashTool.execute({ command }, this.deps.ctx);
    } catch (e) {
      result = { content: (e as Error).message, isError: true };
    }
    this.transcript.updateLastWhere(
      (it) => it.kind === 'tool' && it.id === `bang-${this.bangCounter}`,
      (it) => ({
        ...(it as Extract<DisplayItem, { kind: 'tool' }>),
        status: result.isError ? ('error' as const) : ('ok' as const),
        result: result.content,
      }),
    );
    this.history.push(
      stored(
        {
          role: 'user',
          content: `<bash-input>${command}</bash-input>\n<bash-output>\n${result.content}\n</bash-output>`,
        },
        { kind: 'user' },
      ),
    );
    this.persist();
    this.tui.requestRender();
  }

  /**
   * 斜杠命令入口：解析 → busy 分流 → 执行。
   *
   * 命令名与别名表复用 `SLASH_COMMANDS`（`src/chat/commands.ts` 是纯逻辑，不 import react），
   * 两版共用一张表，命令集与别名不会漂移。`busyRoute` 决定回合进行中是即时执行还是排队到回合边界。
   */
  private async handleSlash(raw: string): Promise<void> {
    // plugin 命令名（<pluginId>:<cmd>）不在 SLASH_COMMANDS 里，要作为额外名字集喂进去，
    // 否则会被判成未知命令
    const parsed = parseSlash(raw, new Set(this.pluginCommandMap.keys()));
    if (parsed === null) return; // 调用方已判过前缀，这里只是类型收窄
    const { name, args } = parsed;
    if (name === '') {
      const typed = raw.trim().split(/\s+/)[0] ?? '';
      this.push({ kind: 'note', text: `未知命令：${typed}（/help 看清单）` });
      return;
    }
    if (this.busy && busyRoute(name, args) === 'queue') {
      this.updateQueue([...this.queue, raw.trim()]);
      this.push({
        kind: 'note',
        text: `/${name} 会改动本回合的前提，已排队（${this.queue.length} 条），回合结束后执行`,
      });
      return;
    }
    await this.runCommand(name, args);
  }

  /** 执行一条已解析的命令。busy 分流已在 handleSlash 完成，这里不再判 busy（除耗时命令自身的互斥）。 */
  private async runCommand(name: string, args: string): Promise<void> {
    switch (name) {
      case 'exit':
        this.exit();
        return;

      case 'help':
        this.push({ kind: 'note', text: this.helpBody() });
        return;

      case 'clear':
        // 清屏但保留会话历史：转录区清空 + 强制整屏重绘（这是唯一主动接受全量重绘的地方）
        this.transcript.reset([]);
        this.tui.invalidate();
        this.tui.renderNow(true);
        return;

      case 'new':
        this.newSession();
        return;

      case 'fork':
        this.forkSession();
        return;

      case 'model':
        if (args === '') await this.pickModel();
        else this.applyModel(args);
        return;

      case 'resume':
        if (args === '') await this.pickSession();
        else this.resumeSession(args);
        return;

      case 'rename': {
        const name = await askLine(this.tui, t('session.rename.prompt'));
        if (name === null) return; // Esc 取消
        const trimmed = name.trim();
        const ok = this.deps.store.rename(this.deps.ctx.cwd, this.session.id, trimmed);
        if (ok) {
          if (trimmed === '') delete this.session.name;
          else this.session.name = trimmed;
          this.syncTerminalTitle();
          this.push({ kind: 'note', text: trimmed === '' ? t('session.rename.cleared') : t('session.rename.success', { name: trimmed }) });
        } else {
          this.push({ kind: 'error', text: t('session.rename.failed') });
        }
        return;
      }

      case 'think':
        await this.runThink(args);
        return;

      case 'plan':
        this.togglePlanMode();
        return;

      case 'permission':
        if (args === 'manual' || args === 'auto' || args === 'yolo') this.changeMode(args);
        else this.push({ kind: 'note', text: `当前权限模式：${this.mode}（可用 manual / auto / yolo）` });
        return;

      case 'yolo':
        this.changeMode('yolo');
        return;

      case 'auto':
        this.changeMode('auto');
        return;

      case 'lang':
        this.setLang(args.toLowerCase());
        return;

      case 'mcp':
        this.push({
          kind: 'note',
          text:
            this.deps.mcp !== undefined
              ? formatMcpStatus(this.deps.mcp)
              : '没有配置 MCP 服务器（~/.step-code/mcp.json）',
        });
        return;

      case 'usage':
        this.showUsage(args === '--all');
        return;

      case 'tasks':
        // 无参进交互弹层；带参（如 /tasks list）退化为纯文本，脚本化场景仍可用
        if (args.trim() === '') this.openTasksOverlay();
        else this.push({ kind: 'note', text: formatTaskList(this.background.list(), Date.now()) });
        return;

      case 'memory':
        this.runMemory(args.toLowerCase());
        return;

      case 'restore':
        this.runRestore(args);
        return;

      case 'compact':
        await this.runCompact();
        return;

      case 'export-debug-zip':
        await this.runExportDebugZip();
        return;

      case 'goal':
        this.runGoal(args);
        return;

      case 'loop':
        this.push({ kind: 'note', text: formatCronJobs(this.cron.list()) });
        return;

      case 'skill':
        await this.runSkill(args);
        return;

      case 'agents':
        this.openAgentsOverlay();
        return;

      case 'reflect':
        await this.runReflectCommand();
        return;

      case 'plugin':
        // 管理命令的子命令分发在 pluginCommand.ts，这里只展示它返回的文本
        this.push({ kind: 'note', text: runPluginCommand(args) });
        return;

      case 'provider':
        this.runProvider(args);
        return;

      case 'reload':
        this.runReload();
        return;

      case 'compact-model':
        if (args.trim() === '') await this.pickCompactModel();
        else this.runCompactModel(args.trim());
        return;

      case 'history':
        await this.runHistory(args);
        return;

      case 'team':
        await this.runTeam(args);
        return;

      default: {
        // plugin 命令：模板里的 $ARGUMENTS 展开后当作用户消息静默提交（同 /skill 激活路径）
        const cmd = this.pluginCommandMap.get(name);
        if (cmd !== undefined) {
          this.push({ kind: 'note', text: `已调用 plugin 命令 ${cmd.name}` });
          await this.runTurn(expandPluginCommand(cmd.content, args), { silent: true });
          return;
        }
        this.push({
          kind: 'note',
          text: NOT_WIRED.has(name) ? notWiredText(name) : `/${name} 尚未实现`,
        });
      }
    }
  }

  /** /help 正文：共用注册表生成命令清单，末尾补 pi 版特有的键位与未接线说明。 */
  private helpBody(): string {
    const lines = [
      helpText(),
      '',
      '快捷键：Enter 发送 · Shift+Enter 换行 · Esc 中断/取回队列 · Ctrl+C 退出 · Tab 补全',
      '输入 ! 开头的行会在本地执行 shell 命令（输出注入上下文），Ctrl+S 把队列与草稿插队给运行中的回合',
      '　　　　Alt+V / Ctrl+V 贴剪贴板图片 · Ctrl+O 展开工具输出与思考 · Ctrl+B 前台任务转后台',
    ];
    // 空集合时不打这一行：全部接线后还挂个空提示，看起来像功能残缺
    if (NOT_WIRED.size > 0) lines.push(`pi 版尚未接线：${[...NOT_WIRED].map((n) => '/' + n).join(' ')}`);
    return lines.join('\n');
  }

  /**
   * 读剪贴板图片并把占位符追加到输入框。
   *
   * 失败给三级诊断而不是一句「没有图片」：缺平台工具（Windows 无 PowerShell、
   * macOS 无 pngpaste）与「剪贴板里确实没图」是两回事，用户按了没反应时需要
   * 知道该装工具还是该重新复制。中间那级把剪贴板实际有哪些格式打出来，
   * 下次失败可直接定位。
   */
  private async attachClipboardImage(): Promise<void> {
    this.push({ kind: 'note', text: t('app.image.reading') });
    const { image, formats } = await readClipboardImage();
    if (image === null) {
      const hint = clipboardToolHint();
      if (hint !== null) {
        this.push({ kind: 'note', text: hint });
      } else if (formats !== null && formats !== '' && formats !== '<empty>') {
        const shown = formats.length > 200 ? `${formats.slice(0, 200)}…` : formats;
        this.push({ kind: 'note', text: t('app.image.noneFormats', { formats: shown }) });
      } else {
        this.push({ kind: 'note', text: t('app.image.none') });
      }
      return;
    }
    const att = this.images.add(image.base64, image.mediaType, image.width, image.height);
    const cur = this.editor.getText();
    this.editor.setText((cur === '' || cur.endsWith(' ') ? cur : `${cur} `) + att.placeholder);
    // 附加成功要有明确回执：占位符插进输入框这一下容易被忽略，尤其贴第二张时
    // 光看输入框分不清有没有生效。计数取 store 的实际张数。
    this.push({ kind: 'note', text: t('app.image.attached', { count: this.images.size() }) });
    this.tui.requestRender();
  }

  // ---------------------------------------------------------------- goal 与 team

  /**
   * goal 生命周期事件的落地：消息流打标记、徽标更新、事件落盘、快照持久化。
   *
   * 数字（轮数、用时）取自快照而不是重新计算：完成事件里 goal 已被清除，
   * 此时回查 GoalMode 拿到的是 null。
   */
  private onGoalChange(ev: GoalChangeEvent): void {
    const g = ev.goal;
    if (ev.type === 'completed') {
      this.status.setState({ goal: undefined });
      this.push({
        kind: 'note',
        text:
          `目标完成${g.terminalReason !== undefined ? `（${g.terminalReason}）` : ''}` +
          ` · 共 ${g.turnsUsed} 轮 · ${formatDuration(Math.max(0, Date.now() - g.createdAt))}`,
      });
      this.appendWire({ type: 'goal.update', ts: new Date().toISOString(), goal: undefined });
      this.persist();
      return;
    }
    this.syncGoalBadge();
    if (ev.type === 'created') {
      this.push({ kind: 'note', text: `已设定目标：${g.objective}` });
    } else {
      const suffix = g.terminalReason !== undefined ? `（${g.terminalReason}）` : '';
      this.push({ kind: 'note', text: `目标状态：${g.status}${suffix}` });
    }
    this.appendWire({ type: 'goal.update', ts: new Date().toISOString(), goal: { ...g } });
    this.persist();
  }

  /** /goal：无参看状态，pause / resume / cancel 改状态。创建目标由模型调 create_goal 工具。 */
  private runGoal(args: string): void {
    const sub = args.toLowerCase();
    const g = this.goal.get();
    if (sub === '' || sub === 'status') {
      if (g === null) this.push({ kind: 'note', text: '当前没有自主目标（说清要达成什么，我会用 create_goal 设定）' });
      else this.push({ kind: 'note', text: formatGoalPanel(g, Date.now()) });
      return;
    }
    if (sub === 'pause' || sub === 'resume' || sub === 'cancel') {
      if (g === null) {
        this.push({ kind: 'note', text: '当前没有自主目标' });
        return;
      }
      try {
        if (sub === 'pause') this.goal.update('paused');
        else if (sub === 'resume') this.goal.update('active');
        else this.goal.update('complete', '用户取消');
      } catch (e) {
        this.push({ kind: 'error', text: (e as Error).message });
      }
      return;
    }
    this.push({ kind: 'note', text: '用法：/goal（看状态） · /goal pause · /goal resume · /goal cancel' });
  }

  /** /team：init / status / exit / teardown。目录与 git 操作是异步的，逐个 await 后回报。 */
  private async runTeam(args: string): Promise<void> {
    const parts = args.split(/\s+/).filter((x) => x !== '');
    const sub = (parts[0] ?? '').toLowerCase();
    const flag = (name: string): string | undefined => {
      const i = parts.indexOf(name);
      return i >= 0 ? parts[i + 1] : undefined;
    };
    try {
      if (sub === 'init') {
        const { store, created, base } = await initTeam(this.deps.ctx.cwd, flag('--dir'), flag('--repo'), flag('--base'));
        this.team.activate(store);
        this.persist();
        this.push({
          kind: 'note',
          text:
            `${created ? '团队模式已初始化' : '团队模式已就绪（沿用已有档案）'}\n` +
            `基准分支 ${base} · 档案目录 ${store.dir} · 仓库 ${store.repoRoot}`,
        });
        return;
      }
      if (sub === 'status') {
        if (!this.team.active) {
          this.push({ kind: 'note', text: '团队模式未激活（用 /team init 初始化）' });
          return;
        }
        const store = this.team.getStore();
        const state = await store.load();
        this.push({ kind: 'note', text: formatTeamStatus(state.base, store.dir, state.missions) });
        return;
      }
      if (sub === 'exit') {
        // 先落关闭标记（防 resume 复活），标记失败不阻塞：exit 是硬退出通道
        try {
          await this.team.getStore().markClosed();
        } catch {
          // 未激活或档案损坏：照常退出
        }
        this.team.deactivate();
        this.persist();
        this.push({ kind: 'note', text: '已退出团队模式（档案目录保留）' });
        return;
      }
      if (sub === 'teardown') {
        if (!this.team.active) {
          this.push({ kind: 'note', text: '团队模式未激活' });
          return;
        }
        const { removed, kept } = await this.team.getStore().teardown(parts.includes('force'));
        this.team.deactivate();
        this.persist();
        this.push({
          kind: 'note',
          text: `已清理 ${removed.length} 个工作间${kept.length > 0 ? `\n保留（有未提交改动）：${kept.join('、')}` : ''}`,
        });
        return;
      }
      this.push({ kind: 'note', text: '用法：/team init [--dir 路径] [--repo 路径] [--base 分支] · /team status · /team exit · /team teardown [force]' });
    } catch (e) {
      this.push({ kind: 'error', text: (e as Error).message });
    }
  }

  // ---------------------------------------------------------------- 渠道 / 配置重载 / 对话回退

  /**
   * /provider：无参或 list 列渠道，带 id 切换。
   *
   * 不做渠道向导（`/provider add` 是多步表单，属独立交互块）；
   * 无参也不开管理面板，直接给只读清单，比弹一个只能看的面板更直接。
   */
  private runProvider(args: string): void {
    const arg = args.trim();
    if (arg === 'add' || arg.startsWith('add ')) {
      void this.openProviderWizard();
      return;
    }
    if (arg === '') {
      // 无参进交互弹层（查看 + 切换 + 删除 + 新增入口）；list 仍走纯文本
      void this.openProviderManagerOverlay();
      return;
    }
    if (arg === 'list') {
      const providers = this.deps.config.providers ?? {};
      const models = this.deps.config.models ?? {};
      const lines = [`当前服务商：${this.deps.config.provider} · 内置预设：${Object.keys(PROVIDER_PRESETS).join(' / ')}`];
      const ids = Object.keys(providers);
      if (ids.length === 0) lines.push('没有自定义渠道（[providers] 段为空）');
      for (const id of ids) {
        const channel = providers[id]!;
        const aliases = Object.entries(models)
          .filter(([, entry]) => entry.provider === id)
          .map(([alias]) => alias);
        lines.push(
          `  ${id} · ${channel.type} · ${channel.baseUrl ?? '默认地址'} · ${aliases.length} 个别名` +
            (aliases.length > 0 ? `（${aliases.join(', ')}）` : ''),
        );
      }
      this.push({ kind: 'note', text: lines.join('\n') });
      return;
    }
    // 解析顺序：自定义渠道 id > 内置预设名 > 报错列可用
    const target = resolveProviderTarget(this.deps.config, arg);
    switch (target.kind) {
      case 'alias':
        // 渠道选定后按它的首个别名切模型（别名承载渠道、窗口、能力整组绑定）
        this.applyModel(target.alias);
        try {
          saveDefaultProvider(target.providerId, this.deps.config.provider === target.providerId ? undefined : this.deps.config.provider);
        } catch (e) {
          this.push({ kind: 'note', text: `渠道写回配置失败：${(e as Error).message}（本次切换已生效）` });
        }
        return;
      case 'noAlias':
        this.push({ kind: 'note', text: `渠道 ${target.providerId} 下没有任何模型别名，先在 [models] 里加一个` });
        return;
      case 'preset':
        this.applyPreset(target.name);
        return;
      case 'unknown':
        this.push({ kind: 'note', text: `没有渠道或预设叫 ${arg}。可用：${target.available.join(' / ')}` });
        return;
    }
  }

  /** 按内置预设重建 provider。预设不带别名绑定，所以要断开别名与能力标记。 */
  private applyPreset(name: string): void {
    const preset = PROVIDER_PRESETS[name];
    if (preset === undefined) {
      this.push({ kind: 'note', text: `没有内置预设叫 ${name}。可用：${Object.keys(PROVIDER_PRESETS).join(' / ')}` });
      return;
    }
    const nextModel = preset.model ?? this.model;
    try {
      this.provider = createProvider({
        ...this.deps.config,
        provider: name,
        baseUrl: preset.baseUrl ?? this.deps.config.baseUrl,
        model: nextModel,
      });
    } catch (e) {
      this.push({ kind: 'error', text: `切换渠道失败：${(e as Error).message}` });
      return;
    }
    // provider 按预设重建后不再代表别名绑定（渠道与模型都可能变），断开别名记录与能力标记
    this.currentAlias = undefined;
    this.deps.ctx.capabilities = undefined;
    this.deps.ctx.imageMaxEdgePx = undefined;
    this.deps.ctx.imageBudgetBytes = undefined;
    this.deps.ctx.videoBudgetBytes = undefined;
    this.model = nextModel;
    this.modelLabel = nextModel;
    this.syncStatus();
    this.persist();
    this.push({
      kind: 'note',
      text: `已切到 ${name}${preset.model !== undefined ? `，模型 ${nextModel}` : '，模型保持不变'}`,
    });
  }

  /**
   * /reload：重跑配置加载，把变更应用到运行期。
   *
   * 这一层是薄壳：失败时的原子性由组合根的 reloadConfig 保证（抛错则旧配置整体保留）。
   * 会话级状态（模型、权限模式）不被覆盖，配置级绑定（能力标记、图片限额、搜索配置、
   * 压缩绑定）按新值刷新。
   */
  private runReload(): void {
    const reload = this.deps.reloadConfig;
    if (reload === undefined) {
      this.push({ kind: 'note', text: '当前进程没有注入配置重载入口' });
      return;
    }
    const prev = this.deps.config;
    const result = reload();
    if ('error' in result) {
      this.push({ kind: 'error', text: `重载失败：${result.error}（旧配置保持生效）` });
      return;
    }
    const next = result.config;
    this.deps.config = next;
    // 能力与图片限额是配置级绑定：本轮才加上的能力（如 image_in）要即时生效，
    // 且与 provider 是否重建无关，不能被下面的 unchanged 短路跳过
    this.deps.ctx.capabilities = resolveCapabilitiesOnReload(next, this.currentAlias ?? null);
    const limits = resolveImageLimitsOnReload(next, this.currentAlias ?? null);
    this.deps.ctx.imageMaxEdgePx = limits.imageMaxEdgePx;
    this.deps.ctx.imageBudgetBytes = limits.imageBudgetBytes;
    this.deps.ctx.videoBudgetBytes = limits.videoBudgetBytes;
    this.deps.ctx.searchConfig = next.search;
    // 压缩绑定按新配置重解；会话级覆盖（/compact-model）保留——它是用户这次会话的显式选择，
    // 不该被一次 /reload 悄悄抹掉。provider 缓存不清：键是别名，同别名重解直接复用实例。
    this.compactionBinding = resolveCompactionBinding(next, this.compactionProviderCache, this.compactionModelOverride);
    // provider 重建决策：别名仍在按新配置重建；别名被删或重建失败则沿用旧 provider
    const plan = planProviderReload(prev, next, this.model, this.currentAlias ?? null);
    let providerNote = '';
    if (plan.kind === 'rebuild') {
      this.provider = plan.provider;
      this.model = plan.model;
      this.modelLabel = plan.modelLabel;
      this.maxContextSize = plan.maxContextSize;
      this.status.setState({ maxContextSize: plan.maxContextSize });
      this.persist();
      providerNote = 'provider 已按新配置重建';
    } else if (plan.reason === 'aliasRemoved') {
      providerNote = `别名 ${plan.alias ?? ''} 已从配置里删除，本会话继续用当前 provider`;
    } else if (plan.reason === 'aliasInvalid') {
      providerNote = `别名 ${plan.alias ?? ''} 无法解析，本会话继续用当前 provider`;
    } else if (plan.reason === 'buildFailed') {
      providerNote = `provider 重建失败：${plan.message ?? ''}，继续用旧实例`;
    }
    const nextLang = next.language ?? 'zh';
    if (nextLang !== getLocale()) setLocale(nextLang);
    // 新 hookEngine 换了引用，notice 出口要补挂，否则 hook 的可见性提示会静默丢
    this.deps.hookEngineRef.current?.setNoticeSink((m) => this.push({ kind: 'note', text: m }));
    const changes = diffConfig(prev, next);
    if (changes.length === 0 && providerNote === '') {
      this.push({ kind: 'note', text: '配置没有变化' });
    } else {
      const lines = changes.map((c) => formatConfigChange(c) + (c.restart === true ? '（需重启生效）' : ''));
      if (providerNote !== '') lines.push(providerNote);
      this.push({ kind: 'note', text: `配置已重载：\n${lines.join('\n')}` });
    }
    this.syncStatus();
    this.tui.requestRender();
  }

  /**
   * /history：回看本会话的用户输入，回退到指定轮之前。
   *
   * 只动对话（历史与转录区），不碰文件改动——文件级回滚是 /restore，两者互补。
   * 轮次切割与截断点由 computeUndo 算（纯函数，两版共用），这一层只落副作用。
   *
   * 一处限制：没有把 todos 与计划模式一起回滚到那轮之前的快照栈，故附带状态保持现状。
   */
  private async runHistory(args: string): Promise<void> {
    if (this.busy) {
      this.push({ kind: 'note', text: '回合进行中不能回退，先 Esc 中断' });
      return;
    }
    const turns = collectUndoTurns(this.history);
    if (turns.length === 0) {
      this.push({ kind: 'note', text: '本会话还没有可回退的输入' });
      return;
    }
    const arg = args.trim();
    let n: number;
    if (arg === '') {
      // Tab = 只把那条输入取回输入框，不动历史：
      // 「我想改一版重发」与「我要撤销这段对话」是两件事，只给 Enter 会逼用户先撤销
      let recallOnly: string | null = null;
      const picked = await this.showInlinePicker({
        title: '回退到哪一条输入之前',
        items: turns.map((t) => ({
          value: String(t.turns),
          label: t.label === '' ? '（空输入）' : t.label,
          description: t.turns === 1 ? '撤销最近 1 轮' : `撤销最近 ${t.turns} 轮`,
        })),
        hint: '↑↓ 选择 · Enter 回退 · Tab 仅取回文本 · Esc 取消',
        onKey: (data, selected) => {
          if (!matchesKey(data, 'tab') || selected === null) return false;
          const turn = turns.find((t) => String(t.turns) === selected.value);
          recallOnly = turn?.label ?? '';
          return true;
        },
      });
      if (recallOnly !== null) {
        this.editor.setText(recallOnly);
        this.push({ kind: 'note', text: '已把那条输入取回输入框（历史未改动）' });
        this.tui.requestRender();
        return;
      }
      if (picked === null) return;
      n = Number(picked);
    } else {
      n = Number(arg);
      if (!Number.isInteger(n) || n < 1) {
        this.push({ kind: 'note', text: `用法：/history [轮数]（不带参数列出全部 ${turns.length} 条输入）` });
        return;
      }
    }
    const result = computeUndo(this.history, n);
    if (result === null) {
      this.push({ kind: 'note', text: `没有那么多轮可撤销（本会话共 ${turns.length} 轮）` });
      return;
    }
    // 被撤销的最早那条消息正好在截断点上（computeUndo 从 user 消息处切）
    const cut = this.history[result.history.length];
    const prefill = cut === undefined ? '' : extractUserText(cut);
    const removed = this.history.length - result.history.length;
    this.history.length = 0;
    this.history.push(...result.history);
    // 附带状态回滚：todos 与 plan 模式无法从 history 反推，弹快照栈恢复。
    // 栈里没有对应快照（会话恢复后、压缩后）时保持现状——回退消息仍然成立，
    // 只是待办与 plan 停在当前值，note 里说明这一点，不静默。
    const snap = popUndoSnapshots(this.undoStack, result.removedTurns);
    let sideEffects = '';
    if (snap !== undefined) {
      this.todos.items = [...snap.todos];
      this.planMode = snap.planMode;
      this.prePlanMode = snap.prePlanMode;
      this.chrome.setTodos(this.todos.items);
      sideEffects = '，待办与 plan 模式已同步回滚';
    } else if (this.todos.items.length > 0 || this.planMode) {
      sideEffects = '（没有那几轮的状态快照，待办与 plan 模式保持现状）';
    }
    // token 回落：截断点之后没有真实 usage 可覆盖，基准归零后按截断结果重估，
    // 下一条真实 usage 再校正（与 /resume 同口径）
    this.baseTokens = 0;
    this.status.setState({ usedTokens: 0 });
    this.persist();
    const replay = historyToDisplayItems(this.history);
    this.transcript.reset(
      [
        ...replay.items,
        {
          kind: 'note',
          text: `已撤销最近 ${result.removedTurns} 轮，丢弃 ${removed} 条消息${sideEffects}（文件改动不受影响，回滚文件用 /restore）`,
        },
      ],
      replay.foldedTurns,
    );
    this.syncStatus();
    this.tui.invalidate();
    this.tui.renderNow(true);
    // 被撤销的那条输入放回编辑器，方便改一版重发
    if (prefill !== '') this.editor.setText(prefill);
  }

  // ---------------------------------------------------------------- 技能 / 子 agent / 反思

  /**
   * /skill：无参开选择器，`reload` 强制重扫，带参激活。
   *
   * 激活的形态与模型自己调 skill 工具一致：把展开后的技能正文静默注入跑一轮。
   * 不显示成用户消息，否则转录区会出现一大段用户没打过的文本。
   */
  private async runSkill(args: string): Promise<void> {
    const registry = this.deps.skillsRef.current;
    const names = [...registry.skills.keys()];
    if (args === '') {
      if (names.length === 0) {
        this.push({ kind: 'note', text: '没有发现任何技能（放到 .step-code/skills/ 或 ~/.step-code/skills/）' });
        return;
      }
      const picked = await this.showInlinePicker({
        title: '激活技能',
        items: [...registry.skills.values()].map((d) => ({
          value: d.name,
          label: d.name,
          description: d.description ?? '',
        })),
        hint: '↑↓ 选择 · Enter 激活 · 输入过滤 · Esc 取消',
      });
      if (picked === null) return;
      await this.activateSkill(picked, '');
      return;
    }
    // reload 子命令优先于同名技能激活
    if (args === 'reload' || args.startsWith('reload ')) {
      const diff = this.deps.reloadSkills(true) as
        | { added: string[]; removed: string[]; changed: string[] }
        | null
        | undefined;
      const total = diff == null ? 0 : diff.added.length + diff.removed.length + diff.changed.length;
      if (total === 0) {
        this.push({ kind: 'note', text: '技能目录没有变化' });
      } else {
        const fmt = (xs: string[]): string => (xs.length > 0 ? xs.join('、') : '—');
        this.push({
          kind: 'note',
          text: `技能已重扫：新增 ${fmt(diff!.added)} · 移除 ${fmt(diff!.removed)} · 变更 ${fmt(diff!.changed)}`,
        });
      }
      const conflicts = this.deps.skillsRef.current.conflicts ?? [];
      if (conflicts.length > 0) {
        this.push({
          kind: 'note',
          text:
            '同名技能冲突（前者生效）：\n' +
            conflicts.map((c) => `  ${c.name}：${c.winner.dir} 覆盖 ${c.overridden.map((o) => o.dir).join('、')}`).join('\n'),
        });
      }
      return;
    }
    const spaceIdx = args.search(/\s/);
    const name = spaceIdx === -1 ? args : args.slice(0, spaceIdx);
    const rest = spaceIdx === -1 ? '' : args.slice(spaceIdx + 1).trim();
    await this.activateSkill(name, rest);
  }

  private async activateSkill(name: string, args: string): Promise<void> {
    const def = this.deps.skillsRef.current.skills.get(name);
    if (def === undefined) {
      const names = [...this.deps.skillsRef.current.skills.keys()];
      this.push({
        kind: 'note',
        text: `没有名为 ${name} 的技能。可用：${names.length > 0 ? names.join('、') : '（无）'}`,
      });
      return;
    }
    this.push({ kind: 'note', text: `已激活技能 ${def.name}` });
    await this.runTurn(renderSkillActivation(def, args), { silent: true });
  }

  /**
   * 子 agent 会话下钻（只读浏览）：把子会话历史载入 Transcript，Esc 退出恢复原现场。
   *
   * 与 resumeSession 的根本区别：不动 this.session / this.history / 持久化，只替换 Transcript
   * 的显示内容。浏览前保存当前 transcript items（items() 每次 map 出新数组，引用安全），
   * Esc 或发送消息时恢复。这让用户能在 TUI 内直接回看子 agent 做了什么，不必退出复制 CLI 命令。
   */
  private browseSubagentSession(subId: string): void {
    if (this.subagentBrowsing !== null) return; // 已在浏览态，不嵌套
    const cwd = this.deps.ctx.cwd;
    const messages = this.deps.subagentStore.loadFull(cwd, subId);
    if (messages.length === 0) {
      this.push({ kind: 'note', text: `子会话 ${subId} 没有历史记录` });
      return;
    }
    const meta = this.deps.subagentStore.list(cwd).find((m) => m.id === subId);
    const replay = historyToDisplayItems(messages);
    const label = meta?.name ?? meta?.title ?? subId.slice(0, 8);
    // 保存当前视图快照（浅拷贝 DisplayItem 数组，reset 后旧数组不受影响）
    this.subagentBrowsing = { saved: this.transcript.items() };
    const items: DisplayItem[] = [
      { kind: 'note', text: `正在浏览子 agent 会话「${label}」(${replay.totalTurns} 轮) — Esc 返回主会话` },
      ...replay.items,
    ];
    this.transcript.reset(items, replay.foldedTurns);
    this.tui.requestRender();
  }

  /** 退出子 agent 浏览：恢复保存的 transcript 快照。 */
  private exitSubagentBrowse(): void {
    if (this.subagentBrowsing === null) return;
    this.transcript.reset(this.subagentBrowsing.saved);
    this.subagentBrowsing = null;
    this.tui.requestRender();
    this.push({ kind: 'note', text: '已退出子 agent 浏览，返回主会话' });
  }

  /**
   * /reflect：对本会话历史提炼方法论清单。
   *
   * 读的是不受压缩触碰的全量日志，旧会话或未落盘时回退内存历史。产出同步注入会话流，
   * 否则用户说「记住第 2 条」时模型上下文里没有这份清单，两段动作就断开了。
   */
  private async runReflectCommand(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.activity.setBusy(true);
    this.activity.setTip('提炼经验');
    this.syncStatus();
    this.push({ kind: 'note', text: '正在回顾本会话历史…' });
    try {
      const full = this.deps.store.loadFull(this.session.cwd, this.session.id);
      const source = full.length > 0 ? full : this.history;
      const text = await runReflect(this.provider, source, {});
      this.push({ kind: 'note', text: `基于 ${source.length} 条消息的回顾：\n\n${text}` });
      if (text !== REFLECT_EMPTY_HISTORY && text !== REFLECT_NO_FINDINGS) {
        this.history.push(
          stored(
            {
              role: 'user',
              content:
                '以下是 /reflect 对本次会话历史提炼的方法论清单（用户刚在界面上看过）。' +
                '如果用户从中挑选条目让你沉淀（如「记住第 2 条」），按记忆机制写入对应目录；' +
                '用户没有此类要求时不需要主动写。\n\n' +
                text,
            },
            { kind: 'injection' },
          ),
        );
        this.persist();
      }
    } catch (e) {
      this.push({ kind: 'error', text: `回顾失败：${(e as Error).message}` });
    } finally {
      this.busy = false;
      this.activity.setBusy(false);
      this.activity.setTip('');
      this.syncStatus();
      this.tui.requestRender();
    }
  }

  // ---------------------------------------------------------------- 状态类命令

  /** 权限模式切换：内存态 + 状态栏 + 落盘，并落一条 wire 事件（重放时要能还原当时的模式）。 */
  private changeMode(mode: PermissionMode): void {
    this.mode = mode;
    // plan 模式下改权限模式：plan 的只读约束优先，这里只改底模式，退出 plan 后生效
    this.syncStatus();
    this.persist();
    this.appendWire({ type: 'permission.set_mode', ts: new Date().toISOString(), mode });
    this.push({ kind: 'note', text: `权限模式：${mode}` });
  }

  private togglePlanMode(): void {
    if (this.planMode) {
      this.planMode = false;
      if (this.prePlanMode !== null) {
        this.mode = this.prePlanMode;
        this.prePlanMode = null;
      }
      this.push({ kind: 'note', text: '已退出计划模式' });
    } else {
      this.prePlanMode = this.mode;
      this.planMode = true;
      this.push({ kind: 'note', text: '已进入计划模式：只做只读调查，方案想清楚后用 exit_plan_mode 提交' });
    }
    this.syncStatus();
    this.persist();
    this.appendWire({ type: 'plan_mode.set', ts: new Date().toISOString(), enabled: this.planMode });
  }

  private async runThink(args: string): Promise<void> {
    if (args === '') {
      await this.pickThink();
      return;
    }
    const parsed = parseThinkArgs(args);
    if (parsed.kind === 'invalid') {
      this.push({ kind: 'note', text: `未知的思考档位：${parsed.name}（可用 low / medium / high / off）` });
      return;
    }
    if (parsed.kind === 'show') {
      this.push({ kind: 'note', text: `当前思考深度：${this.thinkOverride ?? '跟随配置默认'}` });
      return;
    }
    this.applyThink(parsed.override);
  }

  /** 语言切换：进程内 locale + 配置落盘。pi 版无整树重渲，改完主动重绘一次即可。 */
  private setLang(arg: string): void {
    if (arg === '') {
      this.push({ kind: 'note', text: `当前语言：${getLocale()}（可用 zh / en）` });
      return;
    }
    if (arg !== 'zh' && arg !== 'en') {
      this.push({ kind: 'note', text: '用法：/lang zh 或 /lang en' });
      return;
    }
    setLocale(arg);
    try {
      saveLanguage(arg);
    } catch {
      // 持久化失败只影响下次启动的默认语言，本次切换仍生效
    }
    // 状态栏与提示条的文案在下一帧重取
    this.syncStatus();
    this.tui.requestRender();
    this.push({ kind: 'note', text: `语言已切换：${arg}` });
  }

  /**
   * token 用量统计。数据源是已落盘的 model.usage wire 事件，不碰会话状态。
   * --all 的范围只到当前 cwd：跨目录会把别的项目的会话读进来。
   */
  private showUsage(wantAll: boolean): void {
    try {
      if (wantAll) {
        // 用 listWireSessionIds 而非 list：后者按 .json 快照列举，会漏掉有事件日志但没走到 save 的会话
        const ids = this.deps.store.listWireSessionIds(this.deps.ctx.cwd);
        const events = ids.flatMap((id) => this.deps.store.loadWire(this.deps.ctx.cwd, id));
        this.push({
          kind: 'note',
          text: formatUsageReport(aggregateModelUsage(events), `本目录全部会话（${ids.length} 个）`),
        });
      } else {
        const events = this.deps.store.loadWire(this.session.cwd, this.session.id);
        this.push({ kind: 'note', text: formatUsageReport(aggregateModelUsage(events), `会话 ${this.session.id}`) });
      }
    } catch (e) {
      this.push({ kind: 'error', text: `读取用量失败：${(e as Error).message}` });
    }
  }

  private runMemory(arg: string): void {
    const enabled = this.deps.config.memory?.enabled === true;
    if (arg === 'on' || arg === 'off') {
      const next = arg === 'on';
      if (enabled === next) {
        this.push({ kind: 'note', text: next ? '记忆功能已经是开启状态' : '记忆功能已经是关闭状态' });
        return;
      }
      this.deps.config.memory = { enabled: next };
      try {
        saveMemoryEnabled(next);
      } catch {
        // 持久化失败只影响下次启动，本次切换已在内存生效
      }
      if (next) {
        // 中途开启的回看引导：注入消息流，agent 下一轮补沉淀本次会话的遗留观察
        this.history.push(stored({ role: 'user', content: MEMORY_ONBOARDING_INJECTION }, { kind: 'injection' }));
      }
      this.persist();
      this.push({ kind: 'note', text: next ? '记忆功能已开启' : '记忆功能已关闭' });
      return;
    }
    if (arg !== '') {
      this.push({ kind: 'note', text: '用法：/memory（列清单） · /memory on · /memory off' });
      return;
    }
    this.push({ kind: 'note', text: formatMemoryList(this.deps.ctx.cwd, enabled, Date.now()) });
  }

  /**
   * 文件级 checkpoint 回滚：edit_file/write_file 写前已备份原内容，这里按 cwd 找最近备份写回。
   * 与对话级回退是两件事（这个只动文件，不动对话历史）。
   */
  private runRestore(arg: string): void {
    if (arg === '') {
      this.push({ kind: 'note', text: '用法：/restore <文件路径>（回滚到本次会话修改前的内容）' });
      return;
    }
    const abs = resolvePath(this.deps.ctx.cwd, arg);
    const res = restoreFile(this.deps.ctx.cwd, abs);
    if (res.ok) this.push({ kind: 'note', text: `已回滚：${arg}` });
    else this.push({ kind: 'error', text: `回滚失败：${res.reason}` });
  }

  // ---------------------------------------------------------------- 会话生命周期命令

  /**
   * 开新会话：清历史与派生状态，换绑后台任务目录。
   *
   * 「换绑」不是可选的收尾：BackgroundManager 的落盘目录按会话 id 定，不换绑就把新
   * 会话的任务写进旧会话目录。旧管理器在途任务属于旧会话，不迁移。
   */
  private newSession(): void {
    this.persist();
    this.history.length = 0;
    // 快照栈跨会话无意义（historyLen 对不上新会话），换会话即清
    clearUndoSnapshots(this.undoStack);
    this.todos.items = [];
    this.subagentCounter.spawned = 0;
    this.sessionApprovals.clear();
    this.images.clear();
    // 新会话 model 存别名（同 persist 口径），避免真实 id 被启动时的别名反查误判
    this.session = this.deps.store.create(this.deps.ctx.cwd, this.currentAlias ?? this.model);
    // 队列不跨会话：与 fork 同理，排队内容属于上一个会话的现场（已由开头 persist 保住）。
    // 直接赋值不走 updateQueue，避免给新会话日志记一条凭空的「清空」。
    this.queue = [];
    this.notifyPrepared.clear();
    this.rebindBackground();
    // cron 与 compactionModelOverride 都是内存态、跨会话无意义：不重载 cron，旧会话任务会在新会话
    // 触发（P0 同源）；不重置 override，新会话压缩会用错模型。二者都不落盘，切会话必须手动处理。
    this.reloadCron();
    this.compactionModelOverride = undefined;
    this.planMode = false;
    this.prePlanMode = null;
    this.thinkOverride = undefined;
    // 新会话不继承 goal 与 team（两者都是会话级状态，随会话落盘）
    this.goal.restore(null);
    this.team.deactivate();
    this.steers = [];
    this.continuation = null;
    this.status.setState({ goal: undefined, teamActive: false });
    // context 用量归零：history 已清空，但基准仍是上一会话的值，不重置会继续显示旧占用
    this.baseTokens = 0;
    this.status.setState({ usedTokens: 0 });
    // 新会话 history 为空 → transcript 首条补 welcome 块（logo + 工作目录/会话/模型/版本），
    // 再跟一条「已开始新会话」note。此前只 reset 成 note，welcome 直接消失（空时 staticEntries
    // 会把 WelcomeBox 作为首条常驻）。resume 过来的会话 history 非空，
    // 不补 welcome（会话内容本身已是上文）。welcome 数据结构与 start() 构造首条保持一致。
    const items: DisplayItem[] =
      this.history.length === 0
        ? [
            { kind: 'welcome', data: { cwd: this.deps.ctx.cwd, sessionId: this.session.id, model: this.modelLabel, version: versionLine() } },
            { kind: 'note', text: `已开始新会话 ${this.session.id}` },
          ]
        : [{ kind: 'note', text: `已开始新会话 ${this.session.id}` }];
    this.transcript.reset(items);
    this.syncStatus();
    this.syncTerminalTitle();
    // 与 /clear、resumeSession 对齐：newSession 也走 invalidate + renderNow，
    // 否则只 requestRender 的话，pi-tui 差分渲染可能判定「无变化」跳过重绘，
    // 导致新会话的 welcome 块不显示（2026-08-19 用户报告）。
    this.tui.invalidate();
    this.tui.renderNow(true);
  }

  /** 从当前最新点整会话复制：新 id + forkedFrom 记谱系，源会话不动。 */
  private forkSession(): void {
    this.persist();
    const src = this.session;
    const forked = this.deps.store.create(this.deps.ctx.cwd, this.currentAlias ?? this.model);
    forked.forkedFrom = src.id;
    // 快照栈不随 fork 走：副本是新会话，回退到分叉点之前没有意义
    clearUndoSnapshots(this.undoStack);
    // 断开引用：新会话的消息用独立拷贝，否则两个会话共享同一数组，后续追加会串台
    const copied = this.history.map((m) => ({ ...m }));
    this.history.length = 0;
    this.history.push(...copied);
    forked.messages = this.history;
    forked.todos = [...this.todos.items];
    // fork 保留 thinkOverride 与 plan（是同一现场的延续），但不继承审批白名单（新会话重新问）、
    // 也不继承 goal 与 team（自主目标与团队协调属于源会话的运行现场）
    this.sessionApprovals.clear();
    this.goal.restore(null);
    this.team.deactivate();
    this.status.setState({ goal: undefined, teamActive: false });
    this.session = forked;
    // 队列不随 fork 走：排队内容是用户对源会话说的话，副本继承会让同一批消息在两个
    // 会话各发一次。源会话的队列已由函数开头那次 persist 保住，这里只清内存。
    // 直接赋值不走 updateQueue——此刻日志已是副本的，落一条 queue.update 等于在副本
    // 历史上凭空记一次「清空」。
    this.queue = [];
    this.notifyPrepared.clear();
    // 旧后台管理器的在途任务属于源会话：先整体终止并断开结算回调，防止 settle 回灌到 fork 会话。
    const oldBg = this.background;
    this.rebindBackground();
    oldBg.shutdown();
    // cron 与 compactionModelOverride 都是内存态：fork 是新 sessionId，cron 不重建则旧 sessionId
    // 任务残留 tick 触发（P0）；override 不重置会串走。
    this.reloadCron();
    this.compactionModelOverride = undefined;
    this.persist();
    this.push({
      kind: 'note',
      text: `已分叉：${src.id} → ${forked.id}（${this.history.length} 条消息）`,
    });
    this.syncStatus();
    this.syncTerminalTitle();
  }

  /**
   * 后台任务对账。两个调用点：启动时（`start`）与切会话后（`resumeSession`）。
   *
   * 对账要解决的是**通知的跨进程丢失**：任务在上个进程里跑完，`onSettle` 触发过一次
   * 就不会再触发；上个进程若崩溃或被强杀，那次通知就永久丢了。`reconcile` 拿磁盘上的
   * 任务状态与已落盘的 delivered 幂等键比对，捞出「已终态但没送达」的那批补投。
   *
   * lost 的 team worker 额外标 blocked：worker 进程没了、任务却还挂在 active，
   * 团队状态机会一直等它。fire-and-forget，不阻塞恢复流程。
   */
  private reconcileBackground(delivered: ReadonlySet<string>): void {
    let result: ReturnType<BackgroundManager['reconcile']>;
    try {
      result = this.background.reconcile(delivered);
    } catch {
      return; // 对账失败不该挡住会话启动
    }
    for (const task of result.lost) {
      const m = /^team·([A-Z]\d+)\s/.exec(task.command);
      if (m === null) continue;
      const missionId = m[1]!;
      void (async (): Promise<void> => {
        try {
          if (!this.team.active) return;
          const store = this.team.getStore();
          const state = await store.load();
          const mission = state.missions.find((x) => x.id === missionId);
          if (mission === undefined || mission.status !== 'active') return;
          await store.setStatus(missionId, 'blocked');
        } catch {
          // 静默跳过：团队档案可能已被删
        }
      })();
    }
    const redelivered: string[] = [];
    for (const task of result.redeliver) {
      this.push({
        kind: 'note',
        text: t('background.redelivered', {
          id: task.id,
          status: t(`background.status.${task.status}`),
          command: task.command,
        }),
      });
      // 补投走队列而不是直接 runTurn：启动/切会话这一刻不该自动起一个回合，
      // 用户可能正要输别的。队列在下次回合收尾或手动 Esc 取回时排空。
      const msg = buildSettleMessage(task, { startsPromptTurn: true });
      const body = typeof msg.message.content === 'string' ? msg.message.content : '';
      this.notifyPrepared.set(body, msg);
      redelivered.push(body);
    }
    // 循环外一次性落盘：逐条 updateQueue 会给一次补投写 N 条 queue.update 事件
    if (redelivered.length > 0) this.updateQueue([...this.queue, ...redelivered]);
  }

  /** 后台任务管理器换绑当前会话（任务落盘目录随会话 id 走）。 */
  private rebindBackground(): void {
    const prev = this.background;
    this.background = new BackgroundManager(10, {
      taskTimeoutS: this.deps.config.background?.bashTaskTimeoutS ?? 600,
      tasksDir: this.deps.store.tasksDirFor(this.session.cwd, this.session.id),
      onSettleEvent: (task) => this.appendWire({ type: 'background.task_settle', ts: new Date().toISOString(), task }),
      onSettle: (task) => this.onBackgroundSettle(task),
    });
    // 旧管理器的在途任务属于上个会话，必须先整体终止并断开结算回调，否则它们 settle 时
    // 回调经捕获的 this 回灌到新会话（污染转录 / 误报通知 / 注入模型上下文），与 cron
    // 跨 session 串台同源。rebind 只换引用不终止是这条泄露的结构前提。
    prev.shutdown();
  }

  /**
   * 按当前 sessionId 重载 cron 任务表。构造、/new、/resume 三处都要调用。
   *
   * 切会话时必须做，否则两类 P0 同源泄露：
   * - 旧任务留在内存，tick 到点照常 onFire → 旧会话定时任务在新会话触发；
   * - 新会话 create 的任务被打上陈旧 sessionId，下次启动按新 sessionId 过滤加载不到。
   * rebindSession 清空内存表并换 sessionId，再 restore 只装回本会话自己的任务。
   */
  private reloadCron(): number {
    this.cron.rebindSession(this.session.id);
    const allJobs = this.cronStore.load(this.deps.ctx.cwd);
    const myJobs = allJobs.filter((j) => j.sessionId === this.session.id);
    const staleIds = this.cron.restore(myJobs);
    for (const id of staleIds) void this.cronStore.remove(this.deps.ctx.cwd, id);
    return myJobs.length;
  }

  /**
   * 后台任务到达终态。三件事，与 `onSettleEvent`（只写事件日志）分工不同：
   *
   * 1. 转录区一条 note——用户可读格式，无论后续是否注入模型都要有；
   * 2. 终端通知（铃响 / 桌面通知），独立于 notifyOnComplete：用户切走终端也能感知；
   * 3. 按 busy 分流注入。空闲时取出全部待投递通知各自独立提交、唤醒新回合；
   *    busy 时什么都不做——通知已在管理器的待投递队列里，`runAgent` 会在回合边界
   *    flush 进 messages（模型下一回合即可见，不等整个循环结束）。
   *
   * 这整条链路迁移时漏了（只挂了 onSettleEvent），后台任务因此变成「发出去就忘」：
   * 完成后既无提示也不注入，用户只能自己去 /tasks 翻。
   */
  private onBackgroundSettle(task: BackgroundTask): void {
    this.push({
      kind: 'note',
      text: t('background.settled', {
        id: task.id,
        status: t(`background.status.${task.status}`),
        command: task.command,
      }),
    });
    this.syncStatus();
    if (this.deps.config.background?.notifyTerminal !== false) {
      const statusLabel = t(`background.status.${task.status}`);
      emitTerminalNotification(`后台任务 ${task.id} ${statusLabel}：${task.command}`);
    }
    // notifyOnComplete=false 只提示不注入。待投递队列要清掉，否则回合边界 flush 又注进去了
    if (this.deps.config.background?.notifyOnComplete === false) {
      this.background.drainSettled();
      return;
    }
    if (decideNotifyRoute(this.busy) === 'submit') {
      for (const settled of this.background.drainSettled()) {
        const msg = buildSettleMessage(settled, { startsPromptTurn: true });
        const body = typeof msg.message.content === 'string' ? msg.message.content : '';
        // silent：通知正文是给模型看的 XML 信封，不能显示成用户气泡——那等于系统冒充用户
        // 说了一段话。用户侧可见性由上面那条 note 承担（人读格式）。
        void this.runTurn(body, { silent: true, prepared: msg });
      }
    }
  }

  // ---------------------------------------------------------------- 耗时命令

  /**
   * 上下文压缩。要等一次完整摘要请求（长历史可达数十秒），因此挂上 controller 让 Esc
   * 能中断——复用回合中断的同一通道，Esc 的三态优先级自动适用。
   */
  private async runCompact(): Promise<void> {
    if (this.busy) return;
    // 短历史直接挡在门外：fullCompact 对 length - keepRecent <= 1 的输入原样返回同引用，
    // 与「摘要请求失败」走同一出口，但这次一次请求都没发过——文案不应指向不存在的失败。这里先判长度，给准确原因。
    if (this.history.length - COMPACT_KEEP_RECENT <= 1) {
      this.push({
        kind: 'note',
        text: `历史只有 ${this.history.length} 条消息，最近 ${COMPACT_KEEP_RECENT} 条要原样保留，没有可压缩的部分`,
      });
      return;
    }
    const before = estimateTokens(this.history);
    this.busy = true;
    const controller = new AbortController();
    this.controller = controller;
    this.activity.setBusy(true);
    this.activity.setTip('压缩上下文');
    this.syncStatus();
    this.push({ kind: 'note', text: '正在压缩上下文…' });
    try {
      const compaction = this.compactionBinding;
      const compacted = await fullCompact(
        compaction.provider ?? this.provider,
        this.history,
        COMPACT_KEEP_RECENT,
        this.todos.items,
        compaction.model,
        {
          maxTokens: this.deps.config.compaction.userMessageMaxTokens,
          headTokens: this.deps.config.compaction.userMessageHeadTokens,
        },
        controller.signal,
      );
      if (controller.signal.aborted) {
        this.push({ kind: 'note', text: '压缩已中断，历史未改动' });
      } else if (compacted !== this.history) {
        this.history.length = 0;
        this.history.push(...compacted);
        // 压缩重写了历史，旧快照的 historyLen 全部失效
        clearUndoSnapshots(this.undoStack);
        this.appendWire({ type: 'context.apply_compaction', ts: new Date().toISOString(), messages: [...compacted] });
        const after = estimateTokens(this.history);
        // 状态栏 context 用量立即回落：after 是压缩后全量估算，基准必须一起更新，
        // 否则后续重算会用回压缩前的真实 usage，看起来像没压。
        this.baseTokens = after;
        this.status.setState({ usedTokens: after });
        this.persist();
        // after >= before 的情况真实存在：摘要本身要占 token，短对话下它可能比被替换的
        // 摘要本身要占 token，短对话下它可能比被替换的原文更长（Y 比 X 大）。分开说，并给出真正能腾空间的动作。
        if (after < before) {
          this.push({ kind: 'note', text: `已压缩：${before} → ${after} tokens（省 ${before - after}）` });
        } else {
          this.push({
            kind: 'note',
            text: `已压缩，但摘要比原历史更长（${before} → ${after} tokens）。短对话压缩通常没收益，要彻底腾出窗口用 /new`,
          });
        }
      } else {
        // 同引用返回 = 未压缩（摘要请求失败或质量闸门拦截）。不能打「已压缩：X → X」，
        // 相同数字会被读成压缩成功。
        this.push({ kind: 'note', text: '这次没有压缩（摘要请求失败或未通过质量闸门），历史未改动' });
      }
    } catch (e) {
      // 中断走 note 而非 error：用户主动取消不是故障
      if (controller.signal.aborted) this.push({ kind: 'note', text: '压缩已中断，历史未改动' });
      else this.push({ kind: 'error', text: `压缩失败：${(e as Error).message}` });
    } finally {
      this.busy = false;
      this.activity.setBusy(false);
      this.activity.setTip('');
      if (this.controller === controller) this.controller = null;
      this.syncStatus();
      this.tui.requestRender();
      await this.finishTurn();
    }
  }

  private async runExportDebugZip(): Promise<void> {
    if (this.busy) return;
    this.busy = true;
    this.syncStatus();
    this.push({ kind: 'note', text: '正在打包调试信息…' });
    try {
      const { zipPath, files } = await exportDebugBundle({
        store: this.deps.store,
        cwd: this.session.cwd,
        sessionId: this.session.id,
        model: this.model,
      });
      this.push({
        kind: 'note',
        text: `已导出：${zipPath}\n含：${files.join('、')}\n发出前请自查内容（已做基础脱敏，但仍可能含路径与代码片段）`,
      });
    } catch (e) {
      this.push({ kind: 'error', text: `导出失败：${(e as Error).message}` });
    } finally {
      this.busy = false;
      this.syncStatus();
      this.tui.requestRender();
    }
  }

  /**
   * 回合收尾的统一出口：决定下一步是发队首消息、走 goal 续接，还是就此空闲。
   *
   * 决策交给 `planTurnEnd`（纯函数，两版共用），它钉住的是「队列优先于续接」——
   * 反过来会让 goal 这类高频续接把用户排队的消息饿死。这一层只落副作用。
   */
  private async finishTurn(): Promise<void> {
    const goalActive = this.goal.get()?.status === 'active';
    // OOM 第二道防线：每回合边界折叠超闸门的旧块为摘要（折旧轮 tool/thinking，保留对话骨架）。
    // 仅在 turn 数超 FOLD_TRIGGER_TURNS 时触发（低频安全阀，避免每回合全屏重绘代价）。
    this.transcript.foldOldTurns(FOLD_KEEP_RECENT_TURNS, FOLD_TRIGGER_TURNS);
    // 清单全部完成即清空：待办面板是「还有什么没做」的提示，全绿之后继续常驻只是占行。
    // 有未完成项则跨回合保留。
    if (allTodosDone(this.todos.items)) this.todos.items = [];
    const plan = planTurnEnd({
      continuation: this.continuation,
      goalActive,
      queue: this.queue,
      hasPendingPrompt: this.promptActive,
    });
    this.updateQueue(plan.queueRemainder);
    if (plan.action === 'idle') return;
    if (plan.action === 'submit-queue') {
      const text = plan.text ?? '';
      // 队列里可能混着排队的斜杠命令（busyRoute 判为 queue 的那些）
      if (text.startsWith('/')) await this.handleSlash(text);
      else {
        // 后台通知补投：取回带幂等键的原消息，并按 silent 走（正文是给模型看的 XML 信封）
        const prepared = this.notifyPrepared.get(text);
        if (prepared !== undefined) {
          this.notifyPrepared.delete(text);
          await this.runTurn(text, { silent: true, prepared });
        } else await this.dispatchText(text);
      }
      return;
    }
    // submit-continuation：goal 仍 active 时把 steer 留言拼进注入文本；
    // goal 已结束（assemble 返回 null）退化为原始续接文本，对应 Stop hook 的续行兜底。
    const raw = this.continuation ?? '';
    this.continuation = null;
    // 计轮落在这里：注入真的发出去了才算一轮（闸门只裁决不记账，见 shouldContinueAfterStop）
    let text: string | null = null;
    if (goalActive) {
      this.goal.incrementTurn();
      this.syncGoalBadge();
      text = assembleGoalInject(this.goal, raw, this.steers.splice(0));
    }
    await this.runTurn(text ?? raw, { silent: true });
  }

  // ---------------------------------------------------------------- 模型与会话切换

  /**
   * 按别名或裸 id 切换模型。别名命中则按合并配置重建 provider（别名承载渠道、窗口、
   * 显示名、能力标记整组绑定）；未命中按裸 id 处理，只改模型参数不动 provider。
   * persistDefault=false 用于 /resume：恢复旧会话是回到那个现场，不该悄悄改全局默认。
   */
  private applyModel(arg: string, opts?: { persistDefault?: boolean }): void {
    const persistPointer = (): void => {
      if (opts?.persistDefault === false) return;
      try {
        saveDefaultModel(arg, this.defaultModelPointer);
        this.defaultModelPointer = arg;
      } catch (e) {
        this.push({ kind: 'note', text: `默认模型写回配置失败：${(e as Error).message}（本次切换已生效）` });
      }
    };
    const resolved = resolveModelEntry(this.deps.config, arg);
    if (resolved === null) {
      this.currentAlias = undefined;
      this.deps.ctx.capabilities = undefined;
      this.deps.ctx.imageMaxEdgePx = undefined;
      this.deps.ctx.imageBudgetBytes = undefined;
      this.deps.ctx.videoBudgetBytes = undefined;
      this.model = arg;
      this.modelLabel = arg;
      this.syncStatus();
      this.persist();
      persistPointer();
      this.push({ kind: 'note', text: `已切换模型：${arg}` });
      return;
    }
    try {
      this.provider = createProvider(resolved);
    } catch (e) {
      this.push({ kind: 'error', text: `切换模型失败：${(e as Error).message}` });
      return;
    }
    this.currentAlias = arg;
    this.deps.ctx.capabilities = resolved.capabilities;
    this.deps.ctx.imageMaxEdgePx = resolved.imageMaxEdgePx;
    this.deps.ctx.imageBudgetBytes = resolved.imageBudgetBytes;
    this.deps.ctx.videoBudgetBytes = resolved.videoBudgetBytes;
    this.model = resolved.model;
    this.modelLabel = this.deps.config.models?.[arg]?.displayName ?? resolved.model;
    this.maxContextSize = resolved.maxContextSize;
    this.syncStatus();
    this.persist();
    persistPointer();
    this.push({ kind: 'note', text: `已切换到 ${arg}（${resolved.model}）` });
    // 切到显式声明不收图（-image_in）的模型且历史含图时提醒：图片以占位文本投影，
    // 原图保留，切回多模态模型即恢复。
    if (resolved.capabilities?.includes('-image_in') === true) {
      const n = countHistoryImages(this.history);
      if (n > 0) this.push({ kind: 'note', text: t('app.model.noImageInHint', { count: n }) });
    }
  }

  /** 恢复指定会话：重建历史与转录区，模型跟随该会话当初的选择。 */
  private resumeSession(id: string): void {
    // 走 store.resume 而不是 load：resume = 快照检查点 + 事件日志尾段重放，多做三件
    // load 做不到的事——补上检查点之后的非消息状态变更、闭合末尾悬空 tool_use（不闭合
    // 会让下一轮请求因「tool_use 没有配对的 tool_result」被协议拒绝）、给出已送达通知的
    // 幂等键集合供后台任务对账。启动路径（cli.ts）一直走 resume，应用内 /resume 此前
    // 还停在 load，两条恢复路径行为不一致，这里对齐。
    const r = this.deps.store.resume(this.deps.ctx.cwd, id);
    if (r === null) {
      this.push({ kind: 'note', text: `没找到会话 ${id}` });
      return;
    }
    const data = r.session;
    this.persist();
    this.session = data;
    this.history.length = 0;
    this.history.push(...data.messages.map((m) => ({ ...m })));
    if (r.closedDanglingToolUse) {
      this.push({
        kind: 'note',
        text: `恢复时闭合了 ${r.closedToolUseIds.length} 个未完成的工具调用（合成错误结果，不假装成功）`,
      });
    }
    // 快照栈属于上一个会话的运行现场，切会话即清（否则回退会按错的 historyLen 截断）
    clearUndoSnapshots(this.undoStack);
    // 上个会话经 tool_search 加载的动态工具同样属于那个现场：不清会泄漏到恢复后的会话，
    // 模型看得见一个本轮没人搜过的工具。
    clearDynamicTools();
    this.mode = data.mode ?? this.mode;
    this.planMode = data.planMode ?? false;
    this.thinkOverride = data.thinkOverride;
    // 待办清单随会话落盘却从不恢复：不补会让 resume 串到残留的源会话 todos。
    this.todos.items = [...(data.todos ?? [])];
    // compactionModelOverride 不落盘：resume 到别的会话必须重置，否则新会话压缩用错模型。
    this.compactionModelOverride = undefined;
    // 队列跟着目标会话走：当前会话排着的队属于旧现场，切过去要换成目标会话自己的。
    // 直接赋值不落 wire 事件——此刻 this.session 已经是新会话，落事件会把「恢复」这个
    // 读取动作记成新会话的一次队列变更。
    const restoredQueue = [...(data.queue ?? [])];
    this.queue = restoredQueue;
    this.notifyPrepared.clear();
    // goal 与 team 跟着目标会话恢复。active goal 会被 restore 降级为 paused：
    // 切过来的瞬间不该自动跑起来，要用户确认后 /goal resume。
    this.goal.restore(data.goal);
    void this.team.restore(data.team).then(() => {
      this.status.setState({ teamActive: this.team.active });
      this.tui.requestRender();
    });
    this.steers = [];
    this.continuation = null;
    const resumedGoal = this.goal.get();
    this.syncGoalBadge();
    if (data.model !== '' && data.model !== this.currentAlias) {
      this.applyModel(data.model, { persistDefault: false });
    }
    // 换绑：tasksDir 由 session.id 算出，恢复到别的会话后不换绑，新起的后台任务会写进
    // 上一个会话的任务目录（这里原先只有下面那句对账，注释写着「换绑后」而实际没换过）。
    this.rebindBackground();
    // cron 跟着目标会话走：旧会话的任务属旧现场，必须清空重装本会话自己的（同 newSession）。
    const restoredCronCount = this.reloadCron();
    // 换绑后立刻对账：这批任务的 onSettle 属于上个会话，本会话从未触发过。
    // 切会话即换了 delivered 集合的作用域，内存里那份属于旧会话，清掉重来。
    this.deliveredWritten = new Set(r.deliveredNotifications);
    this.reconcileBackground(this.deliveredWritten);
    const replay = historyToDisplayItems(data.messages);
    // 恢复感知：告诉用户 resume 后挂了多少队列消息与定时任务——此前静默换绑，用户根本不知道
    const restoredParts: string[] = [];
    if (restoredQueue.length > 0) restoredParts.push(`${restoredQueue.length} 条排队消息`);
    if (restoredCronCount > 0) restoredParts.push(`${restoredCronCount} 个定时任务`);
    const restoredHint = restoredParts.length > 0 ? `\n恢复了${restoredParts.join('、')}（切走后保留，回来继续）` : '';
    this.transcript.reset(
      [
        ...replay.items,
        {
          kind: 'note',
          text:
            `已切换到会话 ${data.id}（${replay.totalTurns} 轮 / ${data.messages.length} 条消息）` +
            (resumedGoal !== null ? `
该会话有目标「${resumedGoal.objective}」，已暂停，用 /goal resume 继续` : '') +
            restoredHint,
        },
      ],
      replay.foldedTurns,
    );
    this.syncStatus();
    this.syncTerminalTitle();
    this.tui.invalidate();
    this.tui.renderNow(true);
    // resume 后如果 goal 不活跃且 queue 非空，自动开始 drain 第一条排队消息——
    // 不需要用户先发消息才能触发，避免用户看到 queue:28 却不知道怎么办。
    // goal 活跃时不 drain：goal 有自己的推进节奏，drain 会干扰自动回合。
    const goalActive = resumedGoal !== null && resumedGoal.status === 'active';
    if (!goalActive && restoredQueue.length > 0) {
      void this.finishTurn();
    }
  }

  private async pickModel(): Promise<void> {
    const items = modelItems(this.deps.config, this.currentAlias);
    if (items.length === 0) {
      this.push({ kind: 'note', text: '配置里没有 [models.*] 别名，先用 /model <模型 id> 直切' });
      return;
    }
    const tabs = modelTabs(this.deps.config);
    const hasHistory = this.history.some((m) => m.origin.kind === "user" || m.origin.kind === "user_verbatim" || m.origin.kind === "assistant");
    const picked = await this.showInlinePicker({
      title: t('modelPicker.title'),
      items,
      hint:
        tabs.length > 1
          ? '↑↓ 选择 · Enter 确认 · Shift+Enter 仅本会话 · Tab 切渠道 · 输入过滤 · Esc 取消'
          : '↑↓ 选择 · Enter 确认 · Shift+Enter 仅本会话 · 输入过滤 · Esc 取消',
      subtitle: hasHistory ? t('modelPicker.cacheWarning') : undefined,
      tabs,
      itemsForTab: (tabId) => modelItems(this.deps.config, this.currentAlias, tabId),
      // Shift+Enter = 仅本会话生效，不写回默认模型指针
      onShiftSelect: (value) => this.applyModel(value, { persistDefault: false }),
    });
    if (picked !== null) this.applyModel(picked);
  }

  /**
   * 会话选择器。除恢复之外还有三件事：
   * d 删除（二次确认，当前会话不可删）、r 重命名（行内单行输入）、
   * 子 agent 会话作为只读分组列在末尾——它们不能被恢复成主会话，选中只提示。
   */
  private async pickSession(): Promise<void> {
    const all = this.deps.store.list(this.deps.ctx.cwd);
    const mains = all.filter((m) => m.parentId === undefined);
    const subs = all.filter((m) => m.parentId !== undefined);
    if (mains.length === 0 && subs.length === 0) {
      this.push({ kind: 'note', text: '本目录还没有历史会话' });
      return;
    }
    const buildItems = (): SelectItem[] => {
      const metas = this.deps.store.list(this.deps.ctx.cwd);
      const m = metas.filter((x) => x.parentId === undefined);
      const sub = metas.filter((x) => x.parentId !== undefined);
      const items = sessionItems(m, Date.now(), this.session.id).map((it) => ({
        ...it,
        label: it.label,
      }));
      if (sub.length > 0) {
        items.push({ value: '__sub_header__', label: '── 子 agent 会话（只读）──', description: '' });
        for (const it of sessionItems(sub)) items.push({ ...it, value: `sub:${it.value}`, label: `  ${it.label}` });
      }
      return items;
    };

    const picked = await this.showInlinePicker({
      title: '恢复会话',
      items: buildItems(),
      hint: '↑↓ 选择 · Enter 恢复 · Delete 删除 · r 重命名 · 输入过滤 · Esc 取消',
      onKey: (data, selected, overlay) => {
        if (selected === null) return false;
        const id = selected.value;
        const filterEmpty = overlay.getFilter() === '';
        if (id === '__sub_header__') return matchesKey(data, 'delete') || (data === 'r' && filterEmpty);
        if (id.startsWith('sub:')) {
          return matchesKey(data, 'delete') || (data === 'r' && filterEmpty);
        }
        // 删除走 Delete 键（不再占用裸 d，d 还给搜索框）
        if (matchesKey(data, 'delete') || (data === 'd' && filterEmpty)) {
          if (id === this.session.id) {
            this.push({ kind: 'note', text: '不能删除当前会话（先 /new 或切到别的会话）' });
            return true;
          }
          void this.confirmDeleteSession(id, overlay, buildItems);
          return true;
        }
        // 重命名仅在过滤为空时触发（r 还给搜索框）
        if (data === 'r' && filterEmpty) {
          void this.renameSessionInline(id, overlay, buildItems);
          return true;
        }
        return false;
      },
    });
    if (picked === null) return;
    if (picked === '__sub_header__') return;
    if (picked.startsWith('sub:')) {
      this.browseSubagentSession(picked.slice(4));
      return;
    }
    this.resumeSession(picked);
  }

  /** 删除会话：先问一句再删（删除不可逆，且列表里相邻两行差一个字符很容易点错）。 */
  private async confirmDeleteSession(
    id: string,
    overlay: PickerOverlay,
    rebuild: () => SelectItem[],
  ): Promise<void> {
    const answer = await askLine(this.tui, `删除会话 ${id}？输入 y 确认（其它任意键取消）`);
    if (answer !== null && answer.trim().toLowerCase() === 'y') {
      const ok = this.deps.store.delete(this.deps.ctx.cwd, id);
      this.push({ kind: 'note', text: ok ? `已删除会话 ${id}` : `删除失败：${id}` });
      overlay.setItems(rebuild());
    }
    this.tui.setFocus(overlay);
    this.tui.requestRender();
  }

  /** 重命名会话：行内单行输入，空串视为取消（清名字请用 store 层，不在这里给隐式语义）。 */
  private async renameSessionInline(
    id: string,
    overlay: PickerOverlay,
    rebuild: () => SelectItem[],
  ): Promise<void> {
    // 拿当前名字作预填：用户改几个字即可，不用凭记忆全名重打。store.list 读索引，开销可忽略。
    const meta = this.deps.store.list(this.deps.ctx.cwd).find((m) => m.id === id);
    const currentName = meta?.name ?? meta?.title ?? id.slice(0, 8);
    const name = await askLine(
      this.tui,
      `会话「${currentName}」的新名字`,
      meta?.name ?? '', // 预填自定义名；无自定义名时为空（用户从头输入）
      '留空清除自定义名 · Enter 确认 · Esc 取消',
    );
    if (name === null) return; // Esc 取消
    const trimmed = name.trim();
    if (trimmed === '') {
      // 留空 = 清除自定义名，回落自动标题（store.rename 内部 delete data.name）
      const ok = this.deps.store.rename(this.deps.ctx.cwd, id, '');
      this.push({ kind: 'note', text: ok ? `已清除「${currentName}」的自定义名（回落自动标题）` : `操作失败：${id}` });
    } else {
      const ok = this.deps.store.rename(this.deps.ctx.cwd, id, trimmed);
      this.push({ kind: 'note', text: ok ? `已重命名为「${trimmed}」` : `重命名失败：${id}` });
      // 改的是当前会话时 tab 标题跟着变（name 优先于 title）
      if (ok && id === this.session.id) {
        this.session.name = trimmed;
        this.syncTerminalTitle();
      }
    }
    overlay.setItems(rebuild());
    this.tui.setFocus(overlay);
    this.tui.requestRender();
  }

  private async pickThink(): Promise<void> {
    const hasHistory = this.history.some((m) => m.origin.kind === "user" || m.origin.kind === "user_verbatim" || m.origin.kind === "assistant");
    const picked = await this.showInlinePicker({
      title: t('thinkPicker.title'),
      items: thinkItems(this.thinkOverride),
      hint: '↑↓ 选择 · Enter 确认 · Esc 取消',
      subtitle: hasHistory ? t('app.think.cacheWarning') : undefined,
    });
    if (picked === null) return;
    this.applyThink(picked === '__default__' ? undefined : picked);
  }

  /** 应用会话级思考深度覆盖。undefined = 回落配置默认。 */
  private applyThink(override: ThinkOverride | undefined): void {
    this.thinkOverride = override;
    this.syncStatus();
    this.persist();
    this.appendWire({ type: 'think.set', ts: new Date().toISOString(), override });
    this.push({
      kind: 'note',
      text: override === undefined ? '思考深度改为跟随配置默认' : `思考深度：${override}`,
    });
  }

  // ---------------------------------------------------------------- 回合执行

  private buildHooks(): LoopHooks {
    const base: LoopHooks = {
      /**
       * goal 续跑的轮级驱动薄壳：裁决交给 decideGoalTurn，副作用（计轮、标 blocked）
       * 在这一层落定。返回续接描述后由 runAgent 产 continuation 事件，回合收尾时派发下一轮。
       */
      shouldContinueAfterStop: () => {
        const d = decideGoalTurn(this.goal);
        if (d.kind === 'stop') return null;
        if (d.kind === 'blocked') {
          this.goal.update('blocked', d.budget === 'turns' ? '轮次预算用尽' : 'token 预算用尽');
          this.push({
            kind: 'note',
            text: d.budget === 'turns' ? '目标已达轮次预算上限，停在这里等你决定' : '目标已达 token 预算上限，停在这里等你决定',
          });
          return null;
        }
        // 计轮不在这里：闸门只裁决不记账。注入要到 finishTurn 的 submit-continuation
        // 分支才真的发出去，中途被中断/被队列抢先时若已计轮，turnsUsed 就虚高
        // （同源修法）。
        return { inject: d.inject };
      },
      authorizeToolCall: async (req) => {
        // plan 模式守卫：写与执行一律拒（exit_plan_mode 例外，走下方确认）
        if (this.planMode) {
          const deny = planModeDenyReason(req.name);
          if (deny !== null) return { decision: 'deny', reason: deny, errorCode: 'PLAN_MODE_BLOCKED' };
        }
        // exit_plan_mode：展示计划请用户确认，批准后退出 plan 并恢复原权限模式
        if (req.name === 'exit_plan_mode') {
          const plan = typeof (req.input as { plan?: unknown } | null)?.plan === 'string' ? (req.input as { plan: string }).plan : '';
          const { approved, feedback } = await this.askPlanApproval(plan);
          if (approved) {
            this.planMode = false;
            if (this.prePlanMode !== null) {
              this.mode = this.prePlanMode;
              this.prePlanMode = null;
            }
            this.syncStatus();
            this.persist();
            this.push({ kind: 'note', text: '计划已批准，退出计划模式开始执行' });
            return { decision: 'allow' };
          }
          return {
            decision: 'deny',
            reason:
              feedback !== undefined
                ? `用户拒绝了该计划，修订意见：${feedback}
请据此修订后再次用 exit_plan_mode 提交。`
                : '用户拒绝了该计划。请根据反馈修订计划后再次用 exit_plan_mode 提交，或向用户询问如何调整。',
          };
        }
        const d = decide(req.name, this.mode, this.sessionApprovals);
        if (d === 'allow') return { decision: 'allow' };
        const outcome = await this.askApproval(req.name, req.input);
        if (outcome.kind === 'allow') {
          // 允许并附言：权限通道只能回 decision，附言排队为回合后的跟进消息送达模型
          // （它不影响这次执行，影响的是后续行为，如「下次先跑测试再改」）。
          if (outcome.feedback !== undefined && outcome.feedback !== '') {
            this.updateQueue([...this.queue, `（批准 ${req.name} 时附言）${outcome.feedback}`]);
            this.push({ kind: 'note', text: '已批准，附言会在本轮结束后发给模型' });
          }
          return { decision: 'allow' };
        }
        if (outcome.kind === 'allow-session') {
          this.sessionApprovals.add(req.name);
          return { decision: 'allow' };
        }
        return {
          decision: 'deny',
          reason:
            outcome.feedback !== undefined && outcome.feedback !== ''
              ? `用户拒绝了这次调用，反馈：${outcome.feedback}`
              : '用户拒绝了这次工具调用。请换一种方式，或先询问用户。',
        };
      },
    };
    const engine = this.deps.hookEngineRef.current;
    return engine === undefined ? base : composeLoopHooks(engine, base);
  }

  /**
   * 弹层挂载的统一路径：审批三桥（工具审批 / 计划确认 / 提问）共用一个内联挂载。
   * 审批是独占的（promptActive 防重复）。
   *
   * 落位方式：内联替换输入区（editor replacement），与内联选择器同一条路径——
   * 把交互块挂进 inputSlot 替换 editor，出现在对话最底部、状态栏之上，不遮挡历史消息；
   * 结算时恢复 editor。此前走 tui.showOverlay(anchor:'center') 浮层，会盖住两侧消息历史。
   */
  private showPrompt<T>(make: (settle: (value: T) => void) => Component): Promise<T> {
    return new Promise<T>((resolve) => {
      const block = make((value) => {
        this.promptActive = false;
        this.activity.setTip('');
        this.inputSlot.clear();
        this.inputSlot.addChild(this.editor);
        this.tui.setFocus(this.editor);
        this.tui.requestRender();
        resolve(value);
      });
      this.promptActive = true;
      this.activity.setTip('等待你确认');
      this.inputSlot.clear();
      this.inputSlot.addChild(block);
      this.tui.setFocus(block);
      this.tui.requestRender();
    });
  }

  private askApproval(name: string, input: unknown): Promise<ApprovalOutcome> {
    return this.showPrompt<ApprovalOutcome>(
      (settle) => new InlineApproval(name, input, () => this.tui.requestRender(), settle),
    );
  }

  private askPlanApproval(plan: string): Promise<PlanOutcome> {
    return this.showPrompt<PlanOutcome>(
      (settle) => new PlanApproval(plan, () => this.tui.requestRender(), settle),
    );
  }

  private askUserQuestion(req: AskUserRequest): Promise<QuestionAnswers> {
    return this.showPrompt<QuestionAnswers>(
      (settle) => new QuestionPrompt(req, () => this.tui.requestRender(), settle),
    );
  }

  /**
   * 跑一轮。
   *
   * silent=true 用于 goal 续接与 Stop hook 续行：这类文本是系统生成的注入，
   * 不该在转录区显示成用户说的话（显示出来会让人以为自己发过这段），
   * 但仍要作为 user 消息进历史，否则模型看不到续接指令。
   */
  private async runTurn(
    text: string,
    opts?: {
      silent?: boolean;
      /**
       * 已装配好的 user 消息，直接进 history 而不是由本方法 stored() 一个新的。
       * 后台任务通知走这条：`buildSettleMessage` 产出的消息带 kind='background_task'、
       * taskId 与 notificationId（补投幂等键），重新 stored 会退化成 kind='injection'
       * 并丢掉幂等键，崩溃后对账就会重复投递同一条通知。
       */
      prepared?: StoredMessage;
    },
  ): Promise<void> {
    // 图片占位符 → image content block。没有图片时 content 就是原文本（走旧路径），
    // 转录区显示的是折叠掉占位符的正文，不把 base64 摊到屏幕上。
    const extracted = extractImageContent(text, this.images);
    // 能力拦截：当前模型显式声明不收图（capabilities 含 -image_in）时带图提交直接拦下——
    // 防新图被投影层静默占位、用户误以为模型看到了图。
    // 必须在压栈之前拦：拦下后本轮等于没发生，压了栈就会给 /history 留一个空快照。
    if (extracted.imageCount > 0 && this.deps.ctx.capabilities?.includes('-image_in') === true) {
      this.push({ kind: 'error', text: t('app.image.modelNoImageIn', { count: extracted.imageCount }) });
      return;
    }
    // 附带状态快照：在首次改动 history 之前压栈。silent 注入（goal 续接、cron、技能正文）
    // 不是用户的一轮输入，不压栈——否则 /history 的「撤销 N 轮」与快照栈深度错位。
    if (opts?.silent !== true) {
      pushUndoSnapshot(this.undoStack, {
        historyLen: this.history.length,
        todos: [...this.todos.items],
        planMode: this.planMode,
        prePlanMode: this.prePlanMode,
      });
    }
    if (opts?.silent !== true) {
      this.push({
        kind: 'user',
        text: extracted.imageCount > 0 ? `${extracted.displayText} [${extracted.imageCount} 张图]` : text,
      });
    }
    const userMsg = opts?.prepared ??
      stored({ role: 'user', content: extracted.content }, { kind: opts?.silent === true ? 'injection' : 'user' });
    this.history.push(userMsg);
    // 用户输入立即持久化：防进程在模型响应期间闪退（OOM/未捕获异常）时输入丢失
    this.appendWire({ type: 'context.append_message', ts: userMsg.ts, message: userMsg });

    this.busy = true;
    this.activity.setBusy(true);
    this.syncStatus();
    this.tui.requestRender();

    const controller = new AbortController();
    this.controller = controller;
    const hooks = this.buildHooks();
    const compaction = this.compactionBinding;
    const runSubagent = createSubagentRunner({
      provider: this.provider,
      cwd: this.deps.ctx.cwd,
      apiKey: this.deps.ctx.apiKey,
      baseUrl: this.deps.ctx.baseUrl,
      capabilities: this.deps.ctx.capabilities,
      // 媒体限额随主控透传：迁移时漏了这三项，子 agent 一直按内置缺省处理图片/视频
      imageMaxEdgePx: this.deps.ctx.imageMaxEdgePx,
      imageBudgetBytes: this.deps.ctx.imageBudgetBytes,
      videoBudgetBytes: this.deps.ctx.videoBudgetBytes,
      config: this.deps.config,
      hooks,
      maxDepth: this.deps.config.subagent.maxDepth,
      maxStepsDefault: this.deps.config.subagent.maxSteps,
      userMessageBudget: {
        maxTokens: this.deps.config.compaction.userMessageMaxTokens,
        headTokens: this.deps.config.compaction.userMessageHeadTokens,
      },
      compaction: {
        maxContextSize: this.maxContextSize,
        triggerRatio: this.deps.config.compaction.triggerRatio,
        reservedTokens: this.deps.config.compaction.reservedTokens,
      },
      compactionModel: compaction.model,
      compactionProvider: compaction.provider,
      sessionCounter: this.subagentCounter,
      parentSessionId: this.session.id,
      skills: this.deps.skillsRef.current,
      subagentStore: this.deps.subagentStore,
      // 子 agent 进度直接写进那条 spawn_agent 工具卡片——差分渲染下条目内嵌就是实时面板
      onEvent: (_id, ev) => {
        if (ev.kind === 'start') this.activity.setTip(`子 agent ${ev.subagentType}：${ev.description}`);
        if (ev.kind === 'end') this.activity.setTip('');
        this.applySubagentProgress(ev);
      },
    });

    // system 逐轮组装（composeSystem 定段序：低频内容在前，保住 prompt 缓存前缀）。
    // memory 段仅开启时注入，每轮现扫目录——条目数小、开销可忽略，换来的是 agent 自己
    // 写完文件后下一轮即被索引到。这一段与 sessionContext 都曾整块漏掉，见 composeSystem 注释。
    const system = composeSystem({
      prefix: this.deps.systemPrefix,
      skills: skillListing(this.deps.skillsRef.current, this.deps.config.skillListingBudget),
      subagents: subagentListing([...this.deps.subagentRegistry.values()]),
      agentsMd: this.deps.agentsMd,
      memory: this.deps.config.memory?.enabled === true ? memorySection(scanMemory(this.deps.ctx.cwd)) : '',
      sessionContext: this.sessionContext,
    });

    try {
      for await (const ev of runAgent({
        provider: this.provider,
        system,
        ctx: {
          ...this.deps.ctx,
          skills: this.deps.skillsRef.current,
          signal: controller.signal,
          depth: 0,
          runSubagent,
          // dynamic_workflow 的阶段进度：phase 事件按 title 追加（index 是哨兵 -1，
          // 阶段在运行时才知道，不能按 index 定位），同样挂在工具卡片上。
          onWorkflowStep: (info) => this.applyWorkflowStep(info),
          todos: this.todos,
          background: this.background,
          goal: this.goal,
          team: this.team,
          cron: this.cron,
          askUser: (req) => this.askUserQuestion(req),
          // 子 agent 并发上限：不传会退到 runTurn.ts 里的硬编码 4，与 [subagent] max_concurrent 脱节
          subagentMaxConcurrent: this.deps.config.subagent.maxConcurrent,
        },
        messages: this.history,
        signal: controller.signal,
        hooks,
        model: this.model,
        thinking: thinkStreamParam(this.thinkOverride, thinkLevelsOf(this.deps.config.thinking)),
        compaction: {
          maxContextSize: this.maxContextSize,
          triggerRatio: this.deps.config.compaction.triggerRatio,
          reservedTokens: this.deps.config.compaction.reservedTokens,
        },
        compactionModel: compaction.model,
        compactionProvider: compaction.provider,
        // /think 门控据此判定当前渠道支不支持思考参数
        providerName: this.deps.providerName,
        // 把状态栏的真实 usage 基准交给压缩预检。基准为 0（全新会话尚无真实 usage）时不传：
        // 让 runAgent 走估算路径，那条路径会补上框架侧开销；传 0 会被当成「已测量」而丢掉补偿。
        initialUsage: this.baseTokens > 0 ? { total: this.baseTokens, measuredLength: this.measuredLen } : undefined,
        userMessageBudget: {
          maxTokens: this.deps.config.compaction.userMessageMaxTokens,
          headTokens: this.deps.config.compaction.userMessageHeadTokens,
        },
        // 不传等于 0，而 0 在 loop.ts 里就是「关闭自动续写」——正文被 max_tokens 截断后
        // 不再自动续写，用户只看到半截回答。默认 3。
        maxAutoContinues: this.deps.config.continuation?.maxAutoContinues,
        todos: this.todos.items,
        injectBackgroundNotifications: true,
        steerQueue: this.activeSteer,
        onWireEvent: (event) => this.appendWire(event),
      })) {
        this.streamBuffer.ingest(ev);
      }
    } catch (e) {
      this.streamBuffer.drain();
      this.applyEvent({ type: 'error', message: (e as Error).message });
    } finally {
      this.streamBuffer.drain();
      // 收尾兜底：残留的思考必须在本回合内落块。
      //
      // drain() 只是把 StreamBuffer 的缓冲吐给 applyEvent，而 thinking_delta 在 applyEvent
      // 里只累积进 thinkingAccum、不落块——落块靠的是「下一个内容流事件」触发 settle。
      // 于是当本回合最后一批事件就是思考时（模型只吐思考就结束、流在思考中途断开、
      // 生成器早退没发 turn_done/aborted），accum 会滞留到下一轮：下一轮首个 text 事件
      // 才 settle，那一刻转录区末块已经是新一轮的 user 消息，思考块因此落在新输入之后。
      // 用户看到的现象就是上一轮的思考泄漏到这一轮、输出顺序错乱。
      //
      // 放在 drain() 之后：drain 会把缓冲里最后那截 thinking_delta 也喂进 accum，
      // 顺序反了就会漏掉那一截。
      if (settleThinking(this.transcript, this.thinkingAccum)) {
        this.thinkingAccum = '';
        this.activity.setThinking(false);
      }
      this.controller = null;
      // steer 兜底：run 结束（end_turn/出错）而循环没走到 step 边界时，activeSteer 里
      // 的插话不会被消费——倒回队列头部按正常队列机制续发，用户的话不丢不错位。
      if (this.activeSteer.length > 0) {
        this.updateQueue([...this.activeSteer.splice(0), ...this.queue]);
        this.push({ kind: 'note', text: '插话没赶上本轮（回合已结束），已转回队列', boundary: true });
      }
      this.busy = false;
      this.activity.setBusy(false);
      this.activity.setTip('');
      this.syncStatus();
      this.persist();
      // 会话标题 AI 生成：首轮回答后触发一次，fire-and-forget 不阻塞收尾
      this.maybeGenerateTitle();
      this.tui.requestRender();
      // 队列续发：回合收尾后自动发下一条。
      // 队列里可能混着排队的斜杠命令（busyRoute 判为 queue 的那些），
      // 统一走 drainQueue 分流，否则命令会被当成普通消息发给模型。
      await this.finishTurn();
    }
  }

  // ---------------------------------------------------------------- 事件应用

  /** AgentEvent → 转录区变更。 */
  private applyEvent(ev: AgentEvent): void {
    if (ev.type === 'thinking_start') {
      this.activity.setThinking(true);
      this.tui.requestRender();
      return;
    }
    if (ev.type === 'thinking_delta') {
      this.thinkingAccum += ev.text;
      this.activity.addOutputChars(ev.text.length);
      // preview 只传尾部窗口，而非全量 accum：Text 组件 setText 后会重新折行整个串，
      // 若 accum 随每 chunk 线性增长，累计重折成本是 O(N²)——长思考（几百 chunk）下这是
      // 卡顿与内存尖峰的同源压力。preview 只需尾部 N 行，传尾部即可，让 Text 始终处理有界串。
      // accum 本身仍全量保留（回合结束落成 thinking 定稿块、进 compaction 都需要完整文本）。
      this.activity.setThinking(true, this.previewTail(this.thinkingAccum));
      this.tui.requestRender();
      return;
    }
    // 内容流事件到来 = 思考段结束：已累积的思考落成定稿块，保证 thinking 块永远排在
    // 同一段正文之前。usage 例外——它是状态数字不是内容流，回合尾部才发，让它切断思考段
    // 会把一段完整思考劈成前后两块（顺序看着还对，但块数与内容边界都错了）。
    if (ev.type === 'usage') {
      this.baseTokens = ev.totalTokens;
      if (ev.measuredLength !== undefined) this.measuredLen = ev.measuredLength;
      this.status.setState({ usedTokens: this.baseTokens });
      this.tui.requestRender();
      return;
    }
    this.activity.setThinking(false);
    if (settleThinking(this.transcript, this.thinkingAccum)) this.thinkingAccum = '';
    if (ev.type === 'thinking_end') {
      this.tui.requestRender();
      return;
    }

    // 表格扣留的放行点：任何非正文事件都是文本流边界，扣留内容先落地再处理事件。
    if (ev.type !== 'text' && this.tableHold.active) {
      const rest = this.tableHold.flush();
      if (rest !== '') appendText(this.transcript, rest);
    }
    switch (ev.type) {
      case 'text': {
        this.activity.addOutputChars(ev.text.length);
        // 经表格扣留层：疑似 pipe-table 起点之后的内容扣到表格结束再落地，
        // 消除流式表格逐行重排列宽的闪跳（详见 chat/tableHoldback.ts）。
        const visible = this.tableHold.feed(ev.text);
        if (visible !== '') appendText(this.transcript, visible);
        break;
      }
      case 'tool_forming': {
        this.activity.noteToolActivity();
        // 模型开始流式吐参数就挂卡（成形中），不等参数 JSON 完整——填掉参数流的等待空窗。
        this.transcript.push({
          kind: 'tool',
          id: ev.id,
          name: ev.name,
          input: {},
          status: 'running',
          startedAt: Date.now(),
          forming: true,
          partialArgs: '',
        });
        break;
      }
      case 'tool_args_delta': {
        this.activity.noteToolActivity();
        this.transcript.updateLastWhere(
          (it) => it.kind === 'tool' && it.id === ev.id,
          (it) => {
            const t = it as Extract<DisplayItem, { kind: 'tool' }>;
            return { ...t, partialArgs: (t.partialArgs ?? '') + ev.partialJson };
          },
        );
        break;
      }
      case 'tool_start': {
        this.activity.noteToolActivity();
        // 成形卡转正：tool_forming 挂的卡就地填实参数、清 forming 态。
        // id 匹配不上时（OpenAI 首帧缺 id 的 synthetic id）按同名成形卡兜底。
        const reconciled = this.transcript.updateLastWhere(
          (it) => it.kind === 'tool' && it.forming === true && (it.id === ev.id || it.name === ev.name),
          (it) => ({ ...(it as Extract<DisplayItem, { kind: 'tool' }>), input: ev.input, forming: undefined, partialArgs: undefined }),
        );
        if (reconciled) break;
        const toolItem: Extract<DisplayItem, { kind: 'tool' }> = {
          kind: 'tool',
          id: ev.id,
          name: ev.name,
          input: ev.input,
          status: 'running',
          startedAt: Date.now(),
        };
        // spawn_agent：把角色名和任务简述写进条目，卡片可直接显示
        if (ev.name === 'spawn_agent') {
          const inp = ev.input as Record<string, unknown> | null;
          if (inp !== null) {
            // 模型省略 subagent_type 时默认 'general'（与 spawnAgent 工具实现同款默认），
            // 否则卡片没有类型标识，用户分不清 explore/general。
            const st = typeof inp.subagent_type === 'string' ? inp.subagent_type : 'general';
            const desc = typeof inp.description === 'string' ? inp.description : undefined;
            if (st !== undefined || desc !== undefined) {
              toolItem.subagentType = st;
              toolItem.description = desc;
            }
          }
        }
        this.transcript.push(toolItem);
        break;
      }
      case 'tool_end':
        this.activity.noteToolActivity();
        this.transcript.updateLastWhere(
          (it) => it.kind === 'tool' && it.id === ev.id,
          (it) => ({ ...(it as Extract<DisplayItem, { kind: 'tool' }>), status: ev.isError ? 'error' : 'ok', result: ev.result, errorCode: ev.errorCode }),
        );
        // todo_list 工具改的是 this.todos，面板要跟着刷；其它工具走这一路开销是两次赋值
        this.chrome.setTodos(this.todos.items);
        break;
      case 'retry':
      case 'notice':
        this.transcript.push({ kind: 'note', text: ev.message, boundary: true });
        break;
      case 'thinking_downgrade':
        this.transcript.push({ kind: 'note', text: `思考预算耗尽，已自动降到 ${ev.toLevel} 档`, boundary: true });
        break;
      case 'thinking_loop':
        this.transcript.push({ kind: 'note', text: '检测到思考流循环，已注入提示重试', boundary: true });
        break;
      case 'thinking_recover':
        this.transcript.push({ kind: 'note', text: '模型只输出了思考，正基于前序分析直接作答', boundary: true });
        break;
      case 'aborted':
        // 成形中的工具卡等不到 tool_start 了（参数没吐完就断了），逐个收尾为已中断，
        // 否则永远停在 running 态。
        while (
          this.transcript.updateLastWhere(
            (it) => it.kind === 'tool' && it.forming === true,
            (it) => ({
              ...(it as Extract<DisplayItem, { kind: 'tool' }>),
              status: 'error' as const,
              forming: undefined,
              partialArgs: undefined,
              result: '参数流式期间被中断',
            }),
          )
        ) {
          // updateLastWhere 每次只收尾最后一个匹配项，循环到没有成形卡为止
        }
        // steer 残留倒进队列头部：中断后按队列机制续发，用户留言不凭空消失
        if (this.steers.length > 0) this.queue.unshift(...this.steers.splice(0));
        this.transcript.push({
          kind: 'note',
          text: this.queue.length > 0 ? `已中断，队列中 ${this.queue.length} 条将继续发送` : '已中断',
          boundary: true,
        });
        break;
      case 'error':
        this.transcript.push({ kind: 'error', text: ev.message });
        break;
      case 'continuation':
        // 续接文本先存下来，回合收尾时按「队列优先于续接」的顺序派发（见 drainQueue）
        this.continuation = ev.inject;
        break;
      case 'turn_done':
        break;
      default:
        break;
    }
    this.tui.requestRender();
  }

  /** 测试用：暴露组件树根（FakeTerminal 下断言渲染输出）。 */
  rootComponents(): Component[] {
    return [this.transcript, this.activity, this.editor, this.status];
  }

  /**
   * Ctrl+G：拉起外部编辑器编辑当前输入框内容。
   *
   * 流程：
   * 1. 把当前输入框文本写入临时文件
   * 2. this.tui.stop() 恢复终端
   * 3. spawnSync 启动编辑器（阻塞等待退出）
   * 4. 读回文件内容，setText 回输入框
   * 5. this.tui.start() 重新进入 raw mode
   * 6. 清理临时文件
   *
   * 编辑器选择优先级：$VISUAL > $EDITOR > 平台 fallback
   * GUI 编辑器需要 --wait 标志才能阻塞；终端类编辑器天然阻塞。
   *
   * 返回 true 表示已消费（编辑器成功启动并回读）；false 表示无法启动。
   */
  openExternalEditor(): boolean {
    const text = this.editor.getText();
    const tmpFile = join(tmpdir(), `step-code-prompt-${Date.now()}.md`);
    try {
      writeFileSync(tmpFile, text, 'utf8');
    } catch {
      return false;
    }

    // 选编辑器：$VISUAL 优先（Unix 惯例），其次 $EDITOR，最后平台 fallback
    const editor = process.env['VISUAL'] ?? process.env['EDITOR'] ?? null;
    let cmd: string;
    let args: string[];
    if (editor !== null && editor.trim() !== '') {
      // 用户配置的编辑器，直接信任（支持复合命令如 "code --wait"）
      const parts = this.parseEditorCommand(editor, tmpFile);
      cmd = parts.cmd;
      args = parts.args;
    } else {
      // 平台 fallback：Windows 优先 code --wait（如果有 VS Code），其次 notepad
      // macOS/Linux 优先 vi（一定能找到）
      if (process.platform === 'win32') {
        const codePath = this.findVSCode();
        if (codePath !== null) {
          cmd = codePath;
          args = ['--wait', tmpFile];
        } else {
          cmd = 'notepad';
          args = [tmpFile];
        }
      } else {
        cmd = process.env['TERM'] !== undefined ? 'vi' : 'vi';
        args = [tmpFile];
      }
    }

    // 停止 TUI：恢复终端到正常模式，否则编辑器的 UI 会画在 pi-tui 的 raw mode 上面
    this.tui.stop();
    try {
      const result = spawnSync(cmd, args, {
        stdio: 'inherit', // 编辑器直接用 stdin/stdout/stderr
        windowsHide: false, // Windows 上 notepad 需要可见窗口
      });
      if (result.status !== 0 && result.error === undefined) {
        // 编辑器非零退出（如 notepad 用户点了取消/关闭）——这不算失败，读回可能的内容
      }
    } finally {
      // 无论成功失败都要重启 TUI
      this.tui.start();
    }

    // 读回文件内容
    try {
      if (existsSync(tmpFile)) {
        const newText = readFileSync(tmpFile, 'utf8');
        this.editor.setText(newText);
      }
    } catch {
      // 读回失败不阻塞——用户的原始输入还在输入框里
    } finally {
      // 清理临时文件
      try {
        if (existsSync(tmpFile)) unlinkSync(tmpFile);
      } catch {
        // 清理失败不阻塞
      }
    }

    this.tui.requestRender();
    return true;
  }

  /**
   * 解析 $EDITOR 环境变量。
   * 支持简单命令（"vim"）和带参数命令（"code --wait"）。
   * 将文件路径追加为最后一个参数。
   */
  private parseEditorCommand(editor: string, filePath: string): { cmd: string; args: string[] } {
    const trimmed = editor.trim();
    if (trimmed === '') return { cmd: 'vi', args: [filePath] };
    // 简单处理：按空格分割，第一个是命令，剩下是参数
    const parts = trimmed.split(/\s+/);
    const cmd = parts[0]!;
    const args = [...parts.slice(1), filePath];
    return { cmd, args };
  }

  /**
   * 查找 VS Code 路径（Windows 上 `code` 不在 PATH 里时需要补全路径）。
   * 检查 VS Code 的标准安装位置。
   */
  private findVSCode(): string | null {
    if (process.platform !== 'win32') return null;
    const candidates = [
      join(homedir(), 'AppData', 'Local', 'Programs', 'Microsoft VS Code', 'bin', 'code.cmd'),
      'code', // 也许在 PATH 里
    ];
    for (const c of candidates) {
      try {
        // 用 where 命令检查 code 是否可用
        const result = spawnSync('where', [c], { stdio: 'ignore' });
        if (result.status === 0) return c;
      } catch {
        // ignore
      }
    }
    return null;
  }
}

export { c as piColors };
