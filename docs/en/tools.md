<p align="center">
  <a href="./README.md">English</a> |
  <a href="../zh/tools.md">简体中文</a>
</p>

# Tools

This page is the reference manual for Step Code's built-in tools: the full list of 29 tools, the parameters and behavioral limits of the file, multimodal, command, network, interaction, and orchestration tools, and the general mechanisms that run through all of them (validation, result feedback, parallel scheduling, permission gating).

Tools are invoked by the model itself; you never write call syntax by hand. The point of this document is to let you know what the model has at its disposal, where each tool's limits are, and which layer to suspect when something goes wrong.

## All tools

Listed in registration order. The "See" column points to the page with the full description of that tool; tools covered here are marked "This page".

| Tool | Responsibility | See |
|------|------|------|
| `read_file` | Read a text file, with line-based paging | This page |
| `read_media` | Read a local image and pass its content back to the model | This page |
| `write_file` | Create a new file or overwrite one entirely | This page |
| `edit_file` | Exact string replacement, returns a line-level diff | This page |
| `list_dir` | List directory contents, marking files and directories | This page |
| `glob` | Find file paths by glob pattern | This page |
| `grep` | Search file contents by regular expression | This page |
| `bash` | Run a shell command, optionally moved to the background | This page |
| `web_search` | Search the web (StepFun's official search) | This page |
| `web_fetch` | Fetch a URL and extract its main content | This page |
| `web_image_search` | Search for images by text description (StepFun's official text-to-image search) | This page |
| `spawn_agent` | Spawn a sub-agent to handle a subtask | [Sub-agents and automation](./agents.md) |
| `exit_plan_mode` | Submit an execution plan and request to exit plan mode | This page |
| `ask_user` | Ask the user a question and let them choose | This page |
| `todo_list` | Maintain the current task list | This page |
| `task_list` | List background tasks and their status | [Sub-agents and automation](./agents.md) |
| `task_output` | View the output of a background task | [Sub-agents and automation](./agents.md) |
| `task_stop` | Terminate a running background task | [Sub-agents and automation](./agents.md) |
| `skill` | Activate a skill and load its full instructions | [Skills, plugins, and MCP](./skills-and-mcp.md) |
| `create_goal` | Set an autonomous goal | [Sub-agents and automation](./agents.md) |
| `update_goal` | Update goal state | [Sub-agents and automation](./agents.md) |
| `set_goal_budget` | Set a turn/token budget for a goal | [Sub-agents and automation](./agents.md) |
| `get_goal` | View the current goal and its usage | [Sub-agents and automation](./agents.md) |
| `cron_create` | Create a scheduled task | [Sub-agents and automation](./agents.md) |
| `cron_list` | List scheduled tasks | [Sub-agents and automation](./agents.md) |
| `cron_delete` | Delete a scheduled task | [Sub-agents and automation](./agents.md) |
| `tool_search` | Search for and lazily load external tools (such as MCP tools) | [Skills, plugins, and MCP](./skills-and-mcp.md) |
| `dynamic_workflow` | Orchestrate sub-agents dynamically with a JS script written on the spot | [Sub-agents and automation](./agents.md) |

Tools provided by MCP servers are registered dynamically once `tool_search` finds them, so they are not in this table; on a name collision the built-in tool wins.

`read_media` is subject to **capability gating**: when the current model does not declare the `image_in` capability, it is unloaded from the tool table entirely, so the model cannot see it and therefore will not call it (see [Configuration](./configuration.md#capabilities-tags)). On a model without image support, the tools actually visible number 28.

## File tools

The first six file tools (`read_file`, `write_file`, `edit_file`, `list_dir`, `glob`, `grep`) depend on no external commands and use native Node APIs, so they behave identically on all three platforms. `read_media`, also a file-reading tool, is the exception: it has to decode images, and lazily loads the third-party library jimp when cropping or downsampling, so it is covered separately under [Multimodal tools](#multimodal-tools). Path parameters are handled uniformly: absolute paths are used as-is, relative paths resolve against the current working directory.

### `read_file`

| Parameter | Type | Description |
|------|------|------|
| `path` | string, required | File path |
| `offset` | positive integer, optional | Starting line number (1-based). Omit to read from the beginning |
| `limit` | positive integer, optional | Number of lines to read. Omit to read to the end, subject to the internal cap |

Each line is returned as "line number + TAB + content", followed by a `<system>` status block stating the line range read, the total line count, and whether the output was truncated.

Behavioral limits:

- At most **2000 lines** per call. A `limit` larger than that is capped at 2000.
- When reading a whole file without `offset` / `limit`, a file larger than **256 KB** errors out and asks you to switch to paged reads. Passing either paging parameter lifts this restriction.
- Passing a directory errors out and suggests `list_dir` instead.
- **Images are blocked and redirected to `read_media`**: detection is by extension (`.png`/`.jpg`/`.jpeg`/`.gif`/`.webp`/`.bmp`/`.ico`) or by file header magic number, and a match errors out asking you to use `read_media`, rather than letting an image fall through to a misleading "file too large, please page" message.
- Other files containing NUL bytes are rejected as binary.
- An empty file returns `<system>文件为空（0 字节）。</system>`.

A common pitfall: "truncated" in the status block covers both not reaching the end of the file and the case where `offset > 1`, so starting from the middle is always flagged as truncated.

### `write_file`

| Parameter | Type | Description |
|------|------|------|
| `path` | string, required | File path |
| `content` | string, required | Complete file content (whole-file overwrite) |

Missing parent directories are created recursively. On success it returns the number of bytes written.

A common pitfall: this is a **whole-file overwrite**, not an append, and it has no "change only part of it" semantics. To modify part of an existing file, use `edit_file`; overwriting with `write_file` means the model has to rewrite the entire text, and long files easily lose content.

### `edit_file`

| Parameter | Type | Description |
|------|------|------|
| `path` | string, required | File path |
| `old_string` | string, required | The original text to be replaced, matched character by character |
| `new_string` | string, required | The replacement content |
| `replace_all` | boolean, optional | Whether to replace all matches, defaults to `false` |

Behavioral limits:

- By default a **unique match** is required. If there are multiple matches and `replace_all` is not set, it errors out and reports the actual number of occurrences.
- If `old_string` and `new_string` are identical, it errors out (no edit needed).
- If `old_string` is not found, it errors out and suggests running `read_file` first to confirm the original text.
- If the file does not exist or cannot be read, it errors out; it will not create the file for you.

**Line-ending tolerance**: the `old_string` the model generates usually uses LF, while Windows files often use CRLF, so character-by-character matching fails on `\r`. The strategy has three steps: first match exactly as given; on failure, normalize the file, `old_string`, and `new_string` all to LF and match again; when writing back, if the original file contained CRLF, restore CRLF throughout, so a CRLF file is never contaminated into LF.

#### The line-level diff in the result

After a successful edit, besides the summary line `已编辑 <path>（替换 N 处）。`, a line-level diff is attached (implemented in `src/tui/diffView.ts`). It computes differences line by line using LCS, then presents them clustered as "changes plus a little context":

- The first line is the summary `+N -M path` (the added/removed counts appear only when non-zero).
- Each cluster of changes keeps **3 lines** of context before and after; two changes less than 6 lines apart are merged into one cluster.
- Clusters are separated by `… N unchanged lines …`.
- The diff body is capped at **40 lines**; beyond that it is truncated with `… N more changes hidden (Ctrl+O to expand)` appended, and in the TUI you press Ctrl+O to expand the full output.

The diff text is plain text with no ANSI; coloring is applied by the render layer based on the leading marker of each line, so the same text can go into the TUI and be fed back to the model verbatim, letting the model confirm it changed the right place.

### `list_dir`

| Parameter | Type | Description |
|------|------|------|
| `path` | string, optional | Directory path, defaults to the current working directory |

Entries are returned sorted by name, with directories carrying a trailing `/`. At most **500 entries** are listed; beyond that `[共 N 项，仅显示前 500 项]` is appended. An empty directory returns `[空目录]`.

It does **not** recurse, and it filters nothing: `node_modules` and `.git` are listed as usual. To find files across directory levels, use `glob`.

### `glob`

| Parameter | Type | Description |
|------|------|------|
| `pattern` | string, required | Glob pattern, such as `src/**/*.ts` or `*.md` |
| `path` | string, optional | Search root, defaults to the current working directory |

`**/node_modules/**`, `**/.git/**`, and `**/dist/**` are always ignored. Results are converted to forward-slash paths relative to the current working directory, sorted, and returned, capped at **200 entries**, with a count notice appended when exceeded. No matches returns `[无匹配文件]`.

A common pitfall: the ignore list is hardcoded to those three patterns, and `.next`, `build`, and `.cache` are not among them, so in a repository with many such directories the results can be crowded out by build artifacts up to the 200-entry cap.

### `grep`

| Parameter | Type | Description |
|------|------|------|
| `pattern` | string, required | Regular expression (JavaScript syntax) |
| `path` | string, optional | Search root, defaults to the current working directory |
| `ignore_case` | boolean, optional | Ignore case, defaults to `false` |

Matching lines are returned in `path:line:content` format, with paths relative to the current working directory.

Behavioral limits:

- Ignored directories: `node_modules`, `.git`, `dist`, `.next`, `build`, `.cache`.
- Directory recursion depth is capped at **20** levels; the number of files scanned is capped at **3000**.
- Single files larger than **512 KB** switch to streaming line-by-line scan; individual line content is truncated to **1 MB**, and the truncation amount is reported truthfully.
- Matches are capped at **200**; on reaching the cap, scanning stops and `[结果已达上限 200 条，可能还有更多匹配]` is appended.
- Files containing NUL bytes are treated as binary and skipped.

A common pitfall: the regular expressions use JavaScript syntax, not grep's POSIX syntax, so escaping rules such as `\{` differ from the command-line `grep`. An invalid regular expression returns an error rather than empty results. Also, each line reports at most one match, so multiple hits on a single line are not listed separately.

## Multimodal tools

### `read_media`

Reads a local image file and passes its content back to the model as an inline image block. It is the only tool that lets the model actually see pixels; when `read_file` encounters an image it just redirects you here.

| Parameter | Type | Description |
|------|------|------|
| `path` | string, required | Image file path |
| `region` | object, optional | View only a rectangle of the original image: `{x, y, width, height}`, in original-image pixel coordinates. Cropped first, then delivered within the budget |
| `full_resolution` | boolean, optional | `true` = skip downsampling and deliver the original image; if the raw bytes exceed 4MB it errors out explicitly and suggests using `region` to read in chunks |
| `probe` | boolean, optional | `true` = return metadata only (format / dimensions / byte size / suggested chunks), without delivering the image. Probe a large or long image first to get its exact dimensions and a ready-made chunking plan, instead of guessing `region` values and hitting errors |

**Capability gating**: when the model's `capabilities` does not declare `image_in`, this tool is unloaded from the tool table entirely, so the model cannot see it and will not try to call it, saving a round trip that was bound to fail. A runtime capability check remains as a fallback.

Behavioral limits:

- **Hard read limit of 100 MB**: anything larger is rejected outright and never read into memory.
- **Delivery budget of 4 MB**: beyond that the image is downsampled proportionally before delivery.
- **Long-edge cap of 1568 px**: beyond that the image is scaled down proportionally (matching the recommended input size of mainstream vision models).
- When there is no cropping and the budget is not exceeded, it takes the **passthrough** path: the raw bytes are delivered directly, with no re-encoding.
- **webp errors out when cropping or downsampling is needed**: jimp cannot re-encode webp, so in that case you are told to convert to png first and read again. A webp within the budget takes the passthrough path and is unaffected.
- If `region` falls outside the original image, it errors out and reports both the original dimensions and the region you gave — and also **suggests a clamped region you can retry with immediately** (the origin pulled inside the image, the span narrowed to what remains). Alternatively, use `probe:true` first for a full chunking plan.
- **Probe a large or long image first**: `probe:true` returns metadata only, with a ready-made list of regions cut to the delivery cap (the last chunk is narrowed to the remaining edge, so copying the list verbatim never goes out of bounds). A 30000-pixel-long screenshot yields about 20 directly usable regions from a single probe call, replacing the "guess a region → out-of-range error → guess again" loop.
- Video and audio are **not supported in v1**: they are identified by magic-number sniffing (MP4/MOV/WebM/MKV/WAV and so on), and on a match it says plainly that reading video/audio is not supported yet, rather than reporting a vague "not an image".
- Image decoding failures (a corrupt file or an unsupported format) are returned as error results.

jimp is loaded lazily when cropping or downsampling, so you only pay that loading cost when decoding is genuinely needed, and the passthrough path never touches it. This is also why it does not fall under the generalization that "all file tools use native Node APIs".

There is one further **protocol limitation**: passing images back is currently end-to-end effective only on `anthropic` protocol providers; on `openai` protocol providers the tool-result folding keeps text only and images are silently dropped (see [Configuration](./configuration.md#capabilities-tags)).

`read_media` has no local side effects and is classified as read-only, so it is allowed straight through under every permission tier. Plan mode no longer blocks it either — reading a UI screenshot while planning is a typical use. See [Permission gating](#permission-gating) below for the decision details.

## `bash`

Runs a single shell command and returns the merged stdout + stderr.

| Parameter | Type | Description |
|------|------|------|
| `command` | string, required | The command to run |
| `timeout` | positive integer, optional | Foreground timeout in seconds, defaults to **60**, capped at **300** (anything larger counts as 300) |
| `run_in_background` | boolean, optional | `true` runs it in the background and returns a task_id immediately |

Output and exit codes:

- Output is capped at **30000 characters**; beyond that the head is kept and `[输出已截断，共 N 字符]` is appended. The internal collection cap during execution is 10 MB.
- A non-zero exit code is returned as an error result, with `[退出码：N]` appended at the end of the body.
- Exit code 0 with no output returns `[命令执行完毕，无输出]`.
- When you press Esc to interrupt, the process is killed and an interruption error is returned.

**A foreground timeout is not a failure**: by default the process is not killed on timeout; instead it is adopted into the background task manager, the background timeout is re-armed, the tool returns normally with an explanatory message (including the output collected so far) plus a task_id, and the task keeps running. If you turn off `[background].bash_auto_background_on_timeout`, or the context does not support background tasks, it reverts to the old behavior: a timeout kills the process and reports an error.

Viewing and terminating background tasks is done with `task_list` / `task_output` / `task_stop`; see [Sub-agents and automation](./agents.md).

### Cross-platform shell probing

Windows has no POSIX shell out of the box, so the `bash` tool probes for an interpreter in a fixed order (implemented in `src/tools/shellResolve.ts`):

1. The environment variable `STEP_SHELL_PATH` (an explicit absolute path to the bash executable, highest priority)
2. `bash` on PATH (excluding `System32\bash.exe`, the WSL launcher)
3. A co-installed Git Bash inferred from the location of `git.exe` and from `git --exec-path`
4. `InstallPath` under the Windows registry key `SOFTWARE\GitForWindows`
5. A fixed list of candidate paths (`C:\Program Files\Git\bin\bash.exe` and others, including per-user installations under `LOCALAPPDATA`)
6. WSL (considered available only when `wsl.exe` exists and `wsl --list --quiet` lists a real distribution)
7. busybox-w32
8. PowerShell (`pwsh` preferred, falling back to `powershell`)

A hit in the first five steps means a POSIX shell of the Git Bash family. When all eight steps come up empty it **errors out directly**, pointing you to install Git for Windows or set `STEP_SHELL_PATH`, and it does **not fall back to `cmd.exe`**: `cmd` does not understand Unix syntax, so falling back to it would be "runs but gets everything wrong", which is harder to diagnose than an explicit error.

On POSIX platforms none of this probing happens; `$SHELL` is used directly, defaulting to `/bin/bash`.

Depending on which interpreter is actually in effect, the command is preprocessed:

| Interpreter | Command preprocessing | Working directory |
|--------|------------|----------|
| Git Bash / MSYS bash | `>NUL` rewritten to `> /dev/null` | Native Windows paths are passed as-is (converting to `/c/` actually causes errors) |
| WSL | Same as above, plus a `cd '/mnt/<drive letter>/...'` prefix on the command | A native Windows path is passed to spawn; the working directory inside bash is switched by the prefixed `cd` |
| busybox | `>NUL` rewritten to `> /dev/null` | Native paths |
| PowerShell | Passed through unchanged | Native paths |

The `>NUL` rewrite covers bare `NUL`, the device name `NUL:`, and the quoted `"NUL"`, without touching ordinary words like `NULL` or `nullable`.

Probe results are cached in-process, so once a real shell is found it is probed only once. The exception is "nothing found at all": that result is only throttled for 30 seconds rather than cached long-term, so installing Git Bash partway through a long-running session takes effect automatically, with no restart needed.

The interpreter in effect also determines the syntax hints in the system prompt, so when falling back to PowerShell the model is told to use cmdlet syntax instead of continuing to write `ls` or `2>/dev/null`.

## Network tools

### `web_search`

Connects to StepFun's official web search endpoint, billed per the StepFun platform (pay-as-you-go on the api channel / Credit on the plan channel).

> **Endpoint resolution (important)**: the search request's url and key resolve by the priority "`[search.web]` → `[search]` → main session channel":
>
> - **With `[search]` configured**: search uses the independently configured url + key, completely independent of the main session's model channel. This is the recommended setup; see [Configuration](./configuration.md#search-web-search).
> - **Without `[search]` (default)**: falls back to the main session channel's `base_url` + `api_key`. In that case the main session must be on a StepFun channel — switching to a non-StepFun channel (another vendor's model, a self-hosted gateway) fails with 404.
> - **A sub-agent's search follows the main session's search configuration**, not the sub-agent's own `model` alias. As long as the main session's search works, a sub-agent bound to another channel's model still searches normally.
>
> Content search supports both StepFun channels — api (`/v1/search`) and plan (`/step_plan/v1/search`) — while image search is plan-only. See Configuration for details.

| Parameter | Type | Description |
|------|------|------|
| `query` | string, required | Search keywords |
| `n` | integer 1–20, optional | Number of results, defaults to 10 |
| `category` | enum, optional | `programming` / `research` / `gov` / `business`; omit to search the whole web |

Returns the index, title, URL, and snippet of each result (snippets truncated to 500 characters). It errors out when no API key is configured, with a hint that an independent search url and key can be set in the `[search]` section.

If the results returned by the endpoint carry full page content, that content is written into the in-process cache for `web_fetch` to reuse, and `[Cached N URLs with full content for web_fetch]` is noted at the end of the result.

HTTP errors are routed by status code, where **451 means a content moderation block** (the search terms or returned content did not pass review), unrelated to the key or your quota; 401/403 point at a key problem, 429 points at rate limiting or Step Plan quota; for 404 or connection failures, first check whether the search endpoint is configured correctly (see the resolution note above).

### `web_image_search`

Connects to StepFun's official text-to-image search endpoint (`POST <base>/step_plan/v1/search-image`), likewise over the Step Plan channel and consuming Credit.

| Parameter | Type | Description |
|------|------|------|
| `query` | string, required | Image description, Chinese recommended, English also supported |
| `topk` | integer 1–20, optional | Maximum number of images, defaults to 5 |

Returns each image's description (usable directly as alt text), original image URL, dimensions, and source page. When the search terms trigger content moderation, it reports the moderation block explicitly and suggests adjusting the description.

It does not participate in the page-content cache; the cache serves only `web_search` and `web_fetch`.

### `web_fetch`

Fetches the main content of a given URL.

| Parameter | Type | Description |
|------|------|------|
| `url` | string (must be a valid URL), required | The page address to fetch |

The processing order is **cache first, network second**. A cache hit is returned directly with no request sent; on a miss it fetches locally and writes the result back to the cache on success. The beginning of the returned text states where the content came from: the search cache, page extraction, or raw passthrough.

Content processing takes one of two paths:

- **Text responses are passed through as-is**: `text/*` (except `text/html`) plus `application/*` text types such as JSON, JavaScript, XML, RSS/Atom, and shell scripts are returned as the raw response body, never entering the HTML parser.
- **HTML goes through content extraction**: Readability is tried first, and when a title is found the output starts with `# title`. If Readability fails or extracts nothing, it falls back to the text of `<article>` → `<main>` → `<body>`. When neither path yields meaningful content it errors out, noting that the page may require JavaScript to render.

**SSRF protection**:

- Only `http` / `https` are allowed; other schemes are rejected outright.
- Private address ranges are rejected: `0.0.0.0/8`, `10/8`, `100.64/10`, `127/8`, `169.254/16`, `172.16/12`, `192.168/16`, plus the IPv6 `::`, `::1`, `fc00::/7`, and `fe80::/10`.
- `localhost` and `*.localhost` are rejected.
- Domain names are resolved via DNS first and **every** returned address is validated one by one; if any falls in a private range the request is rejected, preventing a domain from resolving into the internal network.
- Validated addresses are pinned for the actual connection, avoiding resolution drift between validation and connection.
- Redirects are **handled manually, hop by hop**, with a full security check redone at every hop, capped at **10 hops**.
- The response body is capped at **10 MB**, predicted from `Content-Length` first and rechecked against the actual byte count after reading.
- HTTP statuses ≥ 400 are returned as errors.

### The shared cache

`web_search` and `web_fetch` share one in-process cache (implemented in `src/tools/webCache.ts`):

- **TTL of 30 minutes**, with expiry checked on read and expired entries deleted immediately.
- **Capacity of 100 entries**, evicting the oldest entry in insertion order when exceeded.
- The key is the raw URL, and writing the same URL again simply overwrites it.
- Entries come from two sources: `search` (page content returned by the search endpoint) and `fetch` (content extracted by a local fetch).

The practical benefit: after `web_search` returns a batch of results, when the model wants to read one of them in depth it calls `web_fetch` and usually hits the cache directly, saving a network round trip. The cache is a process-level singleton and is cleared when switching sessions.

## Interaction tools

None of these three tools has local side effects, so they are allowed straight through under any permission tier.

### `ask_user`

The model asks you a question on its own initiative and has you pick from options, used to clarify ambiguity or gather preferences.

| Parameter | Type | Description |
|------|------|------|
| `questions` | array, 1–4 items | The list of questions, asked one at a time in order in the foreground |

The fields of each question:

| Field | Type | Description |
|------|------|------|
| `question` | string, required | The full question text |
| `header` | string, optional | A very short category label (chip), ≤ 12 characters |
| `options` | array, 2–4 items | Candidate options, each with a `label` and an optional `description` |
| `multi_select` | boolean, optional | Whether multiple selections are allowed, defaults to `false` |

The options do not need to include an "other" entry of their own; the system appends a free-input entry automatically. Put the recommended option first and mark its `label` with a trailing `(Recommended)`.

The foreground blocks synchronously waiting for your answer, and the answer is fed back into the conversation as context. Pressing Esc to cancel returns empty answers and, as a non-error result, tells the model that the user cancelled this question, so it continues from the information it already has instead of asking again and again. Sub-agents have no UI, so calling it there returns a message that the current context does not support asking the user.

### `exit_plan_mode`

Submits an execution plan under plan mode and requests to exit.

| Parameter | Type | Description |
|------|------|------|
| `plan` | string, required | The prepared execution plan (Markdown), spelling out what will be done, which files change, in what order, and how it will be verified |

The tool itself does nothing and just returns "plan submitted"; the real action is the host intercepting this call and presenting the plan to you for confirmation. On approval it exits plan mode and executes under normal permissions; on rejection your feedback is fed back so the model can revise the plan.

It is the only way out of plan mode. The permission interception rules under plan mode are described in [Interactive use](./interactive.md).

### `todo_list`

Maintains the current task list, used to track progress on multi-step tasks that span turns.

| Parameter | Type | Description |
|------|------|------|
| `todos` | array, optional | The updated **complete** list (whole-list replacement). Omit it to read only; pass an empty array to clear the list |

Each entry is `{ title, status }`, where `status` is one of `pending` / `in_progress` / `done`.

Reading and writing are combined: pass `todos` to replace the whole list, pass `[]` to clear it, and pass no parameter to just read the current list. The list lives in its own store and **does not occupy conversation history**; in the TUI it is shown as a panel.

"Exactly one `in_progress`" is a soft constraint: a reminder is attached to the return value of a successful update, but nothing enforces it, and the model can violate it.

## General mechanisms

The following mechanisms apply to all tools, including dynamically registered MCP tools.

### Input validation and schema generation

Each tool uses a single zod schema to do two things at once: validate inputs at runtime, and automatically generate the JSON Schema sent to the model. A parameter's type, range, optionality, and description text are written only once, leaving no room for drift where "the schema says one thing and the code validates another".

`safeParse` runs before the call, and on failure it returns `工具 <name> 入参校验失败：<原因>` without entering execute.

### Mandatory paired result feedback

A hard convention of the agent loop: **every `tool_use` must be paired with a `tool_result`, and an orphaned `tool_use` must never occur**. An orphaned tool call makes the conversation history invalid and causes subsequent requests to fail outright.

The safeguard is treating a tool's return value as a trust boundary (`coerceToolResult` in `src/tools/index.ts`):

- A valid result object passes through unchanged.
- A bare string return is wrapped into a success result.
- A return of `undefined`, a primitive, or a malformed object is converted into a synthesized error result.

Add to that the three paths of an unknown tool name, failed input validation, and an exception thrown by execute, all of which are also converted into error results, and `executeTool` therefore **never throws**: no matter what happens inside a tool, the agent loop always gets a result it can feed back.

### Tool errors do not throw

When a tool runs into a problem it returns a "failure result" (fed back with an `isError` flag) rather than throwing an exception and terminating the turn. A missing file, a non-unique `old_string`, an invalid regular expression, a non-zero command exit code, a search blocked by moderation: all of these come back to the model as error text.

This is deliberate design: the error message is itself input for the model. So error text is written to be specific and to point at the next step; for example, a non-unique `old_string` reports the actual number of occurrences and suggests adding context or setting `replace_all`. The model corrects itself from that, with no need for you to step in.

### Parallel execution

In a single turn the model may issue multiple tool calls. The scheduler (`src/agent/toolScheduler.ts`) does not run them in a fixed serial order; it decides what may run concurrently based on **resource conflicts**.

Each tool declares which resources this particular call will touch (`src/tools/access.ts`):

| Declaration | Meaning | Typical tools |
|------|------|----------|
| `none` | No local side effects | `web_search`, `web_fetch`, `web_image_search` |
| `read` + path | Reads a file or directory | `read_file`, `list_dir`, `glob`, `grep` |
| `write` + path | Writes a file | `write_file`, `edit_file` |
| `all` | Fully exclusive | `bash`, and every tool that declares nothing |

The conflict rules: if either side is `all` there is always a conflict (not even `none` is let through); `none` conflicts with nothing else; two reads never conflict; when at least one side is a write, there is a conflict only if the paths are equal or overlap as a prefix on a directory boundary (`/a/b` and `/a/bc` do not count as overlapping).

So three `read_file` calls run concurrently, two `edit_file` calls on the same file are serialized automatically, and `bash` takes the whole turn exclusively without running in parallel with anything. **Tools that declare no resources are treated as `all`**, so a new tool that forgets its declaration degrades to safe serial behavior rather than a concurrency accident.

The scheduler sets no numeric cap: the number of tools in a turn is naturally bounded by the model's output length, and the conflict model is the real limit. Only `spawn_agent` is additionally limited by sub-agent concurrency slots (backed by real API quota).

Whatever the actual execution order, **results are fed back in the original order the model called them**. When queuing on the same resource, it is first come first served by call order, and later calls do not jump the queue.

### Permission gating

Tools are grouped into three risk categories (`src/agent/permission/mode.ts`):

| Category | Tools | Decision |
|------|------|------|
| Read-only / no side effects | `read_file`, `read_media`, `list_dir`, `glob`, `grep`, `web_search`, `web_fetch`, `web_image_search`, `spawn_agent`, `exit_plan_mode`, `ask_user`, `todo_list` | Allowed straight through under any permission tier |
| File writes | `write_file`, `edit_file` | `manual` requires confirmation, `auto` / `yolo` allow |
| Command execution | `bash` | `manual` / `auto` require confirmation, `yolo` allows |
| Others (MCP tools and plugin tools) | — | Confirmation required, to be conservative |

A few notes: `spawn_agent` is in the whitelist because the act of spawning is itself harmless, and writes and executions inside the sub-agent each go through permissions on their own; `ask_user` only gathers preferences, and plan mode uses it to clarify requirements too. `read_media` has no local side effects; now that it sits on the read-only row, purely investigative reads such as viewing a UI screenshot are no longer hard-blocked in plan mode. Tool names you approved in this session are remembered, and later calls with the same name are allowed straight through.

The decision yields only two outcomes, "allow" or "needs confirmation"; **rejection comes only from your choice in the confirmation dialog**. Plan mode is an independent dimension layered on top of the permission tiers: once enabled, write and execution tools are hard-blocked and only read-only investigation and `exit_plan_mode` are allowed.

How to switch between the three permission tiers, how to operate the confirmation dialog, and how to enter and exit plan mode are described in [Interactive use](./interactive.md).
