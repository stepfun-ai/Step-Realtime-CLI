<p align="center">
  <a href="./README.md">English</a> |
  <a href="../zh/installation.md">简体中文</a>
</p>

# Installation

> If you already have another AI agent at hand, [`skills/step-code-install/`](../../skills/step-code-install/SKILL.md) is an install-instructions skill: point your agent at it and it can carry out the steps on this page for you.

## Requirements

- **Node.js >= 22** (the `glob` tool uses `node:fs.globSync`, an API available from Node 22 onward). Not needed if you use the standalone executable.
- **pnpm**: only required when installing from source or contributing to development. Not needed for npm installs of prebuilt artifacts.
- Windows users: the `bash` tool prefers Git Bash (installing [Git for Windows](https://git-scm.com/download/win) is recommended); when it is absent, it falls back to WSL, busybox-w32, and PowerShell in that order. If Git Bash is installed in a non-standard location, set the `STEP_SHELL_PATH` environment variable to the absolute path of `bash.exe`.

## Choose an installation method

All artifacts are hosted on GitHub Releases; they do not go through the npm public registry. Download links for the standalone executables and the tarball use the `releases/latest/download/` permalink, which always points to the latest Release and never expires with version bumps.

| Method | Prerequisites | What you get | Best for |
|--------|--------------|--------------|----------|
| [Standalone executable](#standalone-executable-no-node-required) | None | A single executable file with a bundled Node runtime | No Node installed; download and run immediately |
| [npm install Release tarball](#npm-install-release-tarball) | Node 22+ | Pre-built `dist/` + `step` command managed by npm | Have Node; want a one-command install |
| [npm install source branch](#npm-install-source-branch-follow-main) | Node 22+ | `dist/` compiled on your machine | Follow latest mainline; accept local compilation |
| [Install from source](#install-from-source) | Node 22+ and pnpm | Full development environment + symlinked `step` | Contributing; modifying code |

## Standalone executable (no Node required)

Download the platform-specific artifact from [Releases](https://github.com/li-xiu-qi/Step-Realtime-CLI/releases/latest) (these links always point to the latest Release):

| Platform | Download |
|----------|----------|
| Windows x64 | [step-code-win32-x64.exe](https://github.com/li-xiu-qi/Step-Realtime-CLI/releases/latest/download/step-code-win32-x64.exe) |
| macOS Apple Silicon | [step-code-darwin-arm64](https://github.com/li-xiu-qi/Step-Realtime-CLI/releases/latest/download/step-code-darwin-arm64) |
| Linux x64 | [step-code-linux-x64](https://github.com/li-xiu-qi/Step-Realtime-CLI/releases/latest/download/step-code-linux-x64) |

Each artifact comes with a same-name `.sha256` checksum file (append `.sha256` to the same path). After downloading, rename it to `step` (or `step.exe` on Windows) and place it on your PATH.

```bash
# macOS / Linux: make executable
chmod +x step

# macOS: browser-downloaded files carry a quarantine attribute; strip it before first run
xattr -d com.apple.quarantine step 2>/dev/null || true
```

## npm install Release tarball

One command installs the latest version (a permalink that always resolves to the latest Release's tarball):

```bash
npm i -g https://github.com/li-xiu-qi/Step-Realtime-CLI/releases/latest/download/step-code.tgz
step --version
```

The tarball includes a pre-built `dist/`. `npm i -g <url>` only unpacks it and links `bin.step`—**nothing is compiled on your machine, and no dependencies are fetched.**

To pin a specific version for reproducible installs, use that tag's versioned asset instead, e.g.:

```bash
npm i -g https://github.com/li-xiu-qi/Step-Realtime-CLI/releases/download/v0.1.2/step-code-0.1.2.tgz
```

## npm install source branch (follow main)

Install directly from the development branch to get the latest code at the moment:

```bash
npm i -g github:li-xiu-qi/Step-Realtime-CLI#step-code-explore-pi
step --version
```

npm clones the repo, installs build dependencies, and then compiles `dist/` on your machine via the `prepare` hook. The trade-off is speed, and build dependencies remain in the global install directory. Measured on 2026-08-02 with Windows + npm and a local git source: about 1 minute, installing 285 packages.

This path resolves dependencies via npm's own logic, not the repository's pnpm lockfile, so dependency drift can cause build failures. If that happens, fall back to the Release tarball above, or install from source as described below.

## Install from source

The current `step-code-explore-pi branch is iterating quickly, and releases may not catch up to the latest code. To get the newest features, build from source:

```bash
git clone -b step-code-explore-pi https://github.com/li-xiu-qi/Step-Realtime-CLI.git
cd Step-Realtime-CLI
pnpm install
pnpm build        # tsc compiles to dist/
pnpm test         # vitest unit tests (optional, verifies the environment works)
```

After building, run with `node dist/main.js`. To register `step` as a global command:

```bash
pnpm link --global
step
```

To use a stable branch, switch manually:

```bash
git checkout main
pnpm install && pnpm build
```

## npm public registry (not currently provided)

`step-code` is not published to the npm public registry, so `npm install -g step-code` is unavailable, and `npm update -g step-code` does not work.

This is a deliberate choice for the current stage, not an omission: the methods above already cover every combination of "Node required or not" and "follow a version or follow mainline", while publishing to a registry introduces long-term commitments such as accounts, publish permissions, and non-retractable versions. We will reevaluate registry publishing once the distribution model stabilizes.

## Upgrading

### Standalone executable

Download the new version and overwrite the file in place.

### npm-installed variants (2 methods)

Re-run the original install command; npm re-resolves the URL or git reference and overwrites the existing installation:

```bash
npm i -g https://github.com/li-xiu-qi/Step-Realtime-CLI/releases/latest/download/step-code.tgz  # latest Release tarball
npm i -g github:li-xiu-qi/Step-Realtime-CLI#step-code-explore-pi                                  # source branch
```

`npm update -g step-code` does not work for these variants—it targets registry packages, while the sources here are git references or URLs.

### Source install upgrade

Source installs are symlink installs. Pull the latest code and rebuild; there is no need to link again. Make sure you are on the recommended branch:

```bash
git checkout step-code-explore-pi   # confirm you are on the recommended branch
git pull
pnpm install    # when dependencies have changed
pnpm build
```

## Uninstalling

### Standalone executable

Delete the executable file and remove it from PATH.

### npm-installed variants

```bash
npm uninstall -g step-code
```

### Source install

```bash
cd Step-Realtime-CLI
pnpm unlink --global   # removes the global step command
```

Configuration, session records, and other data live in `~/.step-code/`. The uninstall command does not touch them; delete that directory manually for a full cleanup.

## FAQ

**`step` command not found**: for npm global installs, check whether the `npm bin -g` directory is on PATH; for source installs, check `pnpm bin --global`. Add the corresponding directory to PATH and restart the terminal.

**Not sure which version is running**: `step --version` outputs something like `0.1.0 (a1b2c3d 2026-08-03T02:46Z)`, where the parenthesized part is the commit and build timestamp at build time. The version number changes once per release cycle, while the build identifier changes on every build—only by combining both can you uniquely identify a specific artifact. A `+dirty` suffix after the commit means the artifact was built from a workspace with uncommitted changes and does not correspond to any commit. If only the version number is present with no parenthesized part, it means git information was unavailable at build time (e.g. built from a tarball).

**`bash` tool reports "no usable shell interpreter" on Windows**: none of Git Bash, WSL, busybox, or PowerShell was detected. Installing [Git for Windows](https://git-scm.com/download/win) is the easiest fix; if it is already installed but in a non-standard location, set the `STEP_SHELL_PATH` environment variable to the absolute path of `bash.exe`.

**Build reports type errors**: run `pnpm install` first to ensure dependencies are complete, then `pnpm build`; if it still fails, run `pnpm typecheck` to see the exact location.

**SEA executable reports missing module**: the artifact is a single-file form with runtime and code bundled together; it does not depend on any sibling files. This error means the file was truncated during download or renaming. Re-download and verify with the accompanying `.sha256` checksum.

**Windows download blocked by SmartScreen**: the artifact is not code-signed, so SmartScreen warns about executables with low download counts. Verify file integrity with `.sha256` first, then choose "Run anyway" in the prompt.

**macOS says "unverified developer" or refuses to run outright**: the artifact carries only an ad-hoc signature and is not notarized. Strip the quarantine attribute and it will run:

```bash
xattr -d com.apple.quarantine step
chmod +x step
```
