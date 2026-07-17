import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Sentinel check that guards against #25-class regressions: if the bundler
// (tsdown / rolldown) ever tree-shakes the OpenTUI runtime module's exports
// away again, `step` fails at runtime with
// "OpenTUI runtime did not export createLocalTuiClientApp()". Neither the
// installer smoke test nor CI exercise the interactive TUI path, so an empty
// chunk can ship undetected. This check surfaces it in CI logs instead.
//
// The check has two modes. Default is NON-BLOCKING: it logs a warning and
// exits 0, which let it ship independently of #28 (the build fix that makes
// the chunk non-empty) while that fix was still in flight. Now that #28 has
// landed on `main`, CI runs this with `--enforce`, which makes a missing/empty
// chunk fail the run — a real hard gate. The non-blocking default is kept for
// local runs where you just want a heads-up without a non-zero exit.
//
// Run after `pnpm build`.

export const REQUIRED_OPENTUI_RUNTIME_SYMBOLS = [
  "createLocalTuiClientApp",
  "LocalStepCliTuiApp",
];

const LOCAL_TUI_APP_CHUNK_PATTERN = /^local-tui-app.*\.js$/u;

/**
 * Recursively collect every `local-tui-app*.js` chunk under `dir`. Matches the
 * post-#28 layout (`dist/runtime/local-tui-app.js`) and any hashed variant the
 * bundler may emit. Source maps and the cjs build are skipped — the esm chunk
 * is what the Node launcher resolves via the dynamic import.
 */
export function findLocalTuiAppChunks(dir) {
  const matches = [];

  if (!fs.existsSync(dir)) {
    return matches;
  }

  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      matches.push(...findLocalTuiAppChunks(fullPath));
      continue;
    }

    if (
      entry.isFile() &&
      LOCAL_TUI_APP_CHUNK_PATTERN.test(entry.name) &&
      !entry.name.endsWith(".map")
    ) {
      matches.push(fullPath);
    }
  }

  return matches;
}

/**
 * Given a chunk's file contents, return the required symbols that are absent.
 * Empty array means the chunk is complete.
 */
export function findMissingSymbols(
  content,
  required = REQUIRED_OPENTUI_RUNTIME_SYMBOLS,
) {
  return required.filter((symbol) => !content.includes(symbol));
}

// Only run the CLI entrypoint when executed directly (`node scripts/check-build-output.mjs`),
// not when imported by tests.
const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
  const enforce = process.argv.slice(2).includes("--enforce");
  const DIST_DIR = path.resolve("dist");

  const report = (lines) => {
    const prefix = enforce ? "✗" : "⚠";
    for (const line of lines) {
      console.error(`${prefix} ${line}`);
    }
  };

  const chunks = findLocalTuiAppChunks(DIST_DIR);

  if (chunks.length === 0) {
    report([
      "build output check: no local-tui-app chunk found under dist/",
      "Run `pnpm build` first; if you already did, the tsdown entry for src/runtime/local-tui-app.ts may be missing.",
    ]);
    process.exit(enforce ? 1 : 0);
  }

  const failures = [];

  for (const chunk of chunks) {
    const missing = findMissingSymbols(fs.readFileSync(chunk, "utf8"));

    if (missing.length > 0) {
      failures.push({ chunk, missing });
    }
  }

  if (failures.length > 0) {
    report([
      "build output check: OpenTUI runtime exports missing from built chunk(s)",
      ...failures.map(
        ({ chunk, missing }) =>
          `  ${path.relative(DIST_DIR, chunk)}: missing ${missing.join(", ")}`,
      ),
      "This is the #25 regression — the bundler tree-shook the dynamic-import target. Verify the tsdown entry for local-tui-app is present.",
    ]);
    process.exit(enforce ? 1 : 0);
  }

  console.log(
    `✓ build output check passed: local-tui-app chunk exports ${REQUIRED_OPENTUI_RUNTIME_SYMBOLS.join(", ")}`,
  );
}
