import { Box, Text } from 'ink';
import type { WorkflowStepEvent } from '../agent/events.js';

/**
 * dynamic_workflow 动态阶段面板。
 *
 * 与声明式 workflow 的静态步骤面板（已随 workflow 工具删除）不同：dynamic_workflow 的
 * 阶段在运行时才知道、无法预先编号，所以这里不预渲染全部步骤，而是随脚本内 phase(title)
 * 调用逐个追加阶段行——当前阶段 ● 高亮，已过的标 ✓。阶段不挂子 agent 成员（dynamic_workflow
 * 的子 agent 走常规 AgentGroup 路由，不进本面板）。
 */

/** 单个阶段（一次 phase 调用产生一行）。 */
export interface DynamicPhase {
  title: string;
  status: 'running' | 'done';
}

/** 动态阶段面板状态（tool_start 时造空序列，phase 事件逐个追加）。 */
export interface DynamicWorkflowPanelState {
  name: string;
  phases: DynamicPhase[];
}

/** 从 dynamic_workflow 的 tool_start input 装配动态阶段面板初始状态（空阶段序列）。
 * 入参是 script 字符串（无 steps 数组），无法预知阶段，故返回空面板待 phase 追加。 */
export function parseDynamicWorkflowInput(input: unknown): DynamicWorkflowPanelState | null {
  if (input === null || typeof input !== 'object') return null;
  const obj = input as Record<string, unknown>;
  if (typeof obj.script !== 'string' || obj.script === '') return null;
  const name = typeof obj.name === 'string' && obj.name !== '' ? obj.name : 'dynamic_workflow';
  return { name, phases: [] };
}

/** 推进阶段状态：phase 事件按 title 追加新阶段（running），把上一个 running 阶段标 done。
 * 非 phase 事件（index/total 定位的静态步骤事件）对动态面板无意义，原样返回。 */
export function applyDynamicPhaseEvent(
  state: DynamicWorkflowPanelState,
  info: WorkflowStepEvent,
): DynamicWorkflowPanelState {
  if (info.kind !== 'phase') return state;
  const title = info.title ?? '';
  const phases = state.phases.map((p) => (p.status === 'running' ? { ...p, status: 'done' as const } : p));
  phases.push({ title, status: 'running' });
  return { ...state, phases };
}

/**
 * 动态阶段面板：阶段列表（● 当前阶段高亮 / ✓ 已完成阶段）。
 * 头部行（工作流名 + 计时）由 ToolCall 渲染，本组件只渲染阶段序列。
 */
export function DynamicWorkflowPanel({ state }: { state: DynamicWorkflowPanelState }): React.ReactElement {
  return (
    <Box flexDirection="column">
      {state.phases.map((p, i) => {
        const mark = p.status === 'done' ? '✓' : '●';
        const markColor = p.status === 'done' ? 'green' : 'cyan';
        return (
          <Text key={i}>
            {'  '}
            <Text color={markColor}>{mark}</Text>
            {` ${i + 1}. `}
            <Text color="gray">{p.title}</Text>
          </Text>
        );
      })}
    </Box>
  );
}
