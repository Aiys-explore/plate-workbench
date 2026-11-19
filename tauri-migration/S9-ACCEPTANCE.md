# Plate 0.5.0-s9.1 Windows 验收

2026-11-19 在现有 Windows x64 主机完成 S9.1 现场验收，使用独立应用配置和合成笔记。

| 验收项目 | 结果 | 记录 |
| --- | --- | --- |
| Codex CLI 0.170.0 | 真实账号从关联笔记推导出正确结果，15.44 秒进入待审阅。采纳后 Markdown 成功落盘，SQLite 状态为 `DONE`。 | [Agent 结果](evidence/field-s9.1-agents/results.json) |
| Claude Code 2.1.327 | 真实账号完成同一任务，11.34 秒进入待审阅。采纳后 Markdown 成功落盘，SQLite 状态为 `DONE`。 | [Agent 结果](evidence/field-s9.1-agents/results.json) |
| DeepSeek Harness 0.2.2-rc.3 | 已探测到 CLI。配置缺少 API Key 时，显式派发被拦截。真实账号待验。 | [Agent 结果](evidence/field-s9.1-agents/results.json) |
| OpenCode | 本机未探测到可执行入口，真实账号待验。合成 `.cmd` 入口通过标准输入逐字节收到 24,500 字节的多行 UTF-8。 | [Agent 结果](evidence/field-s9.1-agents/results.json) · [S8 回归](evidence/field-s9.1-s8-regression/results.json) |
| Windows 原生文件选择器 | 中文目录及文件名均包含空格，界面回填和持久化配置与所选路径逐字一致。 | [选择器结果](evidence/field-s9.1-picker/results.json) |
| 本机 NSIS 安装及首次启动 | 安装到含中文和空格的目录。安装后 EXE 与 NSIS 载荷一致，首次启动显示 S9 默认目录建议，独立工作区、插件配置和 WebView2 档案正常初始化。临时安装已卸载。 | [首启动结果](evidence/field-s9.1-first-run/results.json) · [载荷校验](evidence/field-s9.1-first-run/install-proof.json) |
| 独立干净 Windows | 待验。现有主机已装 WebView2，现场无独立干净 Windows 环境可验证 WebView2 首次部署。 | |

## 现场修正与回归

- S9.1 将默认试用目录更新为 `Plate-Tauri-S9-试用笔记`，避免自动打开 S7 试用笔记。仍可手选已有工作区。
- S9.0 一次真实回执采纳遇到 SQLite `database or disk is full`。S9.1 显示中文处理提示，故障注入确认回执保持待审阅并可重试。两份真实回执在 S9.1 复跑中均采纳成功。
- TypeScript、Vite 生产构建、Rust 5 项测试和 NSIS 打包通过。同版本预览 EXE 通过 [S8 合成回归 10 组](evidence/field-s9.1-s8-regression/results.json) 和 [S9 合成回归 9 组](evidence/field-s9.1-s9-regression/results.json)。

公开结果保留测试断言和版本，移除了本机绝对路径。现场截图保存在本地验收目录。[现场复跑脚本](evidence/s9-field-e2e.mjs) · [构建与合成回归说明](S9-BRAIN.md)

## GitHub 源码与安装包

- 发布标签 `v0.5.0-s9.1` 指向分支 `checkpoint/tauri-s9` 上的源码提交 [`2f0e3c8252b892011fcba5aa2d34161bbc6ba440`](https://github.com/fundops-notes/plate-workbench/commit/2f0e3c8252b892011fcba5aa2d34161bbc6ba440)。已核对 GitHub 标签和 `tauri-migration/source` 的完整源码树。
- Release 为 Windows x64 预发布。GitHub 回下载安装包为 4,390,911 字节，SHA256 与现场验收包一致，为 `96B7A8423058036544342887AFFE6720C4A0FF50D310E5623B4A20827E0FC716`。[Release](https://github.com/fundops-notes/plate-workbench/releases/tag/v0.5.0-s9.1) · [下载安装包](https://github.com/fundops-notes/plate-workbench/releases/download/v0.5.0-s9.1/Plate-S9-0.5.0-s9.1-Setup-x64.exe)
