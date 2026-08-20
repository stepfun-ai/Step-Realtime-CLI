<p align="center">
  <a href="./README.md">English</a> |
  <a href="../zh/quickstart.md">简体中文</a>
</p>

# Quick start

By the end of this page you will have installed step-code, configured an API key, and completed your first conversation.

## 1. Install

The fastest path (requires Node.js >= 22):

```bash
npm i -g https://github.com/li-xiu-qi/Step-Realtime-CLI/releases/latest/download/step-code.tgz
```

This installs a pre-built package: nothing is compiled locally and no dependencies are fetched, and the link always points to the latest Release. Without a Node environment, download the standalone executable for your platform from [Releases](https://github.com/li-xiu-qi/Step-Realtime-CLI/releases/latest). To contribute, clone the repository and build it yourself:

```bash
git clone https://github.com/stepfun-ai/Step-Realtime-CLI.git
cd Step-Realtime-CLI
pnpm install
pnpm build
pnpm link --global   # afterwards you can use the step command directly
```

For the trade-offs between the four installation methods, plus upgrading, uninstalling, and troubleshooting, see [Installation](./installation.md).

## 2. Configure the API key

Get an API key for the Step models from the [StepFun open platform](https://platform.stepfun.com). Choose either method:

```bash
# Option 1: environment variable
export STEP_CODE_API_KEY=<your-key>

# Option 2: write it into ~/.step-code/config.toml
#   [providers.stepfun]
#   type = "stepfun"
#   api_key = "<your-key>"
```

## 3. First conversation

```bash
step
```

Once the interactive interface opens, type natural language directly, for example:

```
Look at the structure of the current directory and tell me what this project does
```

The model calls tools to read files and run commands, then returns its conclusions to you. Tool results are collapsed into a summary by default; press Ctrl+O to view the full output.

Before writing files or running commands, a confirmation prompt appears (this is the manual permission mode). Use ↑↓ to select and Enter to confirm. To try fully automatic operation, add `--yolo` at startup.

## 4. Common operations

```bash
step -p "find all TODOs under src"   # non-interactive: print the result and exit
step --continue                      # resume the previous session
step --resume                        # open the session picker
```

Inside the interactive interface:

- `/help` lists every command
- `/new` starts a new session
- `/compact` compacts the context manually
- `/exit` quits
- Esc interrupts the current generation

## Next steps

- To make the AI follow your project conventions: put an `AGENTS.md` in the project root, see [The AGENTS.md mechanism](./agents-md.md)
- To capture reusable workflows: write a SKILL.md, see [Skills, plugins, and MCP](./skills-and-mcp.md)
- To adjust the model, context, or default permission behavior: see [Configuration reference](./configuration.md)
