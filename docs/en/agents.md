<p align="center">
  <a href="./README.md">English</a> |
  <a href="../zh/agents.md">简体中文</a>
</p>

# Sub-agents and automation

This page covers the mechanisms that let the model work in parallel, on a schedule, or continuously on your behalf: sub-agents, dynamic_workflow, autonomous goals, and cron jobs, plus the background task management that supports them.

## Sub-agents (spawn_agent)

The model can spawn sub-agents: a fresh context, a role-scoped tool allowlist, and only a summary fed back into the main session when done. This fits the case of "let it handle one thing independently without polluting the main conversation".

- **Two built-in types**: `general` (the full tool set, can read, write, and run commands) and `explore` (read-only investigation, with a tool allowlist of `read_file`/`read_media`/`list_dir`/`glob`/`grep`/`web_search`/`web_fetch`/`web_image_search`/`skill`)
- **Custom**: write an agent definition in `.step-code/agents/<name>.md` (project level) or `~/.step-code/agents/<name>.md` (user level)
- **Precedence**: built-in < user level < project level; for the same name, the later one wins
- **Guardrails**: the per-session spawn limit, the nesting depth limit, the per-agent turn limit, and the parallel concurrency limit are all configurable in the `[subagent]` section (see [Configuration](./configuration.md))

You do not need to invoke this by hand. Just say something like "spawn sub-agents to investigate these directions in parallel" when describing the task, and the model decides on its own.

### `spawn_agent` tool parameters

| Parameter | Description |
|------|------|
| `prompt` | The full task description. The sub-agent cannot see the main conversation history, so the background must be spelled out |
| `subagent_type` | The sub-agent type; defaults to `general` when omitted |
| `description` | A short summary of the subtask (3-5 words), used for the single-line display in the TUI; when omitted, the top of `prompt` is truncated instead |
| `run_in_background` | When `true`, the spawn is asynchronous and returns a `task_id` immediately; use `task_output` to retrieve the result |
| `resume` | A sub-agent session id: continue that session from where it left off, with `prompt` appended as a new instruction to the existing history (no new session is created and the per-session spawn quota is not consumed); the call is refused while the target session is running |

The sub-agent's result string carries its session id — pass that id to `resume` when you need it to keep building on its earlier work. If the summary a sub-agent returns on completion is shorter than 200 characters, one extra turn is appended asking it to expand (at most once), which avoids the "did a lot, reported one sentence" outcome. A sub-agent's full working history is persisted: when it fails or you want to dig into the details, replay it with `step subagents show <id>`, or drill in with the `/agents` command in the interactive UI (lists sub-agents spawned by the current session; see [Session management](./sessions.md#subagent-sessions)).

### Custom agent definition format

Sub-agent definitions can live in two places: project-level `<cwd>/.step-code/agents/<name>.md` and user-level `~/.step-code/agents/<name>.md`. The loading priority is **built-in < user-level < project-level**, and a same-name definition from a later source **fully overrides** the earlier one — it is not a field merge. So if you create an `explore.md` in your project, it completely replaces the built-in `explore`.

YAML frontmatter plus a body, where the body is that agent's system prompt:

```markdown
---
name: reviewer            # optional, defaults to the file name
description: A code review agent, read-only, outputs a list of issues
tools: [read_file, grep, glob]   # optional, defaults to the full tool set
model: step37             # optional, defaults to inheriting the main session model
maxSteps: 40              # optional, defaults to [subagent].max_steps
---

You are a code review sub-agent. You read code but do not modify it...
```

| Frontmatter field | Required | Description |
|------|------|------|
| `name` | No | The registration name; defaults to the file name (with `.md` stripped) |
| `description` | **Yes** | If missing, the file is skipped; this description goes into the tool documentation so the model can pick an agent |
| `tools` | No | The tool allowlist (an array); defaults to the full tool set |
| `model` | No | A model dedicated to this agent; accepts an alias name (e.g., `step35-plan`) or a real model id. The alias corresponds to a `[models.<alias>]` block (alias preferred). Defaults to inheriting the main session's model |
| `maxSteps` | No | The internal turn limit for this agent, overriding the global default |

A file is likewise skipped when its body (the system prompt) is shorter than 20 characters. This check keeps ordinary Markdown sitting in the directory from being mistaken for an agent definition. A file that fails to parse is also just skipped, with no effect on startup.

### Choosing a model for a sub-agent

By default a sub-agent runs on the same model as the main session. The `model` field is the only place to specify a model — there is no global "secondary model" downgrade switch. If you want a given role on a given model, state it in that role's definition.

`model` accepts either a real model id or an alias name (e.g., `step35-plan`). **Prefer the alias**: an alias bundles channel, model id, context window, and display name into one unit. A raw id keeps the parent session's provider (so it cannot cross channels), makes `max_context_size` fall back to the top-level default, and may hit the wrong channel when several providers expose models with the same real id.

The typical use is downgrading read-only exploration work. Searching, locating, and summarizing do not demand deep reasoning, so a lightweight model is enough — and it is faster and cheaper. There are two ways to do it:

**Add a lightweight role**, leaving the built-in `explore` untouched and selecting the type explicitly when spawning. Write `.step-code/agents/explore-fast.md`:

```markdown
---
name: explore-fast
description: Lightweight read-only exploration sub-agent, for retrieval/summary tasks that need no deep reasoning
tools: [read_file, read_media, list_dir, glob, grep, web_search, web_fetch, web_image_search, skill]
model: step35
---

You are a read-only exploration sub-agent. Your job is retrieval and summarization at minimum cost. You cannot modify files or run commands.
You cannot see the main agent's conversation history; all necessary background is in the task description given to you.
```

**Or override the built-in `explore`**, so every exploration task takes the lightweight model. A same-name definition is a **full override, not a field merge**, so you must supply `description`, `tools`, and the body yourself — a file containing only a `model` field is skipped outright for lacking `description` (or for too short a body), and the override silently fails. The cost is that later upgrades to the built-in `explore` system prompt will not propagate into your file; you maintain it yourself.

Choosing between them: pick the override when you want every exploration downgraded, and the new role when you want to choose per task. The former is less thought, the latter keeps the choice open with no maintenance burden.

Custom role names are automatically added to the main agent's system prompt, so the model can reference them directly when spawning; when no custom roles exist, only the built-in `general` and `explore` are listed.

> **Model fallback on session resume**: When a session restored with `--resume`/`-r` or `/resume` stores a `model` that no longer exists in the current config (for example, the alias was removed or renamed), the session automatically falls back to `config.model` instead of failing to start.

### Recursion protection

The fork-bomb risk of sub-agents spawning sub-agents is covered by two independent lines of defense:

1. **Structural removal**: when `depth + 1` has already reached `max_depth`, `spawn_agent` is forcibly removed from the sub-agent's tool set, and no spawning capability is injected into it. It never receives the tool, so it has no way to call it.
2. **Hard depth limit**: even if the first line is bypassed, the runtime still validates against `ToolContext.depth`, and an over-limit call returns an error summary telling it to "complete the task yourself".

Quota accounting has its own subtlety: illegal requests of the two kinds, depth over limit and nonexistent type, do **not** consume the per-session spawn quota; only legitimate spawns count. The configuration ceiling for `max_depth` is hard-capped at 3, and the config file cannot exceed it.

### Parallel execution

The model can return multiple tool calls in a single turn, and step-code decides what may run in parallel by **resource conflict**: each tool declares its own access surface (no side effects / reads a path / writes a path / globally exclusive), non-conflicting ones run in parallel, conflicting ones run serially, and results are always fed back in call order.

The access surface of `spawn_agent` depends on the type: `explore` declares no side effects (parallelizable), while `general` declares global exclusivity (serial by nature). So multiple explore sub-agents and multiple read-only read/grep calls run in parallel, while `general` sub-agents, file writes, and `bash` run serially.

Parallel sub-agents are additionally bound by the concurrency limit of `[subagent].max_concurrent` (default 4); anything beyond it queues for a free slot. A sub-agent that fails due to rate limiting (429) does not hold a slot idle: it goes back to the end of the queue for a delayed retry, and the TUI reports the number of requeues. Permission confirmations always happen serially (multiple approvals never pop up interleaved). All of this is handled automatically by the model; you do not need to control it explicitly.

## Orchestration (spawn_agent and dynamic_workflow)

Orchestration stronger than a single sub-agent is now handled by two tools:

- `spawn_agent` — the model spawns one or more sub-agents and coordinates the results.
- `dynamic_workflow` — the model writes a JavaScript orchestration script on the spot and runs it in a quickjs sandbox; see [JS dynamic workflows](#js-dynamic-workflows-dynamic_workflow) below.

The old declarative `workflow` tool (step templates) has been removed; for multi-stage orchestration use `dynamic_workflow` or coordinate sub-agents via `spawn_agent`.

## JS dynamic workflows (dynamic_workflow)

The `dynamic_workflow` tool lets the model write a JavaScript orchestration script on the spot and execute it in a quickjs sandbox. Multi-stage tasks are handled through script primitives; single-sub-agent work is left to `spawn_agent`.

The script world has zero capabilities: files, network, processes, and environment variables simply do not exist inside it, and the only things available are the primitives injected below. Control flow is not a primitive: `if`, `for`, `.map`, and early `return` are written as plain JS, which is the expressiveness you buy by taking the script route.

The primitives available inside a script:

| Primitive | Description |
|------|------|
| `agent(prompt, opts?)` | Spawns one sub-agent and returns a Promise. A terminal failure returns `null` instead of throwing. `opts` supports `subagentType`, `description`, `schema`, and `phase` |
| `parallel(thunks)` | A concurrency barrier: pass a group of **functions** that return Promises (`[() => agent(...), ...]`), and they run concurrently in one batch before being aggregated. It **never rejects**: failed positions are filled with `null`, so one failure does not drag down the batch |
| `pipeline(items, ...stages)` | Each item passes through the stages serially (`pipeline(items, s1, s2)`). If one item fails at one stage, that item drops to `null` and skips the remaining stages, leaving the other items unaffected |
| `phase(title)` | Marks an execution phase (presentation-layer semantics only, no effect on execution) |
| `budget({agents, minutes})` | Tightens the budget for this run; it **can only tighten, never loosen**. Once exhausted, `agent()` throws |
| `args` | The `args` object passed in at call time, accessed inside the sandbox as the global `args` |
| `console.log` | Quota-limited logging; it does not enter the main context and only rides along in the final report |

**Fan-out must go through `parallel`, not a bare `Promise.all`**: one rejection blows up the whole batch with `Promise.all`, and the guarantee that one failure does not drag down the batch is something only `parallel` can offer. By the same token, do not `await` several independent `agent()` calls one at a time, which is N times slower.

```js
// Fan out independent tasks concurrently, then aggregate
const rs = await parallel([() => agent('Investigate X'), () => agent('Investigate Y'), () => agent('Investigate Z')]);
return 'Synthesis: ' + rs.filter(Boolean).join('; ');
```

Because failed positions are `null`, you **must** call `.filter(Boolean)` or check each item for null before aggregating, otherwise `null` will leak into the results.

### Structured output (the `schema` on `agent`)

`schema` is an **opts field** of `agent(prompt, { schema })`, not a tool-call parameter. It constrains the return value of a **single agent call**, not the script's final report. Once you provide `schema` (a JSON Schema object): an output contract is automatically appended to the prompt, and the return value is parsed as JSON and validated with ajv; on a mismatch, the sub-agent is asked to correct and retry with the validation errors attached, **at most 2 times**; on success it returns the parsed **object** (not a string, so downstream code can read fields directly), and if it still fails it returns `null`.

```js
const S = { type: 'object', properties: { topic: { type: 'string' } }, required: ['topic'] };
const rs = (await parallel(items.map((it) => () => agent('Research: ' + it, { schema: S })))).filter(Boolean);
return rs.map((r) => r.topic).join('\n');
```

If `schema` itself is not a valid JSON Schema, it throws (a script bug, not swallowed into `null`).

### Current state of phase markers

`phase(title)` and `agent(..., { phase })` do emit phase events, but there is **no consumer at present**: the event channel is wired up, while the per-phase display on the TUI side is left for later. So the only real benefit of `phase` today is that it enters the log buffer and is visible in the final report; do not expect a grouped panel to appear in the interface. When running in parallel, mark individual agents with `agent(..., { phase })` rather than serializing concurrency just to attach a phase marker.

### Determinism bans

To keep the cache prefix aligned on resume, the sandbox bans four kinds of non-deterministic APIs:

| Banned | Description |
|------|------|
| `Date()` called as a function | Ignores its arguments and always returns the current time as a string |
| No-arg `new Date()` | Constructs a different result every time |
| `Date.now` | Same as above |
| `Math.random` | Same as above |

What is kept: `new Date(timestamp)` with an argument, `Date.parse`, and `Date.UTC`. **Escape hatch**: when a script genuinely needs the time, pass a timestamp in from the caller via `args` and construct it with `new Date(args.ts)`.

### Tool parameters

| Parameter | Description |
|------|------|
| `script` | The JS orchestration script (an async function body, ending with `return <report>`). Give exactly one of this, `name`, and `script_path`; when both `script` and `name` are given, `script` wins |
| `name` | Loads and runs the existing script at `.step-code/workflows/<name>.js` by name. On a miss it errors out and lists the currently available script names |
| `save_as` | Saves this `script` as a named script (overwriting an existing one with the same name), so it can later be reused via `name`. Must be paired with `script` |
| `script_path` | Reads the script from a file inside cwd and runs it; **a path outside cwd is rejected outright**. Giving it together with `script` or `name` is ambiguous and is rejected |
| `args` | The parameter object passed to the script, accessed inside the sandbox as the global `args` |
| `max_agents` | The total agent limit (a guardrail), default **100**, hard cap **1000**; exceeding it throws into the script |
| `description` | A short summary of the orchestration task (3-5 words), used in the background task list; with `save_as` it is written as the first-line comment of the script |
| `run_in_background` | Runs asynchronously in the background, returns a `task_id` immediately, and injects a notification automatically on the terminal state. **v1 limitation**: a background orchestration hit by `task_stop` is only marked `killed`; the sub-agents already running are not truly aborted |
| `resume_from_run_id` | Names the runId of a previous failure, preloads its journal cache, and replays the script from the beginning |

Other guardrails: the final report is capped at **32KB** (truncated beyond that); the default wall-clock limit is **30 minutes** (`budget({minutes})` can only tighten it); every execution archives a journal automatically for troubleshooting.

### How to recover after a failure

When a script dies you do not have to start over. The failure result carries three things: the number of completed sub-agents, the **journal path**, and the **script archive path** (every run is archived automatically). From these there are two recovery paths, which can be combined:

- `resume_from_run_id: "<the failed runId>"`: preloads that run's journal cache and replays the script from the beginning, where **`agent()` calls that already succeeded return their old results instantly** (without burning tokens again), and only the failed and newly added ones actually run.
- `script_path: "<archive path>"`: edit that archive file directly and rerun, without having to resend the whole script.

The typical fix combines both: edit the archive file to squash the bug, point `script_path` at it, and pass `resume_from_run_id` along to reuse the parts that already completed.

Scripts can be saved under a name for reuse: `save_as` stores one at `.step-code/workflows/<name>.js`, after which `name` invokes the script of that name, and a name that misses lists the available ones. Calling this tool with no parameters at all lists the currently available scripts (a discovery entry point).

## Autonomous goals (goal)

Give it a goal, and the model automatically continues turn after turn until the goal is met or it gets blocked:

```
You: Treat X as the goal and keep pushing on it, with a budget of 20 turns
You: /goal            # view the goal status panel
```

You only need to describe the goal and its hard limits in natural language; the model uses `create_goal` to set the goal and then drives itself.

### Model-side tools

| Tool | Parameters | Description |
|------|------|------|
| `create_goal` | `objective`, `completion_criterion?`, `replace?` | Sets the goal. When a goal is already in progress, `replace` is required to overwrite it |
| `update_goal` | `status`, `reason?` | The single entry point to the state machine; `status` takes `active`/`paused`/`blocked`/`complete` |
| `set_goal_budget` | `turns?`, `tokens?` | Sets the budget; either one alone or both together, but not neither |
| `get_goal` | none | Reads back the current goal and budget usage |

`complete` is transient: marking completion clears the goal and prints a completion statistics line in the transcript (turns plus wall-clock time).

### Turn-level driving

The automatic continuation of a goal is not a loop inside one call, but **one independent agent call per turn**: after the model reports its own stop for this turn (`end_turn`), control returns to the App layer, which decides whether to start the next turn and assembles the injected text for it (the goal reminder, the continuation prompt, and your messages).

The benefit of splitting it this way is that every turn boundary is a clean checkpoint: the budget is judged here, your messages are injected here, and state is persisted here. The cost is that budget judgment is granular to the turn: within a single turn the model can run many model-to-tool exchanges without the budget being checked, so the token budget is a **checkpoint at turn boundaries** rather than a hard gate inside a turn, and a single turn may overshoot the budget before being stopped.

The turn count only counts **automatically continued turns**: the turn you initiated does not count. So `turnBudget = 20` actually means "auto-continue for at most 20 turns", which together with the first turn you initiated adds up to 21 model calls in total.

### Passing it notes while it runs (steer)

You do not have to wait idly while a goal advances autonomously; just type and send. Such a message **does not interrupt the current turn**, and is recorded in the steer queue and handed to the model with the injected text at the start of the next turn (the prompt asks it to respond to that first). The TUI replies with "your message has been recorded and will take effect on the next autonomous turn".

This is a different behavior from "queueing until the goal finishes". Steering applies when the goal status is `active`, the session is currently busy, and what you send is plain text (not a slash command and without images). Messages with images and slash commands follow their own existing paths: commands like `/goal` and `/loop` take effect immediately even while busy, so `/goal pause` can hit the brakes at any time.

When you interrupt the current turn with Esc, steer messages that have not been consumed yet are not lost; they turn into ordinary queued messages and are sent onward.

### Budgets: turns and tokens

A goal supports two hard budgets, either alone or together:

- **Turn budget**: how many turns it may auto-continue at most.
- **Token budget**: how many tokens it may consume cumulatively (accumulated on the billing basis: input minus the cache-hit portion, plus output).

When either budget reaches 75% or more, the injected goal reminder appends a "budget running low, converge and wrap up" hint so the model converges on its own; when either budget is exhausted, the goal is marked blocked at the **next turn boundary** and auto-continuation stops. Budgets are opt-in: the model only sets one when you state a hard limit explicitly, and never invents one.

Tokens spent while paused or blocked do not count toward the goal's ledger, so the token number on the panel is "consumption while the goal was active", which is not the same as the total cost over that goal's lifetime.

### Taking over manually

`/goal` and its subcommands are available at any time (they take effect immediately even while busy):

| Command | Behavior |
|------|------|
| `/goal`, `/goal status` | Shows the status panel: objective, completion criterion, status, turn and token usage against the budgets, termination reason, wall-clock time |
| `/goal pause` | Pauses and stops auto-continuation |
| `/goal resume` | Restores it to active |
| `/goal cancel` | Cancels and clears the goal |

`/goal resume` only changes the status and does not itself start any turn: after resuming, the goal sits in an "active but nobody driving it" state, waiting for your next message (or a cron trigger) to pick it up. For a goal that is already blocked and whose budget has not been loosened, resume will **run one full turn first** before being blocked again at the turn boundary, and the cost of that turn is really incurred. There is no command-level entry point for adjusting budgets; loosening a budget goes through natural language, having the model call `set_goal_budget`.

The status bar has a goal badge (elapsed time, turns[/budget], with the dot colored by status), and setting, pausing, resuming, blocking, and completing all print a marker line in the transcript.

### Persistence

Goal state is saved along with the session (the `goal` field of the session file), persisted on every status change and at the end of every turn. When a session is restored with `--continue` or `--resume`, a goal that was active is **downgraded to paused** (to prevent unattended token burn after a restart), and you need an explicit `/goal resume` to revive it; paused and blocked states are preserved as they were. This downgrade is silent and prints no notice line, so watch the status bar badge, or type `/goal` to confirm.

Sessions branched with `/fork` and created with `/new` do not inherit the goal.

## Team mode (/team)

Split a large piece of work into missions and run multiple sub-agents in parallel, each in its own git worktree, **changing the same (or multiple) repositories**, then review and merge each mission back. Compared with dynamic_workflow: workflows cover batch tasks whose flow is known up front; team mode covers parallel development where missions have dependencies, write conflicts, and need on-the-spot judgment.

```
You: /team init
You: swap the data layer to the new API, update docs and tests too
agent: (plans M1 data layer / M2 docs / M3 tests, each with a write scope and deps)
       (M1 and M2 start in parallel; M3 depends on M1 and is held by the system
        until M1 merges, then unlocks automatically)
       (each worker works in its own worktree, coordinating via mailbox notes)
agent: M1 is done; I reviewed the diff and merged it into main. M3 is now unlocked…
```

### Rules

- **Mutually exclusive write scopes**: at planning time every build mission declares the paths it may touch; overlapping scopes between two build missions are rejected outright. Survey (read-only) missions take no slot.
- **Hard write isolation**: a worker's working directory is its own worktree, and `write_file` / `edit_file` outside it are denied — each worker may only write inside its own worktree. Bash is not intercepted (workers need git commits inside the worktree); normal work stays inside. This is the honest boundary.
- **System-enforced dependency gating**: a mission whose dependencies are not all merged cannot be started — the system refuses, it does not rely on the coordinator remembering.
- **Five-gate merge**: the coordinator reviews the diff before merging — ① reviewed (pass the branch tip you reviewed) ② tip has not moved since ③ dependencies all merged ④ no files outside the mission scope ⑤ `--no-ff` merge. A real conflict triggers an automatic `merge --abort` that restores the repo and returns recovery guidance.
- **Mailbox**: workers and the coordinator leave notes for each other (directed or `all` broadcast; md files under `.teams/comms/inbox/`, auditable).
- **Interruption**: Esc only stops the coordinator's current turn; background workers keep running (stop one with `task_stop`). `/team exit` leaves the mode with all state preserved; `/team init` re-enters and picks up where you left off.

### Commands

| Command | What it does |
|------|------|
| `/team init [--dir <path>]` | Initialize the team (refuses unless the cwd is inside a git repo with at least one commit). `--dir` stores team state outside the repo and, together with per-mission repo ownership, enables cross-repo work |
| `/team status` | Mission list and status (instant even while busy) |
| `/team exit` | Leave team mode, state fully preserved |
| `/team teardown [force]` | Wrap up: remove worktrees (dirty ones are kept unless `force`), state directory kept for audit |

### Model-side tools

`team_init` / `team_plan` / `team_spawn` / `team_merge` / `team_teardown` are coordinator-only (main agent); `team_send` / `team_inbox` / `team_status` are available to the coordinator and workers alike. The status bar shows a `team` badge while team mode is active.

## Cron jobs (cron)

At the appointed time, a prompt is injected into the session and executed automatically:

```
You: Check this repository's CI status every morning at 9
```

The model creates the job with `cron_create`, `/loop` (aliased as `/cron`) shows the list, and `cron_list` / `cron_delete` let the model inspect and delete its own jobs.

| Tool | Parameters | Description |
|------|------|------|
| `cron_create` | `cron`, `prompt`, `recurring?` | A 5-field cron expression (minute hour day month weekday); `recurring` defaults to `true`, and `false` makes it one-shot, deleted automatically after firing |
| `cron_list` | none | Lists id / expression / next fire time / recurring or one-shot |
| `cron_delete` | `id` | Deletes one job |

The scheduler ticks every 10 seconds and comes with an **idle gate**: it does not fire while the current turn is running, and catches up on the next idle tick. So a cron job never interrupts the conversation you are having.

Cron jobs are **persisted per working directory** (not bound to a session): each job is one JSON file under `cron/<cwd bucket>/` in the session data directory, and creation, deletion, and advancing the next fire time on each trigger are persisted immediately (written via a temporary file plus an atomic replace, where a failure only warns and does not affect operation). So jobs survive a process restart and a session restore, and any session in that directory will take them over.

Triggers missed while offline are **coalesced into a single catch-up fire** on restore, rather than replaying the dozen or so that piled up. Each trigger prints a cron card in the transcript (expression, job id, coalesced count, prompt body), so the card tells you how many missed runs were coalesced; what is injected into the model is still just the job's own prompt. Restore also performs two cleanups: recurring jobs created more than 7 days ago are discarded outright, and job files that are corrupt or missing fields are skipped silently, on the principle that losing one bad job beats failing to start.

## Background tasks

The `bash` tool supports `run_in_background`: long commands (builds, tests, servers) move to the background while the main session continues. The same parameter is available on two other tools as well: `spawn_agent` (the whole sub-agent to the background) and `dynamic_workflow` (the whole orchestration to the background), so a time-consuming orchestration does not have to occupy the main session while you wait. It comes with `task_list` / `task_output` / `task_stop` for management, and the status bar has a `bg:N` badge showing the number of background tasks in progress.

The background mode of the two spawning tools shares one **v1 limitation**: `task_stop` only marks the task as `killed` and does not truly abort sub-agents that are already running. They keep running until they finish on their own; their results simply are no longer fed back. Truly stopping them requires interrupting the whole turn.

| Tool | Parameters | Description |
|------|------|------|
| `task_list` | none | Lists all background tasks: id / status / command / exit code |
| `task_output` | `task_id` | Shows one task's output (the tail retained in memory, capped at 64KB) |
| `task_stop` | `task_id` | Terminates a running task |

Tasks have four statuses: `running` / `completed` / `failed` / `killed`. At most 10 background tasks run at the same time, and when the limit is hit, a launch request fails outright with a hint to wait or stop some tasks first.

In the interface, `/tasks` opens the background task browser: ↑↓ or `k`/`j` to select, Tab to toggle the "all / running only" filter, Enter to view the full output, `s` to stop a running task, `r` to refresh, Esc or `q` to close. Pressing `s` on a task that is already terminal only prints a hint and does not enter confirmation. Once in the output viewing state there is a separate set of scrolling keys: ↑↓ or `k`/`j` to scroll by line, PgUp/PgDn to page, Home/`g` to jump to the top, End/`G` to jump to the bottom, Esc or `q` to go back to the list.

Pressing `s` enters the stop confirmation state, where **only `y` (confirm), `n` (cancel), and Esc (cancel)** are accepted and all other keys are swallowed. This is a deliberate guard against misfires, so that a stray `j` does not scroll the list while the confirmation box is still open. A task you confirm stopping sends no terminal-state notification (the result is already right in front of you).

Foreground `bash` has a default timeout of 60 seconds (adjustable with the `timeout` parameter, up to 300 seconds), and on timeout it **automatically moves to the background** to keep running instead of blocking the current turn, with the partial output already collected fed back along with the tool result (this behavior can be turned off in the `[background]` section, making a timeout a kill instead). Background tasks have their own timeout as well (`[background].bash_task_timeout_s`, default 600 seconds, 0 for unlimited), and on expiry SIGTERM comes first, followed by SIGKILL if the process has not exited after a 2-second grace period.

A completion notification is injected on a task's terminal state, so you do not have to poll:

- **Timely**: the notification is injected at a turn boundary, so the model sees it on its next turn without waiting for a whole long task loop to end; when the main session is idle, it triggers a new turn directly.
- **Compact**: the notification body is one line (task description, terminal state, exit code), followed only by a small fallback preview of the output tail (on the order of 2000 characters); the model fetches the full output itself with `task_output`.
- **Quiet**: a task you killed yourself with `task_stop` sends no "finished" notification (the result is already in the tool's return value).

Notification behavior can be turned off in the `[background]` section (`notify_on_complete`), after which the model goes back to querying actively via `task_list`. The terminal bell and desktop notifications are a separate switch (`notify_terminal`).

One anti-pattern to avoid: starting a background task and then immediately waiting on it in place, which is no better than running it in the foreground. The value of a background task is "go do something else and get notified automatically when it finishes".

## Usage advice

The legitimate use of these mechanisms is to **offload your waiting and coordination costs**: parallel investigation goes to explore sub-agents, multi-stage output goes to workflows, work that needs continuous progress goes to a goal, scheduled work goes to cron, and time-consuming commands go to the background. The main session keeps only the parts that need your judgment. Conversely, do not reach for them for a small task that a single sentence can cover, since the mechanisms themselves carry context and token costs.
