<p align="center">
  <a href="./README.md">English</a> |
  <a href="./README_CN.md">简体中文</a>
</p>

> [!IMPORTANT]
> **Unofficial — a community-driven exploration.** Step Code Pi is a CLI explored independently by community contributors.

# Step Code Pi

[![CI](https://github.com/stepfun-ai/Step-Realtime-CLI/actions/workflows/test.yml/badge.svg?branch=step-code-pi-explore)](https://github.com/stepfun-ai/Step-Realtime-CLI/actions/workflows/test.yml)

A terminal coding agent CLI, with StepFun's **Step model family** as the primary target and **pi-tui** for the UI. The model layer speaks three protocols—Anthropic Messages, OpenAI Chat Completions, and OpenAI Responses—so any compatible provider works out of the box; Step is the best-tested and default path.

> This repository is the `step-code-explore-pi` exploration branch of [stepfun-ai/Step-Realtime-CLI](https://github.com/stepfun-ai/Step-Realtime-CLI).

## What it is

Step Code is a terminal coding agent CLI built around an agent loop: the model uses tools to read and write real files and run real commands, results are fed back, and the loop continues until the task is done. It is built with **pi-tui** and targets **StepFun's Step model family** as the primary path, while also supporting any compatible provider through three open protocols (Anthropic Messages, OpenAI Chat Completions, OpenAI Responses).

Key capabilities:
- **Permission tiers + plan mode**: enforce "say what you'll change before changing it"
- **Sub-agents and JS dynamic workflows**: split large tasks and run them in parallel
- **Autonomous goals**: keep driving one objective across turns
- **Memory observation pool (/memory)**: the agent records observed preferences and conventions into plain markdown directories (global + project); observations stay inert until your review promotes them into your rules. Off by default
- **Team mode (/team)**: parallel multi-mission repo changes — git worktree isolation, mutually exclusive write scopes, system-enforced dependency gating, and a five-gate reviewed merge; cross-repo supported
- **Context compaction + session persistence**: resume days later with full history
- **Skills, plugins, and MCP**: lazily loaded external capabilities on demand
- **Background execution**: long commands and entire sub-agents can be moved to the background
- **Media degradation on all providers**: when an image limit is hit, the most recent N images are kept and older ones replaced with placeholders, with consistent behavior across anthropic / openai / openai_responses
- **Image paste and path readback**: Alt+V pastes from the clipboard; read_media reads images by path and supports probe-based chunk planning
- **Thinking visibility**: the thinking process is rendered in the TUI — streaming preview while running, a collapsed block when done; when the model returns only a thinking signature with no visible text, the status line still shows "thinking…", so a long silence is distinguishable from a stuck request

## Quick start

Requires Node.js >= 22 (not needed if you use the standalone executable).

```bash
npm i -g https://github.com/li-xiu-qi/Step-Realtime-CLI/releases/latest/download/step-code.tgz
export STEP_CODE_API_KEY=<your-key>
step
```

That installs a pre-built package: nothing is compiled locally and no dependencies are fetched, and the link always points to the latest Release. Without Node, grab the standalone executable for your platform (Windows / macOS / Linux) from [Releases](https://github.com/li-xiu-qi/Step-Realtime-CLI/releases/latest); to modify the code, install from source instead.

See [Quick start](./docs/en/quickstart.md) for installation and configuration details, and [Installation](./docs/en/installation.md) for the trade-offs between the four installation methods.

If you already have another AI agent at hand, [`skills/step-code-install/`](./skills/step-code-install/SKILL.md) is an install-instructions skill: clone the repo, point your agent at it, and it will know how to build, where to put the API key, and what to check when the build fails.

## Documentation

English documentation lives under [`docs/en/`](./docs/en/); the Chinese originals under [`docs/`](./docs/) are the source of truth.

| Document | Contents |
|----------|----------|
| [Quick start](./docs/en/quickstart.md) | Install, set the API key, first conversation |
| [Installation](./docs/en/installation.md) | Requirements, building from source, global command, upgrade and uninstall |
| [Configuration](./docs/en/configuration.md) | Every config.toml field, multi-protocol providers and model aliases, environment variables, data directories |
| [Interactive use](./docs/en/interactive.md) | TUI layout, slash commands, keybindings, the three permission tiers, plan mode, switching model and provider |
| [Tools](./docs/en/tools.md) | Parameters and behavioral limits of every built-in tool, parallel execution and result feedback |
| [Sub-agents and automation](./docs/en/agents.md) | spawn_agent, dynamic_workflow, autonomous goals, scheduled tasks, background tasks |
| [Session management](./docs/en/sessions.md) | Persistence, resuming, forking, context compaction, review, non-interactive output |
| [Skills, plugins, and MCP](./docs/en/skills-and-mcp.md) | SKILL.md format, loading precedence, plugins, MCP integration |
| [Hooks](./docs/en/hooks.md) | Running shell commands at five lifecycle events |
| [AGENTS.md](./docs/en/agents-md.md) | How project conventions are loaded, overridden, and sourced |

## Development

Source layers: `config` → `provider` → `tools` → `agent` (the loop) → `tui-pi` (pi-tui) → `cli.ts` (entry); `main.ts` is only the bin bootstrap (sets NODE_ENV, then loads cli.js).

```bash
pnpm dev          # run directly with tsx, for interactive development
pnpm typecheck    # tsc in strict mode
pnpm test         # vitest
```

CI runs typecheck, build, and test on Ubuntu, Windows, and macOS. Development conventions and the rules for model integration are in [`AGENTS.md`](./AGENTS.md); the contribution process is in [`CONTRIBUTING.md`](./CONTRIBUTING.md).

## Acknowledgements

The source code of Step Code is written from scratch by this project; it is not affiliated with, sponsored by, or endorsed by any third-party project. Third-party open-source license texts are collected under [`licenses/`](./licenses/) for compliance, with details in [`licenses/NOTICE.md`](./licenses/NOTICE.md).

## License

MIT, see [`LICENSE`](./LICENSE). Third-party acknowledgements and licenses are under [`licenses/`](./licenses/).
