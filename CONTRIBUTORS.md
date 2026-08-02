# 贡献者

本文件记录 `step-code-explore` 从零重构分支的主要贡献者及其贡献方向。项目处于探索期，本文件随重要贡献持续更新。

## 当前贡献者

| 贡献者 | GitHub | 主要贡献 |
|--------|--------|----------|
| **li-xiu-qi** | [@li-xiu-qi](https://github.com/li-xiu-qi) | 项目作者与维护者。`step-code-explore` 从零重构的发起与推进，agent 主循环、provider 边界层、子 agent 跨渠道模型解析、TUI 交互、文档体系与发布准备。 |
| **Peron** | [@PeronGH](https://github.com/PeronGH) | 无痕思考修复（PR #1）。识别出模型只回思考签名、不回正文时 UI 零信号、与卡死无法区分的问题，实现 `thinking_start` / `thinking_end` 边界事件与状态行「思考中…」显示，并把忙碌态随机状态词改为中性词。 |
| **ZouR-Ma** | [@ZouR-Ma](https://github.com/ZouR-Ma) | `step-code-explore` 分支探索的支持与指导。在上游 stepfun-ai/Step-Realtime-CLI 开辟 `step-code-explore` 空分支供从零重构使用，为新架构探索提供了独立的演进空间。 |

## 说明

- 本文件按**贡献方向**记录，不逐条罗列 commit；commit 级的作者归属以 git 历史为准。
- 合并外部 PR 时，若因目标分支结构调整需要改写提交（如 cherry-pick），会在 commit message 中以 `Co-authored-by` 保留原作者身份，并在本文件登记其贡献。
- 想成为贡献者：见 [CONTRIBUTING.md](./CONTRIBUTING.md)。
