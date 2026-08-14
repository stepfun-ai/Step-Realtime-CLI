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
import { subagentListing } from '../agent/systemPrompt.js';
import { resolveModelEntry, saveDefaultModel, type StepCodeConfig } from '../config/config.js';
import { createProvider } from '../provider/factory.js';
import type { ChatProvider } from '../provider/types.js';
import { resolveCompactionBinding } from '../provider/compaction.js';
import type { SessionData, SessionStore } from '../session/store.js';
import { skillListing, type SkillRegistry } from '../skill/registry.js';
import type { ToolContext } from '../tools/types.js';
import type { DisplayItem } from '../tui/types.js';
import { historyToDisplayItems } from '../tui/historyReplay.js';
import { parseThinkArgs, thinkLevelsOf, thinkStreamParam, type ThinkOverride } from '../tui/thinkCommand.js';
import { modelItems, showPicker, sessionItems, thinkItems } from './pickers.js';
import { StreamBuffer } from '../tui/streamBuffer.js';
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
  configStartupNotice?: string;
}

/** 退出信息：交给 cli 打印 resume 提示。 */
export interface PiChatExit {
  sessionId: string;
  hasContent: boolean;
}

const HINTS = 'Enter 发送 · Esc 中断 · Ctrl+C 退出 · /help 命令';

export class PiChat {
  private readonly deps: PiChatDeps;
  private readonly tui: TuiMainScreen;
  private readonly transcript = new Transcript();
  private readonly activity = new ActivityLine();
  private readonly status: StatusLine;
  private readonly editor: ChatEditor;
  /** 审批等弹层的挂载点：常驻容器，内容按需增删（组件树形状不随消息变化）。 */
  private readonly overlayHost = new Container();

  private readonly history: StoredMessage[] = [];
  private session: SessionData;
  private readonly background = new BackgroundManager();
  private readonly todos: { items: import('../tools/types.js').TodoStore['items'] } = { items: [] };
  private readonly sessionApprovals = new Set<string>();
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
    this.editor.onSubmit = (text) => {
      void this.onSubmit(text);
    };
    this.editor.onEscapeKey = () => this.onEscape();
    this.editor.onCtrlC = () => this.onCtrlC();

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
    this.replayHistory();
    if (this.deps.configStartupNotice !== undefined) {
      this.push({ kind: 'note', text: this.deps.configStartupNotice });
    }
    this.tui.start();
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
    try {
      this.deps.store.appendFull(this.session.cwd, this.session.id, this.history);
      this.deps.store.save(this.session);
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
    this.persist();
    this.tui.stop();
    this.resolveExit?.({ sessionId: this.session.id, hasContent: this.history.length > 0 });
    this.resolveExit = undefined;
  }

  // ---------------------------------------------------------------- 提交

  private async onSubmit(raw: string): Promise<void> {
    const text = raw.trim();
    this.editor.setText('');
    if (text === '') return;
    this.editor.addToHistory(text);

    if (text.startsWith('/')) {
      await this.handleSlash(text);
      return;
    }
    if (this.busy) {
      // busy 时提交进队列，回合收尾自动续发（对齐 Ink 版发送队列语义）
      this.queue.push(text);
      this.syncStatus();
      this.push({ kind: 'note', text: `已排队（${this.queue.length} 条），回合结束后自动发送` });
      return;
    }
    await this.runTurn(text);
  }

  private async handleSlash(cmd: string): Promise<void> {
    const name = cmd.slice(1).split(/\s+/)[0] ?? '';
    switch (name) {
      case 'exit':
      case 'quit':
        this.exit();
        return;
      case 'help':
        this.push({
          kind: 'note',
          text: [
            '可用命令：',
            '  /help    显示本清单',
            '  /new     开新会话（清空当前上下文）',
            '  /clear   清屏（保留会话历史）',
            '  /plan    开关计划模式（只读调查 → 提交计划 → 确认后执行）',
            '  /model   切换模型（无参开选择器）',
            '  /resume  恢复历史会话（无参开选择器）',
            '  /think   思考深度（无参开选择器）',
            '  /exit    退出',
            '',
            '快捷键：Enter 发送 · Esc 中断/取回队列 · Ctrl+C 退出 · Shift+Enter 换行',
            '（其余命令在 M4 接线）',
          ].join('\n'),
        });
        return;
      case 'new': {
        this.history.length = 0;
        this.transcript.reset([{ kind: 'note', text: '已开始新的上下文' }]);
        this.baseTokens = 0;
        this.status.setState({ usedTokens: 0 });
        this.tui.requestRender();
        return;
      }
      case 'model': {
        const arg = cmd.slice(1).split(/\s+/).slice(1).join(' ').trim();
        if (arg === '') await this.pickModel();
        else this.applyModel(arg);
        return;
      }
      case 'resume': {
        const arg = cmd.slice(1).split(/\s+/).slice(1).join(' ').trim();
        if (arg === '') await this.pickSession();
        else this.resumeSession(arg);
        return;
      }
      case 'think': {
        const arg = cmd.slice(1).split(/\s+/).slice(1).join(' ').trim();
        if (arg === '') {
          await this.pickThink();
          return;
        }
        const parsed = parseThinkArgs(arg);
        if (parsed.kind === 'invalid') {
          this.push({ kind: 'note', text: `未知的思考档位：${parsed.name}（可用 low / medium / high / off）` });
          return;
        }
        if (parsed.kind === 'show') {
          this.push({ kind: 'note', text: `当前思考深度：${this.thinkOverride ?? '跟随配置默认'}` });
          return;
        }
        this.thinkOverride = parsed.override;
        this.syncStatus();
        this.persist();
        this.push({ kind: 'note', text: `思考深度：${parsed.override}` });
        return;
      }
      case 'plan': {
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
        return;
      }
      case 'clear':
        this.transcript.reset([]);
        this.tui.invalidate();
        this.tui.renderNow(true);
        return;
      default:
        this.push({ kind: 'note', text: `暂未接线的命令：${cmd}（M4 接线全量命令集）` });
    }
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
    if (data.model !== '' && data.model !== this.currentAlias) {
      this.applyModel(data.model, { persistDefault: false });
    }
    const replay = historyToDisplayItems(data.messages);
    this.transcript.reset(
      [
        ...replay.items,
        {
          kind: 'note',
          text: `已切换到会话 ${data.id}（${replay.totalTurns} 轮 / ${data.messages.length} 条消息）`,
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
    const picked = await showPicker(this.tui, { title: '选择模型', items });
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
    this.thinkOverride = picked === '__default__' ? undefined : picked;
    this.syncStatus();
    this.persist();
    this.push({
      kind: 'note',
      text: this.thinkOverride === undefined ? '思考深度改为跟随配置默认' : `思考深度：${this.thinkOverride}`,
    });
  }

  // ---------------------------------------------------------------- 回合执行

  private buildHooks(): LoopHooks {
    const base: LoopHooks = {
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

  private async runTurn(text: string): Promise<void> {
    this.push({ kind: 'user', text });
    this.history.push(stored({ role: 'user', content: text }, { kind: 'user' }));

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
      // 队列续发：回合收尾后自动发下一条（对齐 Ink 版 drain 语义）
      const next = this.queue.shift();
      if (next !== undefined) {
        this.syncStatus();
        await this.runTurn(next);
      }
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
