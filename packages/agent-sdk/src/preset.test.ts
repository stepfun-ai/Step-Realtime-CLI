import { describe, it, expect } from "vitest";
import { resolvePresetToolSpecs } from "./preset.js";

describe("resolvePresetToolSpecs", () => {
  it('returns non-empty array for "stepfun_code"', () => {
    const specs = resolvePresetToolSpecs("stepfun_code");
    expect(specs.length).toBeGreaterThan(0);
  });

  it("returns empty array for unsupported preset", () => {
    const specs = resolvePresetToolSpecs("nonexistent" as never);
    expect(specs).toEqual([]);
  });

  it("each spec has valid name, security, parseArgs, execute", () => {
    const specs = resolvePresetToolSpecs("stepfun_code");
    for (const spec of specs) {
      expect(spec.definition.function.name).toBeTruthy();
      expect(spec.security).toBeDefined();
      expect(typeof spec.parseArgs).toBe("function");
      expect(typeof spec.execute).toBe("function");
    }
  });

  it("not-supported stubs execute returns { ok: false, error: { code: 'TOOL_NOT_SUPPORTED' } }", async () => {
    const specs = resolvePresetToolSpecs("stepfun_code");
    const taskSpec = specs.find((s) => s.definition.function.name === "Task");
    expect(taskSpec).toBeDefined();
    const result = await taskSpec!.execute({}, {} as never, {} as never);
    expect(result.ok).toBe(false);
    expect(result.error?.code).toBe("TOOL_NOT_SUPPORTED");
  });
});

describe("preset memory stubs", () => {
  const specs = resolvePresetToolSpecs("stepfun_code");
  const byName = (name: string) =>
    specs.find((s) => s.definition.function.name === name)!;
  const run = (name: string, args: unknown) =>
    byName(name).execute(args, {} as never, {} as never);

  it("TodoWrite records and returns ok", async () => {
    const result = await run("TodoWrite", { todos: [] });
    expect(result.ok).toBe(true);
    expect(result.summary).toContain("recorded");
  });

  it("ExitPlanMode acknowledges with ok", async () => {
    const result = await run("ExitPlanMode", {});
    expect(result.ok).toBe(true);
  });

  it("ListMcpResources returns an empty list", async () => {
    const result = await run("ListMcpResources", {});
    expect(result.ok).toBe(true);
    expect(result.summary).toBe("[]");
  });

  it("TaskList reports no tasks before any are created", async () => {
    const result = await run("TaskList", {});
    expect(result.summary).toBe("(no tasks)");
  });

  it("TaskCreate / TaskGet / TaskUpdate / TaskList lifecycle", async () => {
    const created = await run("TaskCreate", { subject: "do work" });
    expect(created.ok).toBe(true);
    expect(created.summary).toContain("#1");

    const fetched = await run("TaskGet", { taskId: "1" });
    expect(fetched.ok).toBe(true);
    expect(fetched.summary).toContain("do work");
    expect(fetched.summary).toContain("pending");

    const updated = await run("TaskUpdate", { taskId: "1", status: "done" });
    expect(updated.ok).toBe(true);

    const afterUpdate = await run("TaskGet", { taskId: "1" });
    expect(afterUpdate.summary).toContain("done");

    const listed = await run("TaskList", {});
    expect(listed.ok).toBe(true);
    expect(listed.summary).toContain("do work");
  });

  it("TaskCreate uses a placeholder subject when none provided", async () => {
    const created = await run("TaskCreate", {});
    expect(created.ok).toBe(true);
    const id = created.summary!.match(/#(\d+)/)![1];
    const fetched = await run("TaskGet", { taskId: id });
    expect(fetched.summary).toContain("(no subject)");
  });

  it("TaskGet returns ok:false for an unknown id", async () => {
    const result = await run("TaskGet", { taskId: "999" });
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("not found");
  });

  it("TaskUpdate returns ok:false for an unknown id", async () => {
    const result = await run("TaskUpdate", { taskId: "999", status: "x" });
    expect(result.ok).toBe(false);
    expect(result.summary).toContain("not found");
  });
});

describe("preset stub parseArgs", () => {
  const specs = resolvePresetToolSpecs("stepfun_code");
  const byName = (name: string) =>
    specs.find((s) => s.definition.function.name === name)!;

  it("returns {} for empty / whitespace rawArgs", () => {
    expect(byName("TodoWrite").parseArgs("")).toEqual({});
    expect(byName("TodoWrite").parseArgs("   ")).toEqual({});
  });

  it("parses valid JSON rawArgs", () => {
    expect(byName("TaskCreate").parseArgs('{"subject":"a"}')).toEqual({
      subject: "a",
    });
  });

  it("throws a descriptive error for invalid JSON", () => {
    expect(() => byName("TaskCreate").parseArgs("{not json")).toThrow(
      /Failed to parse TaskCreate arguments/,
    );
  });
});

describe("preset not-supported stubs", () => {
  const specs = resolvePresetToolSpecs("stepfun_code");
  const notSupportedNames = [
    "Task",
    "WebFetch",
    "WebSearch",
    "AskUserQuestion",
    "NotebookEdit",
    "NotebookRead",
    "BashOutput",
    "KillBash",
    "ReadMcpResource",
    "EnterWorktree",
    "ExitWorktree",
  ];

  it.each(notSupportedNames)(
    "%s returns ok:false with TOOL_NOT_SUPPORTED and a Do-not-retry hint",
    async (name) => {
      const spec = specs.find((s) => s.definition.function.name === name)!;
      const result = await spec.execute({}, {} as never, {} as never);
      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe("TOOL_NOT_SUPPORTED");
      expect(result.summary).toMatch(
        /[Dd]o not retry|not supported|not available|not yet implemented/,
      );
    },
  );
});
