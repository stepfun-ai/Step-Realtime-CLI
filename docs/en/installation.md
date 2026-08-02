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

## Installing from source (recommended)

To install Step Code today, clone the `step-code-explore` branch and build from source. This is the current main installation path while the npm package registration is still pending.

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

> The npm package is not yet registered. Until it is, please use the source install above.

## Upgrading

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

> The npm package is not yet registered. Until it is, use the source upgrade path above.

## Uninstalling

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

> The npm package is not yet registered. Until it is, use the source uninstall path above.

Configuration, session records, and other data live in `~/.step-code/`, and the uninstall command does not touch them; delete that directory manually for a full cleanup.

## Troubleshooting

**The `step` command is not found**: the target directory of `pnpm link --global` is not on PATH. Run `pnpm bin --global` to see the directory and add it to PATH.

**The `bash` tool reports "no usable shell interpreter" on Windows**: none of Git Bash, WSL, busybox, or PowerShell was detected. Installing [Git for Windows](https://git-scm.com/download/win) is the easiest fix; if it is already installed but in a non-standard location, set the absolute path of `bash.exe` in the `STEP_SHELL_PATH` environment variable.

**The build reports type errors**: run `pnpm install` first to make sure dependencies are complete, then `pnpm build`; if it still fails, run `pnpm typecheck` to see the exact location.
