---
name: step-code-install
description: 安装 Step Code CLI（终端编码 agent，阶跃星辰 Step 模型驱动）：环境要求、源码构建、配置 API key、验证、升级与卸载、常见故障排查
when_to_use: 用户想安装、构建、升级、卸载 Step Code，或安装过程报错需要排查时
---

本 skill 只讲一件事：把 Step Code 装到能跑起来。功能怎么用不在这里，装完见仓库 `docs/`（中文 `docs/zh/`、英文 `docs/en/`）。

> **当前推荐安装方式**：npm 全局安装（v0.4.0 起已发布到 npm 公共 registry）。
> ```bash
> npm install -g step-code
> step --version
> ```
> 一条命令即可使用，无需本地构建。

> **源码安装（开发者或想使用最新未发版功能）**：Step Code 主仓库的 `step-code-explore` 分支。
> ```bash
> git clone -b step-code-explore https://github.com/li-xiu-qi/Step-Realtime-CLI.git
> cd Step-Realtime-CLI
> pnpm install && pnpm build && pnpm link --global
> ```
> 这个分支汇聚最新 step-code 功能迭代，想提前用未发版功能时用它。`main` 分支保留稳定快照，需要时再切。

> **怎么让你的 agent 用上它**：本目录不在各家 CLI 的自动扫描路径里（刻意如此，避免与工具目录冲突）。两种用法——把 `skills/step-code-install/` 整个拷进你 agent 的技能目录（Claude Code 与本项目的兼容目录是 `.agents/skills/`，本项目原生目录是 `.step-code/skills/`）；或者直接把本文件路径丢给 agent 让它读。

## 环境要求

- **Node.js >= 22**（硬性要求，不是建议值）。低于 22 会在构建或启动时失败，因为代码用了 `node:fs` 的 `globSync`，该 API 自 Node 22 起可用。
- **pnpm**。仓库用 pnpm 管理依赖与脚本。
- 一个可用的 **StepFun API key**（阶跃星辰开放平台申请）。

先确认版本，不要跳过这一步：

```bash
node -v      # 必须 >= v22
pnpm -v
```

Node 版本不够时，用版本管理器装 22（如 fnm、nvm、Volta），不要用系统包管理器覆盖全局 Node。

## 安装

### 推荐：npm 全局安装（v0.4.0 起已发布）

```bash
npm install -g step-code
step --version
```

一条命令即可，不需要本地 clone 和构建。npm 全局装完后，`step` 命令直接可用。

### 备选：源码安装

想参与开发、调试最新未发版功能，或 npm 安装受网络环境限制时，用源码安装。日常优先从 `step-code-explore` 分支拉取：

```bash
git clone -b step-code-explore https://github.com/li-xiu-qi/Step-Realtime-CLI.git
cd Step-Realtime-CLI
pnpm install
pnpm build
pnpm link --global
```

四步作用：`git clone -b step-code-explore` 拉取当前开发分支；`pnpm install` 装依赖；`pnpm build` 执行 `tsc -p tsconfig.json` 编译到 `dist/`；`pnpm link --global` 把 `step` 命令软链接到全局，之后任意目录可用。

想用稳定分支时手动切换：

```bash
git checkout main
pnpm install && pnpm build
```

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

## 验证安装

```bash
step --version          # 打印版本号
step -p "你好"          # 非交互执行一条指令，打印结果后退出
step                    # 进入交互界面，输入 /help 看全部命令
```

`step -p` 能正常返回模型回复，说明依赖、构建、key 三者都通了。

想校验配置文件本身是否合法：

```bash
step doctor config      # 校验 ~/.step-code/config.toml，退出码 0 通过、1 失败
```

它会报出 TOML 语法错误、语义非法值，以及拼错的顶层键（拼错的键在正常启动时会被静默忽略，`doctor` 是唯一能发现它们的入口）。

## 升级

### npm 全局安装升级

```bash
npm update -g step-code
```

### 源码安装升级

拉最新代码重新构建即可，不用重新 link。注意当前工作分支，推荐在 `step-code-explore` 上拉取更新：

```bash
cd Step-Realtime-CLI
git checkout step-code-explore    # 确认在推荐分支上
git pull
pnpm install    # 依赖有变动时需要
pnpm build
```

## 卸载

### npm 全局安装卸载

```bash
npm uninstall -g step-code
```

### 源码安装卸载

在仓库目录下解除全局软链接：

```bash
cd Step-Realtime-CLI
pnpm unlink --global    # 移除全局 step 命令
```

配置与会话数据在 `~/.step-code/`，卸载命令不会动它。要彻底清理就手动删除该目录（里面有你的会话历史与配置，删前确认）。

## 常见故障

**`step: command not found`**
`pnpm link --global` 没执行成功，或 pnpm 的全局 bin 目录不在 `PATH` 里。执行 `pnpm bin --global` 查出该目录，把它加入 `PATH`。

**构建报 TypeScript 错误**
先确认 Node 版本 >= 22，再确认 `pnpm install` 完整跑过（依赖缺失会表现为类型报错）。

**启动报缺少 API key**
检查 `STEP_CODE_API_KEY` 是否在当前 shell 生效（`echo $STEP_CODE_API_KEY`）。环境变量只对设置它的那个 shell 会话有效，新开终端要重新 export 或写进 shell 配置文件。

**Windows 上工具执行失败、提示找不到 shell**
Step Code 在 Windows 上依次探测 Git Bash、WSL、busybox-w32、PowerShell。四者都没有时会明确报错。装 Git for Windows 是最省事的解法；也可以用 `STEP_SHELL_PATH` 环境变量显式指定 shell 可执行文件路径。

**模型返回 400，提示协议不支持**
不同模型开放的协议不同，某个模型走它不支持的协议通道必然报错。渠道协议怎么配见 `docs/zh/configuration.md` 的协议与渠道章节。

## 进一步

装完之后：

- `docs/zh/quickstart.md`（英文 `docs/en/quickstart.md`）第一次对话怎么走
- `docs/zh/installation.md` 更细的安装说明，含 Windows shell 探测链的完整顺序
- `docs/zh/configuration.md` 全部配置项
