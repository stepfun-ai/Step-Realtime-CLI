<p align="center">
  <a href="./README.md">English</a> |
  <a href="../zh/sessions.md">简体中文</a>
</p>

# Session management

This page covers saving, resuming, forking, compacting, and reviewing sessions, plus non-interactive output formats.

## Persistence

Every conversation is automatically saved as a snapshot under `~/.step-code/sessions/`, bucketed by working directory: when you start in project A's directory, you only see project A's sessions. The session title is initially derived from the first message; after the first complete answer, a semantic title is generated once asynchronously with the current model, replacing the derived value (on failure the derived value is kept and the session is unaffected). Sessions that have been renamed (`r`) or whose title was changed externally are never overwritten.

## Continuing and resuming

```bash
step --continue        # continue the most recent session in the current directory
step -c -p "continue"  # continue in non-interactive mode
step --resume          # open the interactive session picker (↑↓ to browse, type to search, Enter to resume)
step --resume <id>     # resume a specific session directly
step --session <id>    # same as --resume <id>
```

Headless management:

```bash
step sessions list          # list sessions for the current directory
step sessions show <id>     # view session contents
step sessions delete <id>   # delete
step sessions rename <id> <name>   # rename (equivalent to pressing r in the picker)
```

Inside the interactive interface: `/resume` without an id opens the interactive session picker, `/resume <id>` switches straight to a specific session, `/sessions` lists sessions read-only, and `/new` starts a new session.

### Interactive session picker (shared by `-r` on the command line and `/resume` in the interface)

- **↑↓** moves the highlight, with paged display (10 entries per page; page through to see all historical sessions, there is no longer an entry-count cap).
- **Typing searches incrementally** (matching the title and the first message, space-separated terms combined with AND); Backspace deletes one character at a time.
- **Enter** resumes the highlighted session, **Esc** cancels.
- **Delete / Ctrl+D** deletes the highlighted session after a `[y/N]` confirmation (local files, not recoverable); the session currently in use cannot be deleted. The current session is marked as current in the list.
- **r** renames the highlighted session: enter edit mode, type the new name, and press Enter to confirm (an empty name clears the custom name). Renaming does not refresh the last-used time, so it will not push the session to the top of the list; display precedence is custom name > title > id, and the custom name participates in search. The command line `step sessions rename <id> <name>` is equivalent.

### Session-level state persistence

The following state is saved with the session and read back when you reopen and resume it: conversation history, the TODO list, the goal snapshot, the **permission mode** (manual/auto/yolo), and the **model**. That is, if you switched with `/yolo` or `/model` during a session, resuming that session later still gives you the mode and model from that time (explicit `--yolo`/`--auto`/`--model` on the command line takes precedence). When an older session snapshot lacks these fields, the startup defaults apply.

### Replaying history on resume

When you resume a session (`step -r`, `--continue`, or `/resume` in the interface), the historical conversation is re-rendered into the terminal: user input, assistant replies, thinking blocks, tool calls, and results are laid out in their original order and look the same as a live conversation. Tool calls show the execution status and result from that time; reminder messages injected internally for the model are not displayed.

A dual-metric note appears at the bottom, for example "Resumed session X (23 turns · 302 messages)":

- **Turns**: split by each of your real human inputs; everything between one input and the next counts as one turn, which matches the intuitive sense of how many back-and-forths you had.
- **Messages**: the actual number of messages in the underlying store (one assistant reply may carry several tool calls, and a batch of tool results is packed into a single message), used by system logic such as context and compaction.

For long sessions only the **most recent 15 turns** are replayed by default, with a note at the top saying that N earlier turns have been collapsed. This only affects how much content is redrawn in the terminal; the full history is still loaded in its entirety and remains visible to the model as the conversation continues.

## Forking

`/fork` copies the entire session from the current latest point into a new session, leaving the source session untouched. Useful when you want to try another direction from here without losing the progress you have now.

## Context compaction

When the conversation grows long and approaches the context limit, compaction runs automatically: first a micro-compaction (clearing the bodies of old tool results), and if it is still over the limit, a full LLM summary. Trigger conditions are configurable in the `[compaction]` section. Use `/compact` for manual compaction.

Once generated, the summary must pass a quality check (non-empty, carrying a certain proportion of the information volume that was compacted, free of history-rendering markers); a summary that fails the check causes a retry with a smaller input, and after repeated failures this compaction is abandoned and the history is kept in full. See [the `[compaction]` section of the configuration reference](./configuration.md#compaction-context-compaction).

The complete raw history is unaffected by compaction: each session also keeps an append-only full log (`<id>.full.jsonl`) for `/reflect` to use.

## Review (/reflect)

`/reflect` walks the full conversation history in segments and prints out reusable methodological lessons distilled from it. Run it once when wrapping up a long session to capture how this one got done. The non-interactive equivalent is `step --reflect -c`.

## Export

`/export-debug-zip` or `step export-debug-zip [sessionId]` exports a session debug bundle (zip) for troubleshooting.

## Non-interactive output

In `-p` mode: assistant text goes to stdout, while tool calls and errors go to stderr, so it can be piped directly. Adding `--output-format stream-json` emits one JSON line per event for programmatic consumption (for example feeding it into your own script or CI).

For the event envelope contract, the full list of event types, and versioning rules, see [stream-json event stream](./stream-json.md).


## Subagent sessions

Every subagent run (spawned via `spawn_agent`) is persisted as its own session under the `subagents/` subdirectory of the session bucket: a `<id>.json` snapshot, a `<id>.full.jsonl` full log, and a runtime `<id>.lock` active lock. Subagent sessions stay out of the main session list and never pollute `/resume` or `--continue`.

Headless management:

```bash
step subagents list          # list subagent sessions for this directory (type · status · parent)
step subagents show <id>     # replay a subagent's full history
step subagents delete <id>   # delete (refused while the session is running and holds its lock)
```

Inside the TUI, the `/resume` picker shows main sessions only; selecting one resumes that session directly (see the interactive picker section above for details). Sub-agent sessions are managed separately by the `/agents` command: it lists sub-agent sessions spawned from the current session, and selecting one drills into that sub-agent's full history (read-only, current session unchanged). **Note: the drill-in view is read-only — you cannot keep chatting inside a sub-agent session.** To have a sub-agent continue from its earlier work, use the `spawn_agent` tool's `resume` parameter (initiated by the model). Headless access is available via `step subagents list` / `step subagents show <id>`.

**Resuming**: the `spawn_agent` tool accepts `resume=<subagent session id>` to continue from where the session left off — the new instruction is appended as a user message instead of replacing the history. Finished and failed sessions can both be resumed; the only gate is that the target session is not currently running (an active lock yields an explicit refusal). Resuming is not a new spawn and does not consume the per-session spawn quota. Tool results carry the subagent session id so the model can reference it later.

**Crash safety**: if the previous run died in the middle of a tool call (the last assistant message contains a tool call with no result), resuming first appends a synthetic "previous execution was interrupted" tool result so the replayed history is safe to send to the model.

**Retention** (`~/.step-code/config.toml`):

```toml
[subagent.retention]
delete_with_parent = true   # deleting a main session also deletes its subagent sessions (default on)
max_sessions = 0            # cap on subagent sessions (oldest pruned first); 0 = unlimited
ttl_days = 0                # expiry in days; 0 = never expire
```

By default nothing is deleted proactively; the only automatic reclamation is the cascade that follows a main session's deletion. Retention cleanup for `max_sessions` / `ttl_days` runs once at process startup (scanning only the current working directory's subagent sessions) and does not run again during the process. Every cleanup path skips subagent sessions that are currently running.
