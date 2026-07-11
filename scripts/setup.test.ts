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

function copySetupScript(root: string, scripts: string): void {
  const source = join(process.cwd(), "scripts", "setup.sh");
  const target = join(scripts, "setup.sh");
  const unavailableChrome = join(root, "unavailable-chrome");
  const script = readFileSync(source, "utf8")
    .replace(
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      unavailableChrome,
    )
    .replace(
      "/Applications/Chromium.app/Contents/MacOS/Chromium",
      unavailableChrome,
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
  copySetupScript(root, scripts);

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

    expect(script).toContain(
      'brew install --cask google-chrome || warn "Chrome install failed — continuing without AEC"',
    );
  });

  it.skipIf(process.platform === "win32")(
    "continues with AEC disabled when Homebrew cannot install Chrome",
    () => {
      const { home, log, root } = createTestEnvironment();
      const result = execFileSync("bash", ["scripts/setup.sh"], {
        cwd: root,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: home,
          PATH: `${join(root, "bin")}:/usr/bin:/bin`,
          SETUP_TEST_LOG: log,
          SHELL: "/bin/bash",
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
