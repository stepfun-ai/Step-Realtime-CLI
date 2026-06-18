import { describe, it, expect, vi } from "vitest";
import {
  createCanUseToolBridge,
  filterToolSpecsByAllowedNames,
} from "./canUseTool-bridge.js";
import type { CanUseTool } from "./types.js";
import type { ToolApprovalRequest, ToolSpec } from "@step-cli/protocol";

function makeRequest(
  overrides: Partial<ToolApprovalRequest> = {},
): ToolApprovalRequest {
  return {
    toolName: "Bash",
    toolCallId: "call-1",
    rawArgs: '{"command":"ls"}',
    ...overrides,
  } as ToolApprovalRequest;
}

describe("createCanUseToolBridge - bypass paths", () => {
  it("returns no-op policy when no canUseTool is supplied", () => {
    const bridge = createCanUseToolBridge({});
    expect(bridge.permissionPolicy).toBeUndefined();
    expect(bridge.approvalHandler).toBeUndefined();
  });

  it.each([
    [
      "allowDangerouslySkipPermissions",
      { allowDangerouslySkipPermissions: true as const },
    ],
    ["bypassPermissions", { permissionMode: "bypassPermissions" as const }],
    ["dontAsk", { permissionMode: "dontAsk" as const }],
    ["auto", { permissionMode: "auto" as const }],
  ])("installs no policy for %s even with canUseTool", (_label, opts) => {
    const canUseTool: CanUseTool = vi.fn(async () => ({
      behavior: "allow" as const,
    }));
    const bridge = createCanUseToolBridge({ canUseTool, ...opts });
    expect(bridge.permissionPolicy).toBeUndefined();
    expect(bridge.approvalHandler).toBeUndefined();
    expect(canUseTool).not.toHaveBeenCalled();
  });

  it("onTurnBoundary clears pendingDenials in bypass mode", () => {
    const bridge = createCanUseToolBridge({});
    bridge.pendingDenials.set("x", { message: "m" });
    bridge.onTurnBoundary();
    expect(bridge.pendingDenials.size).toBe(0);
  });
});

describe("createCanUseToolBridge - permissionPolicy.evaluate", () => {
  const canUseTool: CanUseTool = async () => ({ behavior: "allow" as const });

  it("auto-allows edit tools under acceptEdits mode", () => {
    const bridge = createCanUseToolBridge({
      canUseTool,
      permissionMode: "acceptEdits",
    });
    const decision = bridge.permissionPolicy!.evaluate("Edit", "{}", undefined);
    expect(decision.mode).toBe("allow");
    expect(decision.risk).toBe("write");
  });

  it("requires confirm for non-edit tools under acceptEdits mode", () => {
    const bridge = createCanUseToolBridge({
      canUseTool,
      permissionMode: "acceptEdits",
    });
    const decision = bridge.permissionPolicy!.evaluate("Bash", "{}", undefined);
    expect(decision.mode).toBe("confirm");
    expect(decision.risk).toBe("execute");
  });

  it("confirms in default mode and falls back to read risk for unknown tools", () => {
    const bridge = createCanUseToolBridge({
      canUseTool,
      permissionMode: "default",
    });
    const decision = bridge.permissionPolicy!.evaluate(
      "SomeUnknownTool",
      "{}",
      undefined,
    );
    expect(decision.mode).toBe("confirm");
    expect(decision.risk).toBe("read");
  });
});

describe("createCanUseToolBridge - approvalHandler", () => {
  it("returns allow-once when canUseTool allows", async () => {
    const canUseTool: CanUseTool = vi.fn(async () => ({
      behavior: "allow" as const,
    }));
    const bridge = createCanUseToolBridge({
      canUseTool,
      permissionMode: "default",
    });
    const decision = await bridge.approvalHandler!(makeRequest());
    expect(decision).toBe("allow-once");
    expect(bridge.pendingDenials.size).toBe(0);
  });

  it("records denial message and returns deny when canUseTool denies", async () => {
    const canUseTool: CanUseTool = async () => ({
      behavior: "deny",
      message: "nope",
    });
    const bridge = createCanUseToolBridge({
      canUseTool,
      permissionMode: "default",
    });
    const decision = await bridge.approvalHandler!(
      makeRequest({ toolCallId: "c9" }),
    );
    expect(decision).toBe("deny");
    expect(bridge.pendingDenials.get("c9")).toEqual({ message: "nope" });
  });

  it("treats a thrown error as deny and records the error message", async () => {
    const canUseTool: CanUseTool = async () => {
      throw new Error("boom");
    };
    const bridge = createCanUseToolBridge({
      canUseTool,
      permissionMode: "default",
    });
    const decision = await bridge.approvalHandler!(
      makeRequest({ toolCallId: "c7" }),
    );
    expect(decision).toBe("deny");
    expect(bridge.pendingDenials.get("c7")).toEqual({ message: "boom" });
  });

  it("records a generic message when a non-Error is thrown", async () => {
    const canUseTool: CanUseTool = async () => {
      throw "string failure";
    };
    const bridge = createCanUseToolBridge({
      canUseTool,
      permissionMode: "default",
    });
    await bridge.approvalHandler!(makeRequest({ toolCallId: "c8" }));
    expect(bridge.pendingDenials.get("c8")).toEqual({
      message: "canUseTool threw an error",
    });
  });

  it("throws when ToolApprovalRequest has no toolCallId", async () => {
    const canUseTool: CanUseTool = async () => ({ behavior: "allow" as const });
    const bridge = createCanUseToolBridge({
      canUseTool,
      permissionMode: "default",
    });
    await expect(
      bridge.approvalHandler!(makeRequest({ toolCallId: undefined })),
    ).rejects.toThrow(/toolCallId/);
  });

  it("parses rawArgs JSON and forwards toolUseId + signal to canUseTool", async () => {
    const ac = new AbortController();
    const canUseTool = vi.fn(async () => ({ behavior: "allow" as const }));
    const bridge = createCanUseToolBridge({
      canUseTool,
      permissionMode: "default",
      abortController: ac,
    });
    await bridge.approvalHandler!(
      makeRequest({
        toolName: "Write",
        toolCallId: "cc",
        rawArgs: '{"path":"a.txt"}',
      }),
    );
    expect(canUseTool).toHaveBeenCalledWith(
      "Write",
      { path: "a.txt" },
      { toolUseId: "cc", signal: ac.signal },
    );
  });

  it("falls back to {} for invalid JSON rawArgs", async () => {
    const canUseTool = vi.fn(async () => ({ behavior: "allow" as const }));
    const bridge = createCanUseToolBridge({
      canUseTool,
      permissionMode: "default",
    });
    await bridge.approvalHandler!(
      makeRequest({ rawArgs: "not json", toolCallId: "z" }),
    );
    expect(canUseTool).toHaveBeenCalledWith(
      "Bash",
      {},
      expect.objectContaining({ toolUseId: "z" }),
    );
  });

  it("onTurnBoundary clears recorded denials", async () => {
    const canUseTool: CanUseTool = async () => ({
      behavior: "deny",
      message: "x",
    });
    const bridge = createCanUseToolBridge({
      canUseTool,
      permissionMode: "default",
    });
    await bridge.approvalHandler!(makeRequest({ toolCallId: "k" }));
    expect(bridge.pendingDenials.size).toBe(1);
    bridge.onTurnBoundary();
    expect(bridge.pendingDenials.size).toBe(0);
  });
});

describe("filterToolSpecsByAllowedNames", () => {
  function spec(name: string): ToolSpec {
    return {
      definition: { type: "function", function: { name, parameters: {} } },
    } as unknown as ToolSpec;
  }

  it("returns the original list when allowedTools is undefined", () => {
    const specs = [spec("Read"), spec("Bash")];
    expect(filterToolSpecsByAllowedNames(specs, undefined)).toBe(specs);
  });

  it("returns the original list when allowedTools is empty", () => {
    const specs = [spec("Read")];
    expect(filterToolSpecsByAllowedNames(specs, [])).toBe(specs);
  });

  it("keeps only specs whose name is in allowedTools", () => {
    const specs = [spec("Read"), spec("Bash"), spec("Write")];
    const result = filterToolSpecsByAllowedNames(specs, ["Read", "Write"]);
    expect(result.map((s) => s.definition.function.name)).toEqual([
      "Read",
      "Write",
    ]);
  });

  it("drops everything when no spec matches", () => {
    const specs = [spec("Read")];
    expect(filterToolSpecsByAllowedNames(specs, ["Nonexistent"])).toEqual([]);
  });
});
