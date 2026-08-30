import { describe, it, expect } from "vitest";
import {
  renderCellResult,
  type CellStatus,
  type NestedToolCall,
  type RunningCell,
} from "./service.js";

function makeCall(overrides?: Partial<NestedToolCall>): NestedToolCall {
  return {
    toolName: "run_command",
    identifier: "run_command",
    ok: true,
    summary: "Command completed",
    ...overrides,
  };
}

function makeCell(overrides?: Partial<RunningCell>): RunningCell {
  return {
    id: "cell-test-1",
    startedAt: Date.now(),
    code: "const r = await tools.run_command({command: 'ls'});",
    abortController: new AbortController(),
    consoleLines: [],
    status: "completed",
    nestedCalls: [],
    completion: Promise.resolve(),
    ...overrides,
  };
}

function render(status: CellStatus, cell: RunningCell) {
  return renderCellResult({ cell, status, commandOutputLimit: 8000 });
}

describe("renderCellResult structured feedback", () => {
  it("reports all-successful completions without failure noise", () => {
    const cell = makeCell({
      nestedCalls: [makeCall(), makeCall({ toolName: "read_file" })],
    });
    const result = render("completed", cell);
    expect(result.ok).toBe(true);
    expect(result.summary).toBe("Script completed · 2 tool calls");
    expect(result.data?.failedToolCalls).toBe(0);
    expect(result.content).not.toContain("failed");
  });

  it("surfaces per-call failure reasons that were previously hidden", () => {
    const cell = makeCell({
      nestedCalls: [
        makeCall(),
        makeCall({
          ok: false,
          summary:
            "Command failed with exit code 1: cat: missing.txt: No such file",
          inputHint: "cat missing.txt",
        }),
      ],
    });
    const result = render("completed", cell);
    expect(result.ok).toBe(true);
    expect(result.summary).toBe(
      "Script completed · 2 tool calls, 1 failed tool call",
    );
    expect(result.data?.failedToolCalls).toBe(1);
    expect(result.content).toContain(
      "✗ run_command cat missing.txt — Command failed with exit code 1",
    );
  });

  it("disambiguates no-return diagnostics when tool calls failed", () => {
    const cell = makeCell({
      nestedCalls: [
        makeCall({ ok: false, summary: "Command failed with exit code 2" }),
      ],
    });
    const result = render("completed", cell);
    expect(result.content).toContain("tool-level failures, not timeouts");
    expect(result.content).toContain(
      "Script completed without a returned result.",
    );
  });

  it("keeps the plain no-return diagnostic when nothing failed", () => {
    const cell = makeCell();
    const result = render("completed", cell);
    expect(result.content).toContain(
      "Script completed without a returned result.",
    );
    expect(result.content).not.toContain("not timeouts");
  });

  it("shows grouped failure reasons when calls exceed the per-call limit", () => {
    const calls: NestedToolCall[] = [];
    for (let index = 0; index < 6; index += 1) {
      calls.push(makeCall({ inputHint: `attempt-${index}` }));
    }
    for (let index = 0; index < 4; index += 1) {
      calls.push(
        makeCall({
          ok: false,
          summary: "Command failed with exit code 1",
          inputHint: `failing-${index}`,
        }),
      );
    }
    const cell = makeCell({ nestedCalls: calls });
    const result = render("completed", cell);
    expect(result.content).toMatch(/6\/10 run_command ×10/);
    expect(result.content).toContain("✗ Command failed with exit code 1");
  });

  it("keeps failed script status reporting intact", () => {
    const cell = makeCell({ errorText: "TypeError: boom" });
    const result = render("failed", cell);
    expect(result.ok).toBe(false);
    expect(result.summary).toBe("Script failed");
    expect(result.content).toContain("TypeError: boom");
  });
});
