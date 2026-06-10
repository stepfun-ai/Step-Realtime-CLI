# Step Realtime CLI

<p align="center">
  <a href="./README.md">English</a> |
  <a href="./README_CN.md">简体中文</a>
</p>

`step-realtime-cli` 是一款运行于终端的 AI 编程助手，支持以文字或**实时语音**两种方式与其交互，可用于代码阅读、修改以及命令执行等日常开发任务。

## 效果演示

![Step Realtime CLI demo](docs/assets/demo.gif)

## 核心能力

- **语音编程**：执行 `step voice` 并佩戴耳机后，即可直接以语音下达指令，助手将自动解析仓库上下文、执行修改并与用户确认。
- **文字对话**：在任意工作目录执行 `step` 即可进入交互式终端 UI，通过自然语言指令开始任务。
- **一次性任务**：通过 `step exec "..."` 提交单次任务，执行完成后直接返回结果。
- **会话续接**：会话状态自动持久化，可通过 `step resume` 在后续随时恢复。
- **只读规划模式**：通过 `step exec --mode plan "..."` 让助手仅阅读代码并输出方案，由用户确认后再执行变更。

## 快速开始

### 环境要求

- macOS / Linux，Node.js 20+
- StepFun API Key（同一密钥可同时用于编程模型与实时语音；如需接入其他模型服务，可分别配置）

### 选择站点

StepFun 提供两个相互独立的站点，请按 API Key 的发放来源选择对应安装方式。两个站点的账号与密钥**不互通**。

| 站点         | 控制台                        | API 域名                  | 安装脚本                         |
| ------------ | ----------------------------- | ------------------------- | -------------------------------- |
| 国内（默认） | https://platform.stepfun.com/ | `https://api.stepfun.com` | `bash scripts/setup.sh`          |
| 海外         | https://platform.stepfun.ai/  | `https://api.stepfun.ai`  | `bash scripts/setup-overseas.sh` |

`scripts/setup-overseas.sh` 会先复用 `scripts/setup.sh` 的全部流程，再把 `~/.step-cli/config.json` 中实时语音的 WebSocket 端点与 models-proxy 基础地址改写为 `api.stepfun.ai`。所有其他参数（`--skip-build`、`--force-config`、`--uninstall` 等）均会原样转发。

### 音频依赖

`scripts/setup.sh`（以及 `scripts/setup-overseas.sh`）默认启用 AEC，并会自动检测或安装 Chrome；该模式下语音的采集与播放由 Chrome（`BrowserAudioDriver`）提供，无需额外安装系统级音频工具。

仅当通过 `step aec off` 关闭 AEC（或 Chrome 不可用导致回落）时，实时语音会切换至系统命令行驱动，此时需要：

- macOS：`sox`，通过 `brew install sox` 安装
- Linux：ALSA 工具集 `arecord` / `aplay`，通常由 `alsa-utils` 提供，例如 `sudo apt install alsa-utils`

### 一键安装

```bash
git clone <repo-url> step-realtime-cli
cd step-realtime-cli

# 国内（platform.stepfun.com）
bash scripts/setup.sh

# 海外（platform.stepfun.ai）
# bash scripts/setup-overseas.sh
```

安装脚本将自动安装依赖、构建可执行文件、将 `step` 命令注册至全局 PATH，并完成语音相关的 VAD / AEC 组件初始化。

安装完成后，请执行以下两步：

1. 编辑 `~/.step-cli/config.json`，将其中两个 `apiKey` 占位符替换为有效密钥
   - `model.apiKey`：编程模型
   - `voice.realtime.apiKey`：实时语音（ASR/TTS）
   - 使用 StepFun 时，两处可填入同一密钥
2. **重新打开终端**，以使 PATH 配置生效

随后可在任意目录运行：

```bash
step voice                        # 进入实时语音对话
step                              # 进入文字交互式 UI
step "帮我读一下 src/index.ts"    # 一次性任务
```

### 卸载

```bash
bash scripts/uninstall.sh
```

该脚本将清理已安装的可执行文件与 PATH 配置，并**保留** `~/.step-cli/config.json` 及历史会话记录。

## 语音模式

```bash
step voice
```

进入后即可直接以语音对话。助手将同步进行语音识别、仓库操作与语音回复。

> 建议佩戴耳机使用，可显著降低扬声器外放被麦克风重新采集导致的回声与误触发，提升识别准确度与对话稳定性。

### 输入模式

- **duplex（连续模式，默认）**：适用于自然对话，由 VAD 自动判定语句结束。
- **ptt（按键说话）**：适用于噪声较大的环境，稳定性更佳。

### VAD（语音活动检测）

默认采用 `energy` 模式，适用于安静环境；在噪声较大或外放场景下，建议切换至精度更高的 `silero`：

```bash
step vad set silero    # 切换至 silero
step vad status        # 查看当前选择
```

### AEC（回声消除）

在不佩戴耳机的外放场景下，扬声器输出可能被麦克风重新采集而引发自激；启用 AEC 可有效避免该问题：

```bash
step aec on            # 启用 AEC
step aec status        # 查看 AEC 状态（同时检测 Chrome 可用性）
```

AEC 依赖本机安装 Chrome；macOS 用户如未安装，可通过 `brew install --cask google-chrome` 进行安装。佩戴耳机时无需启用。

### 调整语速

在 `~/.step-cli/config.json` 中调整 `voice.defaults.speedRatio`，取值范围 `0.5 – 2.0`，默认值为 `1.1`。

## 常用命令

```bash
step                        # 在当前目录启动交互式 UI
step "帮我看看这个 bug"     # 单次任务
step voice                  # 实时语音对话
step resume <session_id>    # 恢复历史会话
step exec --mode plan "..." # 只读规划模式（不修改文件）
step doctor                 # 检查本地依赖、配置和 API Key 状态
step config show            # 查看当前生效的配置
step config sync --write    # 同步升级后新增的配置字段
step theme                  # 导出当前主题以便自定义
```

完整命令列表请执行 `step --help`。

## 配置

所有配置项均位于 `~/.step-cli/config.json`，常见场景如下：

- **更换模型**：修改 `model.model` 与 `model.apiKey`
- **更新语音 API Key**：修改 `voice.realtime.apiKey`
- **VAD / AEC**：使用上文提供的命令进行配置，无需手动编辑 JSON
- **版本升级后**：执行 `step config sync --write` 以补全新增的配置字段（已有取值不会被覆盖）

```bash
step config path        # 查看配置文件路径
step config show        # 查看合并后实际生效的配置
```

## 升级

```bash
git pull
bash scripts/setup.sh           # 国内；海外站点请改用 scripts/setup-overseas.sh
step config sync --write
```

## 反馈与贡献

欢迎通过 Issue / Pull Request 反馈问题或参与贡献。开发规范请参阅 [`CONTRIBUTING.md`](CONTRIBUTING.md) 与 [`AGENTS.md`](AGENTS.md)。

## License

Step Realtime CLI 基于 MIT License 开源发布。完整许可证文本可在本仓库的 [LICENSE](LICENSE) 文件中查阅。该许可证允许自由使用、修改与分发本软件，前提是保留原始的版权声明与许可证条款。
