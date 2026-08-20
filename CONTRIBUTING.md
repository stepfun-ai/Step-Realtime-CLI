# 贡献指南

欢迎为 Step Code 贡献代码、文档或反馈。

## 开发环境

- Node.js ≥ 22（`glob` 工具依赖 `node:fs.globSync`）
- pnpm

```bash
pnpm install
pnpm dev          # tsx 直接跑，交互式开发
```

构建产物默认走 `pnpm build`（tsc → `dist/`）。如需单文件分发，用 `pnpm build:bundle`（esbuild 打包）或 `pnpm build:sea`（Node SEA 单可执行文件，需先 `pnpm approve-builds` 放行 esbuild）。

## 提交 PR 前

本地跑通以下三项（CI 在 Ubuntu / Windows / macOS 三平台同样会跑）：

```bash
pnpm run typecheck
pnpm run build
pnpm run test
```

开发时可用 `pnpm test:watch` 起 watch 模式。测试用 [vitest](https://vitest.dev/)。平台相关代码（如剪贴板、Git Bash 探测）用 `vi.skipIf` / `describe.runIf` 做条件跳过，不要硬编码 `process.platform` 判断整段 skip——这样每个测试文件在三平台都能加载。

## 多个终端并行开发时

同一个工作区开多个终端（或多个 AI agent 会话）同时改代码时，注意两件事。

**一，别用工作区级 git 命令。** `git stash`、`git checkout .`、`git switch`、`git reset --hard` 作用于整个工作区，会连带处理别人正在改的文件。`git stash push <单个文件>` 也不例外——它仍可能带走其他文件的改动。提交时逐文件 `git add`，不用 `git add -A`。

**二，全量 `typecheck` 的报错可能不是你的。** 它会编译整个工作区，包括别人未提交的改动，以及你自己刚编辑到一半的文件。看到不认识的报错时：

```bash
npx vitest run tests/<目标>.test.ts        # 只跑相关测试，按需编译不受无关文件影响
npx tsc --noEmit --skipLibCheck <file>    # 确认报错是否真在那个文件
```

先确认是不是自己造成的，再判断归属。**不要为了绕开报错去改动工作区状态。**

需要长期并行的场景用 worktree：

```bash
git worktree add ../step-code-worktrees/<名字> -b wt/<名字>
```

## 调试

日志写到 `~/.step-code/logs/step-code.log`（进程内还留一份环形缓冲）。交互模式（`step`）日志只进文件，绝不污染 TUI；非交互（`-p`）与 `--reflect` 走 headless 模式。

排查问题时用 `/export-debug-zip`（TUI 内）或 `step export-debug-zip [sessionId]`（命令行）导出脱敏的调试包（会话历史、config、mcp.json、错误日志、环境清单，密钥自动 redact），附在 issue 里最省沟通。

### 界面没反应、日志也是空的

如果交互模式启动后界面不出来，而日志里什么都没有、也没有任何报错，说明故障发生在渲染引擎画出第一帧之前——此时日志与调试包都帮不上，因为程序确实「什么都没做」。

这种情况下有个不用改代码的观测办法：用 Node 的 `--import` 加载一个探针模块，在里面包裹 `process.stdout.write` 计数，并注册 module 钩子在内存里给编译产物注入标记（不落盘、不动仓库文件），就能看出执行停在哪一步、以及界面到底有没有产出字节：

```bash
node --import ./probe.mjs ./dist/main.js
```

关键判据是 **stdout 字节数**：正常启动会在两秒内写出若干帧；恒为 0 说明渲染引擎没能挂载。仓库里的 `tests/tui/firstFrameSmoke.test.ts` 就是这条判据的自动化版本，改动启动入口后请先 `pnpm build` 再跑它（未构建时它会自动跳过）。

## 文档放哪里

本仓库的 `docs/` 只放**面向用户的使用文档**——怎么装、怎么配、怎么用。

产品与技术设计稿（PRD、方案、取舍记录等）不进本仓库，包括 `docs/design/` 这类路径。它们维护在独立的产品设计仓库里，不随源码发布。

写用户文档时，描述功能就讲它本身：解决什么问题、行为边界在哪、怎么用。第三方项目的致谢集中放在 `README.md` 的致谢段并关联 `licenses/NOTICE.md`，按开源许可要求收录的 LICENSE 与 NOTICE 放 `licenses/` 下。

## PR 规范（硬性要求）

- **PR 描述必须关联一个 issue**，用 `Closes #N`、`Fixes #N` 或 `Refs #N`。这条由 `pr-lint` 工作流强制校验，不满足会失败。若确无对应 issue，仓库 owner 可加 `skip-issue-link` label 放行。
- 新功能或 bug 修复请配套加测试。
- 提交信息用简洁的祈使句，标注类型前缀（`feat` / `fix` / `docs` / `refactor` / `test` / `chore`）。
- 跨平台路径用 `node:path` 的 `win32` / `posix` 命名空间显式拼接，禁止用默认 `join` 处理 Windows 路径（默认 `join` 在 POSIX 上会把反斜杠当普通字符，导致 mock `process.platform='win32'` 的测试失败）；平台判断避免硬编码。
- 不要提交构建产物（`dist/`）或密钥（`.env`）。

## 报告问题

用仓库的 issue 模板（bug / feature / docs / chore / question）。安全漏洞请走 [SECURITY.md](./SECURITY.md) 的私密披露渠道，不要开公开 issue。

## 架构与约定

开发前请先读 [`AGENTS.md`](./AGENTS.md)，其中包含多协议模型接入、分层结构与协作规范。
