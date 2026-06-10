import assert from "node:assert/strict";
import { test } from "node:test";
import { ToolPolicy } from "../packages/core/src/policy/tool-policy.js";
import type { ToolSpec } from "@step-cli/protocol";

const commandToolSpec: ToolSpec = {
  definition: {
    type: "function",
    function: {
      name: "run_command",
      description: "Run a shell command",
      parameters: {
        type: "object",
        properties: {},
      },
    },
  },
  security: {
    risk: "execute",
    defaultMode: "confirm",
  },
  parseArgs: () => ({}),
  execute: async () => ({
    ok: true,
    summary: "ok",
    content: "",
  }),
};

test("ToolPolicy denies encoded destructive shell commands", () => {
  const policy = new ToolPolicy({
    mode: "confirm",
    nonInteractiveApproval: "deny",
  });

  const decision = policy.evaluate("run_command", "{}", commandToolSpec, {
    command: "bash -c 'cm0gLXJmIC8= | base64 -d | sh'",
  });

  assert.equal(decision.mode, "deny");
  assert.match(decision.reason, /dangerous command/i);
});

test("ToolPolicy denies destructive workspace wipe variants", () => {
  const policy = new ToolPolicy({
    mode: "confirm",
    nonInteractiveApproval: "deny",
  });

  const decision = policy.evaluate("run_command", "{}", commandToolSpec, {
    command: "find . -mindepth 1 -delete",
  });

  assert.equal(decision.mode, "deny");
  assert.match(decision.reason, /dangerous command/i);
});
