import { describe, it, expect, vi, beforeEach } from "vitest";
import { ToolPolicy } from "./tool-policy.js";
import type { ToolSpec, ToolCallInspection } from "@step-cli/protocol";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock("../agent/harness-context.js", () => ({
  getHarnessContext: vi.fn(() => undefined),
}));

vi.mock("../tools/security.js", () => ({
  getToolSecurityIssue: vi.fn(() => null),
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeToolSpec(overrides: {
  name: string;
  risk: "read" | "write" | "execute" | "meta";
  defaultMode?: "allow" | "confirm" | "deny";
}): ToolSpec {
  return {
    definition: {
      type: "function",
      function: { name: overrides.name, parameters: {} },
    },
    security: {
      risk: overrides.risk,
      defaultMode: overrides.defaultMode,
    },
    parseArgs: vi.fn(),
    execute: vi.fn(),
  } as unknown as ToolSpec;
}

describe("ToolPolicy", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -- Constructor & getters --

  it("exposes mode and nonInteractiveBehavior from constructor config", () => {
    const policy = new ToolPolicy({
      mode: "confirm",
      nonInteractiveApproval: "deny",
    });
    expect(policy.getMode()).toBe("confirm");
    expect(policy.getNonInteractiveBehavior()).toBe("deny");
  });

  // -- setMode / getMode --

  it("reflects mode changes via setMode", () => {
    const policy = new ToolPolicy({
      mode: "confirm",
      nonInteractiveApproval: "deny",
    });
    policy.setMode("auto");
    expect(policy.getMode()).toBe("auto");
    policy.setMode("strict");
    expect(policy.getMode()).toBe("strict");
  });

  // -- Override management --

  it("manages overrides: set, clear, get copy, exportConfig round-trip", () => {
    const policy = new ToolPolicy({
      mode: "confirm",
      nonInteractiveApproval: "deny",
      overrides: { bash: "allow" },
    });

    // getOverrides returns a copy
    const overrides = policy.getOverrides();
    expect(overrides).toEqual({ bash: "allow" });
    overrides["read_file"] = "deny";
    expect(policy.getOverrides()).toEqual({ bash: "allow" });

    // setOverride adds new
    policy.setOverride("read_file", "deny");
    expect(policy.getOverrides()).toEqual({ bash: "allow", read_file: "deny" });

    // clearOverride removes
    policy.clearOverride("bash");
    expect(policy.getOverrides()).toEqual({ read_file: "deny" });

    // exportConfig round-trip
    const exported = policy.exportConfig();
    expect(exported).toEqual({
      mode: "confirm",
      nonInteractiveApproval: "deny",
      overrides: { read_file: "deny" },
    });
  });

  it("copies overrides in constructor so mutating the original config does not affect the policy", () => {
    const originalOverrides: Record<string, "allow" | "confirm" | "deny"> = {
      bash: "allow",
    };
    const policy = new ToolPolicy({
      mode: "auto",
      nonInteractiveApproval: "allow",
      overrides: originalOverrides,
    });

    // Mutate the original
    originalOverrides["read_file"] = "deny";
    expect(policy.getOverrides()).toEqual({ bash: "allow" });
  });

  // -- evaluate: unregistered tool --

  it("returns deny for unregistered tools (spec=undefined)", () => {
    const policy = new ToolPolicy({
      mode: "auto",
      nonInteractiveApproval: "allow",
    });
    const decision = policy.evaluate("unknown_tool", "{}", undefined);
    expect(decision.mode).toBe("deny");
    expect(decision.reason).toContain("not registered");
  });

  // -- evaluate: security issue --

  it("returns deny when getToolSecurityIssue reports a problem", async () => {
    const { getToolSecurityIssue } = await import("../tools/security.js");
    vi.mocked(getToolSecurityIssue).mockReturnValueOnce(
      "dangerous tool detected",
    );

    const policy = new ToolPolicy({
      mode: "auto",
      nonInteractiveApproval: "allow",
    });
    const spec = makeToolSpec({ name: "danger", risk: "write" });
    const decision = policy.evaluate("danger", "{}", spec);
    expect(decision.mode).toBe("deny");
    expect(decision.reason).toBe("dangerous tool detected");
  });

  // -- evaluate: dangerous command patterns --

  it("denies dangerous command: rm -rf /", () => {
    const policy = new ToolPolicy({
      mode: "auto",
      nonInteractiveApproval: "allow",
    });
    const spec = makeToolSpec({ name: "bash", risk: "execute" });
    const inspection: ToolCallInspection = { command: "rm -rf /" };
    const decision = policy.evaluate("bash", "{}", spec, inspection);
    expect(decision.mode).toBe("deny");
    expect(decision.reason).toContain("dangerous command");
  });

  it("denies dangerous command: shutdown", () => {
    const policy = new ToolPolicy({
      mode: "auto",
      nonInteractiveApproval: "allow",
    });
    const spec = makeToolSpec({ name: "bash", risk: "execute" });
    const inspection: ToolCallInspection = { command: "sudo shutdown now" };
    const decision = policy.evaluate("bash", "{}", spec, inspection);
    expect(decision.mode).toBe("deny");
  });

  it("denies dangerous command: reboot", () => {
    const policy = new ToolPolicy({
      mode: "auto",
      nonInteractiveApproval: "allow",
    });
    const spec = makeToolSpec({ name: "bash", risk: "execute" });
    const inspection: ToolCallInspection = { command: "reboot" };
    const decision = policy.evaluate("bash", "{}", spec, inspection);
    expect(decision.mode).toBe("deny");
  });

  it("denies dangerous command: mkfs", () => {
    const policy = new ToolPolicy({
      mode: "auto",
      nonInteractiveApproval: "allow",
    });
    const spec = makeToolSpec({ name: "bash", risk: "execute" });
    const inspection: ToolCallInspection = { command: "mkfs.ext4 /dev/sda1" };
    const decision = policy.evaluate("bash", "{}", spec, inspection);
    expect(decision.mode).toBe("deny");
  });

  it("denies dangerous command: dd if=", () => {
    const policy = new ToolPolicy({
      mode: "auto",
      nonInteractiveApproval: "allow",
    });
    const spec = makeToolSpec({ name: "bash", risk: "execute" });
    const inspection: ToolCallInspection = {
      command: "dd if=/dev/zero of=/dev/sda",
    };
    const decision = policy.evaluate("bash", "{}", spec, inspection);
    expect(decision.mode).toBe("deny");
  });

  it("denies encoded destructive shell commands", () => {
    const policy = new ToolPolicy({
      mode: "confirm",
      nonInteractiveApproval: "deny",
    });
    const spec = makeToolSpec({ name: "bash", risk: "execute" });
    const inspection: ToolCallInspection = {
      command: "bash -c 'cm0gLXJmIC8= | base64 -d | sh'",
    };

    const decision = policy.evaluate("bash", "{}", spec, inspection);
    expect(decision.mode).toBe("deny");
    expect(decision.reason).toMatch(/dangerous command/i);
  });

  it("allows benign encoded text", () => {
    const policy = new ToolPolicy({
      mode: "confirm",
      nonInteractiveApproval: "deny",
    });
    const spec = makeToolSpec({ name: "bash", risk: "execute" });
    const inspection: ToolCallInspection = { command: "echo SGVsbG8=" };

    const decision = policy.evaluate("bash", "{}", spec, inspection);
    expect(decision.mode).toBe("confirm");
  });

  it("denies destructive rm paths beyond filesystem root", () => {
    const policy = new ToolPolicy({
      mode: "auto",
      nonInteractiveApproval: "allow",
    });
    const spec = makeToolSpec({ name: "bash", risk: "execute" });
    const inspection: ToolCallInspection = { command: "rm -rf /tmp/test" };

    const decision = policy.evaluate("bash", "{}", spec, inspection);
    expect(decision.mode).toBe("deny");
    expect(decision.reason).toMatch(/dangerous command/i);
  });

  it("denies destructive rm variants with split force and recursive flags", () => {
    const policy = new ToolPolicy({
      mode: "auto",
      nonInteractiveApproval: "allow",
    });
    const spec = makeToolSpec({ name: "bash", risk: "execute" });

    for (const command of [
      "rm -r -f /tmp/test",
      "rm -r --force /tmp/test",
      "rm --recursive --force /tmp/test",
    ]) {
      const inspection: ToolCallInspection = { command };
      const decision = policy.evaluate("bash", "{}", spec, inspection);
      expect(decision.mode).toBe("deny");
      expect(decision.reason).toMatch(/dangerous command/i);
    }
  });

  it("denies destructive find delete variants", () => {
    const policy = new ToolPolicy({
      mode: "auto",
      nonInteractiveApproval: "allow",
    });
    const spec = makeToolSpec({ name: "bash", risk: "execute" });
    const inspection: ToolCallInspection = {
      command: "find / -mindepth 1 -delete",
    };

    const decision = policy.evaluate("bash", "{}", spec, inspection);
    expect(decision.mode).toBe("deny");
    expect(decision.reason).toMatch(/dangerous command/i);
  });

  it("denies destructive workspace wipe variants", () => {
    const policy = new ToolPolicy({
      mode: "auto",
      nonInteractiveApproval: "allow",
    });
    const spec = makeToolSpec({ name: "bash", risk: "execute" });
    const inspection: ToolCallInspection = {
      command: "find . -mindepth 1 -delete",
    };

    const decision = policy.evaluate("bash", "{}", spec, inspection);
    expect(decision.mode).toBe("deny");
    expect(decision.reason).toMatch(/dangerous command/i);
  });

  it("denies git clean forced delete variants", () => {
    const policy = new ToolPolicy({
      mode: "auto",
      nonInteractiveApproval: "allow",
    });
    const spec = makeToolSpec({ name: "bash", risk: "execute" });
    const inspection: ToolCallInspection = { command: "git clean -fdx" };

    const decision = policy.evaluate("bash", "{}", spec, inspection);
    expect(decision.mode).toBe("deny");
    expect(decision.reason).toMatch(/dangerous command/i);
  });

  it("denies git clean forced delete variants regardless of short flag order", () => {
    const policy = new ToolPolicy({
      mode: "auto",
      nonInteractiveApproval: "allow",
    });
    const spec = makeToolSpec({ name: "bash", risk: "execute" });

    for (const command of ["git clean -xdf", "git clean -x -d -f"]) {
      const inspection: ToolCallInspection = { command };
      const decision = policy.evaluate("bash", "{}", spec, inspection);
      expect(decision.mode).toBe("deny");
      expect(decision.reason).toMatch(/dangerous command/i);
    }
  });

  // -- Per-tool override precedence --

  it("per-tool override takes precedence over mode-based decision", () => {
    const policy = new ToolPolicy({
      mode: "strict",
      nonInteractiveApproval: "deny",
      overrides: { bash: "allow" },
    });
    const spec = makeToolSpec({ name: "bash", risk: "execute" });
    const decision = policy.evaluate("bash", "{}", spec);
    expect(decision.mode).toBe("allow");
    expect(decision.reason).toContain("override");
  });

  // -- "auto" mode --

  it('"auto" mode allows all tools after security check passes', () => {
    const policy = new ToolPolicy({
      mode: "auto",
      nonInteractiveApproval: "allow",
    });
    const spec = makeToolSpec({ name: "bash", risk: "execute" });
    const decision = policy.evaluate("bash", "{}", spec);
    expect(decision.mode).toBe("allow");
    expect(decision.reason).toContain("Auto-approval");
  });

  // -- "strict" mode --

  it('"strict" mode denies write tools', () => {
    const policy = new ToolPolicy({
      mode: "strict",
      nonInteractiveApproval: "deny",
    });
    const spec = makeToolSpec({ name: "write_file", risk: "write" });
    const decision = policy.evaluate("write_file", "{}", spec);
    expect(decision.mode).toBe("deny");
    expect(decision.reason).toContain("Strict");
  });

  it('"strict" mode denies execute tools', () => {
    const policy = new ToolPolicy({
      mode: "strict",
      nonInteractiveApproval: "deny",
    });
    const spec = makeToolSpec({ name: "bash", risk: "execute" });
    const decision = policy.evaluate("bash", "{}", spec);
    expect(decision.mode).toBe("deny");
  });

  it('"strict" mode allows read tools', () => {
    const policy = new ToolPolicy({
      mode: "strict",
      nonInteractiveApproval: "deny",
    });
    const spec = makeToolSpec({ name: "read_file", risk: "read" });
    const decision = policy.evaluate("read_file", "{}", spec);
    expect(decision.mode).toBe("allow");
  });

  it('"strict" mode allows meta tools', () => {
    const policy = new ToolPolicy({
      mode: "strict",
      nonInteractiveApproval: "deny",
    });
    const spec = makeToolSpec({ name: "list_tools", risk: "meta" });
    const decision = policy.evaluate("list_tools", "{}", spec);
    expect(decision.mode).toBe("allow");
  });

  // -- "confirm" mode --

  it('"confirm" mode uses tool defaultMode when set', () => {
    const policy = new ToolPolicy({
      mode: "confirm",
      nonInteractiveApproval: "deny",
    });
    const spec = makeToolSpec({
      name: "safe_read",
      risk: "read",
      defaultMode: "allow",
    });
    const decision = policy.evaluate("safe_read", "{}", spec);
    expect(decision.mode).toBe("allow");
    expect(decision.reason).toContain("default policy");
  });

  it('"confirm" mode confirms write tools when no defaultMode set', () => {
    const policy = new ToolPolicy({
      mode: "confirm",
      nonInteractiveApproval: "deny",
    });
    const spec = makeToolSpec({ name: "write_file", risk: "write" });
    const decision = policy.evaluate("write_file", "{}", spec);
    expect(decision.mode).toBe("confirm");
  });

  it('"confirm" mode confirms execute tools when no defaultMode set', () => {
    const policy = new ToolPolicy({
      mode: "confirm",
      nonInteractiveApproval: "deny",
    });
    const spec = makeToolSpec({ name: "bash", risk: "execute" });
    const decision = policy.evaluate("bash", "{}", spec);
    expect(decision.mode).toBe("confirm");
  });

  it('"confirm" mode allows read tools when no defaultMode set', () => {
    const policy = new ToolPolicy({
      mode: "confirm",
      nonInteractiveApproval: "deny",
    });
    const spec = makeToolSpec({ name: "read_file", risk: "read" });
    const decision = policy.evaluate("read_file", "{}", spec);
    expect(decision.mode).toBe("allow");
  });

  it('"confirm" mode allows meta tools when no defaultMode set', () => {
    const policy = new ToolPolicy({
      mode: "confirm",
      nonInteractiveApproval: "deny",
    });
    const spec = makeToolSpec({ name: "list_tools", risk: "meta" });
    const decision = policy.evaluate("list_tools", "{}", spec);
    expect(decision.mode).toBe("allow");
  });
});
