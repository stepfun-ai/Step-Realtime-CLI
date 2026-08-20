# 安装

> 手上已有别的 AI agent 的话，仓库里的 [`skills/step-code-install/`](../../skills/step-code-install/SKILL.md) 是一份安装说明技能，让你的 agent 读它即可代你完成本页的步骤。

## 环境要求

- **Node.js >= 22**（`glob` 工具用到 `node:fs.globSync`，该 API 自 Node 22 起可用）。用单文件可执行版则不需要 Node。
- **pnpm**：只有从源码安装、参与开发时需要。用 npm 装现成产物不需要。
- Windows 用户：`bash` 工具优先使用 Git Bash（推荐安装 [Git for Windows](https://git-scm.com/download/win)），未安装时依次回退 WSL、busybox-w32、PowerShell。Git Bash 装在非标准路径时，可把 `bash.exe` 绝对路径设到环境变量 `STEP_SHELL_PATH`。

## 选哪种安装方式

全部产物都在 GitHub Releases 上，不经过 npm 公共 registry。单文件可执行与 tarball 的下载链接走 `releases/latest/download/` 永久链接，始终指向最新 Release，不随版本号失效。

| 方式 | 前置 | 装完是什么 | 适合 |
|------|------|-----------|------|
| [单文件可执行](#单文件可执行无需-node-环境) | 无 | 一个可执行文件，自带 Node 运行时 | 不想装 Node、想下载即用 |
| [npm 装 Release tarball](#npm-装-release-tarball) | Node 22+ | 预编译的 `dist/` + npm 管理的 `step` 命令 | 有 Node，想一条命令装好 |
| [npm 装源码分支](#npm-装源码分支跟随最新主干) | Node 22+ | 在你机器上编译出的 `dist/` | 要跟最新主干、能接受本机编译 |
| [从源码安装](#从源码安装) | Node 22+ 与 pnpm | 完整开发环境 + 软链的 `step` | 参与开发、要改代码 |

## 单文件可执行（无需 Node 环境）

从 [Releases](https://github.com/li-xiu-qi/Step-Realtime-CLI/releases/latest) 下载对应平台产物（下列链接始终指向最新 Release）：

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

## npm 装 Release tarball

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

## npm 装源码分支（跟随最新主干）

直接从开发分支装，拿到的是当下最新代码：

```bash
npm i -g github:li-xiu-qi/Step-Realtime-CLI#step-code-explore-pi
step --version
```

npm 会先克隆仓库、安装构建依赖，再通过 `prepare` 钩子在本机编译出 `dist/`。代价是慢，且构建依赖会留在全局安装目录里。实测（2026-08-02，Windows + npm，本地 git 源）：耗时约 1 分钟，装入 285 个包。

这条路径的依赖树由 npm 自行解析，不走仓库里的 pnpm lockfile，因此存在依赖漂移导致编译失败的可能。失败时改用上面的 Release tarball，或按下文从源码安装。

## 从源码安装

当前分支 `step-code-explore-pi 仍在快速迭代，Release 不一定追平最新代码。需要最新特性时可以从源码构建：

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

## npm 公共 registry（暂不提供）

`step-code` 没有发布到 npm 公共 registry，因此 `npm install -g step-code` 不可用，也没有 `npm update -g step-code`。

这是当前阶段的选择而非遗漏：上面几种方式已经覆盖「要不要 Node 环境」「跟版本还是跟主干」的全部组合，而 registry 发布会额外引入账号、发布权限与版本不可撤回等长期承诺。等分发形态稳定后再评估注册。

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

```bash
cd Step-Realtime-CLI
pnpm unlink --global   # 移除全局 step 命令
```

配置、会话记录等数据在 `~/.step-code/`，卸载命令不会动它；要彻底清理手动删除该目录。

## 常见问题

**`step` 命令找不到**：npm 全局装的话，检查 `npm bin -g` 的目录是否在 PATH 里；源码安装则看 `pnpm bin --global`。把对应目录加入 PATH 后重开终端。

**分不清自己跑的是哪个版本**：`step --version` 的输出形如 `0.1.0 (a1b2c3d 2026-08-03T02:46Z)`，括号里是构建时的 commit 与时间。版本号一个发布周期才动一次，构建标识每次构建都变——这两个信息合起来才能唯一定位一份产物。带 `+dirty` 说明它构建自有未提交改动的工作区，不对应任何一个 commit；只有版本号没有括号，说明构建时拿不到 git 信息（例如从 tarball 构建）。

**Windows 下 `bash` 工具报错「未找到可用的 shell 解释器」**：说明 Git Bash、WSL、busybox、PowerShell 都没探测到。装 [Git for Windows](https://git-scm.com/download/win) 最省事；已装但在非标准路径时，把 `bash.exe` 绝对路径设到环境变量 `STEP_SHELL_PATH`。

**构建报类型错误**：先 `pnpm install` 确保依赖完整，再 `pnpm build`；仍失败跑 `pnpm typecheck` 看具体位置。

**SEA 可执行文件报错找不到模块**：产物是把运行时与代码注入同一个文件的单文件形态，不依赖任何同级文件。出现这类报错说明文件在下载或改名过程中被截断，重新下载并用附带的 `.sha256` 校验。

**Windows 下载后被 SmartScreen 拦**：产物未做代码签名，SmartScreen 会对下载量低的可执行文件给出提示。可先用 `.sha256` 核对文件完整性，再在提示里选择继续运行。

**macOS 提示「无法验证开发者」或直接被拒绝执行**：产物只做了 ad-hoc 签名、未做公证。摘掉隔离属性后即可运行：

```bash
xattr -d com.apple.quarantine step
chmod +x step
```
