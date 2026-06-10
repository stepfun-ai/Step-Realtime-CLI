import type {
  Capability,
  CapabilityTraits,
  ToolCallRequest,
  CapabilityResult,
  ToolSchema,
} from "@step-cli/realtime";
import type { CodingBridge } from "./coding-bridge.js";

const SCHEMA: ToolSchema = {
  name: "coding_agent",
  description:
    "调用后台 coding agent 执行编程任务 (读写文件、运行命令、代码修改等)。" +
    "agent 是独立进程，完成后会返回结果摘要。",
  parameters: {
    type: "object",
    properties: {
      task: {
        type: "string",
        description: "任务描述 — 尽可能具体清晰",
      },
      session: {
        type: "string",
        description:
          "continue: 在上一次 coding session 基础上继续。new: 开启全新 session。",
        enum: ["continue", "new"],
      },
    },
    required: ["task"],
  },
};

const TRAITS: CapabilityTraits = {
  latencyClass: "minutes",
  streaming: true,
  cancellable: true,
  stateful: true,
  sideEffects: "external-write",
};

export class CodingAgentCapability implements Capability {
  readonly id = "coding_agent";
  readonly schema = SCHEMA;
  readonly traits = TRAITS;

  constructor(private readonly bridge: CodingBridge) {}

  async invoke(req: ToolCallRequest): Promise<CapabilityResult> {
    const task = String(req.arguments.task ?? "");
    const session = (req.arguments.session as "continue" | "new") ?? "continue";

    if (!task.trim()) {
      return {
        callId: req.callId,
        ok: false,
        output: JSON.stringify({ error: "task is required" }),
      };
    }

    try {
      const summary = await this.bridge.onToolCall({ task, session });
      return {
        callId: req.callId,
        ok: true,
        output: summary,
        display: `coding: ${task.slice(0, 60)}`,
      };
    } catch (err) {
      return {
        callId: req.callId,
        ok: false,
        output: JSON.stringify({ error: String(err) }),
      };
    }
  }
}
