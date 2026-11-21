# S10 阶段验收与路线比对

计划基线为 [S10 开发执行计划](plans/s10_workbench_harness_plan.md) 及 [视觉修订版](plans/s10_workbench_harness_plan_1.md)。源码起点为 S9.6 的 `d6eccf45e468a7ba5cdba7d29e77ff9a238c5407`。以下记录按计划里的 M1 至 M4 顺序累积。

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

## M3 · 统一 Harness 与双引擎 · 2026-11-22

源码提交 `0a70b73df9188125a4467e52862ff9b78b484892`，发布到 GitHub 的 `checkpoint/tauri-s10` 分支。

| 计划条目 | 实际与验收 |
| --- | --- |
| §3.5–3.6 · 权限与暂存 | 路径授权基于规范路径并拒绝上级跳转、数据流、设备名和笔记库的通用文件写入。工具生成 SQLite 暂存 Diff，审阅时核对原文。合成任务验证越权读取被拒、审阅前原文件未变、外部修改后应用被拒。 |
| §3.7 · API 执行 | OpenAI 与兼容接口、Anthropic 和 Gemini 接入 SSE，工具调用只开放任务限定的读取、检索与提议。Windows 回环模型服务验证分片工具参数、逐步输出、计费字段及 SQLite 状态流转。Anthropic 输入分片与 Gemini 函数签名往返由单元测试覆盖。 |
| §3.7、§4.4 · 本机 CLI 与工作台 | 复用 Agent 路由、标准输入输出、任务进程监督和 Windows JobObject。新增按任务创建的低权限 AppContainer。Windows 合成独立 EXE 验证逐步输出、进程隔离、越权读取与直接写入失败、子进程被禁用，以及审阅后外部文件写入。三栏工作台已接通历史、对话、工具状态和暂存审阅。 [Microsoft AppContainer 实现文档](https://learn.microsoft.com/en-us/windows/win32/secauthz/implementing-an-appcontainer) |
| 与计划的实现差异 | CLI 使用临时隔离档案和明确的文本提议协议，继承现有插件路由与进程监督。隔离执行只支持独立 Windows EXE，已有用户目录里的 CLI 登录与任意脚本启动器无法自动继承到隔离环境。使用授权文件目录的 API 真正写入仍由用户审阅触发。 |
| 待验范围 | 使用合成 CLI 与回环模型验收，第三方模型实际账户计费、真实 CLI 登录配置及兼容性未验。预算按配置单价与服务返回用量估算，缺用量时保守估算。笔记应用和技能回流由 M4 验收。 |

- `cargo check --locked --manifest-path src-tauri/Cargo.toml` 通过。
- `cargo test --locked --manifest-path src-tauri/Cargo.toml` 通过，15 项。
- `npm run build` 通过，含 TypeScript 检查。
- `node checks/s10-m3-windows.mjs` 通过，覆盖 API 和原生隔离 CLI、权限、待审阅状态、审阅写入和原文变更冲突。

## M4 · 大脑闭环、技能面板与视觉修订 · 2026-11-22

源码提交 `021fc6460278e3802371685d8f596f9c7e9846b8`，发布到 GitHub 的 `checkpoint/tauri-s10` 分支。修订版追加的视觉规范在本阶段落地，并重新验收 M1–M3 的入口。

| 计划条目 | 实际与验收 |
| --- | --- |
| 原计划 §3.7、§5 M4 · 上下文与活力 | 引用的本机记录经权限检查后加入模型上下文。工作台显示 BrainActivationWave 激活的授权笔记，未授权笔记的内容及标识不出现在该任务的激活结果。已验证流式响应期间可见激活记录。 |
| 原计划 §3.6、§5 M4 · 笔记审阅与记忆回流 | 合成笔记在审阅前未写入。应用后依次核对磁盘正文、活力重算、认知年轮、海马体任务回流和技能的调用与采纳次数。笔记应用复用原有保存版本和草稿检查。 |
| 原计划 §4.4、§5 M4 · 做梦整理与技能 | 做梦整理可将选中的同分区闪念发给指定角色的模型，显示可编辑的建议标题与正文，再经确认固化。验收覆盖了 SKILL.md 导入、保存、试用及能力授权与任务权限求交。 |
| 修订版 §5.1–5.5 · 图标与布局 | Lucide React 1.77.0 经统一图标出口及 IconAction 提供控件。Windows 实测 52px 纯图标导航、40px 顶栏、五个导航项、命令面板与键盘导航。大脑 HUD 右下角实测三个图标动作。图谱的数据图形和插件标识继续使用原有资源。[Lucide React](https://lucide.dev/guide/react) |
| 修订版 §5.3、§5.6 · 输入、列表与 Diff | 输入岛四个图标触发器和一个发送动作，附带引用胶囊。任务、记录和技能列表的操作按行悬停或键盘聚焦显现。右侧 Diff 默认折叠，有待审阅徽标，打开后可见差异及接受、驳回图标。设置页保存本机扫描来源与默认任务上限。 |
| 实现差异与待验范围 | 沿用 Plate 的浅色和深色主题变量。保持 Windows 快捷键和原关系图内的大脑能力。验收使用 Windows WebView2、回环模型和合成 CLI。真实第三方模型、已登录的厂商 CLI、签名安装与干净 Windows 仍待验。 |

- `cargo check --locked --manifest-path src-tauri/Cargo.toml` 通过。
- `cargo test --locked --manifest-path src-tauri/Cargo.toml` 通过，15 项。
- `npm run build` 通过，含 `npm run typecheck`，Vite 保留包体积警告。
- `checks/s10-m1-windows.mjs` 至 `checks/s10-m4-windows.mjs` 四套 Windows WebView2 Playwright 冒烟通过。渲染器无控制台错误。部分退出有 WebView2 宿主窗口注销诊断。
- 合成验收截图 [复合输入岛](evidence/s10-m4/composer.png) · [暂存审阅](evidence/s10-m4/workbench-review.png) · [大脑 HUD](evidence/s10-m4/brain-hud.png)。
