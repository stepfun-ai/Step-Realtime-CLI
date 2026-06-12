# Step 5: 文档一致性

本 Step 检查代码变化是否需要同步文档。

## 通用检查

- 文档应匹配真实 package script、路径、构建命令和环境要求。
- 本 Skill 不新增业务规划内容。
- 不得把每次运行的检查记录写入稳定环境文档。
- 只实现了部分行为或未完成 runtime 验证时，不要把文档写成"已完整完成"。
- 面向使用者的 setup 指令应使用 manifest 中真实存在的路径和 package script。

## 需要更新文档的情况

- 新增或修改的脚本命令（package.json scripts）。
- 新增或修改的环境变量或配置项。
- 新增或修改的 CLI 命令、option、flag。
- 新增或修改的 path alias（tsconfig.json paths）。
- 新增或修改的 extension/skill 及其使用方式。
- 架构分层或依赖规则变化。
- 构建/打包流程变化。

## README 检查

> 本项目**暂不接收**对 `README.md`、`README_CN.md` 的修改。

- 如果变更范围内包含 `README.md` 或 `README_CN.md` 的修改，报告为不符合 `AGENTS.md` 当前规则。
- 不自动回退开发者改动；只有开发者明确要求修复时，才在声明范围内处理。
- 其他文档（`docs/` 下的技术文档、配置文档注释等）按正常文档一致性规则检查。

## .gitignore 检查

> 本项目**暂不接收**对 `.gitignore` 的修改。

- 如果变更范围内包含 `.gitignore` 的修改，报告为不符合 `AGENTS.md` 当前规则。
- 不自动回退开发者改动；只有开发者明确要求修复时，才在声明范围内处理。

## 变更日志

- 如项目使用 CHANGELOG 或类似机制，重大变更应记录。
- 本 Skill 不负责编写变更日志，但应提醒开发者是否需要更新。

## 配置文档

- `.oxlintrc.json`、`knip.config.ts`、`.dependency-cruiser.cjs`、`tsconfig.json` 的变更应记录原因。
- 稳定项目事实以 `AGENTS.md`、`package.json`、`tsconfig.json`、`.dependency-cruiser.cjs` 和相关 docs 为准；不要把每次检查记录写入稳定文档。
