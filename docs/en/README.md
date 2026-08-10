<p align="center">
  <a href="./README.md">English</a> |
  <a href="../zh/README.md">简体中文</a>
</p>

# Step Code User Guide

Step Code is a coding agent CLI for the terminal, powered by StepFun's Step model family. The model uses tools to read and write real files and run real commands; results are fed back and the loop continues until the task is done.

This guide follows the order you are likely to need things in. If you are new, start with Quick start.

## Documentation map

| Page | What it answers |
|------|-----------------|
| [Quick start](./quickstart.md) | Up and running in 10 minutes: install, set the key, first conversation |
| [Installation](./installation.md) | Requirements, building from source, the global command, upgrading and uninstalling |
| [Configuration](./configuration.md) | API keys, every config.toml field, multi-protocol providers, multiple providers and models, thinking, hooks, environment variables, data directories |
| [Interactive use](./interactive.md) | TUI layout, slash commands, keybindings, the three permission tiers, plan mode, the model selector, plugin management |
| [Tools](./tools.md) | Parameters and behavioral limits of every built-in tool, parallel execution, result feedback, permission gating |
| [Sub-agents and automation](./agents.md) | spawn_agent, parallel execution, dynamic_workflow, goals, cron, background tasks |
| [Session management](./sessions.md) | Persistence, resuming, forking, compaction, review, non-interactive output |
| [stream-json event stream](./stream-json.md) | Being driven by external programs: envelope contract, all event types, versioning rules |
| [Skills, plugins, and MCP](./skills-and-mcp.md) | SKILL.md format, loading precedence, extra_skill_dirs, what plugins can provide, MCP and mcp.json |
| [Hooks](./hooks.md) | Lifecycle hooks: the five events, execution and blocking conventions, injection |
| [AGENTS.md](./agents-md.md) | How project conventions are loaded, overridden, and sourced |

## Cheat sheet

```bash
step                    # enter the interactive interface
step -p "<instruction>" # run a single instruction non-interactively
step --continue         # resume the previous session
```

Type `/help` in the interactive interface to list every slash command.

## About this translation

The Chinese documentation under [`docs/zh/`](../zh/README.md) is the source of truth. If a page here contradicts it, or if you find a page that has fallen behind, trust the Chinese version and please open an issue.
