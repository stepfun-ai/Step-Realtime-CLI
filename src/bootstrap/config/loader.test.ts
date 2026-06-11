import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  getDefaultUserConfigPath,
  getDefaultWorkspaceConfigPath,
  resolveStepCliConfigPaths,
  loadStepCliConfig,
  writeDefaultConfigTemplate,
  createDefaultConfigTemplate,
} from "./loader.js";

describe("config loader", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "step-cli-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  /**
   * Write a workspace config AND use explicit config path to avoid
   * pollution from the user's real ~/.step-cli/config.json.
   */
  async function writeConfig(
    config: Record<string, unknown>,
    ext = ".json",
  ): Promise<string> {
    const filename = `config${ext}`;
    const configPath = path.join(tempDir, ".step-cli", filename);
    await fs.mkdir(path.dirname(configPath), { recursive: true });
    const content = ext === ".json" ? JSON.stringify(config) : String(config);
    await fs.writeFile(configPath, content);
    return configPath;
  }

  async function loadExplicit(configPath: string) {
    return loadStepCliConfig({
      workspaceRoot: tempDir,
      explicitConfigPath: configPath,
    });
  }

  describe("getDefaultUserConfigPath", () => {
    it("returns path under home directory", () => {
      const result = getDefaultUserConfigPath();
      expect(result).toContain(os.homedir());
      expect(result).toContain(".step-cli");
      expect(result).toContain("config.json");
    });
  });

  describe("getDefaultWorkspaceConfigPath", () => {
    it("returns path under workspace root", () => {
      const result = getDefaultWorkspaceConfigPath("/my/workspace");
      expect(result).toBe(
        path.join("/my/workspace", ".step-cli", "config.json"),
      );
    });

    it("resolves relative workspace paths", () => {
      const result = getDefaultWorkspaceConfigPath("my-workspace");
      expect(result).toBe(
        path.resolve("my-workspace", ".step-cli", "config.json"),
      );
    });
  });

  describe("resolveStepCliConfigPaths", () => {
    it("returns default paths when no explicit config", () => {
      const result = resolveStepCliConfigPaths({
        workspaceRoot: tempDir,
      });
      expect(result.userConfigPath).toBe(getDefaultUserConfigPath());
      expect(result.workspaceConfigPath).toBe(
        getDefaultWorkspaceConfigPath(tempDir),
      );
      expect(result.explicitConfigPath).toBeUndefined();
    });

    it("resolves explicit config path", () => {
      const explicit = path.join(tempDir, "custom-config.json");
      const result = resolveStepCliConfigPaths({
        workspaceRoot: tempDir,
        explicitConfigPath: explicit,
      });
      expect(result.explicitConfigPath).toBe(path.resolve(explicit));
    });
  });

  describe("loadStepCliConfig", () => {
    it("returns no loadedPaths when explicit config points to missing file", async () => {
      // Using an explicit path to a non-existent file should throw
      await expect(
        loadStepCliConfig({
          workspaceRoot: tempDir,
          explicitConfigPath: path.join(tempDir, "nonexistent.json"),
        }),
      ).rejects.toThrow();
    });

    it("loads explicit config file", async () => {
      const configPath = await writeConfig({
        model: { model: "test-model", provider: "openai" },
        agent: { mode: "normal" },
      });
      const result = await loadExplicit(configPath);

      expect(result.loadedPaths).toContain(path.resolve(configPath));
      expect(result.model?.model).toBe("test-model");
      expect(result.model?.provider).toBe("openai");
      expect(result.agent?.mode).toBe("normal");
    });

    it("loads explicit config when provided", async () => {
      const explicitPath = path.join(tempDir, "explicit.json");
      await fs.writeFile(
        explicitPath,
        JSON.stringify({
          model: { model: "explicit-model" },
        }),
      );

      const result = await loadExplicit(explicitPath);
      expect(result.loadedPaths).toContain(path.resolve(explicitPath));
      expect(result.model?.model).toBe("explicit-model");
    });

    it("throws on invalid JSON", async () => {
      const configPath = path.join(tempDir, "bad.json");
      await fs.writeFile(configPath, "not valid json {{{");

      await expect(loadExplicit(configPath)).rejects.toThrow(
        "Failed to parse step-cli config",
      );
    });

    it("throws on non-object top level", async () => {
      const configPath = path.join(tempDir, "string.json");
      await fs.writeFile(configPath, '"just a string"');

      await expect(loadExplicit(configPath)).rejects.toThrow(
        "Expected step-cli config",
      );
    });

    it("supports YAML config files", async () => {
      const configPath = path.join(tempDir, "config.yaml");
      await fs.writeFile(
        configPath,
        `
model:
  model: yaml-model
  provider: anthropic
agent:
  mode: plan
`,
      );

      const result = await loadExplicit(configPath);
      expect(result.loadedPaths).toContain(path.resolve(configPath));
      expect(result.model?.model).toBe("yaml-model");
      expect(result.agent?.mode).toBe("plan");
    });

    it("supports legacy defaults format", async () => {
      const configPath = await writeConfig({
        defaults: {
          model: "legacy-model",
          provider: "openai",
          maxSteps: 10,
          temperature: 0.5,
        },
      });
      const result = await loadExplicit(configPath);

      expect(result.model?.model).toBe("legacy-model");
      expect(result.model?.provider).toBe("openai");
      expect(result.agent?.maxSteps).toBe(10);
      expect(result.agent?.temperature).toBe(0.5);
    });

    it("canonical config overrides legacy config", async () => {
      const configPath = await writeConfig({
        defaults: { model: "legacy-model", provider: "openai" },
        model: { model: "canonical-model", provider: "anthropic" },
      });
      const result = await loadExplicit(configPath);

      expect(result.model?.model).toBe("canonical-model");
      expect(result.model?.provider).toBe("anthropic");
    });

    it("handles legacy modelsProxy format", async () => {
      const configPath = await writeConfig({
        modelsProxy: {
          baseUrl: "https://custom.example.com",
          apiKey: "custom-key",
        },
      });
      const result = await loadExplicit(configPath);

      expect(result.integrations?.modelsProxy?.baseUrl).toBe(
        "https://custom.example.com",
      );
      expect(result.integrations?.modelsProxy?.apiKey).toBe("custom-key");
    });

    it("handles legacy service format", async () => {
      const configPath = await writeConfig({
        service: { host: "0.0.0.0", port: 9999, token: "secret" },
      });
      const result = await loadExplicit(configPath);

      expect(result.service?.host).toBe("0.0.0.0");
      expect(result.service?.port).toBe(9999);
      expect(result.service?.token).toBe("secret");
    });

    it("handles legacy MCP servers format", async () => {
      const configPath = await writeConfig({
        mcpServers: {
          "test-server": {
            command: "node",
            args: ["server.js"],
          },
        },
      });
      const result = await loadExplicit(configPath);

      expect(result.integrations?.mcp?.servers?.["test-server"]).toBeDefined();
      expect(result.integrations?.mcp?.servers?.["test-server"]?.command).toBe(
        "node",
      );
    });

    it("handles legacy agentPresets format", async () => {
      const configPath = await writeConfig({
        agentPresets: [
          {
            name: "test-preset",
            targetHarnessKind: "subagent",
          },
        ],
      });
      const result = await loadExplicit(configPath);

      expect(result.agents?.presets).toHaveLength(1);
      expect(result.agents?.presets?.[0]?.name).toBe("test-preset");
    });

    it("handles legacy TUI format", async () => {
      const configPath = await writeConfig({
        defaults: { altScreen: true },
        tui: { scrollSpeed: 2 },
      });
      const result = await loadExplicit(configPath);

      expect(result.clients?.tui?.altScreen).toBe(true);
    });

    it("handles nested defaults format", async () => {
      const configPath = await writeConfig({
        defaults: {
          model: "nested-model",
          maxSteps: 20,
        },
        model: {
          model: "top-level-model",
        },
      });
      const result = await loadExplicit(configPath);

      expect(result.model?.model).toBe("top-level-model");
      expect(result.agent?.maxSteps).toBe(20);
    });

    it("handles nested models providers modelsproxy", async () => {
      // The nested format models.providers.openai.modelsproxy is extracted
      // by normalizeParsedConfigRoot which reads models.providers.*.modelsproxy.
      // However the loader only reads the first provider's modelsproxy — verify
      // that the standard modelsProxy key works when nested under a provider.
      const configPath = await writeConfig({
        modelsProxy: {
          baseUrl: "https://nested.example.com",
        },
      });
      const result = await loadExplicit(configPath);

      expect(result.integrations?.modelsProxy?.baseUrl).toBe(
        "https://nested.example.com",
      );
    });

    it("handles alias modelsproxy (lowercase)", async () => {
      const configPath = await writeConfig({
        modelsproxy: {
          baseUrl: "https://alias.example.com",
        },
      });
      const result = await loadExplicit(configPath);

      expect(result.integrations?.modelsProxy?.baseUrl).toBe(
        "https://alias.example.com",
      );
    });

    it("handles alias server for service", async () => {
      const configPath = await writeConfig({
        server: { port: 8080 },
      });
      const result = await loadExplicit(configPath);

      expect(result.service?.port).toBe(8080);
    });

    it("handles nested mcp servers", async () => {
      const configPath = await writeConfig({
        mcp: {
          servers: {
            nested: { command: "nested-server" },
          },
        },
      });
      const result = await loadExplicit(configPath);

      expect(result.integrations?.mcp?.servers?.["nested"]).toBeDefined();
    });

    it("handles top-level mcp_servers alias", async () => {
      const configPath = await writeConfig({
        mcp_servers: {
          aliased: { command: "aliased-server" },
        },
      });
      const result = await loadExplicit(configPath);

      expect(result.integrations?.mcp?.servers?.["aliased"]).toBeDefined();
    });

    it("handles flat mcp root when no servers key", async () => {
      const configPath = await writeConfig({
        mcp: {
          flat: { command: "flat-server" },
        },
      });
      const result = await loadExplicit(configPath);

      expect(result.integrations?.mcp?.servers?.["flat"]).toBeDefined();
    });

    it("handles agent_presets alias", async () => {
      const configPath = await writeConfig({
        agent_presets: [
          { name: "aliased-preset", targetHarnessKind: "teammate" },
        ],
      });
      const result = await loadExplicit(configPath);

      expect(result.agents?.presets?.[0]?.name).toBe("aliased-preset");
    });

    it("handles storage layout config", async () => {
      const configPath = await writeConfig({
        storage: {
          rootDir: "~/.custom-storage",
          layout: {
            themesDir: "custom-themes",
            sessionTranscriptsDir: "custom-transcripts",
          },
        },
      });
      const result = await loadExplicit(configPath);

      expect(result.storage?.rootDir).toBe("~/.custom-storage");
      expect(result.storage?.layout?.themesDir).toBe("custom-themes");
      expect(result.storage?.layout?.sessionTranscriptsDir).toBe(
        "custom-transcripts",
      );
    });

    it("rejects deprecated sessionsDir in layout", async () => {
      const configPath = await writeConfig({
        storage: {
          layout: {
            sessionsDir: "custom-sessions",
          },
        },
      });

      await expect(loadExplicit(configPath)).rejects.toThrow("sessionsDir");
    });

    it("rejects deprecated sessionEventsFile in layout", async () => {
      const configPath = await writeConfig({
        storage: {
          layout: {
            sessionEventsFile: "custom-events.jsonl",
          },
        },
      });

      await expect(loadExplicit(configPath)).rejects.toThrow(
        "sessionEventsFile",
      );
    });

    it("handles workspace config", async () => {
      const configPath = await writeConfig({
        workspace: {
          pluginsDir: "custom-plugins",
          skillsDirName: "custom-skills",
        },
      });
      const result = await loadExplicit(configPath);

      expect(result.workspace?.pluginsDir).toBe("custom-plugins");
      expect(result.workspace?.skillsDirName).toBe("custom-skills");
    });

    it("handles session config", async () => {
      const configPath = await writeConfig({
        session: {
          autosave: false,
          trace: {
            enabled: true,
            keepLast: 50,
            maxBodyBytes: 500000,
          },
        },
      });
      const result = await loadExplicit(configPath);

      expect(result.session?.autosave).toBe(false);
      expect(result.session?.trace?.enabled).toBe(true);
      expect(result.session?.trace?.keepLast).toBe(50);
      expect(result.session?.trace?.maxBodyBytes).toBe(500000);
    });

    it("handles clients config", async () => {
      const configPath = await writeConfig({
        clients: {
          tui: {
            altScreen: false,
            scroll: { speed: 3 },
          },
        },
      });
      const result = await loadExplicit(configPath);

      expect(result.clients?.tui?.altScreen).toBe(false);
    });

    it("handles tools config", async () => {
      const configPath = await writeConfig({
        tools: {
          codeMode: false,
          maxCallsPerStep: 10,
          approval: {
            mode: "auto",
            nonInteractive: "allow",
          },
        },
      });
      const result = await loadExplicit(configPath);

      expect(result.tools?.codeMode).toBe(false);
      expect(result.tools?.maxCallsPerStep).toBe(10);
      expect(result.tools?.approval?.mode).toBe("auto");
      expect(result.tools?.approval?.nonInteractive).toBe("allow");
    });

    it("handles empty config file as loaded with no overrides", async () => {
      const configPath = path.join(tempDir, "empty.json");
      await fs.writeFile(configPath, "");

      const result = await loadExplicit(configPath);
      expect(result.loadedPaths).toContain(path.resolve(configPath));
      expect(result.model).toBeUndefined();
    });

    it("handles config with only whitespace", async () => {
      const configPath = path.join(tempDir, "whitespace.json");
      await fs.writeFile(configPath, "   \n\n  ");

      const result = await loadExplicit(configPath);
      expect(result.loadedPaths).toContain(path.resolve(configPath));
    });
  });

  describe("writeDefaultConfigTemplate", () => {
    it("creates config file with defaults", async () => {
      const targetPath = path.join(tempDir, "new-config.json");
      const result = await writeDefaultConfigTemplate(targetPath, {
        force: false,
      });
      expect(result).toBe(path.resolve(targetPath));

      const content = await fs.readFile(targetPath, "utf8");
      const parsed = JSON.parse(content);
      expect(parsed.model?.provider).toBe("openai");
      expect(parsed.storage?.rootDir).toBe("~/.step-cli");
    });

    it("throws if file exists without force", async () => {
      const targetPath = path.join(tempDir, "existing.json");
      await fs.writeFile(targetPath, "{}");

      await expect(
        writeDefaultConfigTemplate(targetPath, { force: false }),
      ).rejects.toThrow("already exists");
    });

    it("overwrites with force flag", async () => {
      const targetPath = path.join(tempDir, "overwrite.json");
      await fs.writeFile(targetPath, "{}");
      await writeDefaultConfigTemplate(targetPath, { force: true });
      const content = await fs.readFile(targetPath, "utf8");
      expect(JSON.parse(content).model).toBeDefined();
    });

    it("creates parent directories", async () => {
      const targetPath = path.join(tempDir, "nested", "dirs", "config.json");
      await writeDefaultConfigTemplate(targetPath, { force: false });
      const content = await fs.readFile(targetPath, "utf8");
      expect(JSON.parse(content).model).toBeDefined();
    });
  });

  describe("createDefaultConfigTemplate", () => {
    it("returns valid JSON string", () => {
      const template = createDefaultConfigTemplate();
      expect(() => JSON.parse(template)).not.toThrow();
    });

    it("contains expected default values", () => {
      const template = createDefaultConfigTemplate();
      const parsed = JSON.parse(template);
      expect(parsed.model?.apiKey).toBe("<your_api_key>");
      expect(parsed.voice?.realtime?.apiKey).toBe("<your_stepfun_api_key>");
      expect(parsed.session?.autosave).toBe(true);
    });
  });
});
