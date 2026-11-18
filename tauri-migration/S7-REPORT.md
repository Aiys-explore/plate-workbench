# Plate S7 修复与验收

基线为 GitHub `checkpoint/tauri-s6` 的 `12e62fb`。实现和试用包位于独立的 S7 候选目录，版本为 `0.3.0-s7.0`。

| 阶段 | 实现与已核实结果 |
| --- | --- |
| S7-1 | Windows Job Object 在 Agent 执行前接管进程树。合成 Windows 进程验证停止、超时和正常退出均清理受管子进程，另一进程继续运行。三个适配器通过 `.cmd` 逐字节收取多行中文、换行及特殊符号。本机发现 DeepSeek Harness、Codex、Claude Code。采纳时使用标准输出，诊断保留在运行日志。 |
| S7-2 | 编辑器和侧栏共用移除确认与版本检查，新建项目之后能看到该分区笔记。移除会话、插件和导出等未迁移的界面入口。补上系统目录选择和 HTTP/HTTPS 外链。隔离验收确认两个移除入口、取消、空查询的分区过滤、Agent 发现及非允许协议的拦截。 |
| S7-3 | 未保存笔记先保全草稿并按基准修订写入，再分派。外部改写阻断分派并保留草稿。已有 Agent 运行日志更新时，追问输入框保持同一个 DOM 节点、焦点和选区。验收覆盖缩进内容、代码围栏、完整多行追问、采纳 54 行结果、采纳后再次保存，以及停止后保留原 Agent。 |
| S7-4 | 派生和端口连接使用 UUID 引用。按 Tab 连续派生六层，六个新节点的横坐标为 546、774、1002、1230、1434、1638。父笔记保留对子笔记的引用，子笔记改名后关系与跳转目标仍正确，重启后坐标一致。 |
| S7-5 | 从候选源码移除 Electron 主进程、预加载及误放的 Cargo 配置。TS 类型检查、Vite 构建和 Windows Rust 进程测试通过。 |

第一次打包验收发现，选择分区后搜索框为空会导致后端误返回零笔记。修正后，空查询返回符合分区和标签条件的笔记，两个删除入口均通过复验。

进程测试可在候选 `source/` 运行 `cargo test --manifest-path src-tauri/Cargo.toml agent_runner::tests`。整包测试脚本为 `evidence/s7-e2e.mjs`，默认运行候选 Release EXE，每次创建独立笔记工作区及 WebView2 数据目录。

最终 Release EXE 的隔离端到端验收 7 项通过，复跑进程退出码为 0。证据见 [result.json](evidence/run-BYJvPs/result.json) 和 [重启后的六层关系图](evidence/run-BYJvPs/s7-graph.png)。

| 试用产物 | 字节 | SHA-256 |
| --- | ---: | --- |
| `plate-workbench.exe` | 12,157,440 | `E2200F0FC37B19DA41725627741669768558D8D5BE1766A4223F32C5A90461DF` |
| `Plate Workbench S7 Preview_0.3.0-s7.0_x64-setup.exe` | 3,737,668 | `E134EA0F1133282737EE7730D208CB8696770919E8A33502E4EA6B947C374A29` |

已验证 Agent 安装发现。分派验收使用合成 Agent，真实账号执行、安装器实装，以及原生目录对话框选择/取消和允许链接在系统浏览器中的打开仍待现场核验。

实现依据：[Windows Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)、[Claude Code 非交互模式](https://code.claude.com/docs/en/headless)、[DeepSeek Harness headless 标准输入](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/bundle/headless/README.md)、[Tauri 目录对话框](https://v2.tauri.app/plugin/dialog/)与[外链打开](https://v2.tauri.app/plugin/opener/)。
