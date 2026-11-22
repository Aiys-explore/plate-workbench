# S10 Windows x64 预览验收 · 2026-11-22

发布版 `v0.6.0-s10.0` 的源码提交为 `9ad6a8001bf0e7f90cd9a6212b3ba8b8967ac023`。已核对远端 tag 与该提交一致。S10 更新清单提交为 `db742439d869b3bbcffd9c05d87aa1b78b3fffaf`，独立发布在 `checkpoint/tauri-s10`。S9 分支在本次发布前后均为 `d6eccf45e468a7ba5cdba7d29e77ff9a238c5407`。[GitHub Release](https://github.com/fundops-notes/plate-workbench/releases/tag/v0.6.0-s10.0)

## 验收结果

| 范围 | 结果 |
| --- | --- |
| 构建 | `cargo check`、`cargo test`（15 项）、`npm run build` 均通过。以 `x86_64-pc-windows-msvc` 构建 NSIS，核对安装后可执行文件的 PE 架构为 x64。Vite 仍报告现有大包体积警告。 |
| 安装与并行启动 | 在 Windows 11 家庭版 x64（26300）与已有 WebView2 上，通过 NSIS 的静默模式实装。程序在当前用户目录 `%LOCALAPPDATA%/Plate Workbench S10 Preview`，HKCU 中独立登记版本。公开 S9.6 安装包提取出的进程在 S10 安装期间可用。 |
| 启动、重启与界面 | 首次启动建议 `Documents/Plate Workbench S10 Preview`，确认前无默认库或库登记写入。提交隔离空白库后显示 52px、五入口纯图标导航和复合输入岛，可进入模型权限页。退出进程后重启恢复所选库。已修复安装版内嵌字体被拦截的问题，最终版渲染控制台无错误。 |
| S9.6 旧库副本 | 用已发布 S9.6 二进制创建合成库。停进程并完成 WAL 检查点后复制到含中文、日文和韩文的目录。S10 中分区、两篇笔记、关联、图谱坐标和固定状态、草稿、闪念、技能均可读取。原合成库与副本的 Markdown 哈希一致，S10 新增的四类表仅在验收副本初始化。SQLite 完整性与外键检查通过，关闭重启后恢复副本。 |
| 签名和下载 | 安装包具有绑定 `0.6.0-s10.0` 的 Tauri 更新签名。独立校验包签名和可信注释签名，篡改文件最后一个字节后验证被拒绝。匿名重新下载 EXE、SIG 与 SHA256SUMS，哈希匹配，远端 EXE 再验签通过。Windows Authenticode 状态为 `NotSigned`。 |
| S10 更新通道 | 匿名下载的更新清单与发布包、签名和版本一致。实际安装版经 Tauri 更新插件读取该通道，已是当前版本。 |
| 验收收尾与待验 | 已卸载本次测试安装并移除指向隔离库的 S10 登记。用户的 S9.6 和真实笔记未参与验收。使用现成 Windows 和 WebView2，尚未覆盖干净 Windows 首次部署、图形安装向导、原生目录选择器操作和未来版本覆盖升级。 |

发布安装包的 SHA-256 为 `BE0E963DDA3B6297997C542CF0A3636EDBFACD6AEDA3C1418A884411C93143E8`。[公开校验文件](https://github.com/fundops-notes/plate-workbench/releases/download/v0.6.0-s10.0/SHA256SUMS.txt)

## S10 计划比对

| 计划条目 | 结果 |
| --- | --- |
| 原计划 §3.2、§3.8 与 §5 | S10 追加表可在发布版 S9.6 的库副本中初始化，正文、旧表业务数据和登记后重启均通过。本次发行改动集中在版本、应用标识和目录隔离、更新通道、打包与验收，继续用既有 M1–M4 记录核对任务权限与行为。 |
| 修订版 §5.1–5.6 | 发行包实测导航宽度、模型权限页、复合输入岛与旧库大脑视图。列表悬停和 Diff 操作沿用 M4 验收。字体改为随安装包发布的本地资源，界面验收无控制台错误。 |

计划与阶段记录见 [原计划](plans/s10_workbench_harness_plan.md) · [视觉修订版](plans/s10_workbench_harness_plan_1.md) · [M1–M4 阶段验收](S10-ACCEPTANCE.md)。

复测脚本为 [s10-install-windows.mjs](source/checks/s10-install-windows.mjs)。证据为 [安装记录](evidence/s10-release/installed-verification.json) · [签名校验](evidence/s10-release/signature-verification.json) · [安装版工作台](evidence/s10-release/installed-s10.png) · [合成旧库大脑视图](evidence/s10-release/installed-legacy-brain.png)。
