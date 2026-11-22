# Plate Workbench S11 验收 · 2026-11-22

S11（0.7.0-s11）通过 M1–M4 验收。GitHub 分支 `checkpoint/tauri-s11` 的源码已通过 `git ls-remote` 核对为 `af2e7ae7d13e85a5a0fbdedbb44508974c7c4fd3`。[S11 源码提交](https://github.com/fundops-notes/plate-workbench/commit/af2e7ae7d13e85a5a0fbdedbb44508974c7c4fd3)

| 阶段 | S11 计划条目 | 验收结果 | 源码提交 |
| --- | --- | --- | --- |
| M1 | §2.1–2.2、§3.1、§4 大脑视图 | S10 样本重复迁移后保留原记录，历史笔记、闪念和技能归入学习。PPR 排除个人笔记。Windows 正常入口完成工作脑区闪念捕获、行内编辑和升格，导出的任务上下文及全笔记检索都排除了个人测试笔记。工作脑区巡检列出休眠或超过 90 天未更新的笔记，可带着笔记发起更新提案。 | `e2eba5b588b4b4e0e7fdf222e76f4581ddad9c4a` |
| M2 | §3.2、§3.5、§4 工作台与 Profiles | 预览和正式运行共用四层 Prompt，读取获授权目录中的规则文件。Profile 在工作台应用 4 步和 0.20 美元样本预算。脑区与模型菜单锚定输入岛，展开时输入岛位置和尺寸保持稳定。文件、笔记及做梦整理均先形成影子差异，经审批才写盘。 | `a31ac43d39d707c85abc54c10de52de9043b705f` |
| M3 | §3.4–3.5、§4 技能详情 | 三条样本使用字数、关键词和合成 AI 裁判，同批比较测试与生产版本。样本结果为 v2 通过 3/3，v1 通过 0/3，实测最大并发为 3。UI 发布 v2 后工作台默认装配 v2，Rust 测试覆盖退役版本回滚与单一生产版本约束。 | `0eec375eae4a1a2d5db7d2b2f24aa90b93d8e04b` |
| M4 | §3.3、§3.5、§4 Hooks 与轨迹 | 实测未信任和文件改动后的脚本均跳过。用户点击信任后，PreToolUse 拒绝理由随工具结果交给下一轮模型。回环 MCP 验证初始化、调用、会话关闭、提交改写和 Stop 续跑，覆盖五个生命周期事件。SessionEnd 在工作脑区生成可编辑候选，关闭内置 Hook 后不生成。Spilling 单测核对大输出完整落盘、分段读取和任务结束清理。 | `af2e7ae7d13e85a5a0fbdedbb44508974c7c4fd3` |

## 实施口径

- 历史技能随其他历史资料归入学习，新技能默认工作。个人脑区禁止跨区挂载和文件导出。新笔记在写文件前保留脑区归属，索引重扫沿用该归属。
- 命令类 Hook 采用 Rhai 受限脚本运行时，支持内联脚本和 `file:` 引用的 `.rhai` 文件。脚本读取 `hook` 事件对象并返回决策，例如 `#{ allow: false, reason: "需要人工复核" }`。脚本有执行限额，运行时无文件、网络和系统命令接口。Windows 系统解释器在 AppContainer 中启动失败，因此采用嵌入运行时保留影子写入边界。[Rhai 执行限额](https://rhai.rs/book/safety/index.html)
- `mcp_tool` 使用 Streamable HTTP，设置项填服务地址和工具名，格式为 `https://host.example/mcp#tool_name`。本地回环验收使用 HTTP，MCP 请求受任务联网权限和脑区导出权限约束。[MCP 传输规范](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- 沿用 S10.1 的无框输入岛、图标按钮、圆角层级与悬浮锚点。右侧抽屉增加影子审阅、运行轨迹和候选记忆，文件与笔记继续使用原有的暂存批准入口。S12 的本体与调度器未纳入本次开发。[S10 原计划](plans/s10_workbench_harness_plan.md) · [S10 视觉修订版](plans/s10_workbench_harness_plan_1.md)

## 复验与范围

在 `tauri-migration/source` 执行以下命令。

```text
npm ci
cargo check --locked --manifest-path src-tauri/Cargo.toml
cargo test --locked --manifest-path src-tauri/Cargo.toml
npm run typecheck
npm run build
cargo build --locked --manifest-path src-tauri/Cargo.toml
node checks/s11-windows.mjs
```

M1、M2、M3 阶段分别通过 17、18、20 项 Rust 测试及前端构建。S11 最终通过 **23 项 Rust 测试**、TypeScript 检查、前端构建与 [Windows WebView2 集成验收](source/checks/s11-windows.mjs)。集成验收使用隔离工作区、合成笔记、回环模型和回环 MCP，渲染器报错数为 0。构建仍有既有 Rust 未使用字段和 Vite chunk 大小警告。

真实笔记库的原地升级、生产模型的返回与计费差异、第三方 MCP 服务、发布安装包与自动更新均未验证。S10.1 远端分支复核仍为 `b2f0f874290ff7edc6fc5101182f28642ad1a327`。

验收后清理了本次新增的 Rust 构建目录、前端依赖、前端构建输出与隔离样本。C 盘可用空间较清理前增加约 7.0 GiB。
