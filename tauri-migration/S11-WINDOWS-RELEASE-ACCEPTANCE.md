# Plate Workbench S11 Windows x64 发布验收 · 2026-11-22

GitHub 预发布 `v0.7.0-s11` 已发布，Tag 已核对为验收源码 `5325be6d07c369ba66434b8b0406d9cb50bb4ec1`。S11 独立更新清单提交为 `559b6ec69a04cbec7fc25be88ac888e3ad971583`。[GitHub Release](https://github.com/fundops-notes/plate-workbench/releases/tag/v0.7.0-s11)

| 验收项 | 结果 |
| --- | --- |
| 迁移数据 | 本机登记的旧库是 S10.0 初始化的空库。本次使用已发布的 S10.1 可执行文件创建带内容的合成样本库，随后复制 Markdown 和工作区标记，并用 SQLite 只读在线备份纳入 WAL。隔离副本包含 2 篇笔记、1 条关联、1 个草稿、1 条图谱布局、1 条候选闪念、1 个技能、1 个服务商、1 个会话及其 2 条消息、1 次任务和 1 条待审阅 Diff。 |
| 数据完整性 | S11 打开副本后，旧版表的记录数和稳定字段、Markdown 文件哈希以及应用读取的两篇笔记内容全部一致。重新索引后的笔记路径、活力字段和更新时间，以及重新绑定的草稿绝对路径按各自口径核对。历史笔记、闪念、技能和任务归入学习脑区，既有技能提示词建立生产版本。SQLite 完整性及外键检查通过，重启后仍打开同一副本且迁移可重复执行。 |
| 草稿迁移 | 草稿路径重新绑定到当前工作区。恢复和另存实测在副本内完成，样本源库保持原样。另存生成可索引的 UUID 笔记，沿用来源脑区。Rust 回归测试覆盖个人脑区草稿的副本归属。 |
| 并行安装与凭据 | Windows x64 NSIS 静默安装实测使用 `Plate Workbench S11 Preview` 安装目录和独立卸载登记。正式 S10.1 进程在 S11 安装期间保持可用。S11 保留模型服务配置并使用独立凭据，S10.1 样本凭据在原版仍可连接回环服务。旧安装可执行文件、卸载登记、工作区登记、原库 SQLite/WAL 和笔记哈希均未变化。 |
| 最终包验证 | 24 项 Rust 测试、发布源码的 TypeScript 检查与前端构建通过。安装后的 x64 程序与安装包提取载荷哈希一致。提取最终程序重跑 S11 M1–M4 Windows WebView2 回归，渲染错误为 0，评测并发峰值为 3。 |
| 公开下载和通道 | 匿名重新下载 EXE、SIG、SHA256SUMS，三项均与发布资产的字节数和哈希一致。Tauri 更新签名绑定安装包名及 `0.7.0-s11`，篡改一字节后验签失败。实际通过旧版和新版程序的 Tauri 更新插件分别检查 S10 与 S11 通道，两版均为各自通道当前版本。旧通道分支及 S10.1 Tag 保持原 SHA。Windows Authenticode 状态为 `NotSigned`。 |

安装包 SHA-256 为 `E9BBB1FA5F1C9BDBFD1BECF9AEC9CD1D36157B99B00930665D46A022C7993086`。[校验文件](https://github.com/fundops-notes/plate-workbench/releases/download/v0.7.0-s11/SHA256SUMS.txt)

## 范围与清理

本次对应 S11 计划 §2 的增量迁移与 §5 的 M1–M4 发行回归。S10 的旧库恢复和更新通道继续使用原登记。新增发行改动集中在 S11 独立安装标识、默认目录、凭据、更新通道，以及跨目录草稿恢复与另存。日用的 S10.1 笔记库、干净 Windows 上首次安装 WebView2、后续 S11 版本的自动更新安装未验证。[S11 阶段验收](S11-ACCEPTANCE.md) · [S10.1 发行验收](S10.1-RELEASE-ACCEPTANCE.md)

已卸载测试安装，清理本次生成的压缩包提取目录、库副本、测试应用配置、下载副本、Rust 构建目录和前端依赖及输出。C 盘可用空间较清理前增加约 5.2 GiB。

[迁移证据](evidence/s11-release/migration-verification.json) · [最终包回归](evidence/s11-release/packaged-verification.json) · [验签结果](evidence/s11-release/signature-verification.json) · [两个更新通道的校验](evidence/s11-release/channel-verification.json) · [复验脚本](source/checks/s11-install-windows.mjs)
