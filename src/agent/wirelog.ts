import type Anthropic from '@anthropic-ai/sdk';
import { normalizeMessage, stored, type StoredMessage } from './message.js';
import type { GoalState } from './goal/mode.js';
import type { PermissionMode } from './permission/mode.js';
import type { BackgroundTask } from './background/manager.js';

/**
 * 事件日志（wire.jsonl）模块：会话状态机的事实源。
 *
 * 定位：`full.jsonl` 从「每行一条消息」升级为「每行一个事件」。消息只是事件的一种
 * （context.append_message），权限模式 / planMode / thinkOverride / goal / 后台任务生命周期
 * 等非消息状态同样以事件落盘，从而获得时序与任意点恢复能力。
 *
 * 核心契约（restore 无副作用）：重放事件重建内存态必须是纯函数——不得产生新事件、
 * 不得触发通知投递或任务调度、不得写盘。live 写路径与 resume 重放路径共用同一份
 * 状态迁移逻辑（applyWireEvent），不存在两份会漂移的「resume 专用装载逻辑」。
 *
 * 落盘纪律：只追加、永不重写；读时容忍最后一行截断（最后一次写入可能崩溃在 flush 中途）。
 */

/** 事件日志格式版本。首行 metadata 事件携带，供将来演进时判别。 */
export const WIRE_FORMAT_VERSION = 1;

/** 通知幂等键：taskId + 终态 + notificationId 三段拼接（NUL 分隔，不可能出现在 id 内）。 */
export function notifyDedupKey(taskId: string, status: string, notificationId: string): string {
  return `${taskId}${status}${notificationId}`;
}

/**
 * 由消息 origin 回填幂等键：notificationId 规范形态是 `task:<taskId>:<status>`，
 * 从中拆出 status 后与显式 delivered 事件算出的键一致；拆不出（旧数据/手写通知）
 * 时 status 落空串——此时键仍稳定可去重，只是与 delivered 事件键不同，可接受。
 */
export function notifyDedupKeyFromOrigin(taskId: string | undefined, notificationId: string): string {
  const match = /^task:(.+):([a-z]+)$/.exec(notificationId);
  const status = match?.[2] ?? '';
  return notifyDedupKey(taskId ?? match?.[1] ?? '', status, notificationId);
}

/**
 * wire.jsonl 事件判别联合。只覆盖 step-code 状态机真实拥有的状态种类，
 * 不预支用不到的事件类型（restore 分支随种类只增不减，种类越少兼容面越小）。
 */
export type WireEvent =
  | {
      /** 首行固定事件：标识这是一条事件日志及其格式版本。 */
      type: 'metadata';
      version: number;
      sessionId: string;
      createdAt: string;
    }
  | {
      /** 一条消息进入会话历史（载荷就是现有 StoredMessage 信封）。 */
      type: 'context.append_message';
      ts: string;
      message: StoredMessage;
    }
  | {
      /** 一次真人 prompt 开轮（轮次计数的事实源，供 goal 轮次预算 / fork 边界使用）。 */
      type: 'turn.prompt';
      ts: string;
      /** 触发本轮的 user 消息 id（可关联回 append_message 事件）。 */
      messageId?: string;
    }
  | {
      /**
       * 一次真实 API 往返的 token 明细。**每轮一条**，是「上下文占用」类问题唯一的事后审计凭据。
       *
       * 为什么必须落盘：会话快照只存消息内容，不存 usage。因此事后无法复原任何时刻的真实
       * input/cache_read/output——2026-08-02 那次「状态栏 479.4k 超上限两成」的排查正是卡在这里，
       * 只能拿压缩后的快照去解释压缩前的占用，得出「差 48 倍」的伪结论（实为复算对象错配）。
       * 一行 JSON 的代价换「需要复现」变成「可事后审计」。
       *
       * 同时记两套口径，缺一不可：
       * - `totalTokens`：服务端 usage 四项相加（状态栏显示值的事实源）
       * - `estimatedTokens` + `measuredLength`：同时刻按字符估算的值与消息条数，
       *   两者比值即估算偏差率——预检用的是估算，偏差率决定预检是否可信。
       */
      type: 'model.usage';
      ts: string;
      /** 本轮实际请求的模型（可能被 /model 或子 agent 覆盖，与顶层配置不同）。 */
      model?: string;
      /** 服务端 usage 四项相加（口径见 usageTotalTokens）。 */
      totalTokens: number;
      /** 计费口径增量（input − cache_read + output，见 billedTokens）。 */
      billedTokens: number;
      inputTokens?: number;
      outputTokens?: number;
      cacheReadTokens?: number;
      cacheCreationTokens?: number;
      /**
       * 同时刻按字符估算的**历史**占用（仅 messages，不含框架开销）。
       * 与 `totalTokens` 直接比是不可比的——真实值含 system + tools。
       * 可比口径是 `estimatedTokens + frameworkTokens`，两者比值才是估算偏差率。
       */
      estimatedTokens: number;
      /** 框架固定开销估算（system prompt 含 AGENTS.md 与 skill 清单，加 tools schema）。 */
      frameworkTokens: number;
      /** 发请求那一刻的历史消息条数。 */
      measuredLength: number;
      /** 本轮停止原因，用于把异常轮（max_tokens / error）与正常轮分开统计。 */
      stopReason: string;
    }
  | {
      /** 权限模式切换。 */
      type: 'permission.set_mode';
      ts: string;
      mode: PermissionMode;
    }
  | {
      /** Plan 模式开关。 */
      type: 'plan_mode.set';
      ts: string;
      enabled: boolean;
    }
  | {
      /** 会话级思考深度覆盖（'off' / 档位名；缺省字段 = 清除覆盖回退默认）。 */
      type: 'think.set';
      ts: string;
      override?: string;
    }
  | {
      /** goal 状态变更（缺省 goal 字段 = 清除 goal）。 */
      type: 'goal.update';
      ts: string;
      goal?: GoalState;
    }
  | {
      /** 应用一次压缩：重放到此事件时，内存里已重建的消息历史整体替换为压缩后的存活序列。 */
      type: 'context.apply_compaction';
      ts: string;
      messages: StoredMessage[];
    }
  | {
      /** 后台任务到达终态（任务状态落盘之外的事件层记录，供审计与重放）。 */
      type: 'background.task_settle';
      ts: string;
      task: BackgroundTask;
    }
  | {
      /** 一条终态通知已投递进会话历史（「已送达」集合的持久化形态，重放时回填）。 */
      type: 'background.notify_delivered';
      ts: string;
      taskId: string;
      status: string;
      notificationId: string;
    };

/**
 * 重放产物：从事件序列重建出的会话内存态。
 * 与 SessionData 的非消息字段一一对应，外加通知幂等集合与轮次计数。
 */
export interface WireReplayState {
  /** 重建后的消息历史（经过 compaction 事件折叠）。 */
  messages: StoredMessage[];
  mode?: PermissionMode;
  planMode?: boolean;
  thinkOverride?: string;
  goal?: GoalState;
  /** 已送达通知的幂等键集合（显式 delivered 事件 + background_task 消息回填双通道）。 */
  deliveredNotifications: Set<string>;
  /** turn.prompt 事件计数。 */
  turnCount: number;
  /** 已终态后台任务（task_settle 事件记录，按任务 id 索引）。 */
  settledTasks: Map<string, BackgroundTask>;
}

/** 空的重放初态。 */
export function emptyWireReplayState(): WireReplayState {
  return {
    messages: [],
    deliveredNotifications: new Set(),
    turnCount: 0,
    settledTasks: new Map(),
  };
}

/**
 * 单步状态迁移：把一个事件应用到重放态上（纯函数，原地修改 state 但不产生任何副作用）。
 * live 写路径与 resume 重放路径共用本函数，保证状态机只有一份实现。
 *
 * 已送达集合的双通道回填：除显式 background.notify_delivered 事件外，重放到
 * origin.kind === 'background_task' 且携带 notificationId 的消息时同样回填——
 * 通知消息进了历史即视为送达，与 delivered 事件互为冗余（进程可能死在两者写入之间）。
 */
export function applyWireEvent(state: WireReplayState, event: WireEvent): void {
  switch (event.type) {
    case 'metadata':
      break;
    case 'context.append_message': {
      const message = normalizeMessage(event.message);
      state.messages.push(message);
      const origin = message.origin;
      if (origin.kind === 'background_task' && origin.notificationId !== undefined) {
        state.deliveredNotifications.add(notifyDedupKeyFromOrigin(origin.taskId, origin.notificationId));
      }
      break;
    }
    case 'turn.prompt':
      state.turnCount += 1;
      break;
    case 'permission.set_mode':
      state.mode = event.mode;
      break;
    case 'plan_mode.set':
      state.planMode = event.enabled;
      break;
    case 'think.set':
      state.thinkOverride = event.override;
      break;
    case 'goal.update':
      state.goal = event.goal;
      break;
    case 'context.apply_compaction':
      state.messages = event.messages.map(normalizeMessage);
      break;
    case 'background.task_settle':
      state.settledTasks.set(event.task.id, event.task);
      break;
    case 'background.notify_delivered':
      state.deliveredNotifications.add(
        notifyDedupKey(event.taskId, event.status, event.notificationId),
      );
      break;
  }
}

/**
 * 顺序重放一串事件，返回重建态。纯函数：不写盘、不发通知、不调度任务。
 * 这是 resume 恢复路径的唯一状态重建入口。
 */
export function replayWireEvents(events: readonly WireEvent[], base?: WireReplayState): WireReplayState {
  const state = base ?? emptyWireReplayState();
  for (const event of events) applyWireEvent(state, event);
  return state;
}

/**
 * 解析一行 JSONL 为事件。损坏行（含崩溃截断的尾行）返回 null，调用方跳过。
 * 行内消息型载荷读入即归一化（旧字符串 origin → 对象形态）。
 */
export function parseWireLine(line: string): WireEvent | null {
  const trimmed = line.trim();
  if (trimmed === '') return null;
  let raw: unknown;
  try {
    raw = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof raw !== 'object' || raw === null) return null;
  const event = raw as WireEvent;
  if (typeof event.type !== 'string') return null;
  return event;
}

/** 悬空 tool_use 闭合结果。 */
export interface DanglingClosure {
  messages: StoredMessage[];
  /** 是否合成了闭合消息。 */
  closed: boolean;
  /** 被闭合的 tool_use id 列表（审计/测试用）。 */
  closedToolUseIds: string[];
}

/**
 * 闭合悬空 tool call：进程若死在「assistant 发出 tool_use」与「tool_result 回写」之间，
 * 重放出的历史末尾会悬着未应答的 tool_use——直接续跑会被 provider 拒（协议要求每个
 * tool_use 必须有对应 tool_result）。resume 时在内存里合成一条 is_error 的 tool_result
 * 闭合交换，不假装成功，也不改写事件日志（闭合消息随下回合正常持久化路径落盘）。
 *
 * 只闭合末尾悬空段：历史中段的悬空（理论上不该存在）不动，避免误改旧交换。
 */
export function closeDanglingToolUse(messages: readonly StoredMessage[]): DanglingClosure {
  const last = messages.at(-1);
  if (last === undefined || last.message.role !== 'assistant' || typeof last.message.content === 'string') {
    return { messages: [...messages], closed: false, closedToolUseIds: [] };
  }
  const toolUseIds = last.message.content
    .filter((b): b is Anthropic.ToolUseBlockParam => b.type === 'tool_use')
    .map((b) => b.id);
  if (toolUseIds.length === 0) {
    return { messages: [...messages], closed: false, closedToolUseIds: [] };
  }
  const closure: Anthropic.ToolResultBlockParam[] = toolUseIds.map((id) => ({
    type: 'tool_result',
    tool_use_id: id,
    is_error: true,
    content: '[会话中断：该工具调用未产生结果，已按失败闭合]',
  }));
  return {
    messages: [...messages, stored({ role: 'user', content: closure }, 'tool')],
    closed: true,
    closedToolUseIds: toolUseIds,
  };
}

/** 孤儿 tool_result 修复结果。 */
export interface OrphanToolResultRepair {
  messages: StoredMessage[];
  /** 是否改写过消息。 */
  repaired: boolean;
  /** 被降级为 text 的 tool_result 对应的 tool_use id 列表（审计/测试用）。 */
  repairedToolUseIds: string[];
}

/** 提取 tool_result 块的纯文本内容（字符串原样，数组取 text 块拼接）。 */
function toolResultPlainText(block: Anthropic.ToolResultBlockParam): string {
  if (typeof block.content === 'string') return block.content;
  if (Array.isArray(block.content)) {
    return block.content
      .filter((b): b is Anthropic.TextBlockParam => b.type === 'text')
      .map((b) => b.text)
      .join('\n');
  }
  return '';
}

/**
 * 修复孤儿 tool_result：存量会话可能因「快照 wireSeq 游标落后 + resume 尾段重放」
 * 产生尾部同 id 重复，形成 assistant(tool_use) → user(result) → assistant(text)
 * → user(result 孤儿) 的序列。孤儿 tool_result 的前一条非 tool 消息不是含匹配
 * tool_use 的 assistant，严格校验 tool 配对的 OpenAI 兼容渠道会拒绝整段历史
 * （HTTP 400：messages with role 'tool' must be a response to a preceeding
 * message with 'tool_calls'）。
 *
 * resume 时在内存里把孤儿 tool_result 块降级为 text 块——内容完整保留、不丢信息，
 * 只是不再冒充工具协议消息；有效配对（能匹配到前序 assistant tool_use 的）原样不动。
 * 与 closeDanglingToolUse 同一纪律：不改写事件日志，修复结果随下回合正常持久化落盘。
 *
 * 配对判据：user 消息含 tool_result 时，向前跳过连续的纯 tool_result user 消息，
 * 第一条必须是含匹配 tool_use 的 assistant；否则该块为孤儿。
 */
export function repairOrphanToolResults(messages: readonly StoredMessage[]): OrphanToolResultRepair {
  const out: StoredMessage[] = [];
  const repairedToolUseIds: string[] = [];
  for (const m of messages) {
    const content = m.message.content;
    if (m.message.role !== 'user' || typeof content === 'string') {
      out.push(m);
      continue;
    }
    const hasToolResult = content.some((b) => b.type === 'tool_result');
    if (!hasToolResult) {
      out.push(m);
      continue;
    }
    // 前向配对锚点：跳过连续的纯 tool_result user 消息（它们与当前消息同属一组应答）
    let anchor: StoredMessage | undefined;
    for (let j = out.length - 1; j >= 0; j--) {
      const prev = out[j];
      const prevContent = prev.message.content;
      const pureToolResults =
        prev.message.role === 'user' &&
        typeof prevContent !== 'string' &&
        prevContent.length > 0 &&
        prevContent.every((b) => b.type === 'tool_result');
      if (pureToolResults) continue;
      anchor = prev;
      break;
    }
    const validIds = new Set(
      anchor !== undefined &&
        anchor.message.role === 'assistant' &&
        typeof anchor.message.content !== 'string'
        ? anchor.message.content
            .filter((b): b is Anthropic.ToolUseBlockParam => b.type === 'tool_use')
            .map((b) => b.id)
        : [],
    );
    let changed = false;
    const newContent = content.map((b) => {
      if (b.type !== 'tool_result' || validIds.has(b.tool_use_id)) return b;
      changed = true;
      repairedToolUseIds.push(b.tool_use_id);
      const text: Anthropic.TextBlockParam = {
        type: 'text',
        text: `[历史工具结果 ${b.tool_use_id}] ${toolResultPlainText(b)}`,
      };
      return text;
    });
    out.push(
      changed ? { ...m, message: { ...m.message, content: newContent } } : m,
    );
  }
  return {
    messages: out,
    repaired: repairedToolUseIds.length > 0,
    repairedToolUseIds,
  };
}
