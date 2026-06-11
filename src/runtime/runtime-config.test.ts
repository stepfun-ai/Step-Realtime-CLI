import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveStepCliRuntimeConfig } from "./runtime-config.js";

// Mock model-limits to avoid network requests during tests.
// resolveCachedModelTokenLimits probes the default API endpoint when no
// config/env is set, which hangs until AbortController timeout (5s).
vi.mock("../bootstrap/config/model-limits.js", async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import("../bootstrap/config/model-limits.js")
    >();
  return {
    ...actual,
    resolveCachedModelTokenLimits: vi.fn().mockResolvedValue(null),
  };
});

describe("runtime config", () => {
  let tempDir: string;
  let originalEnv: NodeJS.ProcessEnv;
  let configPath: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "step-cli-runtime-"));
    configPath = path.join(tempDir, "config.json");
    originalEnv = { ...process.env };
    // Clear step-related env vars so they don't interfere
    for (const key of Object.keys(process.env)) {
      if (key.startsWith("STEP_") || key.startsWith("STEPCLI_")) {
        delete process.env[key];
      }
    }
    // Always create an empty config as baseline to isolate from user's real config
    await fs.writeFile(configPath, "{}");
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
    process.env = originalEnv;
  });

  async function writeConfig(config: Record<string, unknown>) {
    await fs.writeFile(configPath, JSON.stringify(config, null, 2));
  }

  function resolve(overrides: Record<string, unknown> = {}) {
    return resolveStepCliRuntimeConfig({
      options: {
        workspace: tempDir,
        config: configPath,
        resume: false,
        altScreen: false,
        json: false,
        verbose: false,
        ...overrides,
      },
      cliOptionSources: {
        ...(((overrides as Record<string, unknown>).cliOptionSources ??
          {}) as Record<string, unknown>),
      },
      resumeSession: false,
      useAlternateScreen: false,
      interactionSurface: "headless",
    } as Parameters<typeof resolveStepCliRuntimeConfig>[0]);
  }

  it("resolves defaults when no config or env vars", async () => {
    const result = await resolve();
    const cfg = result.stepCliConfig;

    expect(result.workspaceRoot).toBe(path.resolve(tempDir));
    // provider is undefined when no config/provider/env is set — resolved as openai at runtime
    expect(cfg.model).toBe("step/native");
    expect(cfg.baseUrl).toBe("https://api.stepfun.com/v1");
    expect(cfg.mode).toBe("normal");
    expect(cfg.maxSteps).toBe(Infinity);
    expect(cfg.temperature).toBe(0.2);
  });

  it("resolves from environment variables", async () => {
    process.env.STEP_MODEL = "env-model";
    process.env.STEP_BASE_URL = "https://env.example.com";
    process.env.STEP_API_KEY = "env-api-key";
    process.env.STEP_MODEL_PROVIDER = "anthropic";

    const result = await resolve();
    const cfg = result.stepCliConfig;

    expect(cfg.model).toBe("env-model");
    expect(cfg.baseUrl).toBe("https://env.example.com");
    expect(cfg.apiKey).toBe("env-api-key");
    expect(cfg.provider).toBe("anthropic");
  });

  it("resolves from config file", async () => {
    await writeConfig({
      model: {
        model: "config-model",
        provider: "openai",
        baseUrl: "https://config.example.com",
        apiKey: "config-key",
      },
      agent: {
        mode: "plan",
        maxSteps: 50,
        temperature: 0.7,
      },
    });

    const result = await resolve();
    const cfg = result.stepCliConfig;

    expect(cfg.model).toBe("config-model");
    expect(cfg.baseUrl).toBe("https://config.example.com");
    expect(cfg.apiKey).toBe("config-key");
    expect(cfg.provider).toBe("openai");
    expect(cfg.mode).toBe("plan");
    expect(cfg.maxSteps).toBe(50);
    expect(cfg.temperature).toBe(0.7);
  });

  it("CLI options override config file", async () => {
    await writeConfig({
      model: {
        model: "config-model",
        provider: "openai",
        baseUrl: "https://config.example.com",
      },
      agent: {
        maxSteps: 50,
        temperature: 0.7,
      },
    });

    const result = await resolveStepCliRuntimeConfig({
      options: {
        workspace: tempDir,
        config: configPath,
        model: "cli-model",
        provider: "anthropic",
        baseUrl: "https://cli.example.com",
        apiKey: "cli-key",
        maxSteps: 100,
        temperature: 0.1,
        resume: false,
        altScreen: false,
        json: false,
        verbose: false,
      },
      cliOptionSources: {
        model: "cli",
        provider: "cli",
        baseUrl: "cli",
        apiKey: "cli",
        maxSteps: "cli",
        temperature: "cli",
      },
      resumeSession: false,
      useAlternateScreen: false,
      interactionSurface: "headless",
    });
    const cfg = result.stepCliConfig;

    expect(cfg.model).toBe("cli-model");
    expect(cfg.baseUrl).toBe("https://cli.example.com");
    expect(cfg.apiKey).toBe("cli-key");
    expect(cfg.provider).toBe("anthropic");
    expect(cfg.maxSteps).toBe(100);
    expect(cfg.temperature).toBe(0.1);
  });

  it("environment variables override config file", async () => {
    process.env.STEP_MODEL = "env-model";
    process.env.STEP_BASE_URL = "https://env.example.com";
    await writeConfig({
      model: {
        model: "config-model",
        baseUrl: "https://config.example.com",
      },
    });

    const result = await resolve();
    const cfg = result.stepCliConfig;

    expect(cfg.model).toBe("env-model");
    expect(cfg.baseUrl).toBe("https://env.example.com");
  });

  it("resolves storage root directory", async () => {
    const result = await resolveStepCliRuntimeConfig({
      options: {
        workspace: tempDir,
        config: configPath,
        storageRootDir: "~/.custom-storage",
        resume: false,
        altScreen: false,
        json: false,
        verbose: false,
      },
      cliOptionSources: {
        storageRootDir: "cli",
      },
      resumeSession: false,
      useAlternateScreen: false,
      interactionSurface: "headless",
    });

    expect(result.stepCliConfig.storageRootDir).toContain(".custom-storage");
  });

  it("resolves interaction profile for json headless", async () => {
    // When json:true and no surfaceOverride, surface resolves to "json"
    const result = await resolveStepCliRuntimeConfig({
      options: {
        workspace: tempDir,
        config: configPath,
        resume: false,
        altScreen: false,
        json: true,
        verbose: false,
      },
      cliOptionSources: {},
      resumeSession: false,
      useAlternateScreen: false,
      // Don't pass interactionSurface so json:true takes effect
    });
    expect(result.stepCliConfig.interactionProfile.surface).toBe("json");
  });

  it("resolves interaction profile for interactive", async () => {
    const result = await resolveStepCliRuntimeConfig({
      options: {
        workspace: tempDir,
        config: configPath,
        resume: false,
        altScreen: true,
        json: false,
        verbose: false,
      },
      cliOptionSources: {},
      resumeSession: false,
      useAlternateScreen: true,
      interactionSurface: "interactive",
    });
    expect(result.stepCliConfig.interactionProfile.surface).toBe("interactive");
  });

  it("resolves useAlternateScreen from config when interaction is interactive", async () => {
    await writeConfig({
      clients: {
        tui: {
          altScreen: true,
        },
      },
    });

    const result = await resolveStepCliRuntimeConfig({
      options: {
        workspace: tempDir,
        config: configPath,
        resume: false,
        altScreen: false,
        json: false,
        verbose: false,
      },
      cliOptionSources: {},
      resumeSession: false,
      // When surface is "interactive", useAlternateScreen defaults to true
      // if not explicitly provided
      interactionSurface: "interactive",
    });

    expect(result.stepCliConfig.useAlternateScreen).toBe(true);
  });

  it("resolves tool permission overrides", async () => {
    await writeConfig({
      tools: {
        approval: {
          overrides: {
            "dangerous-tool": "deny",
            "safe-tool": "allow",
          },
        },
      },
    });

    const result = await resolveStepCliRuntimeConfig({
      options: {
        workspace: tempDir,
        config: configPath,
        toolOverride: { "extra-tool": "confirm" },
        resume: false,
        altScreen: false,
        json: false,
        verbose: false,
      },
      cliOptionSources: {
        toolOverride: "cli",
      } as any,
      resumeSession: false,
      useAlternateScreen: false,
      interactionSurface: "headless",
    });

    expect(result.stepCliConfig.toolPermissionOverrides).toEqual({
      "dangerous-tool": "deny",
      "safe-tool": "allow",
      "extra-tool": "confirm",
    });
  });

  it("resolves MCP servers from config", async () => {
    await writeConfig({
      integrations: {
        mcp: {
          servers: {
            "test-server": {
              command: "node",
              args: ["server.js"],
            },
          },
        },
      },
    });

    const result = await resolve();
    const cfg = result.stepCliConfig;

    expect(cfg.mcpServers?.["test-server"]).toBeDefined();
    expect(cfg.mcpServers?.["test-server"]?.command).toBe("node");
  });

  it("resolves agent presets from config", async () => {
    await writeConfig({
      agents: {
        presets: [
          {
            name: "reviewer",
            targetHarnessKind: "subagent",
          },
        ],
      },
    });

    const result = await resolve();
    const cfg = result.stepCliConfig;

    expect(cfg.agentPresets).toHaveLength(1);
    expect(cfg.agentPresets?.[0]?.name).toBe("reviewer");
  });

  it("resolves verbose flag", async () => {
    const result = await resolveStepCliRuntimeConfig({
      options: {
        workspace: tempDir,
        config: configPath,
        resume: false,
        altScreen: false,
        json: false,
        verbose: true,
      },
      cliOptionSources: {},
      resumeSession: false,
      useAlternateScreen: false,
      interactionSurface: "headless",
    });
    expect(result.stepCliConfig.verbose).toBe(true);
  });

  it("resolves resume session flag", async () => {
    const result = await resolveStepCliRuntimeConfig({
      options: {
        workspace: tempDir,
        config: configPath,
        resume: true,
        altScreen: false,
        json: false,
        verbose: false,
      },
      cliOptionSources: {},
      resumeSession: true,
      useAlternateScreen: false,
      interactionSurface: "headless",
    });
    expect(result.stepCliConfig.resumeSession).toBe(true);
  });

  it("resolves autoSaveSession from config", async () => {
    await writeConfig({
      session: {
        autosave: false,
      },
    });

    const result = await resolve();
    expect(result.stepCliConfig.autoSaveSession).toBe(false);
  });

  it("resolves session trace settings from config", async () => {
    await writeConfig({
      session: {
        trace: {
          enabled: true,
          keepLast: 100,
          maxBodyBytes: 2000000,
          headerInjectionBaseUrls: ["https://example.com"],
        },
      },
    });

    const result = await resolve();
    const cfg = result.stepCliConfig;

    expect(cfg.sessionTraceEnabled).toBe(true);
    expect(cfg.sessionTraceKeepLast).toBe(100);
    expect(cfg.sessionTraceMaxBodyBytes).toBe(2000000);
    expect(cfg.sessionTraceHeaderInjectionBaseUrls).toEqual([
      "https://example.com",
    ]);
  });

  it("falls back to builtin defaults for session trace", async () => {
    const result = await resolve();
    const cfg = result.stepCliConfig;

    expect(cfg.sessionTraceEnabled).toBe(true);
    expect(cfg.sessionTraceKeepLast).toBe(200);
    expect(cfg.sessionTraceMaxBodyBytes).toBe(1048576);
  });

  it("resolves TUI scroll config", async () => {
    await writeConfig({
      clients: {
        tui: {
          scroll: {
            scrollSpeed: 3,
          },
        },
      },
    });

    const result = await resolve();
    expect(result.stepCliConfig.tuiScroll).toBeDefined();
    expect(result.stepCliConfig.tuiScroll?.scrollSpeed).toBe(3);
  });

  it("resolves skills directory name", async () => {
    await writeConfig({
      workspace: {
        skillsDirName: "custom-skills",
      },
    });

    const result = await resolve();
    expect(result.stepCliConfig.skillsDirectoryName).toBe("custom-skills");
  });

  it("resolves plugins directory", async () => {
    await writeConfig({
      workspace: {
        pluginsDir: "custom-plugins",
      },
    });

    const result = await resolve();
    // pluginsDir is stored as-is from config
    expect(result.stepCliConfig.pluginsDir).toBe("custom-plugins");
  });

  it("handles explicit config path", async () => {
    const explicitPath = path.join(tempDir, "explicit-config.json");
    await fs.writeFile(
      explicitPath,
      JSON.stringify({
        model: {
          model: "explicit-model",
        },
      }),
    );

    const result = await resolveStepCliRuntimeConfig({
      options: {
        workspace: tempDir,
        config: explicitPath,
        resume: false,
        altScreen: false,
        json: false,
        verbose: false,
      },
      cliOptionSources: {},
      resumeSession: false,
      useAlternateScreen: false,
      interactionSurface: "headless",
    });

    expect(result.stepCliConfig.model).toBe("explicit-model");
  });

  it("handles STEPCLI_CONFIG_PATH env var", async () => {
    const explicitPath = path.join(tempDir, "env-config.json");
    await fs.writeFile(
      explicitPath,
      JSON.stringify({
        model: {
          model: "env-config-model",
        },
      }),
    );
    process.env.STEPCLI_CONFIG_PATH = explicitPath;

    // Don't use resolve() helper since we want env var to drive config path
    const result = await resolveStepCliRuntimeConfig({
      options: {
        workspace: tempDir,
        resume: false,
        altScreen: false,
        json: false,
        verbose: false,
      },
      cliOptionSources: {},
      resumeSession: false,
      useAlternateScreen: false,
      interactionSurface: "headless",
    });

    expect(result.stepCliConfig.model).toBe("env-config-model");
  });

  it("resolves model request retries", async () => {
    await writeConfig({
      agent: {
        retries: {
          modelRequest: 5,
        },
      },
    });

    const result = await resolve();
    expect(result.stepCliConfig.modelRequestRetries).toBe(5);
  });

  it("resolves tool execution retries", async () => {
    await writeConfig({
      agent: {
        retries: {
          toolExecution: 3,
        },
      },
    });

    const result = await resolve();
    expect(result.stepCliConfig.toolExecutionRetries).toBe(3);
  });

  it("resolves max tool result context chars", async () => {
    await writeConfig({
      tools: {
        maxResultContextChars: 5000,
      },
    });

    const result = await resolve();
    expect(result.stepCliConfig.maxToolResultCharsInContext).toBe(5000);
  });

  it("resolves command timeout and output limit", async () => {
    await writeConfig({
      tools: {
        commandTimeoutMs: 60000,
        commandOutputLimit: 80000,
      },
    });

    const result = await resolve();
    const cfg = result.stepCliConfig;

    expect(cfg.commandTimeoutMs).toBe(60000);
    expect(cfg.commandOutputLimit).toBe(80000);
  });

  it("resolves repeated tool call limit", async () => {
    await writeConfig({
      tools: {
        repeatedCallLimit: 5,
      },
    });

    const result = await resolve();
    expect(result.stepCliConfig.repeatedToolCallLimit).toBe(5);
  });

  it("resolves parallel tool calls setting", async () => {
    await writeConfig({
      tools: {
        parallelCalls: false,
      },
    });

    const result = await resolve();
    expect(result.stepCliConfig.parallelToolCalls).toBe(false);
  });

  it("resolves code mode setting", async () => {
    await writeConfig({
      tools: {
        codeMode: false,
      },
    });

    const result = await resolve();
    expect(result.stepCliConfig.codeMode).toBe(false);
  });

  it("resolves tool presentation profile", async () => {
    await writeConfig({
      tools: {
        presentation: {
          profile: "raw",
          aliasSeed: "test-seed",
          descriptionStyle: "simple",
        },
      },
    });

    const result = await resolve();
    const cfg = result.stepCliConfig;

    expect(cfg.toolPresentationProfile).toBe("raw");
    expect(cfg.toolAliasSeed).toBe("test-seed");
    expect(cfg.toolDescriptionStyle).toBe("simple");
  });

  it("resolves approval mode", async () => {
    await writeConfig({
      tools: {
        approval: {
          mode: "auto",
          nonInteractive: "allow",
        },
      },
    });

    const result = await resolve();
    const cfg = result.stepCliConfig;

    expect(cfg.approvalMode).toBe("auto");
    expect(cfg.nonInteractiveApproval).toBe("allow");
  });

  it("resolves max user clarifications per turn", async () => {
    await writeConfig({
      agent: {
        maxUserClarificationsPerTurn: 5,
      },
    });

    const result = await resolve();
    expect(result.stepCliConfig.maxUserClarificationsPerTurn).toBe(5);
  });

  it("resolves anthropic thinking budget tokens", async () => {
    await writeConfig({
      model: {
        reasoning: {
          anthropicThinkingBudgetTokens: 32000,
        },
      },
    });

    const result = await resolve();
    expect(result.stepCliConfig.anthropicThinkingBudgetTokens).toBe(32000);
  });

  it("resolves openai reasoning effort", async () => {
    await writeConfig({
      model: {
        reasoning: {
          openaiReasoningEffort: "low",
        },
      },
    });

    const result = await resolve();
    expect(result.stepCliConfig.openaiReasoningEffort).toBe("low");
  });

  it("resolves model timeout", async () => {
    await writeConfig({
      model: {
        timeoutMs: 300000,
      },
    });

    const result = await resolve();
    expect(result.stepCliConfig.timeoutMs).toBe(300000);
  });

  it("resolves token limits from config", async () => {
    await writeConfig({
      model: {
        tokens: {
          maxContext: 80000,
          maxOutput: 16000,
          minOutput: 256,
          outputSafetyMargin: 512,
        },
      },
    });

    const result = await resolve();
    const cfg = result.stepCliConfig;

    expect(cfg.maxContextTokens).toBe(80000);
    expect(cfg.maxOutputTokens).toBe(16000);
    expect(cfg.minOutputTokens).toBe(256);
    expect(cfg.outputTokenSafetyMargin).toBe(512);
  });

  it("resolves system prompt profile", async () => {
    await writeConfig({
      agent: {
        systemPromptProfile: "minimal",
      },
    });

    const result = await resolve();
    expect(result.stepCliConfig.systemPromptProfile).toBe("minimal");
  });

  it("resolves agent operating mode", async () => {
    await writeConfig({
      agent: {
        mode: "plan",
      },
    });

    const result = await resolve();
    expect(result.stepCliConfig.mode).toBe("plan");
  });
});
