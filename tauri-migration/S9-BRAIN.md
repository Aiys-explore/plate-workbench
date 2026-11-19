# Plate 0.5.0-s9.1 大脑工作台

首次打开会建议使用 Plate-Tauri-S9-试用笔记。可手动选择已有工作区。打开关系图右上角的「大脑」。按 Ctrl+Shift+Space 呼出闪念输入，按 Enter 保存，按 Shift+Enter 换行。闪念保存在当前导图分区，选择「固化」可新建 Markdown 笔记或追加到本分区现有笔记。「做梦整理」按显著度和记录时间列出候选，可一次选取同一分区的多条闪念。

勾选「任务使用大脑上下文」后，交办和追问会将当前笔记、同项目两跳图谱内排名最高的五条关联笔记、最近三条闪念以及最多两项匹配技能交给选定的 Agent。开关保存在工作区 SQLite，首次打开默认关闭。开启后的任务在画布上短暂点亮已激活的笔记及连线。技能可在底栏新增，也可从采纳后的任务回执沉淀。

任务回执可附带结构化记忆提案。先在「待审阅」预览，采纳回执后再点「记忆提案」并确认应用。修改事实时会写入原断言的截止时间和继任断言。笔记的「认知年轮」显示当前事实、历史断言和修订前片段。SQLite 记录已批准的 Markdown 写入，重启时可继续落盘。目标笔记存在草稿时，先保存或丢弃草稿，再用「做梦整理」重试待写入项。

「活力热力」根据访问次数、关系度数和时间衰减显示卡片。休眠点在悬停或键盘聚焦时展开。由 S8 迁移的笔记初始为语义记忆，活力值为 1；用户打开、保存或任务唤醒后进入衰减计算。

## S8 评审改动

- 顶栏展示已启用且就绪的插件数。未指定 Agent 的 TODO 由 Rust 按当前优先级选路，显式指派及追问使用同一就绪检查。
- OpenCode 使用 stdin 接收任务正文，支持 Windows 原生可执行文件和 npm 的 .cmd 或 .bat 包装器。适配器在写入后关闭 stdin。
- DeepSeek 凭据使用独立保存操作。原有只包含凭据的插件更新调用继续可用。
- 自定义清单可用单个独立的 {model} 占位参数定位模型选项。省略占位参数时，模型选项放在 -- 之前，没有 -- 时追加到末尾。

## Windows 复跑

从本目录的 source 子目录执行。使用 Node.js 24、Rust MSVC 工具链和 WebView2。NSIS 打包需要 Tauri 的 NSIS 工具缓存或可访问其下载地址。验收脚本使用本机回环端口、合成 CLI 和独立工作区。

```powershell
npm ci
npm run build
cargo test --locked --manifest-path src-tauri/Cargo.toml
npm run tauri build -- --bundles nsis
node ../evidence/s8-agent-e2e.mjs ./src-tauri/target/release/plate-workbench.exe
node ../evidence/s9-brain-e2e.mjs ./src-tauri/target/release/plate-workbench.exe
```
