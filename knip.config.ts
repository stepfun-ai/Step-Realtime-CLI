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
  ],
  ignoreExportsUsedInFile: true,
  treatConfigHintsAsErrors: false,
};

export default config;
