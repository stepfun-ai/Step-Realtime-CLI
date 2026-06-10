# Silero VAD Plugin (@step-cli/realtime-vad-silero)

Neural Voice Activity Detection for the realtime SDK, powered by [Silero VAD](https://github.com/snakers4/silero-vad) running on `onnxruntime-node`.

Use this when the built-in energy VAD's quality is insufficient — noisy
environments, multiple speakers nearby, background music. Silero recognizes
human speech specifically rather than "is there sustained sound", so
false-positive rates are dramatically lower.

## Trade-offs vs the built-in energy VAD

|                    | energy (built-in)    | silero (this plugin)                                   |
| ------------------ | -------------------- | ------------------------------------------------------ |
| Install size       | 0 (compiled in)      | ~50MB (avr-vad + onnxruntime-node + Silero ONNX model) |
| Native deps        | None                 | onnxruntime-node (per-platform binary)                 |
| Inference cost     | RMS, microseconds    | ~10-30ms ONNX per 96ms frame                           |
| Startup latency    | None                 | 1-2s for ONNX session load                             |
| Quiet room quality | OK                   | Excellent                                              |
| Noisy environment  | Many false positives | Robust                                                 |

## Requirements

- Node.js ≥ 20 (avr-vad's stated requirement)
- Working `onnxruntime-node` binary for your platform (x86_64 / aarch64; macOS / Linux / Windows). See troubleshooting if installation fails.

## Install（本仓库 step-cli）

> 下方旧版命令（`voice-agent ...`、`~/.realtime-agent/`）是迁移前 `harness-ts` 仓库的写法，本仓库**不适用**。请以本节为准。

### 一键安装（推荐）

```bash
pnpm setup:silero
```

完成依赖安装 + 原生二进制下载 + 校验。成功后按提示设置配置即可（见 Enable）。

镜像/网络受限时（公司 npm 镜像常无法代理 microsoft.com 的 302 重定向），传透传参数走官方源或代理：

```bash
pnpm setup:silero --registry https://registry.npmjs.org
# 或：
HTTPS_PROXY=http://your-proxy:port pnpm setup:silero
```

### 这个脚本在做什么（以及为什么不是开箱即用）

`@step-cli/realtime-vad-silero` 是仓库内 workspace 包，已声明依赖 `avr-vad`。安装分两部分：

- **会随 `pnpm install` 自动装**：`avr-vad` 与 `onnxruntime-node` 的 **JS**。Silero 模型权重（~2MB）**打包在 avr-vad 的 npm 包里**，随之带下来——**没有单独的「下载模型」步骤**。
- **不会自动装**：`onnxruntime-node` 的**原生二进制**（~50MB `.node`）。它靠 install 脚本从 microsoft.com 下载，而本仓库用 pnpm 10，默认**拦截**未列入 `pnpm-workspace.yaml` → `onlyBuiltDependencies` 的构建脚本（当前只放行 `esbuild`/`sharp`）。

之所以**不**把 `onnxruntime-node` 全局放行，是为了不让只用内置 energy VAD 的用户也被迫下载这 50MB。`pnpm setup:silero` 用 `pnpm rebuild onnxruntime-node` **按需**触发那段被拦截的下载脚本，不改全局 allowlist。energy VAD 内置零依赖、默认即用，无需本节任何操作。

### 验证（脚本已自动做，手动复查可用）

```bash
node -e "require('onnxruntime-node'); console.log('onnxruntime-node OK')"
```

若报 `Cannot find module ... binding.node` / `was compiled against a different Node`，说明二进制没下成功，见下方「Troubleshooting」。

## Enable（本仓库 step-cli）

VAD 选择存在主 config 的 `voice.defaults.vad`（`~/.step-cli/config.json`）。用命令切换（推荐）：

```bash
pnpm step vad list          # 看可用 VAD 及安装状态
pnpm step vad set silero    # 写入 voice.defaults.vad
pnpm step vad status        # 查看当前选择
```

或直接编辑主 config：

```jsonc
{ "voice": { "defaults": { "vad": "silero" } } }
```

运行时（`src/runtime/build-voice-runtime.ts`）在 **duplex 模式**下读 `voice.vad`，默认 `energy`，设为 `silero` 即切换。然后正常启动：

```bash
node bin/step-cli.js voice --workspace "$PWD"
# 或开发态：pnpm step voice -w "$PWD"
```

启动时会有 1–2s 的 ONNX 模型加载（一次性）。

> **限制**：当前只支持选 VAD **名字**（`energy` / `silero`）。下方「Advanced configuration」里带调参的**对象形式**（`{"vad":{"type":"silero","options":{...}}}`）目前**读不到**——需要先把对象形式解析接进 config 加载链。PTT 模式不经过 VAD，此设置只对 duplex 生效。

## Advanced configuration

> ⚠️ 本仓库现状：选 VAD **名字**（`pnpm step vad set silero`）已接通；但调参所需的**对象形式**配置（`{"vad":{"type":"silero","options":{...}}}`）**尚未接通**——当前只认字符串形式 `voice.defaults.vad: "silero"`，会用下表默认值。下面的写法是接好对象形式解析后的目标用法，列出供参考与后续实现。

迁移后可通过 CLI 传 JSON 调参：

```bash
voice-agent --vad '{"type":"silero","options":{"positiveSpeechThreshold":0.6,"redemptionFrames":12}}'
```

Or in `preferences.json`:

```json
{
  "vad": { "type": "silero", "options": { "positiveSpeechThreshold": 0.6 } }
}
```

### Options reference

| Option                    | Default | Description                                                                                                                                                                                                           |
| ------------------------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `model`                   | `"v5"`  | Silero variant (`"v5"` or `"legacy"`). v5 is the 2024 model, recommended unless you're reproducing legacy behavior.                                                                                                   |
| `positiveSpeechThreshold` | `0.5`   | Probability above which a frame counts as "speech". Increase (e.g. 0.6) for fewer false positives in noisy environments.                                                                                              |
| `negativeSpeechThreshold` | `0.35`  | Probability below which a frame counts as "silence".                                                                                                                                                                  |
| `redemptionFrames`        | `8`     | Consecutive silence frames needed before emitting `speech_end`. Each frame is ~96ms, so 8 = ~768ms of silence. Increase for more tolerant pause handling (good for slow speakers); decrease for snappier auto-commit. |
| `minSpeechFrames`         | `3`     | Minimum sustained-speech frames before emitting `speech_start`. Prevents momentary noise (3 = ~288ms).                                                                                                                |
| `preSpeechPadFrames`      | `1`     | Pad emitted speech segments with N pre-onset frames.                                                                                                                                                                  |

## Verify install（本仓库 step-cli）

本仓库没有 `voice-agent vad list`。用下面任一方式确认就位：

1. **二进制可加载**（最关键，决定 silero 能否真正跑起来）：

   ```bash
   node -e "require('onnxruntime-node'); console.log('onnxruntime-node OK')"
   ```

2. **插件工厂可解析**（用 SDK 的 resolver，从仓库根目录跑）：

   ```bash
   node --import tsx -e "import('@step-cli/realtime').then(m=>m.resolveVadAdapter('silero')).then(()=>console.log('silero resolved')).catch(e=>{console.error(e.message);process.exit(1)})"
   ```

3. **端到端**：`pnpm step vad set silero`（写入主 config 的 `voice.defaults.vad`）后，以 duplex 启动 `voice`，观察 `logs/dev.log` 是否出现 `failed to resolve VAD adapter`（出现即未就位）。

任一步报「找不到原生 binding / module not found」，见下方 Troubleshooting（多为公司 npm 镜像 302 导致二进制没下成）。

## Troubleshooting

### `onnxruntime-node` postinstall fails with 302 redirect / network error

```
Error: Failed to download build list. HTTP status code = 302
```

This is `onnxruntime-node`'s install script failing to download the native binary, usually because the company's npm mirror doesn't proxy `microsoft.com` redirects.

> 前提：先确认已按上面「Install → 启用步骤」把 `onnxruntime-node` 加入 `onlyBuiltDependencies`（否则脚本根本不会跑，也就不会报 302，而是直接被 Ignored）。下面是脚本能跑、但**下载阶段**失败时的处理。

**Workarounds (try in order):**

1. **换官方源后重建二进制：**

   ```bash
   pnpm rebuild onnxruntime-node --registry https://registry.npmjs.org
   ```

2. **手动放置二进制（绕过下载）：** 到 https://github.com/microsoft/onnxruntime/releases 下载与平台匹配的包（如 `onnxruntime-linux-x64-1.23.2.tgz`），解压后把 `.node` 放到 `node_modules/onnxruntime-node/bin/napi-v3/<platform>/<arch>/onnxruntime_binding.node`。

3. **走 HTTPS 代理重建：**
   ```bash
   HTTPS_PROXY=http://your-proxy:port pnpm rebuild onnxruntime-node
   ```

### ARM Linux / Raspberry Pi: no prebuilt binary

`onnxruntime-node` only ships x64 and arm64 binaries; some boards aren't covered.

**Options:**

- Use the built-in energy VAD（安静环境够用，且是本仓库默认）：`pnpm step vad set energy`，或删掉主 config `voice.defaults.vad` 字段
- Build `onnxruntime` from source for your architecture
- Cross-compile on x64 and copy the binary over

### Node version warning: "required: { node: '>=20' }, current: 'v18.x.x'"

`avr-vad@1.0.10` declares `engines.node >= 20`. On Node 18 it installs (with a warning) and may even work, but isn't supported upstream. **Upgrade to Node 20+** for production use.

### Silero loads slowly on first request (1-2s pause)

Expected. `RealTimeVAD.new()` loads the ONNX session and bundled model file (~2MB). This happens once per process; subsequent `processFrame` calls are ~10-30ms each.

### High CPU usage

Each `processFrame` runs ONNX inference. If your audio pump runs faster than 10Hz (i.e. chunks under 100ms), you'll pay 10+ inferences per second, totaling several hundred ms of CPU. Either:

- Increase the audio pump's chunk size in the frontend
- Use the built-in energy VAD (microsecond-scale)

### Frequent false `speech_end` mid-sentence

Slow speakers / longer pauses trigger `speech_end` too early. Bump `redemptionFrames`:

```bash
voice-agent --vad '{"type":"silero","options":{"redemptionFrames":16}}'
```

(16 frames ≈ 1.5s of silence required before commit.)

### Frequent false `speech_start` from background noise

Tighten the positive threshold:

```bash
voice-agent --vad '{"type":"silero","options":{"positiveSpeechThreshold":0.65}}'
```

## Migration to @step-cli/realtime

When the realtime SDK migrates from `harness-ts` to `step-cli/packages/realtime`, this plugin moves to:

```
step-cli/extensions/realtime-vad-silero/
```

User-facing changes:

- Install command becomes: `pnpm add @step-cli/realtime-vad-silero`
- `voice-agent` command becomes `step voice`
- Everything else (config, options, behavior) stays identical

The `preferences.json` `vad` field is forward-compatible.

## Reporting issues

- VAD quality issues (false positives, missed onsets): include a sample audio clip and the options you used
- Install failures: include `node --version`, OS / architecture, and the full npm/pnpm error output
- Performance issues: include CPU usage and audio pump chunk size

## License & credits

- `avr-vad` — Agent Voice Response project, MIT
- Silero VAD model — Silero Team, MIT
- This plugin's glue code — same license as parent SDK
