# Plate Tauri v2 迁移 — S1–S6 Checkpoint（0.3.0-s6.0）

日期：2026-11-18。主分支 `main` 上是 UI.7 Electron 版快照；本分支 `checkpoint/tauri-s6` 新增 Electron→Tauri v2 渐进迁移的完整源码、验收证据与本机试用包，不影响 `main`。

## 目录

- `source/` — Tauri v2 源码（renderer 全量迁移 + Rust 后端：笔记库、Agent 引擎、任务状态机）。不含 `node_modules`/`target`/`out`。
- `evidence/` — S2–S6 E2E 脚本与结果（`s2-e2e.mjs`…`s6-e2e.mjs`、`s6-e2e-result.json`、`packaged-smoke.mjs`、隔离工作区、stub）。
- `REPORT.md` — S1–S6 逐阶段验收报告（含缺陷修复记录）。
- `release/tauri/` — 本机试用包：NSIS 安装器 + win-unpacked 裸 exe。

## 试用包

| 文件 | SHA-256 |
| --- | --- |
| `release/tauri/Plate Workbench_0.3.0-s6.0_x64-setup.exe` | `E172AA139FAA142B410DE54D0CE067F5916B145B2B981215F59BB1A380D7F2E1` |
| `release/tauri/win-unpacked/plate-workbench.exe` | `E8A4DA6F5F45C2BAE05A3C62A2E98451CE50B5ECA547756173288F640D969CE8` |

安装器双击安装；win-unpacked 免安装直接运行。首次启动选择笔记位置即可（默认建议可用）。

## 从源码构建

```
cd tauri-migration/source
npm install
npm run tauri build -- --bundles nsis
```

产物在 `src-tauri/target/release/bundle/nsis/`。开发调试：`npm run tauri dev`。

## 功能范围（S1–S6 全部通过验收）

- S1：Electron 依赖移除，Tauri v2 脚手架，WebView2 加载 React 根节点。
- S2：Rust 笔记库（SQLite + 文件系统）、桥接 IPC、启动选择位置流程。
- S3：图谱即桌面——关系图为常驻主舞台，笔记以右侧抽屉编辑；中文输入/IME 组合落盘。
- S4：图谱 CRUD——拖拽坐标持久化、双击建笔记、Tab 派生、端口连线、右键删除。
- S5：Rust Agent 引擎——四类 agent 自动发现（dsh/codex/claude/opencode）、任务状态机（DOING→PENDING/ERROR）、并发输出汇聚、15 分钟超时、CREATE_NO_WINDOW。
- S6：行内任务胶囊——笔记内 `TODO` 交办、DOING 计时/停止、PENDING 审阅（采纳落盘输出引用块/追加续跑/驳回）、图谱徽标与呼吸灯联动。

## 边界（未验证项）

- 真实 dsh/codex/claude/opencode 账号与联网执行：验收全程用 `PLATE_AGENT_*` stub 注入；实机验收另行执行。
- dsh 桌面版私有安装路径不在自动发现范围内（需接入阶段补目录或登记）。
- 实机输入法候选窗、读屏、系统缩放、外屏恢复未在 Tauri 版重验。
- CDP 模拟键盘在该编辑器的组合态处理下不稳定（与 Tauri 无关），键盘链路以真实输入验收为准。
