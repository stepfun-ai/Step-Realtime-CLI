/**
 * PiChat：pi-tui 前端的主控制器，对应 Ink 版 App.tsx 的核心子集。
 *
 * 与 App.tsx 的心智差异（迁移里变化最大的一处）：
 * Ink 版是「改 state → React 重渲整树 → Ink 算差异」，状态与渲染由 hooks 绑定；
 * 这里是「改数据 → 显式 requestRender() → pi-tui 逐行 diff」。没有 hooks，也没有闭包读到
 * 陈旧值的问题，App.tsx 里那一大批 xxxRef.current 的存在理由（给闭包提供即时值）随之消失，
 * 全部退化成普通字段。
 *
 * M1 范围：主循环（输入 → runAgent → 流式渲染 → 最简审批 → 持久化 → 恢复）、
 * Esc / Ctrl+C 语义、发送队列、/help /exit /new /clear 四个命令。
 * 审批的完整形态（计划确认、ask_user 多选）在 M2，选择器在 M3，命令全量在 M4。
 */
import { Container, ProcessTerminal, TuiMainScreen } from '@earendil-works/pi-tui';
import type { Component } from '@earendil-works/pi-tui';
import type { AgentEvent } from '../agent/events.js';
import type { LoopHooks } from '../agent/hooks.js';
import { composeLoopHooks, type HookEngine } from '../agent/hooks/engine.js';
import { runAgent } from '../agent/loop.js';
import { stored, type StoredMessage } from '../agent/message.js';
import { decide, planModeDenyReason, type PermissionMode } from '../agent/permission/mode.js';
import { createSubagentRunner } from '../agent/subagent/runner.js';
import type { SubagentStore } from '../agent/subagent/store.js';
import type { AgentDefinition } from '../agent/subagent/types.js';
import { BackgroundManager } from '../agent/background/manager.js';
import { CronScheduler } from '../agent/cron/scheduler.js';
import { CronJobStore } from '../agent/cron/store.js';
import { assembleGoalInject, decideGoalTurn } from '../agent/goal/drive.js';
import { GoalMode, type GoalChangeEvent } from '../agent/goal/mode.js';
import { initTeam } from '../agent/team/mode.js';
import { TeamMode } from '../agent/team/mode.js';
import { estimateTokens, fullCompact } from '../agent/compaction/compact.js';
import { MEMORY_ONBOARDING_INJECTION } from '../agent/memory.js';
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
import { resolveCompactionBinding } from '../provider/compaction.js';
import { exportDebugBundle } from '../session/debugBundle.js';
import type { SessionData, SessionStore } from '../session/store.js';
import { aggregateModelUsage } from '../session/usageReport.js';
import type { WireEvent } from '../agent/wirelog.js';
import { renderSkillActivation, skillListing, type SkillRegistry } from '../skill/registry.js';
import { REFLECT_EMPTY_HISTORY, REFLECT_NO_FINDINGS, runReflect } from '../agent/reflect.js';
import { expandPluginCommand, type PluginCommand } from '../plugin/manager.js';
import { runPluginCommand } from '../chat/pluginCommand.js';
import { restoreFile } from '../tools/checkpoint.js';
import { resolvePath } from '../tools/fsutil.js';
import type { ToolContext } from '../tools/types.js';
import type { DisplayItem } from '../chat/types.js';
import { busyRoute, helpText, parseSlash } from '../chat/commands.js';
import { resolveProviderTarget } from '../chat/providerSwitch.js';
import { diffConfig, formatConfigChange, planProviderReload, resolveCapabilitiesOnReload, resolveImageLimitsOnReload } from '../chat/reload.js';
import { extractUserText } from '../chat/backtrack.js';
import { computeUndo } from '../chat/undo.js';
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
import { ChatAutocompleteProvider } from './completion.js';
import { clipboardToolHint, readClipboardImage } from '../chat/clipboardImage.js';
import { extractImageContent, ImageAttachmentStore } from '../chat/imageAttachment.js';
import { modelItems, modelTabs, showPicker, sessionItems, thinkItems } from './pickers.js';
import { StreamBuffer } from '../chat/streamBuffer.js';
import { InlineApproval, PlanApproval, QuestionPrompt, type ApprovalOutcome, type PlanOutcome } from './prompts.js';
import type { AskUserRequest, QuestionAnswers } from '../tools/askUser.js';
import { ChatEditor } from './ChatEditor.js';
import { ActivityLine, StatusLine } from './StatusLine.js';
import { Transcript } from './Transcript.js';
import { c, editorTheme } from './theme.js';

/** PiChat 的构造依赖。字段与 Ink 版 AppProps 一一对应，便于 cli 侧共用同一套装配。 */
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

export class PiChat {
  private readonly deps: PiChatDeps;
  private readonly tui: TuiMainScreen;
  private readonly transcript = new Transcript();
  private readonly activity = new ActivityLine();
  private readonly status: StatusLine;
  private readonly editor: ChatEditor;
  private readonly completion: ChatAutocompleteProvider;
  /** 审批等弹层的挂载点：常驻容器，内容按需增删（组件树形状不随消息变化）。 */
  private readonly overlayHost = new Container();

  private readonly history: StoredMessage[] = [];
  private session: SessionData;
  /** 运行期可变：/new 与 /fork 换绑到新会话的任务目录。 */
  private background = new BackgroundManager();
  private readonly todos: { items: import('../tools/types.js').TodoStore['items'] } = { items: [] };
  private readonly sessionApprovals = new Set<string>();
  /** 自主目标（会话级）：跨轮持有，active 时回合收尾自动续跑。 */
  private readonly goal = new GoalMode();
  /**
   * 定时任务（cwd 级，不属于单个会话）。
   *
   * 调度器是纯内存引擎，持久化叠在这一层：create/delete 走 onJobChange 落盘，
   * 触发后 recurring 补写新游标、一次性任务直接清盘。
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
  private thinkingAccum = '';
  private baseTokens = 0;
  private exitPrimed = false;
  private exitPrimedTimer: ReturnType<typeof setTimeout> | undefined;
  private ticker: ReturnType<typeof setInterval> | undefined;
  private resolveExit: ((info: PiChatExit) => void) | undefined;
  /** 弹层（审批/计划/提问）激活中：暂停 spinner，用户此时在读弹层，动画只是噪声与无谓重绘。 */
  private promptActive = false;

  constructor(deps: PiChatDeps) {
    this.deps = deps;
    this.session = deps.session;
    this.provider = deps.provider;
    this.model = deps.model;
    this.maxContextSize = deps.maxContextSize;
    // 恢复会话时 session.model 存的是「别名 ?? 裸 id」，命中别名则按它重建（与 Ink 版 persist 口径一致）
    const sessionAlias = deps.config.models?.[deps.session.model] !== undefined ? deps.session.model : undefined;
    this.currentAlias = sessionAlias;
    this.modelLabel = (sessionAlias !== undefined ? deps.config.models?.[sessionAlias]?.displayName : undefined) ?? deps.model;
    this.thinkOverride = deps.session.thinkOverride;
    this.defaultModelPointer = deps.config.modelAlias ?? deps.config.model;
    this.mode = deps.initialMode;
    this.planMode = deps.session.planMode ?? false;
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
    // Ctrl+V 读剪贴板图片。busy 时也允许：只往输入框草稿追加占位符，不碰在跑的回合
    // （提交走排队路径，drain 时统一展开成图）。
    this.editor.onCtrlV = () => {
      void this.attachClipboardImage();
      return true;
    };
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
    );
    this.cron.onJobChange = (kind, job) => {
      if (kind === 'create') void this.cronStore.save(this.deps.ctx.cwd, job);
      else void this.cronStore.remove(this.deps.ctx.cwd, job.id);
    };
    // 恢复本 cwd 的任务表；stale 任务由 restore 剔除，这里补清盘
    const staleIds = this.cron.restore(this.cronStore.load(deps.ctx.cwd));
    for (const id of staleIds) void this.cronStore.remove(deps.ctx.cwd, id);

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

    this.tui.addChild(this.transcript);
    this.tui.addChild(this.activity);
    this.tui.addChild(this.overlayHost);
    this.tui.addChild(this.editor);
    this.tui.addChild(this.status);
    this.tui.setFocus(this.editor);
  }

  /** 启动 TUI，返回的 Promise 在退出时 resolve。 */
  start(): Promise<PiChatExit> {
    // 欢迎框是第一个条目（新建与 resume 都显示，与 Ink 版 WelcomeBox 同语义）：
    // 放 replayHistory 之前，恢复会话时它也在历史回放之上。
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
      this.status.setState({ goalTurns: undefined });
    }
    if (this.deps.configStartupNotice !== undefined) {
      this.push({ kind: 'note', text: this.deps.configStartupNotice });
    }
    this.tui.start();
    // @ 文件补全的索引：后台扫 cwd，不阻塞首帧。扫完前 @ 补全为空（优雅降级），
    // 失败也降级为空索引，不影响命令补全。
    void scanFileIndex(this.deps.ctx.cwd)
      .then((files) => this.completion.setFiles(files))
      .catch(() => this.completion.setFiles([]));
    // spinner 与 running 态计时：只在 busy 时真正推进（idle 时 render 返回空行，无写入）
    this.ticker = setInterval(() => {
      if (!this.busy || this.promptActive) return;
      this.activity.tick();
      this.tui.requestRender();
    }, 120);
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
    this.status.setState({
      mode: this.mode,
      model: this.modelLabel,
      thinking: this.thinkOverride,
      maxContextSize: this.maxContextSize,
      planMode: this.planMode,
      busy: this.busy,
      queueLen: this.queue.length,
      backgroundCount: this.background.list().filter((t) => t.status === 'running').length,
    });
  }

  /** 持久化。顺序不变量与 Ink 版一致：先 appendFull 再 save（wireSeq 游标一致性）。 */
  private persist(): void {
    this.session.messages = this.history;
    this.session.todos = [...this.todos.items];
    this.session.mode = this.mode;
    this.session.model = this.currentAlias ?? this.model;
    this.session.thinkOverride = this.thinkOverride;
    this.session.planMode = this.planMode;
    // goal 与 team 快照随会话落盘（无值时清掉旧字段，否则 resume 会复活已结束的目标）
    this.session.goal = this.goal.snapshot() ?? undefined;
    this.session.team = this.team.snapshot() ?? undefined;
    try {
      this.deps.store.appendFull(this.session.cwd, this.session.id, this.history);
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
  }

  // ---------------------------------------------------------------- 输入路由

  /**
   * Esc 三态（与 Ink 版 E3 语义一致）：
   *   1. 审批/弹层激活时由弹层自己消费，走不到这里；
   *   2. busy → 中断当前回合；
   *   3. 空闲 + 队列非空 → 取回队列内容进输入框。
   * 返回 true 表示已消费。
   */
  private onEscape(): boolean {
    if (this.busy) {
      this.controller?.abort();
      return true;
    }
    if (this.queue.length > 0) {
      const merged = this.queue.join('\n');
      this.queue = [];
      const cur = this.editor.getText();
      this.editor.setText(cur === '' ? merged : `${cur}\n${merged}`);
      this.push({ kind: 'note', text: '已把排队消息取回输入框' });
      this.syncStatus();
      return true;
    }
    return false;
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
      this.controller?.abort();
      return true;
    }
    if (this.exitPrimed) {
      this.exit();
      return true;
    }
    if (this.editor.getText() !== '') this.editor.setText('');
    this.exitPrimed = true;
    this.push({ kind: 'note', text: '再按一次 Ctrl+C 退出' });
    this.exitPrimedTimer = setTimeout(() => {
      this.exitPrimed = false;
    }, 5000);
    return true;
  }

  private exit(): void {
    if (this.exitPrimedTimer !== undefined) clearTimeout(this.exitPrimedTimer);
    if (this.ticker !== undefined) clearInterval(this.ticker);
    this.cron.stop();
    this.persist();
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
    this.editor.addToHistory(text);

    if (text.startsWith('/')) {
      await this.handleSlash(text);
      return;
    }
    if (this.busy) {
      // goal 自主推进期间的普通留言走 steer，不进队列：队列消息会作为独立一轮发出，
      // 那样会打断目标推进。steer 拼进下一个自主轮的注入文本，模型继续目标的同时看到留言。
      if (this.goal.get()?.status === 'active') {
        this.steers.push(text);
        this.push({ kind: 'note', text: '已记下，会在目标的下一轮里一起看到' });
        return;
      }
      // busy 时提交进队列，回合收尾自动续发（对齐 Ink 版发送队列语义）
      this.queue.push(text);
      this.syncStatus();
      this.push({ kind: 'note', text: `已排队（${this.queue.length} 条），回合结束后自动发送` });
      return;
    }
    await this.runTurn(text);
  }

  /**
   * 斜杠命令入口：解析 → busy 分流 → 执行。
   *
   * 命令名与别名表直接复用 Ink 版的 `SLASH_COMMANDS`（`src/chat/commands.ts` 是纯逻辑，
   * 不 import react），两版共用一张表，命令集与别名不会漂移。`busyRoute` 决定回合
   * 进行中是即时执行还是排队到回合边界，判据是该命令是否改动当前 turn 依赖的状态。
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
      this.queue.push(raw.trim());
      this.syncStatus();
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
        this.push({ kind: 'note', text: formatTaskList(this.background.list(), Date.now()) });
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
        await this.pickSubagent();
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
    this.push({ kind: 'note', text: '正在读剪贴板图片…' });
    const { image, formats } = await readClipboardImage();
    if (image === null) {
      const hint = clipboardToolHint();
      if (hint !== null) {
        this.push({ kind: 'note', text: hint });
      } else if (formats !== null && formats !== '' && formats !== '<empty>') {
        const shown = formats.length > 200 ? `${formats.slice(0, 200)}…` : formats;
        this.push({ kind: 'note', text: `剪贴板里没有图片。当前格式：${shown}` });
      } else {
        this.push({ kind: 'note', text: '剪贴板里没有图片' });
      }
      return;
    }
    const att = this.images.add(image.base64, image.mediaType, image.width, image.height);
    const cur = this.editor.getText();
    this.editor.setText((cur === '' || cur.endsWith(' ') ? cur : `${cur} `) + att.placeholder);
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
      this.status.setState({ goalTurns: undefined });
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
    // 徽标只在 active 时显示：paused/blocked 的目标不会自动续跑，挂个数字会误导
    this.status.setState({ goalTurns: g.status === 'active' ? g.turnsUsed : undefined });
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
   * 不做 Ink 版的渠道向导（`/provider add` 是多步表单，属独立交互块）；
   * 无参也不开管理面板，直接给只读清单，比弹一个只能看的面板更直接。
   */
  private runProvider(args: string): void {
    const arg = args.trim();
    if (arg === 'add' || arg.startsWith('add ')) {
      this.push({
        kind: 'note',
        text: '渠道向导（/provider add）在 pi 版尚未接线。手动改 ~/.step-code/config.toml 的 [providers] 段后用 /reload 生效',
      });
      return;
    }
    if (arg === '' || arg === 'list') {
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
    this.deps.ctx.searchConfig = next.search;
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
   * 与 Ink 版的一处实差：Ink 版另有一套 undo 快照栈，能把 todos 与计划模式一起回滚到
   * 那一轮之前；pi 版没有这个栈，所以附带状态保持现状（Ink 版在快照被清空时也是这个
   * 行为，比如 resume 或压缩之后）。
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
      const picked = await showPicker(this.tui, {
        title: '回退到哪一条输入之前',
        items: turns.map((t) => ({
          value: String(t.turns),
          label: t.label === '' ? '（空输入）' : t.label,
          description: t.turns === 1 ? '撤销最近 1 轮' : `撤销最近 ${t.turns} 轮`,
        })),
        hint: '↑↓ 选择 · Enter 回退 · 输入过滤 · Esc 取消',
      });
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
          text: `已撤销最近 ${result.removedTurns} 轮，丢弃 ${removed} 条消息（文件改动不受影响，回滚文件用 /restore）`,
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
      const picked = await showPicker(this.tui, {
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
   * /agents：列出当前会话派生的子 agent 会话。
   *
   * Ink 版选中后在弹层里只读回看完整历史。pi 版这一步只给摘要与进入方式：
   * 把子会话历史铺进当前转录区会盖掉主会话现场，而弹层滚动浏览是独立一块交互，
   * 不在这次范围内。
   */
  private async pickSubagent(): Promise<void> {
    const subs = this.deps.subagentStore.list(this.deps.ctx.cwd).filter((m) => m.parentId === this.session.id);
    if (subs.length === 0) {
      this.push({ kind: 'note', text: '本会话还没有派生过子 agent' });
      return;
    }
    const picked = await showPicker(this.tui, {
      title: '本会话的子 agent',
      items: subs.map((m) => ({
        value: m.id,
        label: `${m.agentType ?? 'general'} · ${m.name ?? m.title ?? m.id}`,
        description: `${m.status ?? '未知'} · ${m.messageCount} 条 · ${m.id.slice(0, 8)}`,
      })),
      hint: '↑↓ 选择 · Enter 看摘要 · 输入过滤 · Esc 取消',
    });
    if (picked === null) return;
    const meta = subs.find((m) => m.id === picked);
    this.push({
      kind: 'note',
      text:
        `子 agent ${picked}\n` +
        `类型 ${meta?.agentType ?? 'general'} · 状态 ${meta?.status ?? '未知'} · ${meta?.messageCount ?? 0} 条消息\n` +
        `任务：${meta?.name ?? meta?.title ?? meta?.preview ?? '（无描述）'}\n` +
        `完整历史用 step-code --session ${picked} 打开（只读回看）`,
    });
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
    this.todos.items = [];
    this.subagentCounter.spawned = 0;
    this.sessionApprovals.clear();
    this.images.clear();
    // 新会话 model 存别名（同 persist 口径），避免真实 id 被启动时的别名反查误判
    this.session = this.deps.store.create(this.deps.ctx.cwd, this.currentAlias ?? this.model);
    this.rebindBackground();
    this.planMode = false;
    this.prePlanMode = null;
    this.thinkOverride = undefined;
    // 新会话不继承 goal 与 team（两者都是会话级状态，随会话落盘）
    this.goal.restore(null);
    this.team.deactivate();
    this.steers = [];
    this.continuation = null;
    this.status.setState({ goalTurns: undefined, teamActive: false });
    // context 用量归零：history 已清空，但基准仍是上一会话的值，不重置会继续显示旧占用
    this.baseTokens = 0;
    this.status.setState({ usedTokens: 0 });
    this.transcript.reset([{ kind: 'note', text: `已开始新会话 ${this.session.id}` }]);
    this.syncStatus();
    this.tui.requestRender();
  }

  /** 从当前最新点整会话复制：新 id + forkedFrom 记谱系，源会话不动。 */
  private forkSession(): void {
    this.persist();
    const src = this.session;
    const forked = this.deps.store.create(this.deps.ctx.cwd, this.currentAlias ?? this.model);
    forked.forkedFrom = src.id;
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
    this.status.setState({ goalTurns: undefined, teamActive: false });
    this.session = forked;
    this.rebindBackground();
    this.persist();
    this.push({
      kind: 'note',
      text: `已分叉：${src.id} → ${forked.id}（${this.history.length} 条消息）`,
    });
    this.syncStatus();
  }

  /** 后台任务管理器换绑当前会话（任务落盘目录随会话 id 走）。 */
  private rebindBackground(): void {
    this.background = new BackgroundManager(10, {
      taskTimeoutS: this.deps.config.background?.bashTaskTimeoutS ?? 600,
      tasksDir: this.deps.store.tasksDirFor(this.session.cwd, this.session.id),
      onSettleEvent: (task) => this.appendWire({ type: 'background.task_settle', ts: new Date().toISOString(), task }),
    });
  }

  // ---------------------------------------------------------------- 耗时命令

  /**
   * 上下文压缩。要等一次完整摘要请求（长历史可达数十秒），因此挂上 controller 让 Esc
   * 能中断——复用回合中断的同一通道，Esc 的三态优先级自动适用。
   */
  private async runCompact(): Promise<void> {
    if (this.busy) return;
    // 短历史直接挡在门外：fullCompact 对 length - keepRecent <= 1 的输入原样返回同引用，
    // 与「摘要请求失败」走同一出口。Ink 版据此打「多次尝试均未产出可用摘要」，
    // 但这种情况下一次请求都没发过——文案指向了不存在的失败。这里先判长度，给准确原因。
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
      const compaction = resolveCompactionBinding(this.deps.config);
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
        this.appendWire({ type: 'context.apply_compaction', ts: new Date().toISOString(), messages: [...compacted] });
        const after = estimateTokens(this.history);
        // 状态栏 context 用量立即回落：after 是压缩后全量估算，基准必须一起更新，
        // 否则后续重算会用回压缩前的真实 usage，看起来像没压。
        this.baseTokens = after;
        this.status.setState({ usedTokens: after });
        this.persist();
        // after >= before 的情况真实存在：摘要本身要占 token，短对话下它可能比被替换的
        // 原文更长。Ink 版无条件打「已压缩：X → Y」，用户看到 Y 比 X 大只会以为程序算错了。
        // 这里分开说，并给出真正能腾空间的动作。
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
    const plan = planTurnEnd({
      continuation: this.continuation,
      goalActive,
      queue: this.queue,
      hasPendingPrompt: this.promptActive,
    });
    this.queue = plan.queueRemainder;
    this.syncStatus();
    if (plan.action === 'idle') return;
    if (plan.action === 'submit-queue') {
      const text = plan.text ?? '';
      // 队列里可能混着排队的斜杠命令（busyRoute 判为 queue 的那些）
      if (text.startsWith('/')) await this.handleSlash(text);
      else await this.runTurn(text);
      return;
    }
    // submit-continuation：goal 仍 active 时把 steer 留言拼进注入文本；
    // goal 已结束（assemble 返回 null）退化为原始续接文本，对应 Stop hook 的续行兜底。
    const raw = this.continuation ?? '';
    this.continuation = null;
    const text = goalActive ? assembleGoalInject(this.goal, raw, this.steers.splice(0)) : null;
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
    this.model = resolved.model;
    this.modelLabel = this.deps.config.models?.[arg]?.displayName ?? resolved.model;
    this.maxContextSize = resolved.maxContextSize;
    this.syncStatus();
    this.persist();
    persistPointer();
    this.push({ kind: 'note', text: `已切换到 ${arg}（${resolved.model}）` });
  }

  /** 恢复指定会话：重建历史与转录区，模型跟随该会话当初的选择。 */
  private resumeSession(id: string): void {
    const data = this.deps.store.load(this.deps.ctx.cwd, id);
    if (data === null) {
      this.push({ kind: 'note', text: `没找到会话 ${id}` });
      return;
    }
    this.persist();
    this.session = data;
    this.history.length = 0;
    this.history.push(...data.messages);
    this.mode = data.mode ?? this.mode;
    this.planMode = data.planMode ?? false;
    this.thinkOverride = data.thinkOverride;
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
    this.status.setState({ goalTurns: resumedGoal?.status === 'active' ? resumedGoal.turnsUsed : undefined });
    if (data.model !== '' && data.model !== this.currentAlias) {
      this.applyModel(data.model, { persistDefault: false });
    }
    const replay = historyToDisplayItems(data.messages);
    this.transcript.reset(
      [
        ...replay.items,
        {
          kind: 'note',
          text:
            `已切换到会话 ${data.id}（${replay.totalTurns} 轮 / ${data.messages.length} 条消息）` +
            (resumedGoal !== null ? `
该会话有目标「${resumedGoal.objective}」，已暂停，用 /goal resume 继续` : ''),
        },
      ],
      replay.foldedTurns,
    );
    this.syncStatus();
    this.tui.invalidate();
    this.tui.renderNow(true);
  }

  private async pickModel(): Promise<void> {
    const items = modelItems(this.deps.config, this.currentAlias);
    if (items.length === 0) {
      this.push({ kind: 'note', text: '配置里没有 [models.*] 别名，先用 /model <模型 id> 直切' });
      return;
    }
    const tabs = modelTabs(this.deps.config);
    const picked = await showPicker(this.tui, {
      title: '选择模型',
      items,
      hint:
        tabs.length > 1
          ? '↑↓ 选择 · Enter 确认 · Shift+Enter 仅本会话 · Tab 切渠道 · 输入过滤 · Esc 取消'
          : '↑↓ 选择 · Enter 确认 · Shift+Enter 仅本会话 · 输入过滤 · Esc 取消',
      tabs,
      itemsForTab: (tabId) => modelItems(this.deps.config, this.currentAlias, tabId),
      // Shift+Enter = 仅本会话生效，不写回默认模型指针（Ink 版 sessionOnly 同语义）
      onShiftSelect: (value) => this.applyModel(value, { persistDefault: false }),
    });
    if (picked !== null) this.applyModel(picked);
  }

  private async pickSession(): Promise<void> {
    const metas = this.deps.store.list(this.deps.ctx.cwd).filter((m) => m.parentId === undefined);
    if (metas.length === 0) {
      this.push({ kind: 'note', text: '本目录还没有历史会话' });
      return;
    }
    const picked = await showPicker(this.tui, {
      title: '恢复会话',
      items: sessionItems(metas),
      hint: '↑↓ 选择 · Enter 恢复 · 输入过滤 · Esc 取消',
    });
    if (picked !== null) this.resumeSession(picked);
  }

  private async pickThink(): Promise<void> {
    const picked = await showPicker(this.tui, {
      title: '思考深度',
      items: thinkItems(this.thinkOverride),
      hint: '↑↓ 选择 · Enter 确认 · Esc 取消',
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
        this.goal.incrementTurn();
        this.status.setState({ goalTurns: this.goal.get()?.turnsUsed });
        return { inject: d.inject };
      },
      authorizeToolCall: async (req) => {
        // plan 模式守卫：写与执行一律拒（exit_plan_mode 例外，走下方确认）
        if (this.planMode) {
          const deny = planModeDenyReason(req.name);
          if (deny !== null) return { decision: 'deny', reason: deny };
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
        if (outcome.kind === 'allow') return { decision: 'allow' };
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
   * 弹层挂载的统一路径：把块挂进常驻 overlayHost、焦点交给它，结算后恢复编辑器焦点。
   * 三桥（工具审批 / 计划确认 / 向用户提问）共用，弹层互斥由「同一个 host 只放一个」保证——
   * 这比 Ink 版靠 9 个 useInput 早退分支实现互斥要短得多。
   */
  private showPrompt<T>(make: (settle: (value: T) => void) => Component): Promise<T> {
    return new Promise<T>((resolve) => {
      const block = make((value) => {
        this.promptActive = false;
        this.activity.setTip('');
        this.overlayHost.clear();
        this.tui.setFocus(this.editor);
        this.tui.requestRender();
        resolve(value);
      });
      this.promptActive = true;
      this.activity.setTip('等待你确认');
      this.overlayHost.clear();
      this.overlayHost.addChild(block);
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
  private async runTurn(text: string, opts?: { silent?: boolean }): Promise<void> {
    // 图片占位符 → image content block。没有图片时 content 就是原文本（走旧路径），
    // 转录区显示的是折叠掉占位符的正文，不把 base64 摊到屏幕上。
    const extracted = extractImageContent(text, this.images);
    if (opts?.silent !== true) {
      this.push({
        kind: 'user',
        text: extracted.imageCount > 0 ? `${extracted.displayText} [${extracted.imageCount} 张图]` : text,
      });
    }
    this.history.push(
      stored({ role: 'user', content: extracted.content }, { kind: opts?.silent === true ? 'injection' : 'user' }),
    );

    this.busy = true;
    this.activity.setBusy(true);
    this.syncStatus();
    this.tui.requestRender();

    const controller = new AbortController();
    this.controller = controller;
    const hooks = this.buildHooks();
    const compaction = resolveCompactionBinding(this.deps.config);
    const runSubagent = createSubagentRunner({
      provider: this.provider,
      cwd: this.deps.ctx.cwd,
      apiKey: this.deps.ctx.apiKey,
      baseUrl: this.deps.ctx.baseUrl,
      capabilities: this.deps.ctx.capabilities,
      config: this.deps.config,
      hooks,
      maxDepth: this.deps.config.subagent.maxDepth,
      maxStepsDefault: this.deps.config.subagent.maxSteps,
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
      onEvent: (_id, ev) => {
        if (ev.kind === 'start') this.activity.setTip(`子 agent ${ev.subagentType}：${ev.description}`);
        if (ev.kind === 'end') this.activity.setTip('');
      },
    });

    const system =
      this.deps.systemPrefix +
      skillListing(this.deps.skillsRef.current) +
      subagentListing([...this.deps.subagentRegistry.values()]) +
      (this.deps.agentsMd !== '' ? `\n\n${this.deps.agentsMd}` : '');

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
          todos: this.todos,
          background: this.background,
          goal: this.goal,
          team: this.team,
          cron: this.cron,
          askUser: (req) => this.askUserQuestion(req),
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
        todos: this.todos.items,
        injectBackgroundNotifications: true,
        onWireEvent: (event) => this.appendWire(event),
      })) {
        this.streamBuffer.ingest(ev);
      }
    } catch (e) {
      this.streamBuffer.drain();
      this.applyEvent({ type: 'error', message: (e as Error).message });
    } finally {
      this.streamBuffer.drain();
      this.controller = null;
      this.busy = false;
      this.activity.setBusy(false);
      this.activity.setTip('');
      this.syncStatus();
      this.persist();
      this.tui.requestRender();
      // 队列续发：回合收尾后自动发下一条（对齐 Ink 版 drain 语义）。
      // 队列里可能混着排队的斜杠命令（busyRoute 判为 queue 的那些），
      // 统一走 drainQueue 分流，否则命令会被当成普通消息发给模型。
      await this.finishTurn();
    }
  }

  // ---------------------------------------------------------------- 事件应用

  /** AgentEvent → 转录区变更。逻辑对齐 Ink 版 applyEvent，去掉 React setState 的批处理考虑。 */
  private applyEvent(ev: AgentEvent): void {
    if (ev.type === 'thinking_start') {
      this.activity.setThinking(true);
      this.tui.requestRender();
      return;
    }
    if (ev.type === 'thinking_delta') {
      this.thinkingAccum += ev.text;
      this.activity.setThinking(true, this.thinkingAccum);
      this.activity.addOutputChars(ev.text.length);
      this.tui.requestRender();
      return;
    }
    // 任何非思考事件到来 = 思考块结束：已累积的思考落成定稿块
    this.activity.setThinking(false);
    if (this.thinkingAccum !== '') {
      const text = this.thinkingAccum;
      this.thinkingAccum = '';
      this.transcript.push({ kind: 'thinking', text });
    }
    if (ev.type === 'thinking_end') {
      this.tui.requestRender();
      return;
    }

    switch (ev.type) {
      case 'text': {
        this.activity.addOutputChars(ev.text.length);
        const last = this.transcript.lastItem();
        if (last !== undefined && last.kind === 'assistant') {
          this.transcript.update(-1, { kind: 'assistant', text: last.text + ev.text });
        } else {
          this.transcript.push({ kind: 'assistant', text: ev.text });
        }
        break;
      }
      case 'tool_start':
        this.transcript.push({
          kind: 'tool',
          id: ev.id,
          name: ev.name,
          input: ev.input,
          status: 'running',
          startedAt: Date.now(),
        });
        break;
      case 'tool_end':
        this.transcript.updateLastWhere(
          (it) => it.kind === 'tool' && it.id === ev.id,
          (it) => ({ ...(it as Extract<DisplayItem, { kind: 'tool' }>), status: ev.isError ? 'error' : 'ok', result: ev.result }),
        );
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
      case 'usage':
        this.baseTokens = ev.totalTokens;
        this.status.setState({ usedTokens: this.baseTokens });
        break;
      case 'aborted':
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
    return [this.transcript, this.activity, this.overlayHost, this.editor, this.status];
  }
}

export { c as piColors };
