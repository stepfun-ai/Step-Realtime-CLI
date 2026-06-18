# Branch protection 配置（owner 手动）

仓库 Settings → Branches → Add rule，对 `main` 分支应用：

- [x] Require a pull request before merging
- [x] Require approvals: 1
- [x] Dismiss stale pull request approvals when new commits are pushed
- [x] Require status checks to pass before merging
- [x] Require branches to be up to date before merging

## 必需 status check 名称（关键）

> GitHub Settings 的 required check 列表展示的是 **job id**（含 matrix 时是 `<job-id> (<matrix-value>)`），**不是** workflow name。
> 例如 `test.yml` 的 `jobs.test` + matrix `os` 会在 Settings 中呈现为三项 `test (ubuntu-latest)` / `test (windows-latest)` / `test (macos-latest)`。
> 同理 `pr-lint.yml` 中 `jobs.link-check` 在 Settings 中呈现为 `link-check`，**不是** `pr-lint`。

本仓库必需 check 名单：

- `test (ubuntu-latest)` （来自 `test.yml`；含覆盖率与阈值守门）
- `test (windows-latest)` （来自 `test.yml`）
- `test (macos-latest)` （来自 `test.yml`）
- `link-check` （来自 `pr-lint.yml`；强制 PR 关联 issue）

> 注意：覆盖率已内嵌在 `test (ubuntu-latest)` 中，**不**单独存在 `coverage` job，因此 required check 列表中不应出现 `coverage`。

- [x] Require conversation resolution before merging
- [x] Do not allow bypassing the above settings
- [ ] Allow force pushes（关闭）
- [ ] Allow deletions（关闭）
