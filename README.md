# Step Realtime CLI

<p align="center">
  <a href="./README.md">English</a> |
  <a href="./README_CN.md">简体中文</a>
</p>

`step-realtime-cli` is a terminal-based AI coding assistant. You can interact with it via text or **realtime voice** for everyday tasks such as reading code, editing files, and running commands.

## Demo

![Step Realtime CLI demo](docs/assets/demo.gif)

## Key capabilities

- **Voice coding**: run `step voice` and, with headphones on, issue spoken instructions; the assistant parses repository context, applies edits, and confirms changes verbally.
- **Text chat**: run `step` in any working directory to enter the interactive terminal UI and start a task with natural language.
- **One-shot tasks**: submit a single request via `step exec "..."` and receive the result when execution completes.
- **Session resumption**: session state is persisted automatically and can be resumed at any time via `step resume`.
- **Read-only planning mode**: run `step exec --mode plan "..."` so the assistant only reads the code and proposes a plan, which the user reviews and approves before any changes are applied.

## Quick start

### Requirements

- macOS / Linux, Node.js 20+
- A StepFun API key (a single key may be used for both the coding model and realtime voice; a different provider's key may be configured for the coding side if preferred)

### Choose your region

StepFun operates two independent sites; pick the one that matches where your API key was issued. The two sites do **not** share accounts or keys.

| Region                   | Console                       | API endpoint              | macOS / Linux installer          | Windows installer                                                      |
| ------------------------ | ----------------------------- | ------------------------- | -------------------------------- | ---------------------------------------------------------------------- |
| Mainland China (default) | https://platform.stepfun.com/ | `https://api.stepfun.com` | `bash scripts/setup.sh`          | `powershell -ExecutionPolicy Bypass -File scripts/setup.ps1`           |
| Overseas                 | https://platform.stepfun.ai/  | `https://api.stepfun.ai`  | `bash scripts/setup-overseas.sh` | `powershell -ExecutionPolicy Bypass -File scripts/setup.ps1 -Overseas` |

`scripts/setup-overseas.sh` runs the same flow as `scripts/setup.sh` and then rewrites `~/.step-cli/config.json` so both the realtime WebSocket and the models-proxy base URL point at `api.stepfun.ai`. All other flags (`--skip-build`, `--force-config`, `--uninstall`, …) are forwarded verbatim.
On Windows, pass `-Overseas` to `scripts/setup.ps1` for the same endpoint rewrite.

### Audio dependencies

`scripts/setup.sh` (and `scripts/setup-overseas.sh`) enables AEC by default and will detect or install Chrome automatically. In this default mode, audio capture and playback are handled by Chrome (`BrowserAudioDriver`), and no additional system-level audio utilities are required.

On Windows, voice mode always uses `BrowserAudioDriver`; Chrome, Edge, or Chromium is required. Set `STEP_CHROME_PATH` if your browser is installed in a custom location.

When AEC is disabled via `step aec off` (or falls back because Chrome is unavailable), realtime voice switches to the system command-line audio drivers, which require:

- macOS: `sox`, installable via `brew install sox`
- Linux: ALSA utilities `arecord` / `aplay`, typically provided by `alsa-utils` (e.g. `sudo apt install alsa-utils`)
- Windows: no command-line audio fallback is used; keep browser audio enabled.

### One-shot install

```bash
git clone <repo-url> step-realtime-cli
cd step-realtime-cli

# Mainland China (platform.stepfun.com)
bash scripts/setup.sh
powershell -ExecutionPolicy Bypass -File scripts/setup.ps1   # Windows

# Overseas (platform.stepfun.ai)
# bash scripts/setup-overseas.sh
# powershell -ExecutionPolicy Bypass -File scripts/setup.ps1 -Overseas
```

The installer installs dependencies, builds the executable, registers `step` on your shell `PATH`, and initializes the voice components (VAD / AEC).
On Windows, the installer registers a `step.cmd` launcher backed by Node.js, so Bun native compilation is not required.

After installation completes, perform the following two steps:

1. Edit `~/.step-cli/config.json` and replace the two `apiKey` placeholders with valid keys:
   - `model.apiKey` — coding model
   - `voice.realtime.apiKey` — realtime voice (ASR/TTS)
   - When using StepFun, the same value may be used for both fields
2. **Open a new shell** so that the updated `PATH` takes effect.

Then, from any directory:

```bash
step voice                        # realtime voice conversation
step                              # interactive text UI
step "summarize src/index.ts"     # one-shot task
```

### Uninstall

```bash
bash scripts/uninstall.sh
powershell -ExecutionPolicy Bypass -File scripts/setup.ps1 -Uninstall   # Windows
```

This removes the installed executable and `PATH` entry, while **preserving** `~/.step-cli/config.json` and existing session history.

## Voice mode

```bash
step voice
```

Once started, simply begin speaking. The assistant performs speech recognition, repository operations, and voice replies concurrently in realtime.

> Using headphones is strongly recommended: it significantly reduces echo and false triggering caused by speaker output being re-captured by the microphone, and improves both recognition accuracy and conversation stability.

### Input modes

- **duplex (continuous, default)**: suitable for natural conversation; relies on VAD to determine when an utterance ends.
- **ptt (push-to-talk)**: more reliable in noisy environments.

### VAD (voice activity detection)

The default mode is `energy`, which is suitable for quiet environments. For noisy or speaker-out setups, switch to the more accurate `silero` model:

```bash
step vad set silero    # switch to silero
step vad status        # show current selection
```

### AEC (acoustic echo cancellation)

When speakers are used instead of headphones, TTS output may be re-captured by the microphone and cause feedback. Enabling AEC mitigates this issue:

```bash
step aec on            # enable AEC
step aec status        # show AEC status (also verifies Chrome availability)
```

AEC requires Chrome to be installed locally. On macOS, the CLI will suggest `brew install --cask google-chrome` if Chrome is not detected. AEC is not required when using headphones.

### Speech rate

Adjust `voice.defaults.speedRatio` in `~/.step-cli/config.json`. The valid range is `0.5 – 2.0`, with a default of `1.1`.

## Common commands

```bash
step                        # launch the interactive UI in the current directory
step "look at this bug"     # one-shot task
step voice                  # realtime voice conversation
step resume <session_id>    # resume a previous session
step exec --mode plan "..." # read-only planning mode (does not modify files)
step config show            # display the effective configuration
step config sync --write    # add newly introduced configuration fields after upgrade
step theme                  # export the current theme for customization
```

For the full command list, run `step --help`.

## Configuration

All configuration resides in `~/.step-cli/config.json`. Typical adjustments include:

- **Switch models**: update `model.model` and `model.apiKey`
- **Update voice API key**: update `voice.realtime.apiKey`
- **VAD / AEC**: use the commands listed above rather than editing the JSON manually
- **After upgrade**: run `step config sync --write` to populate newly added configuration fields (existing values are preserved)

```bash
step config path        # show the configuration file path
step config show        # show the merged effective configuration
```

## Upgrade

```bash
git pull
bash scripts/setup.sh           # mainland; or scripts/setup-overseas.sh for api.stepfun.ai
powershell -ExecutionPolicy Bypass -File scripts/setup.ps1   # Windows
step config sync --write
```

## Feedback & contributing

Issues and pull requests are welcome. Please refer to [`CONTRIBUTING.md`](CONTRIBUTING.md) and [`AGENTS.md`](AGENTS.md) for development conventions.

Core contributors (stepfun CLI team): [@ZouR-Ma](https://github.com/ZouR-Ma) · [@qiushi20260601](https://github.com/qiushi20260601) · [@MelodyVAR](https://github.com/MelodyVAR) · [@beanzhou](https://github.com/beanzhou) · [@icystone](https://github.com/icystone)

## License

Step Realtime CLI is licensed under the MIT License. You can find the license file in the [LICENSE](LICENSE) file of this repository. This permits free use, modification, and distribution of the software, provided that the original copyright notice and license terms are retained.
