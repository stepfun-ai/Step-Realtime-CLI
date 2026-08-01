# 安装

> 手上已有别的 AI agent 的话，仓库里的 [`skills/step-code-install/`](../../skills/step-code-install/SKILL.md) 是一份安装说明技能，让你的 agent 读它即可代你完成本页的步骤。

## 环境要求

- **Node.js >= 22**（`glob` 工具用到 `node:fs.globSync`，该 API 自 Node 22 起可用）
- **pnpm**（包管理）
- Windows 用户：`bash` 工具优先使用 Git Bash（推荐安装 [Git for Windows](https://git-scm.com/download/win)），未安装时依次回退 WSL、busybox-w32、PowerShell。Git Bash 装在非标准路径时，可把 `bash.exe` 绝对路径设到环境变量 `STEP_SHELL_PATH`。

## 从源码安装

目前推荐直接 clone `step-code-explore` 分支，它包含 step-code 最新功能迭代；`main` 分支保留稳定快照。

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

## 升级

源码安装即软链接安装，拉取最新代码后重新构建即可，无需重新 link。注意当前工作分支，推荐在 `step-code-explore` 上拉取更新：

```bash
git checkout step-code-explore    # 确认在推荐分支上
git pull
pnpm install    # 依赖有变化时
pnpm build
```

## 卸载

```bash
pnpm unlink --global   # 移除全局 step 命令
```

配置、会话记录等数据在 `~/.step-code/`，卸载命令不会动它；要彻底清理手动删除该目录。

## 常见问题

**`step` 命令找不到**：`pnpm link --global` 的目标目录不在 PATH 里。执行 `pnpm bin --global` 查看目录，把它加入 PATH。

**Windows 下 `bash` 工具报错「未找到可用的 shell 解释器」**：说明 Git Bash、WSL、busybox、PowerShell 都没探测到。装 [Git for Windows](https://git-scm.com/download/win) 最省事；已装但在非标准路径时，把 `bash.exe` 绝对路径设到环境变量 `STEP_SHELL_PATH`。

**构建报类型错误**：先 `pnpm install` 确保依赖完整，再 `pnpm build`；仍失败跑 `pnpm typecheck` 看具体位置。
