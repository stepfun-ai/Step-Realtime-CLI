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

## 调试

日志写到 `~/.step-code/logs/step-code.log`（进程内还留一份环形缓冲）。交互模式（`step`）日志只进文件，绝不污染 TUI；非交互（`-p`）与 `--reflect` 走 headless 模式。

排查问题时用 `/export-debug-zip`（TUI 内）或 `step export-debug-zip [sessionId]`（命令行）导出脱敏的调试包（会话历史、config、mcp.json、错误日志、环境清单，密钥自动 redact），附在 issue 里最省沟通。

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
