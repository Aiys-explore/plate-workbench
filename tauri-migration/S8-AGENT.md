# Plate S8-Agent · 0.4.0-s8.1

在工作台右上角打开「Agent 设置」。这里可以探测本机 CLI、安装或移除 Plate 插件、开启接入、调整优先级，以及选择执行模型。未指定 Agent 的 TODO 使用排序最靠前、已开启且就绪的插件。停用或移除后，编辑器隐藏对应选项，Rust 执行入口拒绝新的分派。

DeepSeek Harness 的 API Key 与可选 Base URL 在插件详情配置。Windows 使用 DPAPI 保护保存的密钥。可通过原生文件选择器指定 CLI，也可以导入本机 JSON 命令模板。自定义插件导入后默认停用。

内置执行适配器覆盖 Codex、Claude Code、DeepSeek Harness 和 OpenCode。其他目录项可以显示本机探测结果，需要兼容连接器才能分派。模型选择支持沿用 CLI 配置、本机模型记录、预设及自定义标识。

## 验收记录

Windows 候选通过 TypeScript 检查、Rust 5 项测试、生产构建和 NSIS 打包。使用独立工作区、设置目录和合成 CLI 的 8 组专项验收通过。

| 项目 | 实测结果 |
| --- | --- |
| AC-M1 插件中心 | 显示 CLI 版本、本机模型缓存、安装和接入状态。用合成的关联 App 检查 Windows 版本资源读取。 |
| AC-M2 停用隔离 | 停用 Claude 后，TODO 联想及指派列表隐藏该选项。手写指派保留原文，后台拦截且未创建运行记录。 |
| AC-M3 重装 | 在面板卸载再安装 Claude 后，重新探测版本并进入可用列表。 |
| AC-M4 优先级与模型 | 拖拽后，无指定 Agent 的 TODO 交给 Codex。子进程收到 `exec --skip-git-repo-check -m gpt-6.2-sol -`，标准输入与任务内容一致。 |
| DeepSeek 与自定义插件 | 合成 DeepSeek 收到 Base URL 和密钥，合成密钥未明文保存且在日志中被遮蔽。自定义插件在显式开启后经 stdin 接收任务。 |
| 收折与管理 | 七个已安装条目可展开和批量选择，需要连接器的目录项未进入可用列表。 |
| 视觉 | 核对浅色、深色及 620 px 窄窗截图。窄窗弹窗宽 587 px，未发生横向溢出。 |
| 重启 | 排序、模型及凭据状态保留。重启前后均为三条合成执行记录。 |

真实账号执行、原生文件选择器操作和干净 Windows 安装待现场核验。

## Windows 复跑

从 `tauri-migration/source` 执行，需有 Tauri v2 的 Windows 构建环境及 WebView2。脚本生成合成 CLI 和独立测试工作区。

```powershell
npm ci
cargo test --manifest-path src-tauri/Cargo.toml
npm run tauri build -- --bundles nsis
$evidence = Join-Path $env:TEMP ('plate-s8-agent-evidence-' + (Get-Date -Format 'yyyyMMdd-HHmmss'))
node ../evidence/s8-agent-e2e.mjs ./src-tauri/target/release/plate-workbench.exe $evidence
```
