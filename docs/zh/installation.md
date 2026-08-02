# 安装

> 手上已有别的 AI agent 的话，仓库里的 [`skills/step-code-install/`](../../skills/step-code-install/SKILL.md) 是一份安装说明技能，让你的 agent 读它即可代你完成本页的步骤。

## 环境要求

- **Node.js >= 22**（`glob` 工具用到 `node:fs.globSync`，该 API 自 Node 22 起可用）
- **pnpm**（包管理）
- Windows 用户：`bash` 工具优先使用 Git Bash（推荐安装 [Git for Windows](https://git-scm.com/download/win)），未安装时依次回退 WSL、busybox-w32、PowerShell。Git Bash 装在非标准路径时，可把 `bash.exe` 绝对路径设到环境变量 `STEP_SHELL_PATH`。

## 从 GitHub Release 安装（当前推荐）

每个版本发布时会附带两个产物：**SEA 可执行文件**（单文件，无需 Node 环境）和 **npm tarball**（`.tgz`，需 Node 22+）。推荐优先用 SEA 可执行文件。

### SEA 可执行文件（推荐）

从 [Releases](https://github.com/li-xiu-qi/Step-Realtime-CLI/releases) 下载对应平台的 `step-code-<version>-<platform>.exe`，重命名为 `step.exe`，放到 PATH 里即可。

### npm tarball

```bash
# 直接安装 tarball，不依赖 npm registry
npm install -g https://github.com/li-xiu-qi/Step-Realtime-CLI/releases/download/v0.1.0/step-code-0.1.0.tgz
step --version
```

tarball 内含预编译的 `dist/`，`npm install -g <url>` 会自动解包并链接 `bin.step`。

## 从源码安装

当前分支 `step-code-explore` 仍在快速迭代，Release 不一定追平最新代码。需要最新特性时可以从源码构建：

```bash
git clone -b step-code-explore https://github.com/li-xiu-qi/Step-Realtime-CLI.git
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

## npm 全局安装（v0.1.0 起计划注册）

```bash
npm install -g step-code
step --version
```

> 当前 npm 公共 registry 尚未注册 `step-code` 包，此命令在注册完成后才可用。在此之前请使用上面的 GitHub Release 或源码安装方式。

## 升级

### Release 安装升级

直接下载新版本覆盖即可。SEA 可执行文件替换同名文件；npm tarball 重新执行安装命令会自动覆盖。

### 源码安装升级

源码安装即软链接安装，拉取最新代码后重新构建即可，无需重新 link。注意当前工作分支，推荐在 `step-code-explore` 上拉取更新：

```bash
git checkout step-code-explore    # 确认在推荐分支上
git pull
pnpm install    # 依赖有变化时
pnpm build
```

### npm 全局安装升级（v0.1.0 起计划注册）

```bash
npm update -g step-code
```

> 当前 npm 公共 registry 尚未注册 `step-code` 包，此命令在注册完成后才可用。在此之前请使用上面的 Release 或源码升级方式。

## 卸载

### SEA / tarball 卸载

```bash
npm uninstall -g step-code
```

### 源码安装卸载

```bash
cd Step-Realtime-CLI
pnpm unlink --global   # 移除全局 step 命令
```

### npm 全局安装卸载（v0.1.0 起计划注册）

```bash
npm uninstall -g step-code
```

> 当前 npm 公共 registry 尚未注册 `step-code` 包，此命令在注册完成后才可用。在此之前请使用上面的 Release 或源码卸载方式。

配置、会话记录等数据在 `~/.step-code/`，卸载命令不会动它；要彻底清理手动删除该目录。

## 常见问题

**`step` 命令找不到**：`pnpm link --global` 的目标目录不在 PATH 里。执行 `pnpm bin --global` 查看目录，把它加入 PATH。

**Windows 下 `bash` 工具报错「未找到可用的 shell 解释器」**：说明 Git Bash、WSL、busybox、PowerShell 都没探测到。装 [Git for Windows](https://git-scm.com/download/win) 最省事；已装但在非标准路径时，把 `bash.exe` 绝对路径设到环境变量 `STEP_SHELL_PATH`。

**构建报类型错误**：先 `pnpm install` 确保依赖完整，再 `pnpm build`；仍失败跑 `pnpm typecheck` 看具体位置。

**SEA 可执行文件报错找不到模块**：把 `step.exe` 同级目录下的 `step-code.data` 一起放好，两者必须同目录。
