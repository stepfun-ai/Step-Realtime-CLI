# stream-json Event Stream

`step -p "..." --output-format stream-json` writes every event of the run to stdout as **one JSON object per line**, for consumption by external programs.

```bash
step -p "Read the README and summarize it" --output-format stream-json --yolo
```

```json
{"type":"text","text":"This project"}
{"type":"tool_start","id":"tu_1","name":"read_file","input":{"path":"README.md"}}
{"type":"tool_end","id":"tu_1","name":"read_file","result":"...","isError":false}
{"type":"usage","totalTokens":19414,"measuredLength":2,"billedDelta":19414}
{"type":"turn_done"}
{"type":"session.resume_hint","session_id":"20260802-abc","command":"step -r 20260802-abc","content":"To resume this session: step -r 20260802-abc"}
```

## Envelope contract

Three rules. Read them before writing a consumer:

**1. The top-level `type` is the only discriminator.** Every line has a `type` field. Dispatch on it. No recursive unwrapping, no second field needed to determine the kind.

**2. Unknown `type` values must be skipped, not treated as errors.** New versions add new event types; a consumer that throws on unknown types will break on upgrade. Correct shape:

```python
for line in proc.stdout:
    ev = json.loads(line)
    match ev["type"]:
        case "text": ...
        case "tool_start": ...
        case _: continue      # unknown type — skip, not an error
```

**3. Optional fields are absent, not `null`.** Test for presence, not for `=== null`.

## Versioning and compatibility

`STREAM_JSON_PROTOCOL_VERSION` is currently **3** (v3 adds the `result` and `session.not_found` events — additive, so v2 consumers are unaffected; v2 removed the `role` field from the `session.resume_hint` envelope).

The bump rule splits cleanly in two:

| Change | Bumps version | Why |
|--------|--------------|-----|
| New event type | **No** | Rule 2 above covers it — old consumers skip it |
| New optional field on an existing event | **No** | Old consumers that ignore it are unaffected |
| Changed field semantics | **Yes** | Same name, different meaning — old consumers silently compute wrong results |
| Removed / renamed / retyped field | **Yes** | Old consumers can no longer read the value |

In short: **additive changes will not break your program.** Only semantic changes and removals are breaking.

## Event families

Three families share one flat namespace, distinguished by `type` prefix.

### Agent loop events (no prefix)

| type | Key fields | Notes |
|------|-----------|-------|
| `text` | `text` | Assistant output delta |
| `thinking_start` / `thinking_delta` / `thinking_end` | `text` | Reasoning and its boundaries. Some models emit no visible reasoning text — you get start/end with no deltas |
| `tool_start` | `id` `name` `input` | Tool execution begins |
| `tool_end` | `id` `name` `result` `isError` | Tool execution ends |
| `retry` | `attempt` `delayMs` `message` | Request retry |
| `usage` | `totalTokens` `measuredLength` `billedDelta` | Context usage. `billedDelta` is this turn's billed increment (input + output, always non-negative), present only on real API round trips |
| `notice` | `message` | Informational (compaction applied, overflow retry, …) |
| `continuation` | `inject` | Autonomous continuation: this run ended, text will be injected into the next |
| `aborted` | — | Interrupted |
| `error` | `message` | Failure. **Its presence means exit code 1** |
| `turn_done` | — | One turn completed |
| `result` | `subtype` `text` `durationMs` `toolUses` `usage` `sessionId` | Final summary, emitted once at end of run (before `session.resume_hint`). `subtype` is `success` or `error`; `text` is the aggregated assistant output of the final turn |

### Sub-agent events (`subagent.*`)

Emitted when the main agent spawns sub-agents. **With parallel spawns, attribute by `subagent_id`** — several sub-agents may run at once.

| type | Key fields |
|------|-----------|
| `subagent.start` | `subagent_id` `subagent_type` `description` |
| `subagent.tool` | `subagent_id` `name` |
| `subagent.usage` | `subagent_id` `tokens` (cumulative, not a delta) |
| `subagent.error` | `subagent_id` `message` |
| `subagent.end` | `subagent_id` `is_error` `summary` `summary_truncated` `session_id` `tool_uses` `duration_ms` |

```json
{"type":"subagent.start","subagent_id":"1","subagent_type":"explore","description":"Read config file"}
{"type":"subagent.tool","subagent_id":"1","name":"read_file"}
{"type":"subagent.usage","subagent_id":"1","tokens":7068}
{"type":"subagent.end","subagent_id":"1","is_error":false,"summary":"Config lives at ~/.step-code/config.toml…","session_id":"f2c14fb3-…","tool_uses":1,"duration_ms":10153}
```

On `subagent.end`:

- **It always arrives.** Normal completion, interruption, or internal exception — every `subagent.start` gets a matching `subagent.end`. Safe to use as your "is this sub-agent still running" signal.
- `summary` is truncated past 500 characters, in which case `summary_truncated: true` appears. Retrieve the full output via `session_id`: `step sessions show <session_id>`.
- `tool_uses` and `duration_ms` are that sub-agent's tool call count and wall-clock time.

### Session metadata (`session.*`)

| type | Notes |
|------|-------|
| `session.resume_hint` | Emitted at end of run with `session_id` and `command`, for resuming this session |
| `session.not_found` | Emitted when `-p` is combined with an explicit `--session <id>` that does not exist; carries the requested `session_id` and `sessions_dir`. **The process then exits with code 2** — resumption failure is never silently downgraded to a fresh session in non-interactive mode |

## Error handling

Consumers need to distinguish two failure modes:

**1. The agent reported an error.** A `{"type":"error","message":"..."}` appears in the stream and the process exits with code 1. This is an expected failure and `message` carries a readable cause. **The stream stays intact even when this happens** — already-emitted events are not discarded, the error is appended at the end, and the session is still persisted and resumable.

**2. The process died.** Non-zero exit with no `error` event (e.g. config validation failure during startup). The message is on **stderr**, not stdout.

So the robust pattern is: **parse events from stdout, collect stderr separately, use the exit code as a backstop.**

## Compared to text mode

| | `text` (default) | `stream-json` | `json` |
|---|---|---|---|
| stdout | Assistant output only, pipe-friendly | One JSON event per line | A single JSON object at end of run |
| Tool calls / notices / errors | stderr | stdout, as events | Counted into the `result` object |
| Reasoning | Not emitted | `thinking_*` events | Not emitted |
| Sub-agents | Brief stderr lines (tools and errors only) | All five events | Not emitted |

`text` targets humans and shell pipelines; `stream-json` targets programs that need real-time progress; `json` targets programs that only need the final result — its stdout object has the same shape as the `result` event, so `step -p "..." --output-format json | jq .text` works directly.

## Exit codes

| Code | Meaning |
|------|---------|
| `0` | Run completed (individual tool errors may still have occurred — check `result.subtype` or the event stream) |
| `1` | An `error` event was emitted, stdin was empty when a prompt was expected from it, or startup failed |
| `2` | `-p` with an explicit `--session <id>` and the session does not exist (`session.not_found` event in stream-json mode) |

## Known limitations

- **One-way.** You can only read the event stream; external programs cannot answer the agent's questions. Operations requiring confirmation are denied outright in non-interactive mode — use `--yolo` or `--auto` to allow them.
- One prompt per process; there is no long-lived multi-turn session in a single process. For multi-turn conversations, pass the `session_id` from the previous run's `session.resume_hint` (or the `result` event) to the next run via `--session <id>` — the full message history is restored and the new prompt is appended to it.
