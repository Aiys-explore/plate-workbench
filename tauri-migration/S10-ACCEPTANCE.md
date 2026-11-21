# S10 阶段验收与路线比对

计划基线为 [S10 开发执行计划](plans/s10_workbench_harness_plan.md)。源码起点为 S9.6 的 `d6eccf45e468a7ba5cdba7d29e77ff9a238c5407`。以下记录按计划里的 M1 至 M4 顺序累积。

## M1 · 壳层与 BYOK 基础 · 2026-11-22

源码提交 `eddc11da42fc5ad537e7cfdf80bd843fa219b3ff`，发布到 GitHub 的 `checkpoint/tauri-s10` 分支。

| 计划条目 | 实际与验收 |
| --- | --- |
| §3.1–3.3、§3.8 · 迁移及服务商命令 | SQLite 幂等建表，四个 `provider_*` 命令已接通。Windows 凭据管理器保存完整 Key，SQLite 和 IPC 响应保存脱敏尾号。使用合成服务商验证新增、编辑、重启、请求认证和删除。 |
| §4.1–4.4、§5 M1 · 壳层及设置 | 五个导航入口就绪。工作台为默认视图，关系图复用同一个 NotesWorkspace，点击「大脑视图」或「资料与记录」切换原有大脑面板。Windows WebView 内已验证两处导航和设置重启回读。 |
| 与计划的实现差异 | 沿用锁文件已有的 reqwest 0.13 和 dirs 7，避免并存两个版本。keyring 3 明确启用 Windows 原生后端。大脑在现有关系图中以 hook 和组件组合实现，壳层直接控制该模式。FTS5 使用 SQLite 内置默认 tokenizer。 |
| 待验范围 | 模型连接在回环服务验收，未发送第三方模型请求。签名安装器、macOS、其他平台系统钥匙串未在本阶段验收。模型角色的运行时调用、日志和技能组件按后续里程碑验证。 |

- `cargo check --locked --manifest-path src-tauri/Cargo.toml` 通过。保留既有草稿字段警告及 `similar` 的阶段性未使用警告。
- `cargo test --locked --manifest-path src-tauri/Cargo.toml` 通过，8 项。
- `npm run build` 通过，含 `npm run typecheck`。Vite 报告打包体积警告。
- `node checks/s10-m1-windows.mjs` 在 Windows WebView2 通过，渲染器无控制台错误。验收使用隔离笔记库和合成凭据，关闭阶段有宿主 WebView2 的 Chrome 窗口注销日志。

## M2 · 本机 Agent 记录采集 · 2026-11-22

源码提交 `f81415e154c45f13e511a9ceae07be74a5d8c6a0`，发布到 GitHub 的 `checkpoint/tauri-s10` 分支。

| 计划条目 | 实际与验收 |
| --- | --- |
| §3.4 · 日志采集和检索 | 根据字节游标增量读取 Claude Code、Codex CLI 和自定义 JSONL。保留尾部未写完的记录，截断或文件样本变化时重建该会话索引。同一事务更新会话、消息和 FTS5。中英文关键词在合成记录上验证。 |
| §3.8、§4.4 · 本机记录和海马体 | 五个 `agent_logs_*` 命令及资料页已接通。手动扫描、搜索、消息时间线、引用到工作台均已在 Windows WebView2 验证。将摘要送入指定分区后，可在 EpisodicLane 看到 `agent_trace` 闪念。 |
| 与计划的实现差异 | 摘要使用本地首条用户消息和最近回复生成，全文留在本机索引。按实际字节游标和文件样本识别追加与轮转；内置默认扫描范围为 Claude Code 与 Codex CLI。Gemini 原生会话 JSON 不属于 M2 的 JSONL 验收范围。[Gemini CLI 会话文档](https://geminicli.com/docs/cli/session-management/) |
| 待验范围 | 测试使用合成 JSONL 和隔离工作区。真实历史目录规模、非 JSONL 格式和超长单行没有现场验证。 |

- `cargo check --locked --manifest-path src-tauri/Cargo.toml` 通过。
- `cargo test --locked --manifest-path src-tauri/Cargo.toml` 通过，11 项。
- `npm run build` 通过，含 TypeScript 检查。
- `node checks/s10-m2-windows.mjs` 通过，含重复扫描零新增、增量追加、中文检索、海马体可见性和工作台引用，无渲染器控制台错误。
