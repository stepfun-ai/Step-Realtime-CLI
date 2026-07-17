import { execFileSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const temporaryDirectories: string[] = [];

function createExecutable(
  directory: string,
  name: string,
  contents: string,
): void {
  const path = join(directory, name);
  writeFileSync(path, contents, "utf8");
  chmodSync(path, 0o755);
}

function copySetupScript(scripts: string): void {
  const source = join(process.cwd(), "scripts", "setup.sh");
  const target = join(scripts, "setup.sh");
  const script = readFileSync(source, "utf8").replace(
    "AEC_AVAILABLE=0",
    "detect_chrome() { return 1; }\n\nAEC_AVAILABLE=0",
  );

  writeFileSync(target, script, "utf8");
}

function createTestEnvironment(): { home: string; log: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "step-setup-test-"));
  const scripts = join(root, "scripts");
  const bin = join(root, "bin");
  const home = join(root, "home");
  const log = join(root, "commands.log");
  temporaryDirectories.push(root);
  mkdirSync(scripts, { recursive: true });
  mkdirSync(bin);
  mkdirSync(home);
  copySetupScript(scripts);

  createExecutable(bin, "uname", "#!/usr/bin/env bash\necho Darwin\n");
  createExecutable(
    bin,
    "brew",
    '#!/usr/bin/env bash\nprintf \'brew %s\\n\' "$*" >> "$SETUP_TEST_LOG"\nexit 1\n',
  );
  createExecutable(
    bin,
    "pnpm",
    '#!/usr/bin/env bash\nprintf \'pnpm %s\\n\' "$*" >> "$SETUP_TEST_LOG"\n',
  );
  createExecutable(
    bin,
    "node",
    '#!/usr/bin/env bash\nprintf \'node %s\\n\' "$*" >> "$SETUP_TEST_LOG"\necho 1.0.0\n',
  );
  return { home, log, root };
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { force: true, recursive: true });
  }
});

describe("scripts/setup.sh", () => {
  it("handles a failed Homebrew Chrome install without exiting", () => {
    const script = readFileSync(
      join(process.cwd(), "scripts", "setup.sh"),
      "utf8",
    );

    expect(script).toContain("if brew install --cask google-chrome; then");
    expect(script).toContain(
      'warn "Chrome install failed — continuing without AEC"',
    );
  });

  it("forces Chrome detection to fail in its test fixture", () => {
    const { root } = createTestEnvironment();
    const fixture = readFileSync(join(root, "scripts", "setup.sh"), "utf8");

    expect(fixture).toContain("detect_chrome() { return 1; }");
  });

  it.skipIf(process.platform === "win32")(
    "continues with AEC disabled when Homebrew cannot install Chrome",
    () => {
      const { home, log, root } = createTestEnvironment();
      const result = execFileSync("bash", ["scripts/setup.sh"], {
        cwd: root,
        encoding: "utf8",
        env: {
          HOME: home,
          PATH: `${join(root, "bin")}:/usr/bin:/bin`,
          SETUP_TEST_LOG: log,
          SHELL: "/bin/bash",
          STEP_CHROME_PATH: "",
        },
      });

      expect(result).toContain("[7/7] Installing");
      expect(result).toContain("AEC skipped");
      const commands = readFileSync(log, "utf8");
      expect(commands).toContain("brew install --cask google-chrome");
      expect(commands).toContain(
        "node scripts/run-step.mjs --stale-only aec off",
      );
    },
  );
});

describe("scripts/setup.ps1", () => {
  it("runs the launcher from its install directory before resolving runtime imports", () => {
    const script = readFileSync(
      join(process.cwd(), "scripts", "setup.ps1"),
      "utf8",
    );

    expect(script).toContain('pushd "%~dp0" || exit /b 1');
    expect(script).toContain('set "STEP_EXIT_CODE=%ERRORLEVEL%"');
    expect(script).toContain("popd");
  });
});
