<p align="center">
  <a href="./README.md">English</a> |
  <a href="../zh/configuration.md">简体中文</a>
</p>

# Configuration reference

This page is the complete reference for configuration fields. Look things up by field; for task-oriented usage, see the individual topic pages.

## API key

Three ways to supply it, in priority order: environment variable > `.env` at the project root > `~/.step-code/config.toml`.

`.env` only fills in environment variables that are **not already set** (existing keys are never overwritten), so its real role is "a supplementary source for environment variables" rather than an independent third priority level. Only `KEY=VALUE` lines are parsed; comments and blank lines are ignored, and single or double quotes wrapping the value are stripped automatically.

```bash
# Environment variables (STEP_CODE_API_KEY is preferred; when unset, the conventional
# variable for the provider type is used as a fallback, so stepfun → STEPFUN_API_KEY still works)
export STEP_CODE_API_KEY=<your-key>

# Optional overrides
export STEP_CODE_BASE_URL=https://api.stepfun.com
export STEP_CODE_MODEL=step-3.7-flash
export STEP_CODE_PROVIDER=stepfun    # presets: stepfun / anthropic / openai / openai_responses
```

```toml
# ~/.step-code/config.toml (api_key is no longer supported at the top level; see [providers] / [models] below)
model = "step-3.7-flash"
base_url = "https://api.stepfun.com"
provider = "stepfun"                 # defaults to stepfun (anthropic protocol)
```

The command-line flags `--provider` / `--model` take the highest priority.

## Every config.toml field

File location: `~/.step-code/config.toml`.

There is only this one user-level file, with no project-level config.toml. The location of a config file is a trust boundary: cloning a repository should not let a config file shipped inside it silently inject sensitive items such as api_key, base_url, or `[[hooks]]` commands. Project-scoped customization therefore goes through directory conventions rather than a second config.toml:

| Project-level convention | Location |
|-----------|------|
| Project-level skills | `<project>/.agents/skills/`, `<project>/.step-code/skills/` |
| Project-level sub-agents | `<project>/.step-code/agents/` |
| Project conventions | `<project>/AGENTS.md` and similar; see [How AGENTS.md works](./agents-md.md) |

MCP server declarations (`mcp.json`) and `[[hooks]]` follow the same rule: only the user-level file is read.

### Top-level fields

| Field | Type | Description |
|------|------|------|
| `provider` | string | Provider preset: `stepfun` (default, anthropic protocol) / `anthropic` / `openai` / `openai_responses`. The preset determines the protocol and the default endpoint; see [Protocols and providers](#protocols-and-providers) below |
| `base_url` | string | API address. **Whether it includes `/v1` depends on the protocol**: anthropic does not (the SDK appends `/v1/messages` itself), while openai / openai_responses do (they append `/chat/completions` and `/responses`); see [Protocols and providers](#protocols-and-providers) below |
| `model` | string | Model name; defaults to the provider preset. May be an alias from `[models]` (expanded at startup), and can be overridden by an environment variable or the `--model` flag. **Rewritten automatically when you switch with `/model`** (see [The default model follows your choice](#the-default-model-follows-your-choice) below) |
| `max_context_size` | int | Context limit in tokens, default 262144. Not clamped; the value you write takes effect as-is |
| `max_tokens` | int | Maximum output tokens per response, default 65536 (enough to hold the budget of the highest thinking level plus headroom for the answer, so thinking cannot consume the entire quota and leave zero output). Not clamped |
| `language` | string | Interface language: `zh` (default) / `en`. Any other value falls back to `zh` |
| `permission_mode` | string | Default permission mode: `manual` (default) / `auto` / `yolo`; any other value fails at startup. Priority: the `--yolo` / `--auto` flags > this key > the mode stored in a resumed session. Switching at runtime with `/permission` or `/yolo` does not write back to this key |
| `proxy` | string | Proxy URL (must start with `http://` or `https://`; other values fail at startup). Effective priority: the `HTTPS_PROXY` environment variable > this key > direct connection. It applies to global requests through Node's built-in proxy mechanism; `NO_PROXY` can exclude specific domains (for example a domestic endpoint). Read only at startup, so changing this key and running `/reload` requires a restart to take effect |
| `agents_paths` | string[] | Overrides AGENTS.md collection; see [How AGENTS.md works](./agents-md.md) |
| `agents_md_max_bytes` | int | Total AGENTS.md budget in UTF-8 bytes, default 32768; `0` or a negative value disables loading. Startup warns when truncation occurs; see [How AGENTS.md works](./agents-md.md) |
| `extra_skill_dirs` | string[] | Additional skill scan directories; see [Skills, plugins, and MCP](./skills-and-mcp.md) |
| `disabled_skills` | string[] | Excludes skills by name (from any source); see [Skills, plugins, and MCP](./skills-and-mcp.md) |

An empty string in a string field is equivalent to leaving it unset; a non-numeric value in a numeric field (including `NaN` and infinity) makes the field count as unset and fall back to its default. The three string-array fields (`agents_paths` / `extra_skill_dirs` / `disabled_skills`) must be **valid as a whole**: if the value is not an array, is an empty array, or contains any element that is not a non-empty string, the entire field is discarded rather than filtered element by element. Path fields support `~` expansion and paths relative to the current working directory.

The top-level `provider` / `base_url` / `model` are the minimal form for a single model. The API key is **not** a top-level config item: a key can only be set on a `[providers.<id>]` provider or a `[models.<alias>]` alias, or supplied through an environment variable. To register multiple models and multiple providers and switch between them at runtime, use the `[providers]` and `[models]` tables.

### Protocols and providers

The provider layer supports three protocols, selected by the preset name or by the `type` field of `[providers.<id>]`:

| Protocol | Endpoint suffix | Does `base_url` include `/v1`? | Tool calling | Suitable for |
|------|----------|------------------------|----------|------|
| `anthropic` | `/v1/messages` | **No** (the SDK appends it) | Yes | coding (default; the `stepfun` and `anthropic` presets use it) |
| `openai` | `/v1/chat/completions` | **Yes** | Yes | coding |
| `openai_responses` | `/v1/responses` | **Yes** | Yes | coding (on the StepFun side, currently only `step-3.7-flash` supports this protocol) |

The StepFun Step family (such as `step-3.7-flash`) can be reached over all three protocols; all three support streaming output and tool calling, and all three can run the agent loop. The default `stepfun` preset uses the anthropic protocol, matching the behavior of earlier versions. On the StepFun side, `openai_responses` is currently open only for `step-3.7-flash`; using another model over this protocol is rejected by the server.

> **The most common pitfall: the `/v1` difference in `base_url`.** For the anthropic protocol, `base_url` only needs the domain (`https://api.stepfun.com`) and the SDK appends `/v1/messages` automatically. For the openai and openai_responses protocols, `base_url` must include `/v1` (`https://api.stepfun.com/v1`), otherwise the endpoint is assembled incorrectly and the request returns 404. The four built-in presets already set the correct default for their protocol, so this only matters when you set `base_url` yourself.

### The `[providers.<id>]` provider table

A provider is one set of "endpoint plus credentials". Once declared, it can be referenced by multiple model aliases, and multiple endpoints or multiple keys for the same vendor can be expressed separately.

```toml
[providers.step-anthropic]
type = "anthropic"                    # protocol type: anthropic / openai / openai_responses
base_url = "https://api.stepfun.com"  # the anthropic protocol takes no /v1

[providers.step-openai]
type = "openai"                       # OpenAI Chat Completions, suitable for coding
base_url = "https://api.stepfun.com/v1"  # the openai protocol takes /v1
api_key = "<your-key>"                # recommended for multi-provider setups: set the key on the provider
# api_key_env = "MY_GW_KEY"           # or store only the environment variable name, keeping the secret off disk (mutually exclusive with api_key, which wins)
```

| Field | Required | Description |
|------|------|------|
| `type` | Yes | Protocol type: `anthropic` / `openai` / `openai_responses` (the `stepfun` preset name is also accepted). If it is missing or invalid, the provider is invalid and the whole entry is skipped |
| `base_url` | No | Provider-specific API address; when omitted it falls back to the alias, then to the top level. When neither the provider nor the alias supplies one and the provider `type` differs from the top-level `provider`, it falls back to the default endpoint of that `type` preset (so an anthropic address is not sent to an openai-protocol client). Whether to include `/v1` depends on the protocol (see the table above) |
| `api_key` | No | Provider-specific key (recommended for multi-provider setups); when omitted it falls back along the [key resolution priority](#key-resolution-priority) |
| `api_key_env` | No | Indirect reference: stores only the environment variable name, keeping the secret off disk. Lower priority than `api_key`, higher than the conventional environment variables |

When a provider sets neither `api_key` nor `api_key_env`, it falls back to the conventional environment variable for its `type`. Each protocol has its own widely used variable name, and reusing them lets an existing environment work with zero changes:

| Provider type | Conventional environment variable |
|-----------|--------------|
| `stepfun` | `STEPFUN_API_KEY` |
| `anthropic` | `ANTHROPIC_API_KEY` |
| `openai` / `openai_responses` | `OPENAI_API_KEY` |

The built-in presets `stepfun` and `anthropic` always exist as implicit providers, and the `provider` field in `[models]` may point either at a custom provider id or directly at a built-in preset name, so older configs need no migration.

### Key resolution priority

When each model alias is expanded, the first available key is taken along the chain for its branch (`env(X)` means reading the environment variable named X; an empty string counts as unset):

- **Provider branch** (the alias `provider` points at a `[providers.<id>]` provider): provider `api_key` → env(provider `api_key_env`) → the conventional environment variable for the provider type → alias `api_key` → env(alias `api_key_env`) → the implicit provider key (`STEP_CODE_API_KEY` or the conventional environment variable for that branch's provider).
- **Preset/inherited branch** (the alias `provider` points at a built-in preset name, or is omitted): alias `api_key` → env(alias `api_key_env`) → the conventional environment variable for that branch's provider (inherited from the top-level provider when the alias `provider` is omitted) → `STEP_CODE_API_KEY`.

The implicit provider key itself comes from `STEP_CODE_API_KEY` > the conventional environment variable for the current provider. `api_key` is no longer supported at the top level of config.toml. When no key is found anywhere along the chain, startup no longer fails; instead the provider constructor throws a "missing API key" error with configuration guidance.

> **Warning about mixing vendors**: the implicit provider key is the last fallback for every provider, so when a provider has no key of its own, that key is sent to that provider's endpoint. When mixing several vendors, always give each provider its own `api_key` or `api_key_env` so a key is never sent to the wrong vendor.

### The `[models.<alias>]` alias table

An alias packages "provider + model id + context window + display information" into a single switchable unit. All fields are optional; omitted items inherit the top-level configuration when merged, and an omitted `model` equals the alias itself.

```toml
[models."step-3.7-flash"]
provider = "stepfun"                    # references a provider id or a built-in preset name
model = "step-3.7-flash"
max_context_size = 262144
display_name = "Step 3.7 Flash"         # optional, used by the selector and the status bar
capabilities = ["thinking", "image_in"] # optional, array of strings, passed through as-is
```

| Field | Description |
|------|------|
| `provider` | A provider id or a built-in preset name; defaults to the top-level provider. If the id it points at is neither a declared provider nor a built-in preset name, the alias is invalid (it has no effect when expanded and falls back to the top-level configuration) |
| `model` | The real model id; when omitted it equals the alias itself |
| `base_url` / `api_key` | Overrides the endpoint and credentials of the provider or the top level |
| `api_key_env` | Indirect reference: stores only the environment variable name, keeping the secret off disk. For its position in the fallback chain, see [Key resolution priority](#key-resolution-priority) |
| `max_context_size` | The context window for this model; when omitted it falls back to the top-level default |
| `max_tokens` | Maximum output tokens per response; when omitted it falls back to the top level |
| `display_name` | Display name in the selector and the status bar; defaults to the alias |
| `capabilities` | Array of capability tags (such as `thinking` or `image_in`), used for capability gating and future feature detection. Must be a non-empty array of plain strings, otherwise the whole field is ignored |

- The final model is expanded through the alias table once at startup, so `--model <alias>`, `STEP_CODE_MODEL=<alias>`, and the top-level `model = "<alias>"` in toml all behave identically.
- At runtime, `/model` opens the interactive selector and `/model <alias>` switches directly. Switching rebuilds the provider from the merged configuration, and the context window follows; see [Interactive use](./interactive.md).
- Unknown fields inside an alias are ignored; an entry is skipped when its alias name is an empty string or its value is not a table.

#### The default model follows your choice

Switching with `/model` (confirming in the selector or `/model <alias>` directly) also rewrites the top-level `model` to the selected **alias**, so the next time you start `step` for a new session, your last choice is used automatically without editing the config file by hand.

Write behavior:

- Only the top-level `model = ` line is changed. Comments, the `[providers.*]` and `[models.*]` sections, and the original file's newline style (CRLF/LF) are preserved verbatim; the file is not rewritten wholesale.
- What gets written is the **alias**, not the expanded real model id. An alias carries the whole binding of "provider + real model + window size + display name", and writing the real id would make the alias unfindable at the next startup, so `max_context_size` would fall back to the top-level default (and compaction timing would drift with it).
- Nothing is written when the value is unchanged.
- When the config file is not writable (read-only, or insufficient permissions), the switch still takes effect for this session and only a single line is printed in the transcript, because writing the config only affects the next startup.

The following two cases do **not** modify the config file:

| Scenario | Reason |
|------|------|
| The `step --model <x>` command-line override | A flag expresses "use it temporarily for this run", and letting a one-off override produce persistent consequences would violate flag semantics |
| `/resume` restored an older session that used a different model | Resuming returns you to that session's context rather than expressing a preference for future new sessions; glancing at an old session should not silently change the global default |

When several step processes switch models at the same time, the last writer wins. That race only affects "which model the next startup uses" and does not corrupt the config contents.

#### capabilities tags

`capabilities` is the capability declaration of an alias. Four values are currently supported, and only `image_in` currently has a gating effect:

| Value | Meaning | Gating |
|----|------|------|
| `thinking` | The model emits its reasoning process | Reserved (currently gates nothing; the models.dev catalog import writes it automatically, and the `/provider add` wizard offers it as a multi-select) |
| `image_in` | The model accepts image input | Mounts the `read_media` tool: when undeclared, the tool is unmounted from the tool table and the model cannot see it |
| `video_in` | The model accepts video input | Reserved (the v1 video path is not implemented) |
| `audio_in` | The model accepts audio input | Reserved |

- Neither the display of thinking nor the request wording looks at `capabilities`: the `think:` segment in the status bar comes from the session-level `/think` level, thinking blocks are rendered unconditionally, and whether the thinking request field is sent is decided by the `[thinking]` section.
- After changing a declaration, `/reload` applies it immediately (no model switch or restart needed).
- **Protocol limitation (important)**: image passthrough for `read_media` is currently end-to-end only on `anthropic` protocol providers. On `openai` protocol providers, the tool result collapse keeps text only and images are dropped silently. An openai provider that declares `image_in` therefore still cannot actually read images; this protocol translation gap is logged as a pending fix.

### The `/provider` wizard

The `/provider` command is the interactive management entry point for providers:

- **No arguments**: opens the provider management panel, a merged list of custom `[providers]` entries and the built-in presets (a custom provider wins when it shares a name with a preset, preset-only rows are labeled "built-in", and the currently active provider is marked `← current`). Enter switches provider: a custom provider switches to its first model alias in config-file order (the same path as the `/model` selector, rebuilding the provider from the merged alias configuration and writing back the default model pointer), while a preset goes through preset rebuilding; when a provider has no aliases, nothing is switched and a notice is shown. A, or the CTA row at the end, enters the add wizard; D deletes a custom provider (see below); Esc closes the panel.
- **`/provider list`**: a read-only text list (id / protocol / endpoint / alias count and the aliases that belong to it), for print mode and scripted scenarios.
- **`/provider <id>`**: switches directly from text, resolving custom provider ids first and then built-in preset names; when neither matches, it reports an error and lists all available providers.
- **`/provider add`**: launches the add wizard, with two paths:
  - **Manual entry**: step through the provider id, protocol type, base_url, API key (or an environment variable reference), the first model alias (model id / display name / window), and a capabilities multi-select.
  - **Catalog import**: pulls the vendor list from the models.dev model catalog (the address defaults to `https://models.dev/api.json` and `--url` can override it with a mirror or a local file). After you pick a vendor, the endpoint, all model aliases, windows, and capabilities are prefilled from the catalog metadata, and only the API key is left to supply. Models in deprecated or alpha status are excluded from the import list.
- Writes **append** `[providers]` / `[models]` sections at the **end** of config.toml: the file is not re-serialized, and existing content and comments are preserved as-is. A timestamped backup is taken before the write, `step doctor config` runs automatically afterwards, and a failure rolls the change back. After a successful addition, the configuration is refreshed automatically and the model selector is opened directly (preselected to the new provider tab) to set the default model; Esc merely means "do not set a default" and does not undo the provider and model already written to disk.
- Catalog fetching follows the global proxy convention: the `HTTPS_PROXY` environment variable > the top-level `proxy` key > direct connection. When the catalog is unreachable, the wizard suggests checking the network, the proxy settings, or a `--url` mirror.

**Deleting a provider** (D in the panel, with an inline [y/N] confirmation): removal happens at the text level, deleting the whole `[providers.<id>]` section from config.toml along with every `[models.<alias>]` section whose `provider = "<id>"`. If the top-level `model` pointer refers to a deleted alias, it is cleared as well (the next startup falls back to default resolution). The same safety chain as addition applies: timestamped backup before the write → a single write to disk → doctor validation → rollback on failure. Built-in presets cannot be deleted (they are not in config.toml). When you delete the currently active provider, the in-memory provider instance stays usable for this session and expires after a restart or a switch; run `/reload` after deleting to apply the configuration fully.

### `[thinking]`: the reasoning process

The Step 3.x family always thinks: whether or not the thinking field is sent, the response may include thinking blocks, and the TUI renders them unconditionally (see [Interactive use](./interactive.md)). This section only controls **whether the request side actively sends the thinking field, and its budget**.

```toml
[thinking]
enabled = true         # default false: does not actively send the thinking field, preserving existing request behavior
budget_tokens = 8192   # optional; the thinking budget, clamped to >= 1024
default_level = "high" # optional; the default level (a level name from levels), whose budget takes priority over budget_tokens

[thinking.levels]      # optional; the level table (level name → budget), defaults to low=1024 / medium=4096 / high=32000
low = 1024
medium = 4096
high = 32000
```

| Field | Default | Description |
|------|------|------|
| `enabled` | false | Whether to actively send the `thinking` request field. Off by default, for compatibility with models that reject that field |
| `budget_tokens` | — | Thinking token budget, clamped to >= 1024 |
| `levels` | low/medium/high = 1024/4096/32000 | The level table (level name → budget); custom levels are checked level by level for answer headroom |
| `default_level` | — | The default level name (must exist in the levels table, otherwise loading reports a configuration error); its budget becomes the request default, taking priority over `budget_tokens` |

When enabled, `max_tokens - budget_tokens >= 2048` is required (leaving minimum headroom for the answer, otherwise thinking consumes the entire quota and the answer is empty); failing that reports a configuration error at load time, and custom levels are checked level by level under the same rule. The default `max_tokens` (65536) leaves ample headroom for the built-in high level (32000), so the out-of-the-box setup does not hit this.

At runtime, `/think` switches the level for the session (selector / direct / off); see [Interactive use](./interactive.md). If the level you switch to leaves insufficient answer headroom under the current `max_tokens` (`max_tokens - level budget < 2048`), a budget warning is shown immediately on switching (without blocking it), suggesting a larger `max_tokens` or a lower thinking level. This avoids sending a request where thinking eats the whole budget, the answer is empty, and an "empty response" error is reported.

> If you do hit an "empty response / thinking consumed the entire output budget" message: the current thinking level's budget is close to `max_tokens`, leaving no room to generate the answer. Raise `max_tokens`, or lower the thinking level with `/think`.

> The `[thinking]` section applies only to the **anthropic protocol** (`budget_tokens` is an Anthropic field). Under the openai and openai_responses protocols, StepFun always thinks and neither needs nor sends this field, so this section is ignored; the reasoning process is still rendered normally.

### `[subagent]`: sub-agent limits

| Field | Default | Range | Description |
|------|------|------|------|
| `max_per_session` | 10 | 1–50 | Cumulative spawn limit per session |
| `max_depth` | 1 | 1–3 | Maximum nesting depth |
| `max_steps` | 100 | 1–1000 | Maximum internal round trips inside a sub-agent |
| `max_concurrent` | 4 | 1–16 | Concurrency limit for parallel sub-agents |

#### `[subagent.retention]`: sub-agent session retention

| Field | Default | Description |
|------|------|------|
| `delete_with_parent` | true | Deleting a main session also deletes its sub-agent sessions (ones holding an active lock are skipped) |
| `max_sessions` | 0 | Cap on sub-agent sessions; the oldest are pruned first. 0 = unlimited |
| `ttl_days` | 0 | Expiry in days for sub-agent sessions. 0 = never expire |

Cleanup for `max_sessions` / `ttl_days` runs once at process startup, and every cleanup path skips sub-agent sessions that are currently running. See [Session management](./sessions.md#subagent-sessions) for viewing and managing sub-agent sessions.

### `[compaction]`: context compaction

| Field | Default | Range | Description |
|------|------|------|------|
| `trigger_ratio` | 0.85 | 0.5–0.99 | Compaction triggers once usage reaches the context limit times this value |
| `reserved_tokens` | 32000 | 0–500000 | Compaction triggers once the remaining window falls below this value |
| `model` | — | — | A dedicated model for compaction summaries; defaults to the main model |
| `user_message_max_tokens` | 20000 | 0–200000 | Verbatim budget for the user's own words: the total volume of original user messages preserved separately alongside the summary during compaction. 0 disables the verbatim block, returning to pure summary behavior |
| `user_message_head_tokens` | 2000 | 0–the previous field | The share of the verbatim budget allotted to the "earliest messages"; the remainder goes to the most recent ones |

Besides producing a handoff summary, compaction also preserves the original user messages that were compacted away, **verbatim** and as **separate messages** within the budget, placed before the summary.
This directly addresses the fact that a summary loses the original intent through paraphrase: a summary is the model's second-hand retelling, and once the wording drifts, later turns keep working from the wrong understanding.

Verbatim messages carry their own source marker in the storage layer (`user_verbatim`), so they **can survive multiple rounds of compaction**: each round they compete for the budget again,
and the older the original words, the more likely they are squeezed out when the budget is tight, so the decay is gradual rather than total by the second round. They do not count toward session turns and
are not retrieved by rollback editing as "the previous user input"; a compacted session does, however, derive its title from them (by then the earliest human input is no longer in the history).

Trade-offs when the budget is tight: the earliest messages keep the beginning (the task definition and global constraints usually live there) and the most recent messages keep the end (the current intent lives there).
A single over-budget message is truncated in the corresponding direction and annotated with "the first/second half of this message has been truncated"; the truncated prefix of the message at the boundary of the recent segment is recycled into the earliest segment
(so a single large paste keeps both its head and its tail and loses only the middle). When a middle message is dropped entirely, a system-reminder is inserted stating how many tokens were omitted and
that the content is covered by the summary, so the model does not conclude the user never said it; that notice is regenerated each round and does not accumulate.

Pure acknowledgements (messages whose entire content is acknowledgement, such as "继续", "好的", "ok", "收到") do not consume the verbatim budget: they carry zero information and,
beyond taking budget, dilute attention. Matching is whole-message equality only, with no length threshold, because a message like "use plan B" is equally short yet carries a decision and must be preserved.

When verbatim messages exceed 60% of the compacted segment, the pure summary form is restored automatically: that means the compacted segment itself is too small and the original words are nearly all of its content,
so moving them again is relocation rather than compaction. In real long sessions the compacted segment consists mostly of model output and tool results, so this guardrail does not fire.

#### Summary quality validation

A summary is not used just because it came back. After generation it must pass three checks, and failing any one of them counts as a failed summary for this round:

1. **Non-blank.**
2. **Minimum information floor**: the summary's token count must not fall below "2% of the compacted content", capped at 200 tokens. The floor rises with the volume compacted: the more you compact, the higher the information requirement on the summary, while a small compacted segment is barely constrained at all (a one-sentence summary is genuinely enough there). The floor is always held below the size of the original, so there is no deadlock where the summary is required to be longer than the source.
3. **No history render markers**: a summary containing markers such as `[调用工具 X]`, `[工具结果]`, `[image ...]`, `[audio ...]`, or `[video ...]` fails. Those markers only appear in the history fed to the summarization model, so writing them back into the summary means the model is copying the source instead of writing handoff notes.

On failure, the oldest message is dropped, the input is shrunk, and the summary is regenerated, for at most 3 attempts. If all three fail, **this compaction is abandoned and the history is preserved in full**: better not to compact than to replace an entire stretch of history with an invalid summary. An empty summary, or a network or API error on the summary request, follows the same "shrink the input and retry" path.

These three checks are built-in behavior today and are not configurable.

### `[background]`: background tasks

All four fields are optional and fall back to the defaults in the table below.

| Field | Type | Default | Description |
|------|------|------|------|
| `bash_auto_background_on_timeout` | bool | true | Move a foreground bash command to the background after it times out; `false` kills it on timeout |
| `bash_task_timeout_s` | int | 600 | Background task timeout in seconds, clamped to 0–86400; `0` means no limit |
| `notify_on_complete` | bool | true | Actively inject a completion notice when a background task reaches a terminal state; `false` returns to having the model query it through `task_list` |
| `notify_terminal` | bool | true | Emit a terminal bell and a desktop notification when a background task reaches a terminal state; `false` is silent |

The two layers behind `notify_terminal`: the BEL bell works in every terminal, while OSC 9 desktop notifications are only sent in terminals recognized as supporting them (iTerm2, WezTerm, Kitty, Ghostty, Windows Terminal, Warp), wrapped in DCS passthrough automatically inside tmux. Unsupported terminals only ring the bell, without an error.

A non-boolean value in a bool field, or a non-numeric value in `bash_task_timeout_s`, makes the field count as unset and fall back to its default.

### `[search]`: web search

Web search (`web_search` for content, `web_image_search` for images) is a StepFun-platform-specific capability, independent of which model or channel the main session uses. By default it reuses the main session channel's `base_url` + `api_key` — this works out of the box when the main session is on a StepFun channel, but once the main session switches to a non-StepFun channel (another vendor's model, a self-hosted gateway), search requests hit the wrong address and fail.

The `[search]` section decouples search configuration, with three layers: `[search]` is the shared fallback, `[search.web]` overrides content search, and `[search.image]` overrides image search. All fields are optional.

```toml
# Shared section: default url/key for both search tools
[search]
url = "https://api.stepfun.com/v1"
key = "sk-xxxxxxxx"

# Content-search-specific section (overrides the shared section)
[search.web]
url = "https://api.stepfun.com/v1"
key = "sk-xxxxxxxx"

# Image-search-specific section (image search is only offered on the Step Plan channel, so configure it explicitly)
[search.image]
url = "https://api.stepfun.com/step_plan/v1"
key = "sp-xxxxxxxx"
```

| Field | Description | Fallback |
|------|------|------|
| `[search].url` / `.key` | Default Base URL and key for both search tools | empty |
| `[search.web].url` / `.key` | Content-search-specific, overrides the shared section | falls back to `[search]` |
| `[search.image].url` / `.key` | Image-search-specific, overrides the shared section | falls back to `[search]` |

**Endpoint resolution priority**: specific section (`[search.web]`/`[search.image]`) → shared section (`[search]`) → main session channel. A `url` from an independent config is treated as the user's exact intent — the tool only appends `/search` or `/search-image` without stripping `/v1`; only when falling back to the main session channel does it apply the old normalization (strip `/v1`, then append `/step_plan/v1/...`). When an independent config supplies `url` but no `key`, the `key` falls back to the main session channel's `api_key`.

**api and plan channels**: StepFun's web content search works on both the standard API channel (`https://api.stepfun.com/v1/search`, pay-as-you-go) and the Step Plan channel (`https://api.stepfun.com/step_plan/v1/search`, consuming subscription Credit), with the same API key working on both; image search is only offered on the Step Plan channel (`.../step_plan/v1/search-image`). With a Step Plan subscription, prefer setting `[search].url` to the plan channel address across the board.

Once `[search]` is configured, changes take effect immediately (`/reload` hot-reloads it), and search availability no longer depends on the main session's model channel.

## `[[hooks]]`: lifecycle hooks

Run your shell commands at lifecycle event points, for observation or for blocking. Declared as a `[[hooks]]` array, with four fields per entry:

```toml
[[hooks]]
event = "PreToolUse"                        # event name
matcher = "^bash$"                           # optional regex, matched against the tool name / event identifier
command = "python ~/.step-code/hooks/guard.py"
timeout = 30                                 # seconds, optional, default 30, hard cap 600
```

| Field | Required | Description |
|------|------|------|
| `event` | Yes | Event name: `PreToolUse` / `PostToolUse` / `UserPromptSubmit` / `Stop` / `SessionStart`; an event name outside this set makes the entry invalid |
| `matcher` | No | A regex matched against the tool name or an event-related identifier; when omitted it matches everything. An invalid regex makes the entry invalid |
| `command` | Yes | The shell command to run |
| `timeout` | No | Timeout in seconds, default 30, clamped to 1–600 |

Validation is per entry: when one entry has an invalid `event`, a missing or empty `command`, or a `matcher` that fails to compile, only that entry is skipped and the remaining hooks load normally.

Only user-level global configuration is supported (`~/.step-code/config.toml`), with no project level, because the location of a config file is a trust boundary. For event semantics, blocking rules, and the stdin/exit conventions, see [How hooks work](./hooks.md).

## Environment variables

| Variable | Description |
|------|------|
| `STEP_CODE_API_KEY` | API key, highest priority |
| `STEPFUN_API_KEY` | The conventional key variable when the top-level provider is `stepfun`; for other protocols, see the conventional variable table in [the provider table](#the-providersid-provider-table) |
| `ANTHROPIC_API_KEY` | The conventional key variable when the provider or provider type is `anthropic` |
| `OPENAI_API_KEY` | The conventional key variable when the provider or provider type is `openai` / `openai_responses` |
| `STEP_CODE_PROVIDER` | Provider; higher priority than config.toml, lower than `--provider` |
| `STEP_CODE_BASE_URL` | API address; higher priority than config.toml |
| `STEP_CODE_MODEL` | Model name or a `[models]` alias; higher priority than config.toml, lower than `--model` |
| `STEP_CODE_DEBUG` | Set to `1` to relax the runtime log level from info to debug (logs are written to `~/.step-code/logs/step-code.log`; in non-interactive `-p` mode, debug logs also go to stderr) |
| `STEP_SHELL_PATH` | Windows only: the absolute path to the interpreter for the `bash` tool, for cases where Git Bash is installed in a non-standard location. Takes priority over auto-detection |
| `STEP_DEBUG_RENDER` | Set to `1` to enable dynamic frame render budget diagnostics: when a downgrade (`DEGRADED`) or a frame-height threshold hit (`DANGER`) occurs, an entry is appended to `%TEMP%/step-code-render-debug.log`, for debugging rendering and scrolling problems |

The variable name referenced by `api_key_env` is yours to choose and is not in this table. An empty string in the key variables above is equivalent to unset.

## Data directory

What lives under `~/.step-code/`:

| Path | Contents |
|------|------|
| `config.toml` | Main configuration |
| `mcp.json` | External MCP server declarations; see [Skills, plugins, and MCP](./skills-and-mcp.md) |
| `AGENTS.md` | User-level conventions; `AGENTS.override.md` in the same directory takes priority, see [How AGENTS.md works](./agents-md.md) |
| `skills/` | User-level skills |
| `agents/` | User-level custom sub-agents (`*.md`) |
| `plugins/` | Plugin directory; see [Skills, plugins, and MCP](./skills-and-mcp.md) |
| `plugins.json` | Plugin enable/disable state (records the disabled set) |
| `hooks/` | By convention, holds the scripts referenced by `[[hooks]]` (not enforced) |
| `logs/step-code.log` | Runtime log (the diagnostics channel); rotated to `.log.old` at startup once it exceeds 5MB; redacted before writing |
| `sessions/<working-directory key>/` | Session snapshots `<id>.json` and full history `<id>.full.jsonl`, bucketed by working directory |
| `sessions/<working-directory key>/subagents/` | Sub-agent session snapshots, full logs, and the runtime active lock (`.lock`), kept apart from the main session bucket; see [Session management](./sessions.md#subagent-sessions) |
| `sessions/<working-directory key>/attachments/` | Image attachments stored content-addressed (the filename is the sha256), with only a reference pointer left in the session |
| `sessions/cron/<working-directory key>/` | Cron task persistence, bucketed by working directory with one JSON per task; see [Sub-agents and automation](./agents.md) |
| `input-history/` | Input history, isolated per working directory |
| `debug-<session id>-<timestamp>.zip` | The debug bundle exported by `/export-debug-zip` (redacted session, configuration, logs, and environment metadata) |

## Validation: `step doctor config`

The diagnostic exit for a broken configuration. It runs headless, never enters the TUI, and changes no files:

```bash
step doctor config              # validate ~/.step-code/config.toml
step doctor config ./my.toml    # validate a given path
```

`path` defaults to `~/.step-code/config.toml`. It runs **before** `loadConfig`, so the validator itself still works when the configuration is broken badly enough to prevent the process from starting. There are only two exit codes: **0** means parsing and validation passed (warnings still exit 0), and **1** means failure.

Four failure classes (exit code 1, reported as `error:` with an immediate return):

| Failure | Description |
|------|------|
| File does not exist | Reports the absolute path it looked for |
| TOML syntax error | Includes the parser's raw error |
| Top level is not a TOML table | The root of the file is an array or a scalar |
| Semantic error | `thinking` (budget headroom, and whether `default_level` exists in the level table), an invalid `permission_mode` value, an invalid `proxy` form. These three share the throw path with `loadConfig` and relate to safety and correctness, so they are not downgraded to warnings |

Three warning classes (still exit code 0, listed one per line after the `ok:` line):

| Warning | Description |
|------|------|
| Unknown top-level key | `loadConfig` ignores it silently, so it is most likely a typo |
| A `[providers.<id>]` `type` is missing or invalid | That provider is ignored entirely |
| A `[[hooks]]` entry has a missing or invalid `event` | That hook is ignored |

**Only doctor can find a misspelled top-level key**: `loadConfig` silently ignores any top-level key it does not recognize, so typing `permission_mode` as `permision_mode` neither errors nor takes effect, and the configuration looks written yet does nothing. One run of `step doctor config` exposes this class of problem.

It is also the "independent validation before overwriting" step in the change protocol of the built-in `update-config` skill, and the post-write validation entry point for configuration-writing operations such as `/provider add` and provider deletion (a validation failure rolls the change back).
