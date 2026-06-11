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
      "packages/**/src/**/*.test.ts",
      "extensions/**/src/**/*.test.ts",
      "skills/**/src/**/*.test.ts",
      "tests/**/*.test.ts",
    ],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json", "html"],
      include: [
        "packages/utils/src/**/*.ts",
        "packages/core/src/policy/**/*.ts",
        "packages/core/src/tools/**/*.ts",
        "packages/core/src/agent/agent-presets.ts",
        "packages/core/src/agent/delegation-view.ts",
        "packages/core/src/agent/harness-context.ts",
        "packages/core/src/agent/state-machine.ts",
        "packages/agent-sdk/src/**/*.ts",
        "extensions/llm/src/**/*.ts",
        "extensions/mcp/src/**/*.ts",
        "skills/builtin/src/apply-patch.ts",
        "skills/builtin/src/command-output.ts",
        "src/bootstrap/config/loader.ts",
        "src/bootstrap/config/defaults.ts",
        "src/runtime/runtime-config.ts",
        "src/runtime/runtime-utils.ts",
      ],
      exclude: ["**/*.test.ts", "**/*.spec.ts", "dist/**", "node_modules/**"],
      thresholds: {
        // Baseline thresholds for tested core modules.
        // Raise incrementally as coverage expands to more files.
        statements: 50,
        branches: 60,
      },
    },
  },
  resolve: {
    alias: aliases,
  },
});
