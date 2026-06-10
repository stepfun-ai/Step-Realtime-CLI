import type {
  Capability,
  CapabilityTraits,
  ToolCallRequest,
  CapabilityResult,
  ToolSchema,
  RealtimeSession,
} from "@step-cli/realtime";

const SCHEMA: ToolSchema = {
  name: "coding_task_cancel",
  description:
    "取消当前正在后台运行的 coding 任务。仅当用户明确表达要停止/取消时调用。" +
    "如果没有任务在跑,调用是安全的空操作。",
  parameters: {
    type: "object",
    properties: {},
  },
};

const TRAITS: CapabilityTraits = {
  latencyClass: "instant",
  streaming: false,
  cancellable: false,
  stateful: false,
  sideEffects: "harness-self",
};

export class CodingCancelCapability implements Capability {
  readonly id = "coding_task_cancel";
  readonly schema = SCHEMA;
  readonly traits = TRAITS;

  constructor(private readonly session: RealtimeSession) {}

  async invoke(req: ToolCallRequest): Promise<CapabilityResult> {
    const current = this.session.getCurrent();
    if (!current) {
      return {
        callId: req.callId,
        ok: true,
        output: JSON.stringify({ cancelled: false, reason: "no_task" }),
        display: "没有正在运行的任务",
      };
    }
    this.session.cancelTask(current.taskId);
    return {
      callId: req.callId,
      ok: true,
      output: JSON.stringify({ cancelled: true, taskId: current.taskId }),
      display: "已取消任务",
    };
  }
}
