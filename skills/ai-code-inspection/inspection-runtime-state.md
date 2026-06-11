status: idle
run_started_at: null
modifier: null
modifier_source: null
scope_target: null
code_selection_mode: null
current_step: null
current_phase: null
environment_profile_loaded: false
ci_cd_checked: false
database_migration_status: not_applicable

steps: []
remediation:
  pending: []
  completed: []
blocked: []
next_step_candidate: []
modified_files: []
validations: []
risks: []

notes:
  - 本文件只保存一次 ai-code-inspection 运行期间的临时状态。
  - 每次运行开始和最终报告输出后，都必须重置为本初始模板。
  - 不得在这里保存长期环境事实或业务产物内容。
  - 使用 current_phase 区分检查阶段和开发者输入继续后的修复阶段。
  - next_step_candidate 只记录当前 Step 执行中顺带发现但属于下一 Step 的候选问题，不得据此修复或推进。
