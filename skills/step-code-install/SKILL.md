---
name: step-code-install
description: 安装 Step Code CLI（终端编码 agent，阶跃星辰 Step 模型驱动）：四种安装方式、环境要求、配置 API key、验证、升级与卸载、常见故障排查
when_to_use: 用户想安装、构建、升级、卸载 Step Code，或安装过程报错需要排查时
---

本 skill 只讲一件事：把 Step Code 装到能跑起来。功能怎么用不在这里，装完见仓库 `docs/`（中文 `docs/zh/`、英文 `docs/en/`）。

> **四种安装方式，按需选择**：
> - **单文件可执行**（无 Node 环境）：从 [Releases](https://github.com/li-xiu-qi/Step-Realtime-CLI/releases/latest) 下载对应平台产物，改名放进 PATH。
> - **npm 装 Release tarball**（一条命令，推荐）：`npm i -g https://github.com/li-xiu-qi/Step-Realtime-CLI/releases/latest/download/step-code.tgz`，不编译不拉依赖，链接始终指向最新 Release。需 Node 22+。
> - **npm 装源码分支**（跟最新主干）：`npm i -g github:li-xiu-qi/Step-Realtime-CLI#step-code-explore-pi，约 1 分钟，本机编译。需 Node 22+。
> - **从源码安装**（参与开发）：clone + `pnpm install && pnpm build && pnpm link --global`。需 Node 22+ 与 pnpm。
>
> 详细步骤与故障排查见下方各节。

> **怎么让你的 agent 用上它**：本目录不在自动扫描路径里（刻意如此，避免与工具目录冲突）。两种用法——把 `skills/step-code-install/` 整个拷进你 agent 的技能目录（本项目原生目录是 `.step-code/skills/`，兼容目录是 `.agents/skills/`）；或者直接把本文件路径丢给 agent 让它读。

## 环境要求

- **Node.js >= 22**（`glob` 工具用到 `node:fs.globSync`，该 API 自 Node 22 起可用）。用单文件可执行版则不需要 Node。
- **pnpm**：只有从源码安装、参与开发时需要。用 npm 装现成产物不需要。
- 一个可用的 **StepFun API key**（阶跃星辰开放平台申请）。

先确认版本，不要跳过这一步：

```bash
node -v      # 必须 >= v22
pnpm -v      # 仅源码安装需要
```

Node 版本不够时，用版本管理器装 22（如 fnm、nvm、Volta），不要用系统包管理器覆盖全局 Node。

## 安装

### 单文件可执行（无需 Node 环境）

从 [Releases](https://github.com/li-xiu-qi/Step-Realtime-CLI/releases/latest) 下载对应平台产物（链接始终指向最新 Release）：

| 平台 | 下载 |
|------|------|
| Windows x64 | [step-code-win32-x64.exe](https://github.com/li-xiu-qi/Step-Realtime-CLI/releases/latest/download/step-code-win32-x64.exe) |
| macOS Apple Silicon | [step-code-darwin-arm64](https://github.com/li-xiu-qi/Step-Realtime-CLI/releases/latest/download/step-code-darwin-arm64) |
| Linux x64 | [step-code-linux-x64](https://github.com/li-xiu-qi/Step-Realtime-CLI/releases/latest/download/step-code-linux-x64) |

每个产物附带同名 `.sha256` 校验文件（同路径加 `.sha256` 后缀）。下载后重命名为 `step`（Windows 为 `step.exe`）放进 PATH 即可。

```bash
# macOS / Linux 需要补执行权限
chmod +x step

# macOS 从浏览器下载的文件带隔离属性，首次运行前先摘掉
xattr -d com.apple.quarantine step 2>/dev/null || true
```

### npm 装 Release tarball

一条命令装最新版（永久链接，始终解析到最新 Release 的 tarball）：

```bash
npm i -g https://github.com/li-xiu-qi/Step-Realtime-CLI/releases/latest/download/step-code.tgz
step --version
```

tarball 内含预编译的 `dist/`，`npm i -g <url>` 只解包并链接 `bin.step`，**不在你机器上编译，也不拉依赖**。

要锁定某个版本、可复现安装时，把 URL 换成该 tag 的带版本号资产，例如：

```bash
npm i -g https://github.com/li-xiu-qi/Step-Realtime-CLI/releases/download/v0.1.2/step-code-0.1.2.tgz
```

### npm 装源码分支（跟随最新主干）

直接从开发分支装，拿到的是当下最新代码：

```bash
npm i -g github:li-xiu-qi/Step-Realtime-CLI#step-code-explore-pi
step --version
```

npm 会先克隆仓库、安装构建依赖，再通过 `prepare` 钩子在本机编译出 `dist/`。代价是慢，且构建依赖会留在全局安装目录里。实测（2026-08-02，Windows + npm，本地 git 源）：耗时约 1 分钟，装入 285 个包。

这条路径的依赖树由 npm 自行解析，不走仓库里的 pnpm lockfile，因此存在依赖漂移导致编译失败的可能。失败时改用上面的 Release tarball，或按下文从源码安装。

### 从源码安装

要改代码、跑测试、参与开发时走这条。它给的是完整开发环境，`step` 命令来自软链接，改完重新构建即时生效：

```bash
git clone -b step-code-explore-pi https://github.com/li-xiu-qi/Step-Realtime-CLI.git
cd Step-Realtime-CLI
pnpm install
pnpm build        # tsc 编译到 dist/
pnpm test         # vitest 单元测试（可选，验证环境正常）
```

构建后用 `node dist/main.js` 即可运行。想把 `step` 注册成全局命令：

```bash
pnpm link --global
step
```

想用稳定分支时手动切换：

```bash
git checkout main
pnpm install && pnpm build
```

### npm 公共 registry（暂不提供）

`step-code` 没有发布到 npm 公共 registry，因此 `npm install -g step-code` 不可用，也没有 `npm update -g step-code`。

这是当前阶段的选择而非遗漏：上面几种方式已经覆盖「要不要 Node 环境」「跟版本还是跟主干」的全部组合，而 registry 发布会额外引入账号、发布权限与版本不可撤回等长期承诺。等分发形态稳定后再评估注册。

## 配置 API key

最省事的方式是环境变量，装完立即可用：

```bash
export STEP_CODE_API_KEY=<your-key>
```

想持久化就写进 shell 配置（`~/.bashrc`、`~/.zshrc` 等）。也可以写配置文件 `~/.step-code/config.toml`：

```toml
model = "step37"

[providers.stepfun]
type = "stepfun"
api_key = "<your-key>"
```

key 的完整解析优先级、多渠道多模型配置、以及用 `api_key_env` 间接引用环境变量（密钥不落盘）的写法，见 `docs/zh/configuration.md`。

> 首次启动时如果未配置 key，step-code 会提示配置方式，可直接粘贴 key 自动写入配置文件。

## 验证安装

```bash
step --version          # 打印版本号与构建标识
step -p "你好"          # 非交互执行一条指令，打印结果后退出
step                    # 进入交互界面，输入 /help 看全部命令
```

`step -p` 能正常返回模型回复，说明依赖、构建、key 三者都通了。

`--version` 的输出形如 `0.1.0 (a1b2c3d 2026-08-03T02:46Z)`：括号里是构建时的 commit 与时间。同一个版本号下会有很多次构建，报 bug 时把整行贴出来才能定位到具体代码。commit 后面带 `+dirty` 表示这份产物构建自有未提交改动的工作区，不对应任何一个 commit（源码安装且本地改过代码时会出现）；从无 git 信息的目录构建则只报版本号，没有括号部分。

想校验配置文件本身是否合法：

```bash
step doctor config      # 校验 ~/.step-code/config.toml，退出码 0 通过、1 失败
```

它会报出 TOML 语法错误、语义非法值，以及拼错的顶层键（拼错的键在正常启动时会被静默忽略，`doctor` 是唯一能发现它们的入口）。

## 升级

### 单文件可执行

下载新版本覆盖同名文件即可。

### npm 装的两种形态

重新执行原来那条安装命令，npm 会重新解析 URL 或 git 引用并覆盖安装：

```bash
npm i -g https://github.com/li-xiu-qi/Step-Realtime-CLI/releases/latest/download/step-code.tgz  # 最新 Release tarball
npm i -g github:li-xiu-qi/Step-Realtime-CLI#step-code-explore-pi                                  # 源码分支
```

`npm update -g step-code` 对这几种形态不生效——它面向 registry 包，而这里的来源是 git 引用或 URL。

### 源码安装升级

源码安装即软链接安装，拉取最新代码后重新构建即可，无需重新 link。注意当前工作分支，推荐在 `step-code-explore-pi 上拉取更新：

```bash
cd Step-Realtime-CLI
git checkout step-code-explore-pi   # 确认在推荐分支上
git pull
pnpm install    # 依赖有变化时
pnpm build
```

## 卸载

### 单文件可执行

删掉那个可执行文件，并把它从 PATH 里移除。

### npm 装的两种形态

```bash
npm uninstall -g step-code
```

### 源码安装卸载

在仓库目录下解除全局软链接：

```bash
cd Step-Realtime-CLI
pnpm unlink --global   # 移除全局 step 命令
```

配置、会话记录等数据在 `~/.step-code/`，卸载命令不会动它；要彻底清理手动删除该目录。

## 常见故障

**`step` 命令找不到**：npm 全局装的话，检查 `npm bin -g` 的目录是否在 PATH 里；源码安装则看 `pnpm bin --global`。把对应目录加入 PATH 后重开终端。

**Windows 下 `bash` 工具报错「未找到可用的 shell 解释器」**：说明 Git Bash、WSL、busybox、PowerShell 都没探测到。装 [Git for Windows](https://git-scm.com/download/win) 最省事；已装但在非标准路径时，把 `bash.exe` 绝对路径设到环境变量 `STEP_SHELL_PATH`。

**构建报类型错误**：先 `pnpm install` 确保依赖完整，再 `pnpm build`；仍失败跑 `pnpm typecheck` 看具体位置。

**单文件可执行报错找不到模块**：产物是把运行时与代码注入同一个文件的单文件形态，不依赖任何同级文件。出现这类报错说明文件在下载或改名过程中被截断，重新下载并用附带的 `.sha256` 校验。

**Windows 下载后被 SmartScreen 拦**：产物未做代码签名，SmartScreen 会对下载量低的可执行文件给出提示。可先用 `.sha256` 核对文件完整性，再在提示里选择继续运行。

**macOS 提示「无法验证开发者」或直接被拒绝执行**：产物只做了 ad-hoc 签名、未做公证。摘掉隔离属性后即可运行：

```bash
xattr -d com.apple.quarantine step
chmod +x step
```

**模型返回 400，提示协议不支持**：不同模型开放的协议不同，某个模型走它不支持的协议通道必然报错。渠道协议怎么配见 `docs/zh/configuration.md` 的协议与渠道章节。

## 进一步

装完之后：

- `docs/zh/quickstart.md`（英文 `docs/en/quickstart.md`）第一次对话怎么走
- `docs/zh/configuration.md` 全部配置项
- `docs/zh/installation.md` 更细的安装说明，含各方式之间的选择建议
