<p align="center">
  <a href="./README.md">English</a> |
  <a href="../zh/interactive.md">简体中文</a>
</p>

# Interactive use

This page covers day-to-day use of the interactive interface: slash commands, keybindings, permission tiers, and plan mode.

## Interface layout

The pi-tui terminal interface has a welcome box at the top, the conversation stream in the middle (your input, model replies, tool call cards), and a two-line status bar at the bottom. The first line shows the permission tier (manual green / auto yellow / yolo red), the model name, the status, the background task badge `bg:N`, the autonomous goal badge `goal ● elapsed · turns`, and the current path (shortened when too long). The second line shows keybinding hints and context usage (real token percentage). The last two badges appear only when relevant; they take up no space when there is no background task or goal.

Text you type while the model is working is not lost: it joins the send queue and is dispatched one entry at a time when the turn ends, with a queue preview above the input box.

While busy, a status line appears above the input box: `⠋ status word… (12s · ↓ 585 tokens)`, that is a spinner plus elapsed time plus tokens produced this turn (estimated), with a randomly chosen operation tip on the line below. The spinner occupies a line of its own at a fixed width, so it never competes for space with your input.

### Conversation stream and scrolling

You page through history with the terminal's native scrollback (wheel or scrollbar), at any time, without being interrupted by refreshes. Content that has been committed is written once and stays in history permanently. Long content that is still being generated shows only its tail, with a single line at the top reading "↑ N earlier lines hidden"; once output finishes, the full text falls naturally into history. This is a deliberate trade-off: during streaming your attention is on the last few lines, while scrolling back through history is always complete, with nothing lost and nothing jumping.

Tool output is collapsed by default into a one-line summary ("N lines of output · Ctrl+O to expand"), and once committed to history it stays a collapsed summary forever, keeping history compact. Ctrl+O opens the full-screen viewer: recent expandable tool output and thinking content, grouped by turn and rendered in full (Markdown, colorized diffs, italic thinking). Use ↑↓ or `k`/`j` to scroll by line, PgUp/PgDn to page, ←/→ to switch turns, Home/`g` to jump to the top, End/`G` to jump to the bottom, and Esc/`q` or Ctrl+O again to close. The viewer has its own scrolling and does not affect terminal scrollback.

When you resume a session (`step -r` / `/resume`), the conversation history is re-rendered to the terminal and looks the same as it did live. Long sessions replay only the most recent turns by default, with a note at the top saying the earlier ones are collapsed. See [Session management](./sessions.md#replaying-history-on-resume) for details.

## Slash commands

Type `/` to bring up the command menu: ↑↓ to select (wrapping around), Tab to complete, Enter to execute, Esc to close the menu and clear the input box. Matching rules: prefix matching takes priority; with exactly 2 characters a subsequence fallback is additionally enabled, covering abbreviations like `cp` → `compact`. The menu shows 6 entries per screen; beyond that it scrolls in a window and shows `(current/total)`.

All 26 commands (the table below has 27 rows, because `/skill reload` is listed separately: it is a subcommand of `/skill`, not a command of its own):

| Command | What it does |
|------|------|
| `/help` (`/?`) | List every command |
| `/model [alias]` | With no argument, opens the interactive picker (shows only the current model when no `[models]` are registered); with an argument, switches directly |
| `/think [level\|off]` | Thinking depth. With no argument, opens the level picker; with an argument, switches directly; `off` stops sending the thinking field for this session |
| `/permission [manual\|auto\|yolo]` | With no argument, shows the current tier; with an argument, switches (an invalid value behaves like no argument: it only shows, it does not switch) |
| `/yolo` | Switch straight to yolo (allow everything) |
| `/auto` | Switch straight to auto (writes allowed, bash needs approval) |
| `/plan` | Toggle plan mode (session-level state, persisted on toggle) |
| `/provider [name]` | With no argument, opens the provider channel panel (switch / add / delete); `list` prints a static text list; with an argument, switches directly (a custom channel id takes priority over a preset name); `/provider add` launches the add-channel wizard (manual entry or import from the models.dev catalog) |
| `/goal [pause\|resume\|cancel]` | With no argument or `status`, shows the goal status panel; with a subcommand, controls the goal state |
| `/team <subcommand>` | Multi-agent team mode: `init [--dir <path>]` initializes (`--dir` stores state outside the repo for cross-repo work), `status` shows missions, `exit` leaves with state preserved, `teardown [force]` wraps up and removes worktrees |
| `/loop` (alias `/cron`) | List scheduled and recurring tasks with their next trigger time (read-only; creation is done by the model calling `cron_create`) |
| `/fork` | Fork a new session copy from the current point, leaving the original session untouched |
| `/new` | Start a new session (clears the context, todo list, plan mode, dynamic tools, and thinking level override) |
| `/compact` | Compact the context manually, printing the token count before and after |
| `/history [N]` (alias `/undo`) | With no argument, opens the input history panel for this session (Enter backtracks to that turn and recalls the original text for resending, Tab only recalls the text); with an argument, undoes the last N turns directly without opening the panel |
| `/reflect` | Review the full session history, distill reusable methodology, and print it; the output also enters the conversation stream, so you can say "remember item N" to have the agent save it to memory |
| `/agents` | List sub-agent sessions spawned from the current session; select one to drill in and read back its history |
| `/export-debug-zip` | Export a session debug bundle (session body + redacted config + runtime logs) |
| `/usage [--all]` | Show per-model token usage and cache hit rate for this session; `--all` aggregates every session in this working directory (including crash leftovers that have an event log but no snapshot). Read-only, runs instantly while busy |
| `/resume [id]` (alias `/sessions`) | With no argument, opens the interactive session picker (main sessions only); with an id, resumes directly |
| `/lang [zh\|en]` | With no argument, shows the current language; with an argument, switches the interface between Chinese and English and writes `language` back to `config.toml` |
| `/memory [on\|off]` | Memory observation pool: with no argument, lists current observations (global + project layers, with index usage and files needing repair); `on`/`off` toggles and persists to `[memory] enabled` in `config.toml`. Off by default; observations do not take effect directly — they are promoted to your rules only after your review |
| `/mcp` | Check MCP server connection status and tool counts |
| `/skill [name] [args]` | With no argument, opens the interactive skill picker (type to filter, ↑↓ to select, Enter to activate, Esc to cancel); with an argument, activates one manually |
| `/skill reload` | Force a rescan of the skill directories (changes to SKILL.md made mid-session take effect immediately; turn boundaries also detect them automatically) |
| `/reload` | Hot-reload `config.toml` |
| `/plugin` | Manage plugins: `install / list / enable / disable / remove / info` |
| `/tasks` | Open the background task browser (list + output preview + stop running tasks) |
| `/exit` (`/quit`, `/q`) | Quit |

Plugins can register their own commands in the form `/<pluginId>:<commandName>`; after argument expansion they are submitted as a message.

### Command routing while the model is working

Commands typed while the model is running are not all queued. They split into two paths based on whether they change state the current turn depends on:

- **Executed immediately**: `/help`, `/goal`, `/team`, `/loop`, `/sessions`, `/agents`, `/lang`, `/mcp`, `/plugin`, `/tasks`, plus the **argument-free query form** of `/model`, `/provider`, `/permission`, `/skill`, and `/think`. Unknown commands also report immediately, with no need to wait for the turn to end.
- **Queued to the turn boundary**: every other command (those that change history, the session, the model, permissions, or plan mode, or that trigger an exit) joins the send queue just like an ordinary message.

While busy, `/model` with no argument does not open the picker, it only prints a note; `/think` with no argument degrades to a text list of levels; `/fork` and `/export-debug-zip` are refused outright while busy, with a note to try again later.

### `/history` review and backtracking (alias `/undo`)

With no argument, this opens the input history panel for the session: it lists, one by one, the turns as split by real human input (system injections and silent turns do not count). Use ↑↓ to browse and Enter to backtrack to a turn: the context rolls back to before the start of that turn (including the model replies and tool results those turns produced), the transcript is truncated to match, the todo list and plan mode roll back to their per-turn snapshots, and the original input text of that turn is put back into the input box so you can edit it and resend. Tab only recalls the original text into the input box without backtracking; Esc closes the panel.

- **Code changes are not rolled back.** The files have already been written; backtracking only concerns conversation state.
- **You cannot backtrack past a compaction point.** After `/compact`, older turns have been folded into a summary and no longer count as backtrackable turn starts; compaction also clears the snapshot stack.
- `/new`, `/resume`, and `/fork` also clear the snapshot stack. Backtracking afterwards can still roll back the context, but the todo list and plan mode stay as they are (there is no snapshot to restore).
- `/history <positive integer>` (that is, the old `/undo N` usage) skips the panel and undoes the last N turns directly without recalling the text; when N exceeds the number of backtrackable turns, it backtracks as far as the earliest turn.
- The input history reached with ↑↓ in the input box (cross-session drafts) is a separate data source: the panel reviews the turns already sent in this session.

### `/reload` hot-reloads the config

This re-reads `config.toml` without restarting the process and without touching the session history. After running, it prints a field-level diff (`+` added / `-` removed / `~ old → new`); for `api_key` it reports only that it changed, without echoing the content.

- **Failure atomicity**: when parsing or validation fails, the old config is kept in its entirety, with nothing partially applied, and only the error is reported.
- The provider is rebuilt as circumstances require: if the alias the current model is bound to still exists, it is rebuilt from the new config (taking effect on the next request); if the alias was deleted or cannot be resolved, or the rebuild fails, the old provider is kept and a note is printed. When the construction parameters have not changed, the rebuild is skipped.
- A change to `language` switches the interface language immediately.
- A few fields are fixed once at startup, and their diff lines get "restart required" appended: `agents_paths`, `agents_md_max_bytes`, `background.bash_task_timeout_s`.

## Keybindings

| Key | What it does |
|------|------|
| Esc | See "The layered semantics of Esc" below |
| Ctrl+C | During generation the input box takes priority: when the input box has content it only clears the input box and **does not interrupt the turn**; only when the input box is empty does it interrupt the current turn (to interrupt while you have a draft, press once to clear and once more to interrupt). When idle, the first press clears the input box and arms the "press again to quit" state (auto-cancelled after 5 seconds without a second press), and the second press quits |
| Ctrl+B | Send all foreground bash tasks to the background: the process keeps running, the tool call returns a background task id immediately, and the final-state notification and status bar `bg:N` badge stay in sync. Foreground tasks are now registered at process start, so user-initiated detach and foreground-timeout auto-detach share the same release path; interrupting with Esc / Ctrl+C no longer kills a task that has already been detached |
| Ctrl+O | Open the full-screen viewer: recent expandable tool output and thinking content, grouped by turn and rendered in full; ↑↓ or `k`/`j` to scroll by line, PgUp/PgDn to page, ←/→ to switch turns, Home/`g` to jump to the top, End/`G` to jump to the bottom, Esc/`q`/Ctrl+O to close (output already committed to history stays a collapsed summary in the conversation area) |
| Alt+V | Paste an image from the clipboard: appends the placeholder `[image #1 (width×height)]` at the end of the input box, which you can edit and delete like ordinary text and which expands into the image on submit. Available only when idle. On Windows it uses the built-in PowerShell; on macOS the built-in osascript; on Linux it needs `xclip` (X11) or `wl-clipboard` (Wayland) installed, and prints a note when they are missing |
| ↑ / ↓ | With an empty input box, walks back through send history (bash-style draft stashing); when a menu is visible, they belong to menu selection; while busy with an empty input box, ↑ first recalls one entry from the tail of the send queue for editing |

While an overlay is active (the model picker, the thinking level picker, the history review panel, the session picker, the provider channel panel, the add-channel wizard, the background task browser, the approval panel, the question panel, the plan confirmation box), every key goes to that overlay and the global keys in the table above stand down for the moment. Ctrl+O is no exception: pressing Ctrl+O while another overlay is open is ignored, and while the viewer itself is open it takes over every key.

### The layered semantics of Esc

Esc is resolved layer by layer in the following priority order, and overlays always come first:

1. **While an overlay is active**: Esc = cancel / deny, consumed by the overlay itself. In the plan confirmation box, Esc is equivalent to `n` (reject and hand the feedback back to the model for revision).
2. **While the slash menu is visible**: Esc closes the menu and clears the input box without interrupting the turn. Only the next Esc, after the menu is closed, takes effect on the turn.
3. **During generation**: interrupts the current turn, keeping history. When the send queue is non-empty, dispatch resumes automatically once the turn ends.
4. **Idle with a non-empty send queue**: merges the queued content back into the input box and hands it to you for editing; the queue is cleared.
5. **Idle, with an empty queue, an empty input box, and a backtrackable message present**: the first Esc arms the state (auto-cancelled after 5 seconds without a second press), and the second Esc backtracks the previous user message and the history after it, putting the original text back into the input box for re-editing.

### Input box editing keys

The input box supports readline-style cursor movement and deletion keys. When typing by hand, Enter submits and you cannot enter a newline; multi-line text pasted from the clipboard keeps its newlines and is displayed line by line (`\r\n` from the Windows clipboard is normalized to `\n` automatically):

| Key | What it does |
|------|------|
| Home / Ctrl+A | Cursor to the start of the line |
| End / Ctrl+E | Cursor to the end of the line |
| ← / → | Move one character left or right |
| Ctrl+← / Alt+B | Move left by word |
| Ctrl+→ / Alt+F | Move right by word |
| Backspace | Delete the character before the cursor |
| Delete | Delete the character at the cursor |
| Ctrl+W | Delete the previous word (along with the whitespace before it) |
| Ctrl+U | Delete to the start of the line |
| Ctrl+K | Delete to the end of the line |

The cursor is computed in Unicode code points, so CJK characters and emoji are never cut in half.

## Permission tiers

Three tiers, defaulting to manual at startup:

- **manual**: writing files (`write_file` / `edit_file`) and running commands (`bash`) both require item-by-item approval.
- **auto**: file writes are allowed, `bash` still needs approval.
- **yolo**: everything is allowed, suitable for a sandbox or for tasks you fully trust.

Read-only and non-destructive tools are allowed outright at every tier and never interrupt you: `read_file`, `read_media`, `list_dir`, `glob`, `grep`, `web_search`, `web_fetch`, `web_image_search`, `spawn_agent`, `exit_plan_mode`, `ask_user`, `todo_list`. Spawning a sub-agent is harmless in itself; the sub-agent's own writes and command executions each pass through permissions on their own. Tools not on any of the lists above — those brought in by MCP and plugins — require approval under manual and auto.

Tool names for which you have chosen "Allow for this session" are allowed outright for the rest of the session, until `/new` or a session switch.

### The approval panel

When approval is needed under manual or auto, a vertical numbered list pops up with four options:

| Key | What it does |
|------|------|
| ↑↓ + Enter | Move the selection (wrapping around) and confirm |
| 1 / 2 / 3 | Pick directly and act immediately: allow once / allow for this session / deny |
| 4 or f | Enter the "deny with feedback" state |
| y / a / n | Equivalent to 1 / 2 / 3 (kept for muscle memory) |
| Esc | Deny outright at any moment (without feedback) |
| Ctrl+E | Expand or collapse the preview of the content to be written (meaningful only when the content exceeds the display limit) |

After choosing "deny with feedback", that row turns into an inline input box; type your reason and press Enter to feed it back to the model as the tool result. In this state ↑↓ leave the feedback mode and move the selection, and Esc still denies outright. When a `bash` command matches a dangerous pattern, a bold red warning line is rendered above the command summary.

In non-interactive mode (`-p`), write operations require `--auto` or `--yolo`, otherwise they are denied.

## Plan mode

Once `/plan` is on, the permission layer hard-blocks every write-class and execution-class tool (the block reason is fed back to the model as the tool result) and allows only read-only investigation and `exit_plan_mode`. When the model has finished investigating, it calls `exit_plan_mode` to submit the plan, which raises a `Ready to code?` confirmation box: `y` approves and executes, `n` or Esc rejects and hands the feedback back to the model for revision.

After approval, plan mode is turned off automatically and the permission tier you were on before is restored. It is an independent dimension layered on top of the permission tiers: manual + plan, for example, means "produce a plan first, then confirm each step of execution after approval". It suits tasks with a wide blast radius where you want to see the approach before anything moves. Type `/plan` again to turn it off early.

Plan mode is session-level state, persisted on toggle and read back when the session is resumed; `/new` resets it.

## The session picker

`/resume` with no argument (or `step -r` on the command line without an id) opens the interactive session picker: ↑↓ to move (**wrapping around**, unlike the ↑↓ of the provider channel panel, which stops at the ends; paging lets you get through every session), type directly for fuzzy search, Enter to resume, Esc to cancel, Delete/Ctrl+D to delete the highlighted session (`[y/N]` second confirmation; the current session cannot be deleted), and r to rename the highlighted session (renaming does not affect the ordering; the command line `step sessions rename <id> <name>` is equivalent). `/resume <id>` switches directly by text. `/sessions` is an alias of `/resume` and behaves identically; to list sessions read-only, use the command line `step sessions list`. When the current directory has no session history, it only prints a note and does not open the picker. The permission tier and the model are persisted with the session and read back on resume. See [Session management](./sessions.md#interactive-session-picker-shared-by--r-on-the-command-line-and-resume-in-the-interface) for details.

## Switching models

`/model` with no argument opens the interactive picker (provided you have registered aliases under `[models]` in config.toml, see [Configuration](./configuration.md)):

- A single flat list; each row shows the model display name (left column) plus the name of the channel it belongs to (right column, grey), and the entry currently in effect is marked `← current`.
- ↑↓ to move; type characters directly for fuzzy filtering (matching the alias, display name, or channel name), Backspace to delete filter characters; Enter to confirm, Esc to cancel (with a filter term present, it clears the term first).
- While the model is working (busy/streaming), switching is refused with a note.
- When the current session already has history, a warning appears at the top of the picker: "Switching models invalidates the existing prompt cache; start a new session with `/new` to avoid extra token cost".

`/model <alias>` switches directly by text, skipping the picker. Either way, confirming rebuilds the provider from the alias's merged config, the context window follows along, and the status bar shows the new model's display name. Confirming also updates the top-level `model` in config.toml to the chosen alias, so the next new session uses it (the two cases of a `step --model` command-line override and resuming an old session with `/resume` are not written back).

**Shift+Enter for session-only switch**: in the picker, pressing Shift+Enter confirms the model switch but does not write back to config.toml — useful for "try another model for this turn, keep the old one as default". Enter means "switch and set as default"; Shift+Enter means "switch for this session only".

`/think` controls thinking depth (available only on channels using the anthropic protocol with `[thinking]` enabled): with no argument it opens the level picker (degrading to a text list when the session is busy), `/think <level>` switches directly, and `/think off` stops sending the thinking field for this session. The level table comes from `[thinking.levels]` (defaulting to low/medium/high = 1024/4096/32000), and the current level is shown next to the model name in the status bar. Switching affects only the current session and is not written back to config.toml (use `default_level` to persist it); when the session already has history, switching warns that the prompt cache is invalidated. If the level you switch to leaves too little room for the response under the current `max_tokens`, a warning is given, but it is not hard-blocked.

## Switching providers

`/provider` with no argument opens the provider channel panel (when the session is busy it degrades to a note and does not open the panel):

- The list is a merged view of the custom channels in config.toml `[providers]` plus the built-in presets (when a custom channel and a preset share a name, the custom one wins, and rows unique to presets are tagged "builtin"); each row shows the id, type, base_url, and alias count, and the row of the channel currently in effect ends with `← current`.
- ↑↓ to move (**stopping at the top and the bottom, without wrapping around**, which differs from the wrapping ↑↓ of the session picker); Enter on a channel row switches to that channel, and on the trailing `[+ Add channel]` row (or by pressing `a`/`A`) enters the add wizard; `d`/`D` deletes a custom channel (built-in presets cannot be deleted); Esc closes. The add and delete keys are accepted in either case.
- Deletion first drops into an inline `[y/N]` confirmation state, which **accepts only `y`/`n`/Esc** (in either case) and swallows every other key. This is a deliberate guardrail against accidental deletion: while the confirmation is open, pressing ↑↓ will not casually move the selected row away.
- The switching semantics share the same code path as the `/model` picker: a custom channel switches to its first model alias in config-file order (rebuilding the provider, with the context window following along and the default model pointer persisted); when a channel has no aliases, nothing switches and a note is printed. Preset rows go through a preset rebuild (see the table below).

`/provider list` preserves the static text output from the days when the command took no argument (the current provider plus the id/type/base_url/alias count of each custom channel), for print mode and scripting.

`/provider <id>` switches directly by text: it matches custom channel ids first (with the switching semantics above), then built-in preset names, and when neither matches it reports an error and lists every available channel. A preset rebuilds the provider from its built-in definition, taking effect on the next request:

| Preset | Protocol | Notes |
|------|------|------|
| `stepfun` | Anthropic Messages | Default, `base_url` without `/v1` |
| `anthropic` | Anthropic Messages | No preset model; after switching you need `/model` to pick one |
| `openai` | Chat Completions | `base_url` includes `/v1` |
| `openai_responses` | Responses | `base_url` includes `/v1`, supports tool calling; on the StepFun side only `step-3.7-flash` currently offers this protocol |

When a preset comes with a default model, that is switched to as well, otherwise a note asks you to pick one with `/model <name>`. Rebuilding from a preset breaks the binding to the `[models]` aliases (both the channel and the model may change), so a later `/reload` no longer rebuilds the provider through the alias path. An unknown provider name only prints the available list and changes nothing; when a rebuild fails, the original provider is kept and the error is reported.

### Deleting a channel

What D in the panel deletes is a custom channel in config.toml: after confirmation, the whole `[providers.<id>]` section and every `[models.<alias>]` section under it are removed together (and if the top-level `model` pointer points at a deleted alias, it is cleared too), with an automatic timestamped backup before the write, an automatic `step doctor config` validation after it, and a rollback on failure. When you delete the channel currently in effect, this session's provider instance keeps working in memory and lapses on restart or on a switch; after the deletion, `/reload` makes the config take effect throughout.

### Adding a channel (/provider add)

`/provider add` launches the add-channel wizard, so you do not have to edit the config file by hand: the manual entry path fills in the channel, the credentials, and the first model alias step by step (including a multi-select for capabilities); the catalog import path picks a vendor from the models.dev model catalog, with the endpoint, model aliases, window, and capabilities pre-filled from the catalog metadata, leaving you only the API key to supply. The write appends sections at the end of config.toml (comments and existing content are untouched, with an automatic backup plus validation and a rollback on failure). On success the config refreshes automatically and the model picker is raised directly (pre-selected to the new channel's tab) so you can set a default model; Esc there merely means "do not set a default", and the channel and model are already persisted and are not undone. See [the `/provider` wizard in the configuration reference](./configuration.md#the-provider-wizard) for details.

## Displaying the reasoning process

The Step 3.x family are always-thinking models, so responses come with a reasoning process. The TUI renders it unconditionally:

- **During streaming**: the status line shows "Thinking…" plus a scrolling preview of the last few lines, dimmed, and it does not enter the formal conversation stream.
- **When there is no visible thinking text**: some models return only a thinking signature with no thinking body. In that case the status line shows a single "Thinking…" line for the whole thinking block (no scrolling preview), which is dismissed when the block ends — this distinguishes "the model is silently thinking" from "the request is stuck". The busy spinner's random status verbs have been changed to neutral ones ("working/processing/…") and no longer unconditionally claim the model is thinking.
- **After completion**: a dim italic collapsed block is committed, showing at most the first 5 lines, with anything beyond that folded into "… (N lines total)".

Whether the model **actively sends** the thinking request field, and the thinking budget, are controlled by the `[thinking]` section of config.toml (see [Configuration](./configuration.md)); but regardless of whether it is sent, an always-thinking model's response may still carry thinking blocks, and the rendering is always in effect. In non-interactive `-p` mode, thinking content does not go to stdout, keeping the output pipeable.

## Plugin management

`/plugin` manages the plugins under `~/.step-code/plugins/`:

| Subcommand | What it does |
|--------|------|
| `/plugin install <dir>` | Install from a local directory (copied into the plugin directory; reinstalling overwrites and updates) |
| `/plugin list` | List installed plugins with their enabled/disabled or error status |
| `/plugin enable <id>` / `disable <id>` | Enable / disable a plugin |
| `/plugin remove <id>` | Remove a plugin |
| `/plugin info <id>` | View plugin details |

After an enable/disable change, follow the prompt to run `/new` or restart for it to take effect. For what plugins can provide and the manifest format, see [Skills, plugins, and MCP](./skills-and-mcp.md).

## Command-line arguments

```bash
step                          # interactive (enters the pi-tui interface, manual permissions by default)
step -p "find every TODO under src"          # non-interactive: run a single instruction and exit
step --yolo -p "rename a.txt to b.txt"    # --yolo allows everything / --auto allows writes (non-interactive writes need one of them)
step --continue -p "continue the previous task"       # session continuation (-c)
step --session <id>                     # resume a specific session
step --resume                           # open the interactive session picker (-r [id])
step --provider anthropic -p "..."      # switch the provider preset
step --model step-3.7-flash -p "..."   # specify the model
step -C /path/to/project -p "..."       # specify the working directory
step --output-format stream-json -p "..."   # one JSON line per event
step sessions list                      # headless subcommand: session management
step doctor config [path]               # validate config.toml (exit code 0/1)
step export-debug-zip [sessionId]       # export a debug bundle
```

| Argument | Notes |
|------|------|
| `-p, --print <prompt>` | Run a single instruction non-interactively |
| `-y, --yolo` / `--auto` | Permission tier: allow everything / allow writes |
| `-c, --continue` | Continue the most recent session in the current directory |
| `-r, --resume [id]` | Resume a session (opens the picker when no id is given) |
| `--session <id>` | Resume a specific session |
| `--provider <name>` | Provider preset (stepfun / anthropic / openai / openai_responses) |
| `--model <name>` | Model name |
| `-C, --cwd <dir>` | Working directory (the basis for every relative path) |
| `--output-format <fmt>` | Non-interactive output format: `text` (default) or `stream-json` |
| `--reflect` | Run /reflect non-interactively (together with `-c` / `--session`) |
| `-V, --version` / `-h, --help` | Version number / help |

Headless subcommands (they do not enter the TUI): `step sessions list`, `step sessions show <id>`, `step sessions delete <id>`, `step sessions rename <id> <name>`, `step doctor config [path]`, `step export-debug-zip [sessionId]`. Both `doctor config` and `export-debug-zip` run before the config is read, so you can validate and export a debug bundle even when the config is broken.

## Non-interactive mode

```bash
step -p "instruction"                 # runs and exits; results go to stdout, tools and errors to stderr
step --yolo -p "rename a.txt to b.txt"
step -p --output-format stream-json "..."   # one JSON line per event, for programs to consume
```

Non-interactive mode can be used in a pipeline: `step -p "summarize this file" < README.md` puts the assistant output on stdout, ready to feed into a downstream command.

To consume a run programmatically (envelope contract, all event types, versioning rules), see [stream-json event stream](./stream-json.md).
