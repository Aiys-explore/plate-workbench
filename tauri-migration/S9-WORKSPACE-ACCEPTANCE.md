# Windows 文档路径与工作区恢复验收

2026-11-19 在已有 WebView2 的 Windows x64 主机上验证。源码已推送到 `checkpoint/tauri-s9`，并通过 `git ls-remote` 核对远端源码提交 `fea031066f13bb9d0d8f21f47b316b239b621213`。

- 首次启动建议使用 Windows 返回的「文档」文件夹下的 `Plate Workbench`，用户确认后才在所选工作区创建 `projects` 和 `index.sqlite`。解析不到「文档」位置时仍可手动选择。
- 已确认的工作区路径写入 Plate 的本机应用数据。重启直接打开已登记工作区，路径失效时显示原路径并允许重新选择。S9 旧默认目录只在具有工作区标识和 `projects` 目录时作为兼容入口。
- `cargo test --locked --offline` 通过 6 项测试，包含 Unicode 路径登记、覆盖登记及读取缺失路径。前端类型检查、生产前端构建和 Windows 调试候选构建通过。
- 使用独立应用标识和 WebView2 档案运行 `evidence/s9-field-e2e.mjs workspace-startup`。选择带中文、日文、韩文及空格的合成目录后生成 `index.sqlite`，进程完全退出后再次启动自动打开该目录。将登记指到不存在的位置后，启动进入恢复界面，原数据库仍在，缺失目录未被创建。
- 调试候选 EXE 的 SHA256 为 `00E682BBB34B08D69E08EE54085D01B145F7226A42308EC11CDF2976359A6289`。S9.5 Release 下载项仍为原发布包。

本机已有旧工作区，本次用隔离登记避免打开它。新账户默认建议的界面、真实的不同语言 Windows 和文档重定向、干净 Windows 首装及 WebView2 首次部署仍待现场验收。

复跑时用 Tauri 配置覆盖提供独立标识 `local.plate.workbench.workspace-test-<32 位十六进制>`，构建 `--debug --no-bundle` 候选。将 Windows 的「文档」路径和候选对应的 `workspace.json` 路径分别传入 `PLATE_TEST_WINDOWS_DOCUMENTS` 和 `PLATE_TEST_WORKSPACE_REGISTRATION`，再给脚本传入候选 EXE 和证据目录。
