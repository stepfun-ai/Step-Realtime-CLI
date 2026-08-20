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
# Environment variables (the implicit provider recognizes only STEP_CODE_API_KEY;
# the anthropic / openai protocols additionally recognize their conventional variables)
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
| `media_keep_recent` | int | How many recent images media degradation keeps, default 10; `0` = replace all with placeholders. On a 413/400 image-limit rejection, only the older images become placeholder text and the most recent N are kept before retrying, so the model is not left blind. Effective on all providers; per-alias override under `[models.*]`, see [Media degradation](#media-degradation) |

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

When a provider sets neither `api_key` nor `api_key_env`, it falls back to the conventional environment variable for its `type`. These protocols have their own widely used variable names, and reusing them lets an existing environment work with zero changes:

| Provider type | Conventional environment variable |
|-----------|--------------|
| `anthropic` | `ANTHROPIC_API_KEY` |
| `openai` / `openai_responses` | `OPENAI_API_KEY` |

The built-in presets `stepfun` and `anthropic` are only the carriers of the zero-config default policy: with no `[providers]` table at all, the top-level `provider` takes effect directly. The `provider` field in `[models]` may only point at a `[providers.<id>]` custom provider id or be omitted to inherit the top level; explicitly naming a built-in preset makes the alias invalid.

### Key resolution priority

When each model alias is expanded, the first available key is taken along the chain for its branch (`env(X)` means reading the environment variable named X; an empty string counts as unset):

- **Provider branch** (the alias `provider` points at a `[providers.<id>]` provider): provider `api_key` → env(provider `api_key_env`) → the conventional environment variable for the provider type → alias `api_key` → env(alias `api_key_env`) → the implicit provider key (`STEP_CODE_API_KEY` or the conventional environment variable for the top-level provider).
- **Inherited branch** (the alias `provider` is omitted): alias `api_key` → env(alias `api_key_env`) → the conventional environment variable for the top-level provider → `STEP_CODE_API_KEY`.

The implicit provider key itself comes from `STEP_CODE_API_KEY` (the anthropic / openai protocols additionally recognize their conventional environment variables). `api_key` is no longer supported at the top level of config.toml. When no key is found anywhere along the chain, startup no longer fails; instead the provider constructor throws a "missing API key" error with configuration guidance.

> **Warning about mixing vendors**: the implicit provider key is the last fallback for every provider, so when a provider has no key of its own, that key is sent to that provider's endpoint. When mixing several vendors, always give each provider its own `api_key` or `api_key_env` so a key is never sent to the wrong vendor.

### The `[models.<alias>]` alias table

An alias packages "provider + model id + context window + display information" into a single switchable unit. All fields are optional; omitted items inherit the top-level configuration when merged, and an omitted `model` equals the alias itself.

```toml
[models."step-3.7-flash"]
# provider = "<provider-id>"           # optional: references a [providers.<id>] custom provider; defaults to the top-level provider
model = "step-3.7-flash"
max_context_size = 262144
display_name = "Step 3.7 Flash"         # optional, used by the selector and the status bar
capabilities = ["thinking", "image_in"] # optional, see capabilities tags below
```

| Field | Description |
|------|------|
| `provider` | A `[providers.<id>]` custom provider id; defaults to the top-level provider. Explicitly naming a built-in preset (stepfun, anthropic, etc.) or pointing at an undeclared id makes the alias invalid (it has no effect when expanded and falls back to the top-level configuration) |
| `model` | The real model id; when omitted it equals the alias itself |
| `base_url` / `api_key` | Overrides the endpoint and credentials of the provider or the top level |
| `api_key_env` | Indirect reference: stores only the environment variable name, keeping the secret off disk. For its position in the fallback chain, see [Key resolution priority](#key-resolution-priority) |
| `max_context_size` | The context window for this model; when omitted it falls back to the top-level default |
| `max_tokens` | Maximum output tokens per response; when omitted it falls back to the top level |
| `display_name` | Display name in the selector and the status bar; defaults to the alias |
| `capabilities` | Array of capability tags (such as `thinking` or `image_in`); the single source of truth for tool gating and request shaping. Must be a non-empty array of plain strings with values from the allowed set, otherwise startup fails (see [capabilities tags](#capabilities-tags)) |
| `media_keep_recent` | Overrides how many recent images media degradation keeps, per alias; falls back to the top-level `media_keep_recent`. Image limits vary widely by provider (step-3.7 measured at 60 per request, Gemini at 10), so generous providers can keep more and stricter ones fewer; see [Media degradation](#media-degradation) |

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

`capabilities` is the capability declaration of an alias, and it is the **single source of truth** for model capabilities — both tool gating and request shaping read it.

| Value | Meaning | Effect |
|----|------|------|
| `image_in` | The model accepts image input | Mounts the `read_media` tool; image blocks in the request are not stripped |
| `thinking` | The model emits its reasoning process | Historical thinking blocks are sent back with the request instead of being stripped |
| `tool_use` | The model supports tool calling | The tool table is sent normally |
| `cache_control` | The model accepts prompt cache breakpoints | Allows injecting that field (measured as incompatible on the Step family, so it is not injected by default) |
| `video_in` | The model accepts video input | `read_media` can read videos (mp4/mov/webm, delivered inline as raw bytes, default budget 32 MB); video blocks in requests are not projected to placeholder text |
| `audio_in` | The model accepts audio input | Reserved |

**Defaults when undeclared**: `image_in` / `thinking` / `tool_use` are treated as **supported**, `video_in` is treated as **unsupported** (video blocks are large and endpoint support is narrow; undeclared models get video blocks projected to placeholder text before sending), and `cache_control` is not injected.

This bias is deliberate. Guess a capability too low and the client silently strips content you actually sent (images replaced by placeholder text, historical thinking deleted) with no error and nothing to see; guess too high and the server returns an explicit error, with automatic reprojection downgrade as a fallback. **Silently losing content is far harder to diagnose than an explicit error**, so the default is to let it through.

The semantics of `capabilities`: listing a value declares support, and dimensions you omit fall back to the defaults above — omitting one never costs you a capability. A `-` prefix **explicitly negates** (e.g. `capabilities = ["-image_in"]` declares the model does not accept images) for cases where you know the endpoint's behavior: once declared, submitting a message with images is blocked with a notice, and images in history are projected as placeholder text before sending (originals are kept; switching back to a vision-capable model restores them). A lone `-` is treated as an unknown value and fails at startup.

- The value domain is validated: an unknown capability name (for example `image_in` misspelled as `image-in`) fails at startup with the list of valid values, instead of silently doing nothing. A wrong field type (not a non-empty string array) also fails.
- Case and surrounding whitespace are normalized (`IMAGE_IN` equals `image_in`).
- After changing a declaration, `/reload` applies it immediately (no model switch or restart needed).
- The **display** of thinking does not look at `capabilities`: the `think:` segment in the status bar comes from the session-level `/think` level, and thinking blocks are rendered unconditionally. Whether reasoning-control fields are sent is decided by the `[thinking]` section.
- **Protocol limitation**: image passthrough for `read_media` is currently end-to-end only on `anthropic` protocol providers. On `openai` protocol providers, the tool result collapse keeps text only and images are dropped silently. An openai provider that declares `image_in` therefore still cannot actually read images; this protocol translation gap is logged as a pending fix.
- **Models and protocols are not freely interchangeable**: some models are only enabled on specific endpoints. Pointing one at the wrong provider surfaces a server-side 400 at request time, and the error message names the endpoint you should use instead.

#### Media degradation

When a request is rejected for exceeding an image limit (413 payload too large, or a 400 for too many/too-large images), step-code replaces the older images in history with placeholder text, keeps only the most recent N, and retries automatically. This prevents one oversized image from "poisoning" the whole session — where every subsequent message, even plain text, fails with the same error.

**Degradation levels** (retried along the chain, each level at most once per request):

| Level | Behavior |
|------|------|
| `media-degraded` | Keeps the most recent `media_keep_recent` images; older ones become placeholder text (the placeholder states the original image was removed for an API limit, so the model does not think it misremembered) |
| `media-stripped` | All media blocks removed |
| `strict` | Media removed plus thinking blocks and cache_control stripped (most conservative form) |

**Trigger detection**: a 413 always triggers (its meaning is unambiguous). A 400 triggers only when the error message matches a known media "dialect" — `Input images too many` (stepfun, measured), `image exceeds 5 MB maximum` / `image dimensions exceed max allowed size` (Anthropic), `You can only include N image links` (Gemini/Vertex), `At most N image(s)` (vLLM serving), and similar. A bare 400 for an invalid parameter (such as a bad `max_tokens`) does **not** trigger, so real calling bugs are not masked by degradation.

**Configuration**:

- The top-level `media_keep_recent` (default 10) sets the global keep count; `0` = replace all (legacy behavior).
- `media_keep_recent` under `[models.*]` overrides it per alias. Image limits vary widely by provider (step-3.7 measured at 60 per request, Gemini at 10, GLM at 5), so generous providers can keep more and stricter ones fewer.

**Why the default is 10**: step-3.7-flash was measured at 60 images per request (direct API probe, 2026-08-06; 61 images returns `max: 60`), and 10 is a safe one-sixth of that — degradation rarely triggers in everyday use, yet keeps enough context when it does. Reading a long screenshot in segments commonly accumulates 10+ images in one conversation; the old default of 3 would make the main agent forget every image except the most recent three.

**Effective on all providers**: the stepfun provider degrades inside its adapter's send path, while the other protocol providers (anthropic / openai / openai_responses) share a single media-degradation wrapper, so behavior is consistent.

**Known boundary**: modifying historical images invalidates the prompt-cache prefix, so the one or two requests after a degradation may cost more. This is API-side behavior and cannot be avoided.

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

The Step 3.x family always thinks: whether or not reasoning-control fields are sent, the response may include thinking blocks, and the TUI renders them unconditionally (see [Interactive use](./interactive.md)). This section controls **whether the request side actively declares a reasoning depth, and which level it uses**.

```toml
[thinking]
enabled = true            # default false: does not declare a reasoning depth, leaving it to the server
default_level = "medium"  # reasoning level; only low / medium / high are accepted, defaults to medium

[thinking.levels]         # advanced; rarely needed. Only affects the native Anthropic provider
low = 1024
medium = 4096
high = 32000
```

| Field | Default | Description |
|------|------|------|
| `enabled` | false | Whether to actively declare a reasoning depth. Off by default, in which case the server's default depth applies |
| `default_level` | `"medium"` | Reasoning level; only `low` / `medium` / `high` are accepted, anything else makes loading report a configuration error |
| `levels` | low/medium/high = 1024/4096/32000 | **Advanced**: level → budget token count. Only effective on the native Anthropic provider, see below |

At runtime, `/think` switches the level for the session (selector / direct / off); see [Interactive use](./interactive.md).

The level name is sent as the reasoning-strength value directly. The three protocols use different parameter names and nesting (`output_config.effort` / top-level `reasoning_effort` / nested `reasoning.effort`); Step Code translates for each, so you do not need to care which provider you are on.

**There is no `budget_tokens` key.** There used to be one, and it was removed: all three upstream endpoints accept only a level string, never a token count, so that number was never actually sent — it was only used to derive a level. Because the derivation thresholds were fixed, editing `[thinking.levels]` could make the level you picked differ from the level actually sent. A field that has no effect and can silently pick the wrong level should not be exposed. Setting this key now fails fast and points you at `default_level`.

**The numbers under `[thinking.levels]` only take effect on the native Anthropic provider (`api.anthropic.com`)**, where they are sent as `thinking.budget_tokens`. On upstream Step providers, editing them changes nothing; you normally do not need this section at all.

**Leaving `default_level` unset means `medium`, not "declare no level".** This is not mere caution: measurements show that declaring no level is not neutral — on all three channels the reasoning volume then lands near the highest level, which on hard tasks fills the output budget and yields an empty answer. In other words, "not choosing for the user" effectively means "quietly picking the highest level", so the fallback has to name the middle level explicitly.

#### When thinking eats the whole output budget

Thinking and the answer share a single output budget (`max_tokens`), and thinking comes first. When the budget is too small, thinking uses it all up and the answer cannot emit a single character — you see an empty answer whose stop reason is "reached the output limit".

Two fixes, both effective:

1. **Lower the thinking level.** Measured against not declaring a level at all, the low level cuts reasoning by roughly 85% (on the same hard problem, from ~12000 tokens down to ~1900). Use `/think low` at runtime, or set a lower `default_level` in the config.
2. **Raise `max_tokens`.** The default (65536) is enough for the vast majority of coding tasks; if you have manually lowered it, raise it back first when you hit empty answers.

Note what a level actually controls: it nudges *how deeply the model tends to think* — a trained behavioural tendency, not a hard cap. That is why levels make almost no visible difference on **simple** tasks (the model only spends a few hundred tokens thinking anyway, so every level is sufficient); the difference only shows up on tasks that require long reasoning.

Complex tasks (long-document analysis, strict JSON structured output, multimodal input) need more thinking, so leave a correspondingly larger budget.

> **A historical correction**: this section previously stated that lowering the thinking level does not help, citing measurements that showed near-identical thinking length across levels. That conclusion came from a bug on our side — the level parameter was being sent in the wrong field, the server silently ignored it, and every level therefore ran at the server's default depth. Once the field was corrected, levels take real effect.

### `[continuation]`: auto-continue on output truncation

```toml
[continuation]
max_auto_continues = 3  # default 3; set to 0 to disable auto-continue
```

| Field | Default | Range | Description |
|------|------|------|------|
| `max_auto_continues` | `3` | 0–100 | Number of automatic continuation turns after the output is truncated by `max_tokens`; `0` disables auto-continue and falls back to manual 「continue」 |

Auto-continue only applies when the response body is cut off mid-output. It does not fire when thinking exhausts the budget with zero answer tokens (that is a budget-configuration problem, not something continuation can fix). Each continuation turn passes through the same loop guard that halts on zero progress, full repetition, full rewrites, periodic regurgitation, or tortoise-speed cycles.

### `[subagent]`: sub-agent limits

| Field | Default | Range | Description |
|------|------|------|------|
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
| `model` | — | — | A dedicated model for compaction summaries; defaults to the main model. Accepts either a model id or an alias from `[models.<alias>]` — with an alias, summaries go through that alias's **channel** (endpoint / key / protocol), so the main conversation and compaction can live on different channels |
| `user_message_max_tokens` | 20000 | 0–200000 | Verbatim budget for the user's own words: the total volume of original user messages preserved separately alongside the summary during compaction. 0 disables the verbatim block, returning to pure summary behavior |
| `user_message_head_tokens` | 2000 | 0–the previous field | The share of the verbatim budget allotted to the "earliest messages"; the remainder goes to the most recent ones |

At runtime, `/compact-model` switches the compaction model at session scope (overrides the `model` setting, not persisted; `/new` and restarts return to the config):
`/compact-model <alias|model-id>` switches, `/compact-model reset` clears the override, and no arguments show the current binding source and resolution.

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

#### When compaction is evaluated

Compaction is evaluated **before every request sent to the model**, regardless of how the previous turn ended — whether the model called tools, answered directly, you pressed Esc to interrupt, or you started a new turn with a new prompt.

This matters for two reasons:

- When you **send a new prompt**, if usage was already over the line when the previous turn ended, compaction completes before the first request goes out, rather than waiting for some later tool-calling turn.
- Long conversations that rarely call tools are covered too.

There is also a fallback: if a request has already gone out and the endpoint reports a context overflow, a more aggressive rescue compaction runs and the turn is retried. Both paths refresh the status bar usage figure immediately after compacting.

#### When it cannot compact further

When the recent messages that must be kept already exceed the budget, compaction "runs but does not get below the threshold". In that case it does **not** retry summarization every turn (that would keep costing money with no effect). Instead it stops automatic compaction for the current run and prompts you to use `/compact` or `/new`.

One case does not count as "cannot compact further": when history is still short and there is nothing outside the keep window to summarize, compaction has nothing to work with — this does not trigger the stop above, and normal compaction resumes as the conversation grows.

### `[memory]`: the memory observation pool

A long-term observation store maintained by the agent itself: when the user explicitly asks to remember something, corrects the agent, or a stable project convention shows up, the agent writes an observation into two markdown directory layers (global `~/.step-code/memory/` and project `.step-code/memory/`), and the system prompt carries a directory note plus an observation index at its tail. Observations **do not take effect directly** (marked as unconfirmed; confirmed rules like AGENTS.md win on conflict) — they are promoted into your rules only after your periodic review.

```toml
[memory]
enabled = true   # default false: no memory section, no directories created; existing files are kept
```

| Field | Default | Notes |
|------|------|------|
| `enabled` | false | Observation pool toggle. Enabling mid-session via `/memory on` injects a review prompt so the agent backfills observations from the current session |

Notes:

- Storage is markdown body + a `<!-- MEMORY_FIELDS {...} -->` comment block (version / occurrences / updated_at); files are human-editable.
- No embeddings, no background extraction pipeline; updates happen only inside conversation turns (the agent writes with file tools), and the index is re-scanned every turn.
- Sub-agents are read-only: they see the index but cannot write (avoids parallel-write conflicts and noise from ephemeral contexts).
- `/memory` with no argument lists all observations, index character usage, and files that failed to parse.

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

### `[tools.web]`: web result cache

`web_search` (content search) and `web_fetch` (full-text extraction) share a process-level cache to avoid fetching the same URL repeatedly.
`[tools.web]` controls cache capacity with three dimensions; setting any of them to `0` removes that limit.

```toml
[tools.web]
max_size = 100            # entry count limit, default 100
max_bytes = 33_554_432    # total byte limit (estimated), default 32MB (32 * 1024 * 1024)
max_entry_bytes = 2_097_152  # per-entry byte limit (estimated), default 2MB; oversized entries are dropped entirely
```

| Field | Default | Description |
|-------|---------|-------------|
| `max_size` | `100` | Maximum number of cached entries. `0` = unlimited entries |
| `max_bytes` | `33554432` (32MB) | Total cache byte limit (V8 heap estimate, not UTF-8 bytes). `0` = unlimited total bytes |
| `max_entry_bytes` | `2097152` (2MB) | Per-entry byte limit; entries exceeding this are not cached at all (large pages have low cache benefit and high memory cost). `0` = unlimited per-entry |

Bytes are estimated as `string length × 2` (V8 uses 2 bytes/character for strings containing non-Latin1 characters).
When `[tools.web]` is not configured, built-in defaults are used; no manual changes required.

For long sessions or when many sub-agents fetch pages in parallel, reduce `max_bytes` to fit your memory budget; if you mostly fetch large pages, increase `max_entry_bytes`.

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
| `STEP_CODE_API_KEY` | API key; the only variable the implicit provider recognizes |
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

## Startup self-check

`step` automatically validates `~/.step-code/config.toml` on startup — **you do not need to run `step doctor config` yourself**. A clean configuration produces zero output; problems are split by severity:

| Level | Covers | Behavior |
|------|------|------|
| **Fatal** | TOML syntax error, top level is not a table | Reports the error and exits with code 1, with a repair hint (`step doctor config` to validate, or `STEP_CODE_IGNORE_BAD_CONFIG=1` to ignore the bad file and start with defaults) |
| **Warning** | Unknown top-level key, invalid `[providers.<id>]` `type`, alias referencing an unavailable channel, invalid `[[hooks]]` entry | Warns without blocking startup |

**Why the escape hatch is mandatory**: the configuration file lives in the home directory, and users routinely use step-code itself to modify it (the built-in `update-config` skill does exactly that). If a syntax error always caused an exit, you would deadlock: cannot start → cannot use step-code to fix step-code's configuration. With `STEP_CODE_IGNORE_BAD_CONFIG=1` the entire file is ignored, but the interface keeps telling you so (silently running on defaults is exactly what this feature eliminates).

**Alias reference checks** cover three failure modes (shared by `step doctor config` and the startup self-check):

| Mode | Example | Consequence |
|------|------|------|
| Referencing an undeclared channel id | `[models.k3] provider = "ch-typo"` (no `ch-typo` under `[providers]`) | The alias is deactivated; the bare model name goes to the top-level channel |
| Referencing a protocol preset name | `[models.k3] provider = "anthropic"` (without declaring `[providers.anthropic]`) | The alias is deactivated; declare `[providers.anthropic]` first |
| Referencing an ignored channel | `[models.k3] provider = "ch1"` (`[providers.ch1]` has an invalid `type`) | The alias is deactivated as a result; fix the channel, not the alias |

**Warning presentation channels** split by run mode: interactive TUI shows a note in the transcript area (the TUI owns the terminal, nothing goes to stderr/stdout); non-interactive (`-p` / `--output-format stream-json`) writes to stderr (stdout is the protocol channel and stays clean).

It is also the "independent validation before overwriting" step in the change protocol of the built-in `update-config` skill, and the post-write validation entry point for configuration-writing operations such as `/provider add` and provider deletion (a validation failure rolls the change back).
