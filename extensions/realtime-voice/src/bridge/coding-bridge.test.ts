import { describe, expect, it, vi } from "vitest";

const sdk = vi.hoisted(() => {
  class SdkSessionError extends Error {
    code: string;
    constructor(code: string, message = code) {
      super(message);
      this.code = code;
    }
  }
  return { query: vi.fn(), SdkSessionError };
});

vi.mock("@step-cli/agent-sdk", () => ({
  ERR_SESSION_CORRUPT: "SESSION_CORRUPT",
  ERR_SESSION_NOT_FOUND: "SESSION_NOT_FOUND",
  query: sdk.query,
  SdkSessionError: sdk.SdkSessionError,
}));

import { CodingBridge } from "./coding-bridge.js";

async function* messages(values: unknown[]) {
  for (const value of values) yield value as never;
}

function setup() {
  let registration: any;
  const session = {
    registerTask: vi.fn((value) => {
      registration = value;
    }),
  };
  const bridge = new CodingBridge(
    session as never,
    {
      cwd: "/workspace",
      model: "test-model",
      permissionMode: "acceptEdits",
      maxTurns: 4,
      budgetUsd: 1,
    },
    {} as never,
  );
  return { bridge, session, registration: () => registration };
}

describe("CodingBridge", () => {
  it("returns immediately, registers a background task, and translates SDK progress", async () => {
    sdk.query.mockReturnValue(
      messages([
        {
          type: "assistant",
          message: {
            content: [
              { type: "text", text: "working" },
              {
                type: "tool_use",
                id: "u1",
                name: "Read",
                input: { file: "a" },
              },
              { type: "image" },
            ],
          },
        },
        {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "u1",
                content: "ok",
                is_error: false,
              },
              { type: "other" },
            ],
          },
        },
        {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "text_delta", text: "partial" },
          },
        },
        {
          type: "stream_event",
          event: {
            type: "content_block_delta",
            delta: { type: "input_json_delta", partial_json: "{" },
          },
        },
        { type: "stream_event", event: { type: "other" } },
        { type: "system", subtype: "status", status: "requesting" },
        { type: "system", subtype: "status", status: null },
        { type: "system", subtype: "compact_boundary" },
        {
          type: "system",
          subtype: "permission_denied",
          tool_name: "Write",
          tool_use_id: "u2",
          decision_reason: "no",
        },
        { type: "unknown" },
        {
          type: "result",
          result: "completed",
          session_id: "sdk-session",
          total_cost_usd: 0.25,
        },
      ]),
    );
    const { bridge, session, registration } = setup();
    const started = JSON.parse(
      await bridge.onToolCall({ task: "fix it", session: "new" }),
    );
    expect(started.status).toBe("started");
    expect(session.registerTask).toHaveBeenCalledTimes(1);
    const task = registration();
    const emitted: any[] = [];
    const summary = await task.run({}, (entry: any) => emitted.push(entry));
    expect(summary).toMatchObject({ status: "done", summary: "completed" });
    expect(emitted.map((entry) => entry.kind)).toEqual([
      "message",
      "tool_use",
      "tool_result",
      "message",
      "tool_use_delta",
      "status",
      "status",
      "message",
      "tool_denied",
    ]);
    expect(task.completionAnnouncement(summary)).toContain("coding_agent done");
    expect(
      task.statusInstruction({ taskId: started.taskId, progress: {} }, 61),
    ).toContain("1");
  });

  it("resumes an existing coding session and retries once with a fresh session on a resume error", async () => {
    const { bridge, registration } = setup();
    sdk.query.mockReturnValueOnce(
      messages([{ type: "result", result: "first", session_id: "saved" }]),
    );
    await bridge.onToolCall({ task: "first", session: "new" });
    await registration().run({}, vi.fn());

    sdk.query
      .mockImplementationOnce(() => {
        throw new sdk.SdkSessionError("SESSION_NOT_FOUND");
      })
      .mockReturnValueOnce(
        messages([{ type: "result", result: "fresh", session_id: "new-id" }]),
      );
    await bridge.onToolCall({ task: "second", session: "continue" });
    const summary = await registration().run({}, vi.fn());
    expect(summary).toMatchObject({ status: "done", summary: "fresh" });
    expect(sdk.query.mock.calls.at(-2)?.[0].options.resume).toBe("saved");
    expect(sdk.query.mock.calls.at(-1)?.[0].options.resume).toBeUndefined();
  });

  it("reports regular failures and resolves cancellation without waiting for the SDK stream", async () => {
    const { bridge, registration } = setup();
    sdk.query.mockImplementation(() => {
      throw new Error("network down");
    });
    await bridge.onToolCall({ task: "fail", session: "new" });
    await expect(registration().run({}, vi.fn())).resolves.toMatchObject({
      status: "failed",
      summary: "Error: network down",
    });

    let neverResolve!: () => void;
    sdk.query.mockReturnValue(
      messages([{ type: "assistant", message: { content: [] } }]),
    );
    await bridge.onToolCall({ task: "cancel", session: "new" });
    const task = registration();
    const pending = task.run({}, vi.fn());
    task.abortController.abort();
    await expect(pending).resolves.toMatchObject({ status: "interrupted" });
    neverResolve?.();
  });
});
