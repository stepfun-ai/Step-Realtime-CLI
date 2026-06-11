# Step 4: 测试覆盖

本 Step 检查变更行为是否具备足够的自动化覆盖。鉴于项目当前处于早期阶段（vitest 已配置但尚无测试文件），本 Step 以风险记录为主，不强制要求已有测试。

## 重要说明

当前项目已配置 vitest 但无测试文件。以下规则面向项目已有测试基础设施后的日常检查；当前阶段重点在于：确保变更不破坏现有构建和类型系统。

## 测试发现

先读取 `../project-environment-profile.md`，确认测试配置，再检查变更影响。

## 通用覆盖检查

- 项目已配置 vitest；当新增测试时，使用 vitest 而非引入新 runner。
- 新行为应在相邻单元测试中覆盖成功路径和关键失败路径。
- error handling 变化应覆盖失败路径。
- async 逻辑变化应覆盖 loading、success 和 failure 状态。
- test mock 应贴近生产 interface/type。
- 新增导出符号时，应考虑是否需要配套测试。

## UI (React) 覆盖检查

当 ui/ 文件在范围内时执行：

- 新增或修改的 React component 应有组件级测试。
- 自定义 Hook 应有独立测试。
- API wrapper 变化应测试 response unwrap、异常 payload、error normalization。

## TUI (OpenTUI) 覆盖检查

当 src/tui/ 文件在范围内时执行：

- 新增或修改的 TUI component 应测试渲染输出和交互。
- composable/store 变化应有对应测试。

## Gateway 覆盖检查

当 src/gateway/ 文件在范围内时执行：

- service 变化应测试业务编排逻辑。
- controller/handler 变化应测试 route 解析、参数校验和响应 shape。
- repository/provider 变化应测试 data mapping 和错误处理。
- session/memory/storage 变化应测试生命周期和边界条件。

## Extension 覆盖检查

当 extensions/* 文件在范围内时执行：

- 新增或修改的 extension 应测试 adapter 边界行为。
- 动态加载逻辑（如 optional VAD plugin）应测试 fallback 路径。
- 使用 fake client 测试外部 IO 边界。

## 验证命令

- 如果存在测试脚本，运行 `pnpm test`。
- 如果测试文件新增或修改，确保测试通过。
- TypeScript 类型检查 (`pnpm exec tsc --noEmit`) 不能替代测试，但类型通过是测试的基础前提。

## 风险记录

由于项目当前无测试文件：
- 标记 `test_coverage_risk: no_test_infrastructure`
- 建议在适当时机建立基础测试骨架（至少覆盖 core 层和 gateway 层的关键路径）。
