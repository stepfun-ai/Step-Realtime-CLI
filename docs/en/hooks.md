<p align="center">
  <a href="./README.md">English</a> |
  <a href="../zh/hooks.md">简体中文</a>
</p>

# Hooks

Hooks let you run your own shell commands at lifecycle event points without changing any code: to observe what the agent is doing, or to block it at a specific moment. This page covers the configuration shape, the semantics of the five events, and the execution and blocking conventions. For a field-by-field reference, see the [configuration reference](./configuration.md).

## How it relates to the permission system

step-code already has an internal layer of in-process mount points (authorization, result post-processing, continuation decisions), and the permission system hangs off of it. Hooks are **an opening in that layer exposed to users**: shell commands declared in configuration take part in the same lifecycle.

One bottom line to state up front: **hooks are not a security boundary**. When a command times out, crashes, or returns an exit code outside the convention, it is always allowed through (fail-open); the security boundary always remains the permission system. Hooks are positioned as an experience enhancement, for logging, injecting context, and intercepting the occasional obviously wrong operation. Do not expect them to serve as a security fallback.

## Configuration

Declare them in `~/.step-code/config.toml` with a `[[hooks]]` array; each entry has four fields:

```toml
[[hooks]]
event = "PreToolUse"                          # event name
matcher = "^bash$"                             # optional regex, matched against the tool name / event identifier
command = "python ~/.step-code/hooks/guard.py" # the shell command to run
timeout = 30                                   # seconds, optional, default 30, hard cap 600
```

- Multiple entries can be declared for the same event, and all matching entries **run in parallel**.
- When `matcher` is omitted, every trigger of that event matches.
- Only user-level global configuration is supported; there is no project-level variant. The config file location is the trust boundary, which removes the need for an additional content review mechanism.

## The five events

| Event | Can it block | When it fires | What stdout is used for |
|------|----------|----------|-------------|
| `PreToolUse` | Can block (veto only) | Before the tool runs, as the first link in the authorization chain | — |
| `PostToolUse` | Observe | After the tool runs | — |
| `UserPromptSubmit` | Can block + inject | After the user submits input, before the model is called | Injected as context into this turn |
| `Stop` | Can block the stop and continue | When the agent decides this turn is over | — |
| `SessionStart` | Observe + inject | Once after a session is created or resumed | Injects session context once |

A few semantics worth noting:

- **PreToolUse can only veto, not approve**. A hook allowing something through only means it does not object; the existing permission approval still runs afterward (if a confirmation prompt was due, it still appears). It does not replace human confirmation.
- **Stop gives only one chance to continue**. When a Stop hook blocks, the reason is injected so the model keeps going, but this takes effect only once per turn, preventing a blocking hook from trapping the agent in an infinite loop.
- **When UserPromptSubmit blocks**, the model is not called for this turn; when it allows the input through, its stdout text is injected as context.

## Execution and blocking conventions

Each hook is a single shell command that **receives a JSON payload on stdin** (snake_case fields) and decides from it whether to allow or block:

- Base fields: `hook_event_name`, `session_id`, `cwd`.
- Event-specific fields: for example `tool_name`, `tool_input`, `tool_output` (under PostToolUse the tool output is truncated first), varying by event.

The exit code determines the outcome:

| Exit code | Meaning |
|--------|------|
| `0` | Allow; under UserPromptSubmit / SessionStart, stdout is injected as context |
| `2` | Block; stderr is the reason (under PreToolUse it is fed back to the model as the deny reason) |
| Any other non-zero / timeout / crash | **fail-open, allowed through**, with a stderr summary shown in a notice |

The timeout defaults to 30 seconds (`timeout` is configurable, with a hard cap of 600 seconds), and a timeout kills the entire process tree. Hook execution is made visible through notice entries in the conversation area (start / blocked / timed out).

## An example: intercepting writes to a directory

```python
#!/usr/bin/env python3
# ~/.step-code/hooks/guard.py
import json, sys

data = json.load(sys.stdin)
if data.get("tool_name") in ("write_file", "edit_file"):
    path = (data.get("tool_input") or {}).get("path", "")
    if path.startswith("/etc/"):
        print("writing to /etc is not allowed", file=sys.stderr)
        sys.exit(2)   # block
sys.exit(0)           # allow
```

```toml
[[hooks]]
event = "PreToolUse"
matcher = "^(write_file|edit_file)$"
command = "python ~/.step-code/hooks/guard.py"
```

## Hooks provided by plugins

Plugins can declare hooks too (see [Skills, plugins, and MCP](./skills-and-mcp.md)). Plugin hooks reuse the same four fields and the same execution conventions; the difference is that the working directory for `command` is fixed to the plugin root and the `STEP_CODE_PLUGIN_ROOT` environment variable is injected, making it easy to reference scripts inside the plugin. The safety semantics are identical to user hooks (fail-open).
