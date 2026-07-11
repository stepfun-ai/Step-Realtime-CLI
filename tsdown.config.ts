import { defineConfig } from "tsdown";

const runtimeBundleBuild = process.env.STEPCLI_RUNTIME_BUNDLE_BUILD === "1";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    core: "packages/core/src/index.ts",
    "runtime/local-tui-app": "src/runtime/local-tui-app.ts",
    "runtime/local-opentui-entry": "src/runtime/local-opentui-entry.tsx",
  },
  noExternal: [/^@step-cli\//],
  format: runtimeBundleBuild ? ["esm"] : ["esm", "cjs"],
  dts: false,
  clean: true,
  sourcemap: true,
  minify: process.env.NODE_ENV === "production",
  banner: { js: "#!/usr/bin/env node" },
  platform: "node",
  outDir: "dist",
});
