import { describe, it, expect, vi } from "vitest";
import { PluginManager } from "./manager.js";
import type { LoadedToolPlugin } from "./types.js";

function createPlugin(
  id: string,
  hooks: LoadedToolPlugin["plugin"]["hooks"] = {},
): LoadedToolPlugin {
  return {
    plugin: {
      id,
      hooks,
      description: `Test plugin ${id}`,
      register: () => [],
    },
    source: "builtin",
  };
}

describe("PluginManager", () => {
  describe("listPluginIds", () => {
    it("returns ids of all registered plugins", () => {
      const manager = new PluginManager([
        createPlugin("p1"),
        createPlugin("p2"),
      ]);
      expect(manager.listPluginIds()).toEqual(["p1", "p2"]);
    });
  });

  describe("getPlugins", () => {
    it("returns a copy of the plugins array", () => {
      const plugins = [createPlugin("a")];
      const manager = new PluginManager(plugins);
      const result = manager.getPlugins();
      expect(result).toHaveLength(1);
      expect(result).not.toBe(plugins);
    });
  });

  describe("runBeforeModelRequest", () => {
    it("collects injected messages from hooks", async () => {
      const plugin = createPlugin("injector", {
        beforeModelRequest: vi.fn().mockResolvedValue({
          messages: [{ role: "system", content: "hint" }],
        }),
      });

      const manager = new PluginManager([plugin]);
      const result = await manager.runBeforeModelRequest({} as never);
      expect(result.messages).toHaveLength(1);
      expect(result.messages![0]!.content).toBe("hint");
    });

    it("catches hook errors and reports warnings", async () => {
      const plugin = createPlugin("broken", {
        beforeModelRequest: vi.fn().mockRejectedValue(new Error("boom")),
      });

      const manager = new PluginManager([plugin]);
      const result = await manager.runBeforeModelRequest({} as never);
      expect(result.warnings).toBeDefined();
      expect(result.warnings![0]).toContain("boom");
      expect(result.messages).toBeUndefined();
    });

    it("skips non-system messages with a warning", async () => {
      const plugin = createPlugin("bad-role", {
        beforeModelRequest: vi.fn().mockResolvedValue({
          messages: [{ role: "assistant", content: "nope" }],
        }),
      });

      const manager = new PluginManager([plugin]);
      const result = await manager.runBeforeModelRequest({} as never);
      expect(result.warnings).toBeDefined();
      expect(result.messages).toBeUndefined();
    });
  });

  describe("close", () => {
    it("calls shutdown on plugins in reverse order", async () => {
      const order: string[] = [];
      const p1 = createPlugin("first");
      p1.plugin.shutdown = vi.fn().mockImplementation(async () => {
        order.push("first");
      });
      const p2 = createPlugin("second");
      p2.plugin.shutdown = vi.fn().mockImplementation(async () => {
        order.push("second");
      });

      const manager = new PluginManager([p1, p2]);
      await manager.close("done");
      expect(order).toEqual(["second", "first"]);
    });

    it("continues closing even if one plugin throws", async () => {
      const p1 = createPlugin("good");
      p1.plugin.shutdown = vi.fn();
      const p2 = createPlugin("bad");
      p2.plugin.shutdown = vi.fn().mockRejectedValue(new Error("fail"));

      const manager = new PluginManager([p1, p2]);
      await manager.close();
      expect(p1.plugin.shutdown).toHaveBeenCalled();
    });

    it("only runs shutdown once", async () => {
      const p1 = createPlugin("once");
      p1.plugin.shutdown = vi.fn();

      const manager = new PluginManager([p1]);
      await manager.close();
      await manager.close();
      expect(p1.plugin.shutdown).toHaveBeenCalledTimes(1);
    });
  });

  describe("exportState / loadState", () => {
    it("round-trips state through export and load", () => {
      const p1 = createPlugin("stateful");
      let stored: unknown = { count: 42 };
      p1.plugin.exportState = () => stored;
      p1.plugin.loadState = (state: unknown) => {
        stored = state;
      };

      const manager = new PluginManager([p1]);
      const snapshot = manager.exportState();
      expect(snapshot).toEqual({ stateful: { count: 42 } });

      manager.loadState({ stateful: { count: 100 } });
      expect(stored).toEqual({ count: 100 });
    });
  });
});
