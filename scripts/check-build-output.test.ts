import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  findLocalTuiAppChunks,
  findMissingSymbols,
  REQUIRED_OPENTUI_RUNTIME_SYMBOLS,
} from "./check-build-output.mjs";

const tmpDirs: string[] = [];

afterEach(() => {
  while (tmpDirs.length > 0) {
    const dir = tmpDirs.pop()!;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function makeTmpDist(tree: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "step-build-check-"));
  tmpDirs.push(root);
  for (const [relPath, content] of Object.entries(tree)) {
    const fullPath = path.join(root, relPath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content);
  }
  return root;
}

describe("findLocalTuiAppChunks", () => {
  it("finds the post-#28 layout dist/runtime/local-tui-app.js", () => {
    const root = makeTmpDist({
      "runtime/local-tui-app.js": "export {}",
      "runtime/local-tui-app.js.map": "{}",
      "runtime/local-opentui-entry.js": "export {}",
    });

    const chunks = findLocalTuiAppChunks(root);
    expect(chunks).toEqual([path.join(root, "runtime", "local-tui-app.js")]);
  });

  it("finds hashed chunk variants emitted directly under dist/", () => {
    const root = makeTmpDist({
      "local-tui-app-dRVjt31N.js": "export {}",
      "local-tui-app-dRVjt31N.js.map": "{}",
    });

    const chunks = findLocalTuiAppChunks(root);
    expect(chunks).toEqual([path.join(root, "local-tui-app-dRVjt31N.js")]);
  });

  it("skips source maps and the cjs build", () => {
    const root = makeTmpDist({
      "runtime/local-tui-app.js": "export {}",
      "runtime/local-tui-app.cjs": "export {}",
      "runtime/local-tui-app.js.map": "{}",
    });

    const chunks = findLocalTuiAppChunks(root);
    expect(chunks).toEqual([path.join(root, "runtime", "local-tui-app.js")]);
  });

  it("returns an empty list when dist/ is missing (instead of throwing)", () => {
    expect(
      findLocalTuiAppChunks(path.join(os.tmpdir(), "does-not-exist")),
    ).toEqual([]);
  });
});

describe("findMissingSymbols", () => {
  it("returns no missing symbols for a chunk that exports everything", () => {
    const content = `
      export class LocalStepCliTuiApp {}
      export async function createLocalTuiClientApp() {}
    `;
    expect(findMissingSymbols(content)).toEqual([]);
  });

  it("flags the #25 regression: an empty shell with only imports", () => {
    // This is literally what main produced before #28: 3 import lines, no exports.
    const emptyShell = [
      'import "./local-session-target-DAN8-Cwd.js";',
      'import "./local-tui-bootstrap-xGRRjkP0.js";',
      'import process from "node:process";',
    ].join("\n");

    expect(findMissingSymbols(emptyShell).sort()).toEqual(
      [...REQUIRED_OPENTUI_RUNTIME_SYMBOLS].sort(),
    );
  });

  it("reports only the symbols that are actually absent", () => {
    const partial = "export class LocalStepCliTuiApp {}";
    expect(findMissingSymbols(partial)).toEqual(["createLocalTuiClientApp"]);
  });
});
