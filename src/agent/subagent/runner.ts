import type Anthropic from '@anthropic-ai/sdk';
import { sep } from 'node:path';
import type { ChatProvider } from '../../provider/types.js';
import { allToolNames } from '../../tools/index.js';
import { resolvePath as resolveToolPath } from '../../tools/fsutil.js';
import { checkBashWrite } from '../../tools/bashWriteGuard.js';
import type { ToolContext } from '../../tools/types.js';
import type { CompactionThresholds } from '../compaction/compact.js';
import type { SubagentProgressEvent } from '../events.js';
import type { LoopHooks } from '../hooks.js';
import { runAgent } from '../loop.js';
import { stored, type StoredMessage } from '../message.js';
import { skillListing, type SkillRegistry } from '../../skill/registry.js';
import type { SessionData } from '../../session/store.js';
import { resolveModelEntry, type StepCodeConfig } from '../../config/config.js';
import { createProvider } from '../../provider/factory.js';
import { buildAgentRegistry } from './registry.js';
import { closeDanglingToolUse } from '../wirelog.js';
import { timeSection } from '../nowContext.js';
import { memorySection, scanMemory } from '../memory.js';
import type { SubagentStore } from './store.js';
import type { AgentDefinition, RunSubagentFn, SpawnSubagentRequest, SubagentResult } from './types.js';

const SUMMARY_MIN_LEN = 200;
const SPAWN_TOOL = 'spawn_agent';

/**
 * per-worker 写根约束包装：在 team 多 worker 协作模式下，每个 worker 被分配一个独立的
 * git worktree 作为工作间（allowRoot），此函数包装工具授权钩子，确保 worker 只能写
 * 自己的工作间。
 *
 * 为什么需要拦 bash：
 * write_file / edit_file 的参数里有显式 path 字段，检查它是否在 allowRoot 内即可。
 * 但 bash 工具的参数是一整条命令字符串，写入目标藏在命令里——
 * `echo x > /主仓/foo.ts`、`cp a /主仓/b.ts`、`sed -i ... /主仓/c.ts` 都能绕过
 * write_file 的拦截。如果不拦 bash，范围互斥就只剩 team_merge 合并时的事后 diff
 * 检查兜底——而 2026-08-12 实测中曾有一个 worker 通过 bash 重定向写到了工作间外。
 *
 * checkBashWrite 做什么：扫描命令字符串，找出重定向、cp/mv/rm/tee/sed -i/dd/truncate
 * 等写入语法，检查目标路径是否在 allowRoot 内。git 子命令（add/commit）和 npm/npx
 * 一律判为无写入迹象放行——worker 要在工作间里提交，不能误拦。接线前用 21 条 worker
 * 典型命令验证过误报面。
 */
export function wrapWriteGuard(
  base: NonNullable<LoopHooks['authorizeToolCall']>,
  cwd: string,
  writeAllowRoot: string,
): NonNullable<LoopHooks['authorizeToolCall']> {
  const allowRoot = resolveToolPath(cwd, writeAllowRoot);
  return async (subReq) => {
    if (subReq.name === 'write_file' || subReq.name === 'edit_file') {
      const p = (subReq.input as { path?: unknown } | undefined)?.path;
      if (typeof p === 'string') {
        const abs = resolveToolPath(cwd, p);
        if (abs !== allowRoot && !abs.startsWith(allowRoot + sep)) {
          return {
            decision: 'deny',
            reason: `你的写操作被限制在本任务工作间内（${allowRoot}）。请使用该目录下的路径。`,
          };
        }
      }
    }
    if (subReq.name === 'bash') {
      const cmd = (subReq.input as { command?: unknown } | undefined)?.command;
      if (typeof cmd === 'string') {
        const verdict = checkBashWrite(cmd, cwd, allowRoot);
        if (!verdict.ok) {
          return {
            decision: 'deny',
            reason:
              `${verdict.reason} 你的写操作被限制在本任务工作间内（${allowRoot}）。` +
              (verdict.tier === 'B'
                ? '请把写入目标改写成该目录下的显式路径后重试。'
                : '请改用该目录下的路径。'),
          };
        }
      }
    }
    return base(subReq);
  };
}

/** 会话级共享计数器：跨轮（跨 runner 实例）累计单会话的子 agent 派生数。 */
export interface SubagentSessionCounter {
  spawned: number;
}

export interface SubagentRunnerDeps {
  provider: ChatProvider;
  cwd: string;
  apiKey?: string;
  baseUrl?: string;
  /** 当前模型的能力标记（如 image_in，来自别名 capabilities）：子 agent 与父 agent 同模型，原样继承。 */
  capabilities?: readonly string[];
  /** 图片输入长边上限与单图字节预算（来自别名声明）：同 capabilities，原样继承。 */
  imageMaxEdgePx?: number;
  imageBudgetBytes?: number;
  /** 单视频交付字节预算（来自别名声明）：同 capabilities，原样继承。 */
  videoBudgetBytes?: number;
  /**
   * 完整配置（组合根注入）：角色定义里的 `model` 命中 `[models.<别名>]` 时，
   * 据此解析出该别名绑定的渠道并单独构造 provider——子 agent 因此可以跨渠道
   * （如主会话在 A 渠道、探索子 agent 走 B 渠道的轻量模型）。
   * 缺省（如单测直调）= 不做别名解析，`model` 按真实模型 id 走父 provider。
   */
  config?: StepCodeConfig;
  /** 父 agent 的 hooks（子 agent 沿用，使其写操作走父的审批对话）。 */
  hooks: LoopHooks;
  /** 嵌套深度上限（来自 config.subagent.maxDepth，父=0）。 */
  maxDepth: number;
  /** 每个子 agent 内部步数的全局默认（来自 config.subagent.maxSteps）；agent 定义可覆盖。 */
  maxStepsDefault: number;
  /** 压缩阈值：子 agent 也需要循环内压缩兜底（否则放宽步数后会撑爆上下文）。 */
  compaction: CompactionThresholds;
  /** 压缩摘要专用模型覆盖（来自 config.compaction.model）；省略 = 用 provider 默认模型。 */
  compactionModel?: string;
  /** 压缩摘要专用 provider（`[compaction] model` 别名跨渠道时由组合根构造）；省略 = 用各自会话的 provider。 */
  compactionProvider?: ChatProvider;
  /** 用户原话保真预算覆盖（来自 config.compaction.userMessage*）；省略 = 用 compact.ts 默认。 */
  userMessageBudget?: { maxTokens?: number; headTokens?: number };
  /** 会话级共享计数器（外置于 runner 实例，跨轮累计）。只做 UI 序号与展示计数，不承担配额拦截。 */
  sessionCounter: SubagentSessionCounter;
  /** 子会话持久层（组合根注入）：每次派生落盘独立会话（快照 + 全量日志 + 活跃锁）。 */
  subagentStore: SubagentStore;
  /** 主会话 id（顶层派生的子会话 meta.parentId 回退值；嵌套派生时由 req.parentSessionId 线程化覆盖）。 */
  parentSessionId?: string;
  /** skill 注册表（组合根注入）：子 agent 共享，system 拼清单 + ctx 带 skills，使其 skill 工具可用。 */
  skills?: SkillRegistry;
  /** 子 agent 进度事件回调（带子 agent 标识 + 生命周期，供 UI 区分各并行子 agent）。 */
  onEvent?: (id: string | undefined, ev: SubagentProgressEvent) => void;
}

/**
 * 角色 `model` 字段的解析结果：走哪个 provider、发什么模型 id、带什么能力与上下文窗口。
 * 别名未命中（或没注入 config）时退化为「父 provider + 原样字符串」，保持旧行为。
 */
interface ResolvedBinding {
  provider: ChatProvider;
  model?: string;
  capabilities?: readonly string[];
  imageMaxEdgePx?: number;
  imageBudgetBytes?: number;
  videoBudgetBytes?: number;
  maxContextSize?: number;
  /** 渠道名（如 stepfun / openai），空响应诊断上下文用；fallback 路径为 undefined。 */
  providerName?: string;
}

/** 组合根用它造 runSubagent 闭包。注册表按 cwd 构建一次。 */
export function createSubagentRunner(deps: SubagentRunnerDeps): RunSubagentFn {
  const registry = buildAgentRegistry(deps.cwd);
  // 按别名缓存 provider：同一别名的多次派生复用同一实例，避免每次派生重建连接
  const providerCache = new Map<string, ChatProvider>();

  /**
   * 解析角色的模型绑定。命中 `[models.<别名>]` 时按该别名的渠道单独构造 provider
   * （跨渠道派生的关键：base_url / api_key / 协议都随别名走，而不只是换模型 id 字符串）；
   * 未命中别名则原样当真实模型 id 交给父 provider（旧行为，跨渠道不可用）。
   * provider 构造失败（如该渠道缺 key）时退回父 provider，不让子 agent 直接死掉。
   */
  const resolveBinding = (alias: string | undefined): ResolvedBinding => {
    const fallback: ResolvedBinding = {
      provider: deps.provider,
      model: alias,
      capabilities: deps.capabilities,
      imageMaxEdgePx: deps.imageMaxEdgePx,
      imageBudgetBytes: deps.imageBudgetBytes,
      videoBudgetBytes: deps.videoBudgetBytes,
    };
    if (alias === undefined || alias === '' || deps.config === undefined) return fallback;

    const cached = providerCache.get(alias);
    const resolved = resolveModelEntry(deps.config, alias);
    if (resolved === null) return fallback; // 不是别名 → 按真实模型 id 处理
    if (cached !== undefined) {
      return {
        provider: cached,
        model: resolved.model,
        capabilities: resolved.capabilities,
        imageMaxEdgePx: resolved.imageMaxEdgePx,
        imageBudgetBytes: resolved.imageBudgetBytes,
        videoBudgetBytes: resolved.videoBudgetBytes,
        maxContextSize: resolved.maxContextSize,
        providerName: resolved.provider,
      };
    }
    try {
      const provider = createProvider(resolved);
      providerCache.set(alias, provider);
      return {
        provider,
        model: resolved.model,
        capabilities: resolved.capabilities,
        imageMaxEdgePx: resolved.imageMaxEdgePx,
        imageBudgetBytes: resolved.imageBudgetBytes,
        videoBudgetBytes: resolved.videoBudgetBytes,
        maxContextSize: resolved.maxContextSize,
        providerName: resolved.provider,
      };
    } catch {
      return fallback;
    }
  };

  const runImpl: RunSubagentFn = async (req: SpawnSubagentRequest): Promise<SubagentResult> => {
    // 深度硬上限（结构性剔除 spawn_agent 之外的第二道防护）
    if (req.depth + 1 > deps.maxDepth) {
      return {
        summary: `已达子 agent 深度上限（${deps.maxDepth}）。请自己完成该任务，不要再派生子 agent。`,
        isError: true,
      };
    }

    const resumeId = req.resume !== undefined && req.resume !== '' ? req.resume : undefined;
    let subSession: SessionData;
    let sessionId: string;
    let messages: StoredMessage[];
    let agentDef: AgentDefinition;

    if (resumeId !== undefined) {
      // resume 路径：不是新派生，不占 sessionCounter 配额；唯一门槛是目标会话当前没在跑（活跃锁判定）。
      // 已完成与失败的子会话不做区别处理，都可续跑。
      const snap = deps.subagentStore.loadSnapshot(deps.cwd, resumeId);
      if (snap === null) {
        return { summary: `找不到子会话「${resumeId}」（本工作目录下无此子 agent 会话）。`, isError: true };
      }
      const snapDef = registry.get(snap.agentType ?? req.subagentType);
      if (snapDef === undefined) {
        return {
          summary: `子会话「${resumeId}」的角色类型「${snap.agentType ?? req.subagentType}」已不存在，无法恢复。可用类型：${[...registry.keys()].join(', ')}。`,
          isError: true,
        };
      }
      if (!deps.subagentStore.acquireLock(deps.cwd, resumeId)) {
        // 已锁 = 正在跑：明确拒绝而非静默覆写（两个 writer 交替覆写同一快照会静默丢历史）
        return { summary: `子会话「${resumeId}」正在运行（持有活跃锁），无法恢复。等它结束后再试。`, isError: true, sessionId: resumeId };
      }
      agentDef = snapDef;
      subSession = snap;
      sessionId = resumeId;
      messages = snap.messages;
      // 尾部配对校验：崩溃若发生在工具执行段，盘上末条可能是没有配对 tool_result 的 assistant，
      // 直接续跑发 provider 会 400——补合成中断结果的 tool_result
      const closure = closeDanglingToolUse(messages);
      // closeDanglingToolUse 返回新数组，必须同步 subSession.messages 与 messages 两个引用；
      // 否则后续 push 只改 messages，subSession 仍持旧引用，落盘时新消息丢失。
      subSession.messages = messages = closure.messages;
      // 新 prompt 追加为一条 user 消息，不替换历史
      messages.push(stored({ role: 'user', content: req.prompt }, { kind: 'user' }));
      subSession.status = 'running';
    } else {
      const def = registry.get(req.subagentType);
      if (def === undefined) {
        return {
          summary: `未知子 agent 类型「${req.subagentType}」。可用类型：${[...registry.keys()].join(', ')}。`,
          isError: true,
        };
      }

      deps.sessionCounter.spawned += 1;

      // 起步即建立子会话身份：UUID id + 活跃锁 + 状态 running。
      // sid（下方）只是 UI 路由 key，与这里的持久化 sessionId 解耦——sid 在 /new、/fork 后会归零重复，
      // 不能直接当文件名用。
      agentDef = def;
      subSession = deps.subagentStore.create(deps.cwd, {
        model: def.model ?? '',
        agentType: def.name,
        depth: req.depth + 1,
        // parentId 精确化：嵌套派生时 runner 经 req.parentSessionId 把自己的子会话 id 传给下一层，
        // 缺省回退主会话 id（顶层派生）
        parentId: req.parentSessionId ?? deps.parentSessionId,
      });
      sessionId = subSession.id;
      if (!deps.subagentStore.acquireLock(deps.cwd, sessionId)) {
        // 全新 UUID 下实际不可达；防御性返回，不带 sessionId（会话未开始）
        return { summary: '子会话活跃锁建立失败，本次派生已取消。', isError: true };
      }
      messages = [stored({ role: 'user', content: req.prompt }, { kind: 'user' })];
    }
    // 历史落盘：快照（恢复源）+ 全量日志（完整历史）双写，与主会话保持同一套快照+日志双写语义。
    // 持久化失败只丢落盘，不影响子 agent 运行与结果回灌。
    const persist = (): void => {
      try {
        subSession.messages = messages;
        deps.subagentStore.appendMessages(deps.cwd, sessionId, messages);
        deps.subagentStore.saveSnapshot(subSession);
      } catch {
        // 磁盘不可写等场景：静默降级为纯内存运行
      }
    };
    const sid = req.id ?? (resumeId !== undefined ? `re-${resumeId.slice(0, 8)}` : String(deps.sessionCounter.spawned));
    // 终态幂等：`end` 至多发一次。catch 分支要兜底补发（保证消费方一定收到终态），
    // 但正常 return 路径已发过 end 后若落盘等环节再抛，会走到同一个补发点——
    // 这里做去重，让「所有路径至少一次」不退化成「某些路径两次」。
    // 定义在 try 外：catch 分支需要它补发终态。
    let endSent = false;
    const progress = (ev: SubagentProgressEvent): void => {
      if (ev.kind === 'end') {
        if (endSent) return;
        endSent = true;
      }
      deps.onEvent?.(sid, ev);
    };
    // 工具调用次数与墙钟耗时：只报 token 无法区分「卡在慢工具」与「烧在长上下文」，
    // 这两个维度补上这个盲区。
    // 定义在 try 外：catch 分支补发终态时也要带上这两个统计。
    let toolUses = 0;
    const startedAt = Date.now();
    try {
      // 角色的模型绑定：命中别名则连 provider 一起换（跨渠道），未命中退回父 provider
      const binding = resolveBinding(agentDef.model);
      // 子 agent 别名能力声明注入 provider：让 stepfun adapter 的 degrader 按别名 capabilities 决定剥不剥图片。
      // 仅对子代理专属 provider 注入（binding.provider !== deps.provider），避免污染父 agent 的 adapter。
      if (
        binding.capabilities !== undefined &&
        binding.provider !== deps.provider &&
        typeof binding.provider.setRuntimeCapabilities === 'function'
      ) {
        binding.provider.setRuntimeCapabilities(binding.capabilities);
      }
      // 工具集 = 角色白名单（或全部）∩ 已注册。仅当子 agent 还可再下探（depth+1 未达 maxDepth）时保留 spawn_agent，
      // 否则剔除（达深度上限后子 agent 不能再派生，防 fork-bomb）。
      // team 协调类工具一律从子 agent 剔除（它们只能由主 agent 这个协调者调用；send/inbox/status 保留给 worker 通信）。
      const TEAM_COORDINATOR_TOOLS = new Set(['team_init', 'team_plan', 'team_spawn', 'team_merge', 'team_teardown']);
      const canSpawnDeeper = req.depth + 1 < deps.maxDepth;
      const registered = new Set(allToolNames());
      const allowed = (agentDef.tools ?? allToolNames()).filter(
        (t) => (canSpawnDeeper || t !== SPAWN_TOOL) && registered.has(t) && !TEAM_COORDINATOR_TOOLS.has(t),
      );

      // system 拼上 skill 清单：子 agent 也能按需激活技能（与主 agent 一致的懒加载呈现）
      // cwd 覆盖（team worker 落进自己工作间）：system 提示与 ctx 同步用覆盖值
      const cwd = req.cwd ?? deps.cwd;
      const skillPart = deps.skills !== undefined ? skillListing(deps.skills, deps.config?.skillListingBudget) : '';
      // 记忆索引对子 agent 只读注入（开启时）：它做调研需要偏好上下文，但无写入权
      const memoryPart =
        deps.config?.memory?.enabled === true ? `\n\n${memorySection(scanMemory(cwd), 'readonly')}` : '';
      const system = `${agentDef.systemPrompt}\n\n当前工作目录：${cwd}\n\n${timeSection(new Date())}${memoryPart}${skillPart}`;
      // 深度未达上限时给子 agent 注入 runSubagent（同一 runner，可再派生）；达上限则不注入（拿不到派生能力）。
      // 嵌套派生时把自己的子会话 id 线程化传递下去，下一层的 meta.parentId 才能指向真实的直接父级。
      const selfRunner = canSpawnDeeper
        ? (subReq: SpawnSubagentRequest): ReturnType<RunSubagentFn> =>
            runImpl({ ...subReq, parentSessionId: sessionId })
        : undefined;
      const ctx: ToolContext = {
        cwd,
        apiKey: deps.apiKey,
        baseUrl: deps.baseUrl,
        // 搜索配置继承主会话（子 agent 自己的 model 别名只换模型 provider，不改变搜索配置归属）
        searchConfig: deps.config?.search,
        signal: req.signal,
        depth: req.depth + 1,
        runSubagent: selfRunner,
        // 子 agent 共享 skill 注册表
        skills: deps.skills,
        // resume 回灌的历史里图片是 stepref 指针：toWire 发 provider 前需要 attachments 做 rehydrate
        attachments: deps.subagentStore.attachments,
        // 能力标记随解析后的别名走（跨渠道时父模型的能力表不适用于子模型）
        capabilities: binding.capabilities,
        imageMaxEdgePx: binding.imageMaxEdgePx,
        imageBudgetBytes: binding.imageBudgetBytes,
        videoBudgetBytes: binding.videoBudgetBytes,
      };

      // 显示描述优先用模型写的短标签（短 description 防多行/长 prompt 溢出 TUI 行宽、
      // 挤掉行尾统计段）；缺省退回 prompt 截断——先压平换行，避免多行文本污染单行布局。
      const displayDesc =
        req.description !== undefined && req.description !== ''
          ? req.description
          : req.prompt.replace(/\s+/g, ' ').slice(0, 60);
      progress({ kind: 'start', subagentType: agentDef.name, description: displayDesc });

      let hadError = false;
      let aborted = false;
      let lastCause: unknown;
      // 累计计费 token（放 runImpl 闭包：摘要过短追加轮的第二次 run() 自然连续累计）；
      // 只累计带 billedDelta 的真实 usage，压缩后的纯估算事件无增量可计、跳过。
      let tokensUsed = 0;
      // 子 agent 剥离 goal 续接：复用主 hooks 会让子 agent 的 end_turn 触发主 goal 的 incrementTurn 污染计量；
      // Stop hook 续接对子 agent 也不适用（一次性语义在主会话层）
      const subHooks: LoopHooks = { ...deps.hooks };
      delete subHooks.shouldContinueAfterStop;
      // per-worker 写根约束（team worker）：write_file/edit_file 的目标必须落在 writeAllowRoot 内。
      // 在子 agent 自己的 hooks 拷贝上包装，不影响父 agent 与其他并行 worker。
      if (req.writeAllowRoot !== undefined && subHooks.authorizeToolCall !== undefined) {
        subHooks.authorizeToolCall = wrapWriteGuard(subHooks.authorizeToolCall, cwd, req.writeAllowRoot);
      }
      const run = async (): Promise<void> => {
        for await (const ev of runAgent({
          provider: binding.provider,
          providerName: binding.providerName ?? deps.config?.provider,
          system,
          ctx,
          messages,
          signal: req.signal,
          hooks: subHooks,
          maxIterations: agentDef.maxSteps ?? deps.maxStepsDefault,
          allowedTools: allowed,
          model: binding.model,
          // 压缩阈值随别名的上下文窗口走：跨渠道时子模型窗口与父模型可能差一个数量级，
          // 沿用父窗口会让压缩时机失准（窗口小的过晚、窗口大的过早）
          compaction:
            binding.maxContextSize !== undefined
              ? { ...deps.compaction, maxContextSize: binding.maxContextSize }
              : deps.compaction,
          compactionModel: deps.compactionModel,
          compactionProvider: deps.compactionProvider,
          userMessageBudget: deps.userMessageBudget,
        })) {
          if (ev.type === 'tool_start') {
            toolUses += 1;
            progress({ kind: 'tool', name: ev.name });
          }
          else if (ev.type === 'tool_end') {
            progress({ kind: 'tool_end', name: ev.name, isError: ev.isError });
            persist(); // 每个工具回合结束落一次盘：崩溃时盘上保留到最近回合
          }
          else if (ev.type === 'error') progress({ kind: 'error', message: ev.message });
          else if (ev.type === 'usage' && ev.billedDelta !== undefined) {
            tokensUsed += ev.billedDelta;
            progress({ kind: 'usage', tokens: tokensUsed });
          }
          if (ev.type === 'error') {
            hadError = true;
            // 保留原始错误对象：父侧调度层据此识别 429 做重排队（status 只存在于 error 对象上）
            if (ev.cause !== undefined) lastCause = ev.cause;
          }
          if (ev.type === 'aborted') aborted = true;
        }
      };

      await run();
      let summary = lastAssistantText(messages);

      // 摘要过短则追加一轮让子 agent 展开（最多 1 次）
      if (!aborted && !hadError && summary.length < SUMMARY_MIN_LEN) {
        messages.push(
          stored(
            {
              role: 'user',
              content: '请把上面的工作展开成更完整的中文说明：做了什么、结论、关键文件/路径。',
            },
            { kind: 'user' },
          ),
        );
        await run();
        summary = lastAssistantText(messages);
      }

      // 所有 return 点先写终态 status 并落盘，再由 finally 释放活跃锁。
      // 终态事件统一带 summary / toolUses / durationMs / sessionId：外部消费方靠它判断
      // 「干了什么、花了多少」，不必再去读子会话快照。summary 与 return 值保持同一份文本。
      const endStats = (): { toolUses: number; durationMs: number; sessionId: string } => ({
        toolUses,
        durationMs: Date.now() - startedAt,
        sessionId,
      });
      if (aborted) {
        subSession.status = 'aborted';
        persist();
        const abortedText = '子 agent 已被中断。';
        progress({ kind: 'end', isError: true, summary: abortedText, ...endStats() });
        return { summary: abortedText, isError: true, sessionId };
      }
      if (summary === '') {
        subSession.status = 'error';
        persist();
        const failed = hadError ? '子 agent 执行出错，未产出结果。' : '子 agent 未产出可用结果。';
        progress({ kind: 'end', isError: true, summary: failed, ...endStats() });
        return { summary: failed, isError: true, cause: lastCause, sessionId };
      }
      subSession.status = hadError ? 'error' : 'done';
      persist();
      progress({ kind: 'end', isError: hadError, summary, ...endStats() });
      return { summary, isError: hadError, cause: hadError ? lastCause : undefined, sessionId };
    } catch (e) {
      // 未捕获异常（如 provider 层抛出）：同样写终态落盘，保住已有历史
      subSession.status = 'error';
      persist();
      // 终态事件必须在所有退出路径发出：`start` 已发过，若这里只 throw 不发 `end`，
      // 消费方（TUI 条目、stream-json 外部程序）会永久等不到终态——只发中间态事件
      // 而不发终态的实现，会让只监听终态的消费方直接挂起。幂等由 endSent 保证。
      progress({
        kind: 'end',
        isError: true,
        summary: e instanceof Error ? `子 agent 异常中止：${e.message}` : '子 agent 异常中止。',
        toolUses,
        durationMs: Date.now() - startedAt,
        sessionId,
      });
      throw e;
    } finally {
      deps.subagentStore.releaseLock(deps.cwd, sessionId);
    }
  };

  return runImpl;
}

/** 取消息历史里最后一条有文本的 assistant 消息的文本（读内层 message）。 */
function lastAssistantText(messages: StoredMessage[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!.message;
    if (m.role !== 'assistant') continue;
    if (typeof m.content === 'string') {
      if (m.content.trim() !== '') return m.content.trim();
      continue;
    }
    const text = m.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
    if (text !== '') return text;
  }
  return '';
}
