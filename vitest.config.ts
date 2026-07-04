import { defineConfig } from "vitest/config";
import path from "node:path";

/**
 * Build alias entries that support both top-level (@step-cli/pkg)
 * and deep imports (@step-cli/pkg/sub/module.js -> src/sub/module.ts).
 */
function stepAlias(pkgName: string, srcDir: string): Record<string, string> {
  // Deep import MUST come first (more specific) so vite matches it
  // before the top-level catch-all.
  return {
    [`@step-cli/${pkgName}/`]: path.resolve(__dirname, srcDir) + "/",
    [`@step-cli/${pkgName}`]: path.resolve(__dirname, srcDir, "index.ts"),
  };
}

const aliases: Record<string, string> = {
  ...stepAlias("protocol", "packages/protocol/src"),
  ...stepAlias("utils", "packages/utils/src"),
  ...stepAlias("core", "packages/core/src"),
  ...stepAlias("llm", "extensions/llm/src"),
  ...stepAlias("mcp", "extensions/mcp/src"),
  ...stepAlias("sdk", "packages/sdk/src"),
  ...stepAlias("agent-sdk", "packages/agent-sdk/src"),
  ...stepAlias("realtime", "packages/realtime/src"),
  ...stepAlias("realtime-aec", "extensions/realtime-aec/src"),
  ...stepAlias("realtime-voice", "extensions/realtime-voice/src"),
  ...stepAlias("realtime-vad-silero", "extensions/realtime-vad-silero/src"),
  ...stepAlias("skills-builtin", "skills/builtin/src"),
};

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: [
      "src/**/*.test.ts",
      "scripts/**/*.test.ts",
      "packages/**/src/**/*.test.ts",
      "extensions/**/src/**/*.test.ts",
      "skills/**/src/**/*.test.ts",
      "tests/**/*.test.ts",
    ],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html", "lcov"],
      include: [
        "packages/utils/src/**/*.ts",
        "packages/core/src/policy/**/*.ts",
        "packages/core/src/tools/args.ts",
        "packages/core/src/tools/grouped-surface.ts",
        "packages/core/src/tools/presentation.ts",
        "packages/core/src/tools/presentation-profile.ts",
        "packages/core/src/tools/security.ts",
        "packages/core/src/agent/agent-presets.ts",
        "packages/core/src/agent/context-window.ts",
        "packages/core/src/agent/conversation-memory-checkpoint.ts",
        "packages/core/src/agent/delegation-view.ts",
        "packages/core/src/agent/harness-context.ts",
        "packages/core/src/agent/state-machine.ts",
        "packages/core/src/max-steps.ts",
        "packages/agent-sdk/src/**/*.ts",
        "packages/realtime/src/capability/schema.ts",
        "packages/realtime/src/vad/energy-adapter.ts",
        "packages/realtime/src/vad/resolver.ts",
        "extensions/llm/src/**/*.ts",
        "extensions/mcp/src/manager.ts",
        "extensions/mcp/src/tool-plugin.ts",
        "skills/builtin/src/apply-patch.ts",
        "skills/builtin/src/command-output.ts",
        "skills/builtin/src/tool-inspection.ts",
        "skills/builtin/src/tool-result-truncation.ts",
        "src/bootstrap/config/loader.ts",
        "src/bootstrap/config/defaults.ts",
        "src/commands/option-parsers.ts",
        "src/gateway/storage/layout.ts",
        "src/gateway/verifier.ts",
        "src/runtime/runtime-config.ts",
        "src/runtime/runtime-utils.ts",
      ],
      exclude: ["**/*.test.ts", "**/*.spec.ts", "dist/**", "node_modules/**"],
      thresholds: {
        statements: 80,
        branches: 80,
        perFile: true,
        // Module-specific thresholds for high-risk areas
        "packages/core/src/agent/**/*.ts": { statements: 70, branches: 65 },
        "packages/core/src/tools/**/*.ts": { statements: 65, branches: 60 },
        "packages/realtime/src/**/*.ts": { statements: 75, branches: 70 },
      },
    },
  },
  resolve: {
    alias: aliases,
  },
});
