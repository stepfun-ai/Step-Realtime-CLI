import { Box, Text } from 'ink';
import { t } from '../i18n.js';
import type { WorkflowStepEvent } from '../agent/workflow.js';
import type { SubagentProgressEvent } from '../agent/events.js';
import { formatSubagentStats, type SubagentProgress } from './AgentGroup.js';

/** workflow 步骤面板中单个步骤的展示状态。 */
export interface WorkflowStepState {
  kind: string;
  /** 结果变量名（as），无 label 时作步骤名。 */
  as?: string;
  /** 步骤显示名（agent 步骤的 label）。 */
  label?: string;
  status: 'pending' | 'running' | 'done';
  /** parallel/fanout 步骤的组内任务总数。 */
  total?: number;
  /** parallel 各 task 的 label / fanout 各 item，作为成员子 agent 的显示名。 */
  memberLabels?: string[];
  /** 归属本步骤的子 agent（sid 形如 wf-{stepIndex}-{taskIndex}）。 */
  members: SubagentProgress[];
}

/** workflow 步骤面板状态（由 App 在 tool_start 时从 input.steps 装配，事件流推进）。 */
export interface WorkflowPanelState {
  name: string;
  steps: WorkflowStepState[];
  /**
   * 动态模式标记（dynamic_workflow）：true 表示步骤不是预先可知的静态列表，
   * 而是运行时随 phase() 调用逐个追加的阶段序列。此时渲染与 applyStepEvent 走动态分支，
   * 不按 index 定位（phase 事件 index 恒为 -1）。
   */
  dynamic?: boolean;
}

/** wf-{stepIndex}-{taskIndex} 形式的 sid 解析结果。 */
export interface WfSid {
  stepIndex: number;
  taskIndex: number;
}

/** 解析 workflow 子 agent 的 sid；非 wf- 前缀或格式不符返回 null（保持 AgentGroup 原路由）。 */
export function parseWfSid(sid: string): WfSid | null {
  const m = /^wf-(\d+)-(\d+)$/.exec(sid);
  if (m === null) return null;
  return { stepIndex: Number(m[1]), taskIndex: Number(m[2]) };
}

/** 从 tool_start 的 input 装配面板初始状态（全部步骤 pending）。input 不含 steps 数组时返回 null。 */
export function parseWorkflowInput(input: unknown): WorkflowPanelState | null {
  if (input === null || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  if (!Array.isArray(obj.steps)) return null;
  const name = typeof obj.name === 'string' ? obj.name : '';
  const steps: WorkflowStepState[] = [];
  for (const raw of obj.steps) {
    if (raw === null || typeof raw !== 'object') continue;
    const s = raw as Record<string, unknown>;
    const kind = typeof s.kind === 'string' ? s.kind : 'agent';
    const step: WorkflowStepState = {
      kind,
      as: typeof s.as === 'string' ? s.as : undefined,
      label: typeof s.label === 'string' ? s.label : undefined,
      status: 'pending',
      members: [],
    };
    if (kind === 'parallel' && Array.isArray(s.tasks)) {
      step.total = s.tasks.length;
      step.memberLabels = s.tasks.map((task) =>
        task !== null && typeof task === 'object' && typeof (task as Record<string, unknown>).label === 'string'
          ? ((task as Record<string, unknown>).label as string)
          : '',
      );
    } else if (kind === 'fanout' && Array.isArray(s.items)) {
      step.total = s.items.length;
      step.memberLabels = s.items.map((item) => String(item));
    }
    steps.push(step);
  }
  if (steps.length === 0) return null;
  return { name, steps };
}

/** 从 dynamic_workflow 的 tool_start input 装配动态阶段面板初始状态（空阶段序列，待 phase 追加）。
 * dynamic_workflow 的入参是 script 字符串（无 steps 数组），无法预知阶段，故返回 dynamic:true 的空面板。 */
export function parseDynamicWorkflowInput(input: unknown): WorkflowPanelState | null {
  if (input === null || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  if (typeof obj.script !== 'string' || obj.script === '') return null;
  const name = typeof obj.name === 'string' && obj.name !== '' ? obj.name : 'dynamic_workflow';
  return { name, steps: [], dynamic: true };
}

/** 推进步骤状态（start → running / done → done）。
 * phase 分支（dynamic_workflow）：阶段是运行时追加的序列，index 恒 -1 不可用——
 * 把上一个 running 阶段标 done，再按 title 追加一个新 running 阶段。 */
export function applyStepEvent(state: WorkflowPanelState, info: WorkflowStepEvent): WorkflowPanelState {
  if (info.kind === 'phase') {
    const title = info.title ?? '';
    const steps = state.steps.map((s) => (s.status === 'running' ? { ...s, status: 'done' as const } : s));
    steps.push({ kind: 'phase', label: title, status: 'running', members: [] });
    return { ...state, steps };
  }
  const steps = state.steps.map((s, i) =>
    i === info.index ? { ...s, status: info.status === 'start' ? ('running' as const) : ('done' as const) } : s,
  );
  return { ...state, steps };
}

/** 把子 agent 进度事件合并进对应步骤的成员列表（复用 AgentGroup 的条目结构）。 */
export function applySubagentEvent(
  state: WorkflowPanelState,
  wf: WfSid,
  sid: string,
  ev: SubagentProgressEvent,
): WorkflowPanelState {
  const step = state.steps[wf.stepIndex];
  if (step === undefined) return state;
  const members = [...step.members];
  if (ev.kind === 'start') {
    // 优先用任务 label / fanout item 作显示名，缺省回退到 prompt 截断
    const label = step.memberLabels?.[wf.taskIndex];
    members.push({
      id: sid,
      type: ev.subagentType,
      description: label !== undefined && label !== '' ? label : ev.description,
      status: 'running',
      toolCount: 0,
      startedAt: Date.now(),
    });
  } else {
    const idx = members.findIndex((m) => m.id === sid);
    if (idx === -1) return state;
    const m = members[idx]!;
    if (ev.kind === 'tool') {
      members[idx] = { ...m, toolCount: m.toolCount + 1, activity: ev.name };
    } else if (ev.kind === 'error') {
      members[idx] = { ...m, activity: t('app.agent.activityError', { message: ev.message }) };
    } else if (ev.kind === 'usage') {
      // runner 已逐轮累计，这里只赋值（不加法）
      members[idx] = { ...m, tokens: ev.tokens };
    } else {
      members[idx] = { ...m, status: ev.isError ? 'error' : 'done', endedAt: Date.now() };
    }
  }
  const steps = state.steps.map((s, i) => (i === wf.stepIndex ? { ...s, members } : s));
  return { ...state, steps };
}

/** 步骤显示名：agent/synthesize 用 label 或 as；parallel/fanout 用任务计数。 */
function stepLabel(s: WorkflowStepState): string {
  if ((s.kind === 'parallel' || s.kind === 'fanout') && s.total !== undefined) {
    return t('workflow.step.parallelTasks', { count: s.total });
  }
  return s.label ?? s.as ?? '';
}

/** 步骤的已完成成员数（done + error 都算已结束）。 */
function finishedCount(s: WorkflowStepState): number {
  return s.members.filter((m) => m.status === 'done' || m.status === 'error').length;
}

/**
 * workflow 步骤面板：步骤列表（○ 未开始 / ● 运行中 / ✓ 完成）+ 当前步高亮
 * + parallel/fanout 组内子 agent 归属。头部行（workflow 名 + 计时）由 ToolCall 渲染。
 */
export function WorkflowPanel({ state }: { state: WorkflowPanelState }): React.ReactElement {
  return (
    <Box flexDirection="column">
      {state.steps.map((s, i) => {
        const mark = s.status === 'done' ? '✓' : s.status === 'running' ? '●' : '○';
        const markColor = s.status === 'done' ? 'green' : s.status === 'running' ? 'cyan' : 'gray';
        // parallel/fanout 显示组内完成计数；单 agent 步骤运行中显示其成员的 tool 数
        let suffix = '';
        if ((s.kind === 'parallel' || s.kind === 'fanout') && s.total !== undefined) {
          suffix = t('workflow.step.progress', { done: finishedCount(s), total: s.total });
        } else if (s.status === 'running') {
          const m = s.members[0];
          suffix = t('workflow.step.runningInfo', { count: m?.toolCount ?? 0 });
        }
        return (
          <Box key={i} flexDirection="column">
            <Text>
              {'  '}
              <Text color={markColor}>{mark}</Text>
              {` ${i + 1}. `}
              <Text color="white">{s.kind}</Text>
              <Text color="gray"> · {stepLabel(s)}</Text>
              {suffix !== '' ? <Text color="gray">{suffix}</Text> : null}
            </Text>
            {(s.kind === 'parallel' || s.kind === 'fanout') && s.members.length > 0
              ? s.members.map((m, j) => {
                  const branch = j === s.members.length - 1 ? '└─' : '├─';
                  // 状态圆点（●）与 AgentGroup 对齐：黄=运行中、绿=已完成、红=失败、灰=排队中。
                  const mColor =
                    m.status === 'done' ? 'green' : m.status === 'error' ? 'red' : m.status === 'running' ? 'yellow' : 'gray';
                  return (
                    <Box key={j} flexDirection="column">
                      <Text>
                        {'  │   '}
                        {branch} <Text color="white">{m.type}</Text>
                        {/* 无 tick：运行中时长显示最近一次事件触发渲染时的值，终态为定格值 */}
                        <Text color="gray"> · {m.description} · {formatSubagentStats(m, Date.now())} </Text>
                        <Text color={mColor}>●</Text>
                      </Text>
                      {m.status === 'running' && m.activity !== undefined && m.activity !== '' ? (
                        <Text color="gray">{'        '}{m.activity}</Text>
                      ) : null}
                    </Box>
                  );
                })
              : null}
          </Box>
        );
      })}
    </Box>
  );
}
