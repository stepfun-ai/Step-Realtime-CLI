import type { KnipConfig } from "knip";

const config: KnipConfig = {
  workspaces: {
    ".": {
      entry: ["src/index.ts", "src/gateway/index.ts"],
      project: ["src/**/*.ts", "src/**/*.tsx"],
      ignoreFiles: [
        "src/runtime/open-tui-capability-bundle.ts",
        // CJS-bundle stubs aliased in scripts/build-binary-bundle.mjs.
        "src/commands/voice-command-bundle.ts",
        "src/commands/vad-command-bundle.ts",
        "src/tui/components/**",
      ],
    },
    "extensions/llm": {
      project: ["src/**/*.ts"],
    },
    "extensions/mcp": {
      project: ["src/**/*.ts"],
    },
    "packages/core": {
      project: ["src/**/*.ts"],
    },
    ui: {
      project: ["src/**/*.tsx"],
    },
  },
  ignoreDependencies: [
    "ts-prune",
    "ts-unused-exports",
    "@opentui/core-darwin-arm64",
    "@opentui/core-darwin-x64",
    "@opentui/core-linux-arm64",
    "@opentui/core-linux-x64",
    "@opentui/core-win32-x64",
    // Optional VAD plugin dep, loaded at runtime via a widened dynamic import
    // (see realtime-vad-silero/silero-adapter.ts); knip can't see the indirect
    // specifier.
    "avr-vad",
    // @step-cli/agent-sdk is consumed by extensions/realtime-voice (not matched by
    // the root workspace's src/**/*.ts project glob), so knip flags it as unused
    // from the root perspective even though it is a valid workspace dependency.
    "@step-cli/agent-sdk",
  ],
  ignoreIssues: {
    // rg (ripgrep) is an external system binary spawned by shell-tools.ts;
    // not a Node.js package binary declared in package.json.
    "packages/core/src/tools/native-impls/shell-tools.ts": ["binaries"],
  },
  ignoreExportsUsedInFile: true,
  treatConfigHintsAsErrors: false,
};

export default config;
