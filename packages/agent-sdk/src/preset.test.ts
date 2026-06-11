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
