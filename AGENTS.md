# 验收与 GitHub 同步

- 每完成并验收一个开发步骤，将该步骤的源码和验收记录提交并推送到项目对应的 GitHub 分支。核对远端提交 SHA，并在验收记录里写明该 SHA、验收范围、结果和未验证项。
- 本地保留一份正在使用的开发工作树。每次验收只留报告、结果记录及必要的日志和截图。源码副本、虚拟机镜像、依赖、缓存和临时打包产物在验收结束后清理。
- 清理历史源码前，先核对远端提交确实覆盖该版本。存在未同步改动时，先保留唯一工作副本。推送前检查暂存内容，排除真实笔记、用户数据、凭据和本机配置。
- 从 GitHub 提交恢复源码。临时安装包如需交付，放在对应版本的发布位置，并在验收记录中写明链接。

# S10 计划比对

- 每次开发步骤完成后，对照 [S10 开发执行计划](tauri-migration/plans/s10_workbench_harness_plan.md) 与 [视觉修订版](tauri-migration/plans/s10_workbench_harness_plan_1.md) 核查实际范围、交互、数据及权限约束。在该阶段验收记录中标注计划条目、实际表现、偏差及原因、待验项。
- S10 按 M1 → M2 → M3 → M4 推进。每阶段在 `tauri-migration/source` 执行 `cargo check --manifest-path src-tauri/Cargo.toml`、`cargo test --manifest-path src-tauri/Cargo.toml`、`npm run build`，通过后核对计划该阶段的验收条件、记录 GitHub 源码提交，再推进下一阶段。`npm run build` 已包含 `npm run typecheck`。
