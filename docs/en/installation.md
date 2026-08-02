<p align="center">
  <a href="./README.md">English</a> |
  <a href="../zh/installation.md">简体中文</a>
</p>

# Installation

> If you already have another AI agent at hand, [`skills/step-code-install/`](../../skills/step-code-install/SKILL.md) is an install-instructions skill: point your agent at it and it can carry out the steps on this page for you.

## Requirements

- **Node.js >= 22** (the `glob` tool uses `node:fs.globSync`, an API available from Node 22 onward)
- **pnpm** (package management)
- Windows users: the `bash` tool prefers Git Bash (installing [Git for Windows](https://git-scm.com/download/win) is recommended); when it is absent, it falls back to WSL, busybox-w32, and PowerShell in that order. If Git Bash is installed in a non-standard location, set the absolute path of `bash.exe` in the `STEP_SHELL_PATH` environment variable.

## Installing from GitHub Release (recommended)

Each release ships two artifacts: a **SEA executable** (single file, no Node runtime required) and an **npm tarball** (`.tgz`, requires Node 22+). The SEA executable is the recommended format for most users.

### SEA executable (recommended)

Download the platform-specific `step-code-<version>-<platform>.exe` from [Releases](https://github.com/li-xiu-qi/Step-Realtime-CLI/releases), rename it to `step.exe`, and place it on your PATH.

### npm tarball

```bash
# install directly from the tarball URL without npm registry
npm install -g https://github.com/li-xiu-qi/Step-Realtime-CLI/releases/download/v0.1.0/step-code-0.1.0.tgz
step --version
```

The tarball includes a pre-built `dist/`, so `npm install -g <url>` unpacks it and links `bin.step` without requiring a local build step.

## Installing from source

The `step-code-explore` branch is still iterating quickly, so releases may lag behind the latest code. Use the source path when you need the newest features:

```bash
git clone -b step-code-explore https://github.com/li-xiu-qi/Step-Realtime-CLI.git
cd Step-Realtime-CLI
pnpm install
pnpm build        # tsc compiles to dist/
pnpm test         # vitest unit tests (optional, verifies the environment works)
```

After building, run it with `node dist/main.js`. To register `step` as a global command:

```bash
pnpm link --global
step
```

To use the stable branch instead, check out `main` before building:

```bash
git checkout main
pnpm install && pnpm build
```

## Installing with npm (planned for v0.1.0)

Once `step-code` is published to the npm public registry, a global npm install will be the fastest way:

```bash
npm install -g step-code
step --version
```

> The npm package is not yet registered. Until it is, please use the GitHub Release or source install above.

## Upgrading

### Release install

Download the new version and overwrite. For SEA executables, replace the file in place. For npm tarball installs, rerunning the install command upgrades automatically.

### Source install

Installing from source is a symlink installation, so pull the latest code and rebuild; there is no need to link again. Make sure you are on the branch you want (recommended: `step-code-explore`):

```bash
cd Step-Realtime-CLI
git checkout step-code-explore
git pull
pnpm install    # when dependencies have changed
pnpm build
```

### npm install (planned for v0.1.0)

Once the package is published to npm:

```bash
npm update -g step-code
```

> The npm package is not yet registered. Until it is, use the Release or source upgrade path above.

## Uninstalling

### SEA / tarball install

```bash
npm uninstall -g step-code
```

### Source install

```bash
cd Step-Realtime-CLI
pnpm unlink --global   # removes the global step command
```

### npm install (planned for v0.1.0)

Once the package is published to npm:

```bash
npm uninstall -g step-code
```

> The npm package is not yet registered. Until it is, use the Release or source uninstall path above.

Configuration, session records, and other data live in `~/.step-code/`, and the uninstall command does not touch them; delete that directory manually for a full cleanup.

## Troubleshooting

**The `step` command is not found**: the target directory of `pnpm link --global` is not on PATH. Run `pnpm bin --global` to see the directory and add it to PATH.

**The `bash` tool reports "no usable shell interpreter" on Windows**: none of Git Bash, WSL, busybox, or PowerShell was detected. Installing [Git for Windows](https://git-scm.com/download/win) is the easiest fix; if it is already installed but in a non-standard location, set the absolute path of `bash.exe` in the `STEP_SHELL_PATH` environment variable.

**The build reports type errors**: run `pnpm install` first to make sure dependencies are complete, then `pnpm build`; if it still fails, run `pnpm typecheck` to see the exact location.

**SEA executable reports missing module**: make sure the `step-code.data` file next to the executable is present; the executable and its sidecar must live in the same directory.
