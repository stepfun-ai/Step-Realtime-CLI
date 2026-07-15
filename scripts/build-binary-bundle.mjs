import fs from "node:fs/promises";
import path from "node:path";
import { builtinModules } from "node:module";
import { build } from "rolldown";

const repoRoot = process.cwd();
const outDir = path.join(repoRoot, "dist", "bin");
const bundlePath = path.join(outDir, "step-bundle.cjs");
const buildVersion = normalizeCliBuildVersion(
  process.env.STEP_CLI_BUILD_VERSION || (await readPackageVersion(repoRoot)),
);
const builtinSet = new Set(
  builtinModules.flatMap((name) =>
    name.startsWith("node:") ? [name, name.slice(5)] : [name, `node:${name}`],
  ),
);

if (process.argv.includes("--help")) {
  process.stdout.write(
    [
      "Usage: node scripts/build-binary-bundle.mjs",
      "",
      "Builds a single-file CommonJS bundle for the CLI binary path.",
    ].join("\n") + "\n",
  );
  process.exit(0);
}

await fs.mkdir(outDir, { recursive: true });

await build({
  cwd: repoRoot,
  input: path.join(repoRoot, "src", "index.ts"),
  platform: "node",
  treeshake: true,
  external: (id) => builtinSet.has(id),
  resolve: {
    tsconfigFilename: path.join(repoRoot, "tsconfig.json"),
    extensionAlias: {
      ".js": [".ts", ".js"],
      ".mjs": [".mts", ".mjs"],
      ".cjs": [".cts", ".cjs"],
    },
    alias: {
      "../runtime/open-tui-capability.js": path.join(
        repoRoot,
        "src",
        "runtime",
        "open-tui-capability-bundle.ts",
      ),
      "./voice-command.js": path.join(
        repoRoot,
        "src",
        "commands",
        "voice-command-bundle.ts",
      ),
      "./vad-command.js": path.join(
        repoRoot,
        "src",
        "commands",
        "vad-command-bundle.ts",
      ),
    },
  },
  define: {
    "process.env.STEP_CLI_BUILD_VERSION": JSON.stringify(buildVersion),
  },
  output: {
    file: bundlePath,
    format: "cjs",
    inlineDynamicImports: true,
    sourcemap: true,
  },
});

const bundleContent = await fs.readFile(bundlePath, "utf8");
const normalizedBundleContent = bundleContent.replace(
  /^(#!\/usr\/bin\/env node\r?\n)+/,
  "#!/usr/bin/env node\n",
);
if (normalizedBundleContent !== bundleContent) {
  await fs.writeFile(bundlePath, normalizedBundleContent, "utf8");
}

process.stdout.write(
  `Built CLI binary bundle: ${path.relative(repoRoot, bundlePath)}\n`,
);

async function readPackageVersion(root) {
  const packageJsonPath = path.join(root, "package.json");
  const raw = await fs.readFile(packageJsonPath, "utf8");
  const parsed = JSON.parse(raw);
  if (typeof parsed.version !== "string" || parsed.version.trim() === "") {
    throw new Error("package.json version is missing");
  }
  return parsed.version;
}

function normalizeCliBuildVersion(version) {
  const trimmed = String(version).trim();
  if (!trimmed) {
    throw new Error("cli build version is required");
  }
  return trimmed.startsWith("v") ? trimmed.slice(1) : trimmed;
}
