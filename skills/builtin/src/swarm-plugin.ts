import type {
  PluginHookContext,
  PluginHookResult,
} from "@step-cli/core/plugins/types.js";

export type SwarmModeTrigger = "manual" | "task" | "tool";

export interface SwarmModeState {
  readonly isActive: boolean;
  readonly trigger: SwarmModeTrigger | null;
  enter(trigger: SwarmModeTrigger, prompt?: string): void;
  exit(): void;
}

const SWARM_MODE_ENTER_REMINDER = [
  "## Swarm Mode",
  "",
  'You are now in "agent swarm" mode. The user may send tasks that require a large number of parallel subagents.',
  "",
  "## Workflow",
  "",
  "1. First, you may need to do a small amount of exploratory work before deciding how to divide the task across subagents. You may not need subagents during this exploratory phase.",
  "",
  "2. After exploring, if you are convinced no subagent is needed to complete the task, tell the user why and wait for further instructions; otherwise, continue with the appropriate delegation.",
  "",
  "3. Once you have enough context, do not handle the main work yourself. Use AgentSwarm with a `prompt_template` containing the `{{item}}` placeholder and an `items` array for the requested or appropriate number of subagents, partitioning the problem so each item gives one subagent a distinct part of the work. Pass `subagent_model` when the swarm should use a different model than the default.",
  "",
  "## Coordination",
  "",
  "- Give each subagent a distinct scope of work.",
  "- Avoid duplicating work across subagents.",
  "- Avoid assigning conflicting changes or responsibilities to different subagents.",
  "- Remember that subagents have your full capabilities. Do not overload their prompts with excessive detail; only describe the necessary background and each subagent's specific task.",
  "- Unless the user explicitly specifies a lower limit, do not try to conserve the number of agents. AgentSwarm supports up to 128 subagents and queues launches automatically, so decompose work as finely as possible while keeping subagent responsibilities non-conflicting; combine tasks only when they are genuinely inseparable. If the subagents only need to read, inspect, or report back without making changes, their scopes may overlap slightly.",
  "- When you need to inspect progress, use `task_list` to see all active background subtasks, or `task_wait` to wait for a specific task and collect its final result. `AgentSwarm` returns an `<agent_swarm_result>` summary with each subagent's outcome.",
].join("\n");

/** 防止并发 enter 覆盖 active 状态的简单互斥锁。 */
let _enterLock = false;
let active: SwarmModeTrigger | null = null;
const seenPrompts = new Set<string>();
/** 限制 seenPrompts 集合的无界增长。 */
const MAX_SEEN_PROMPTS = 1024;

export function getSwarmMode(): SwarmModeState {
  return {
    get isActive(): boolean {
      return active !== null;
    },
    get trigger(): SwarmModeTrigger | null {
      return active;
    },
    enter(trigger: SwarmModeTrigger, prompt?: string): void {
      // 简易互斥锁：防止并发 enter 覆盖 active 状态。
      if (_enterLock) return;
      _enterLock = true;
      try {
        if (active !== null) return;
        const key = `${trigger}:${prompt ?? ""}`;
        if (seenPrompts.has(key)) return;
        seenPrompts.add(key);
        // 限制集合大小，防止长运行会话中无界增长。超出时一次性裁半。
        if (seenPrompts.size > MAX_SEEN_PROMPTS) {
          const toRemove: string[] = [];
          let count = 0;
          for (const key of seenPrompts) {
            toRemove.push(key);
            count += 1;
            if (count >= seenPrompts.size / 2) break;
          }
          toRemove.forEach((key) => seenPrompts.delete(key));
        }
        active = trigger;
      } finally {
        _enterLock = false;
      }
    },
    exit(): void {
      if (active === null) return;
      // 注意：不清理 seenPrompts —— dedup 需跨 enter/exit 周期保持。
      // 集合大小上限在 enter() 中通过 LRU 式修剪控制。
      active = null;
    },
  };
}

export function createSwarmPlugin(): {
  id: string;
  description: string;
  register: () => [];
  hooks: {
    beforeModelRequest: (context: PluginHookContext) => PluginHookResult | void;
  };
  getSwarmMode: () => SwarmModeState;
} {
  return {
    id: "swarm-plugin",
    description: "Swarm mode state machine and reminder injection",
    register: () => [],
    hooks: {
      beforeModelRequest: (
        context: PluginHookContext,
      ): PluginHookResult | void => {
        if (
          context.harnessType !== "main" ||
          (context.harnessDepth ?? 0) !== 0
        ) {
          return;
        }
        if (active === null) {
          return;
        }
        return {
          messages: [
            {
              role: "system",
              content: SWARM_MODE_ENTER_REMINDER,
            },
          ],
        };
      },
    },
    getSwarmMode: getSwarmMode,
  };
}
