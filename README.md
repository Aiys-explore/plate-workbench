# Plate

Plate 是 Windows 本地笔记与 Agent 工作台。文档用于写作，画板用于摆放资料，关系图从笔记引用生成「上游资料／下游去向」。工作台也可以组织本地 Agent 并交接笔记内容。

本次 checkpoint 固定 `0.2.0-r9-ui.7-relations.1`：UI.7 主界面、关系图四种风格与默认动效、节点聚焦与退出回焦、从关系图打开目标笔记的画板。跨笔记切换会先让用户处理当前草稿。

使用 Windows x64 和 Node.js 24，在仓库根目录运行：

```powershell
npm ci
npm run build
npx --no-install electron-builder --win --dir --config electron-builder.merge.json --config.electronDist=./node_modules/electron/dist --publish never
```

入口为 `release/ui7-relations-r1/win-unpacked/Plate-UI7-Relations.exe`。打包配置会写入 checkpoint 版本；构建使用 `native/` 和 `src/` 中与候选一起冻结的 Windows 原生组件。

定向验收使用隔离配置和 16 篇合成笔记，共通过 8 组检查。[验收记录](acceptance/checkpoint.json) · [浅色](acceptance/plate-editorial-upper-branch.png) · [深色](acceptance/dark-wide.png) · [窄窗](acceptance/plate-dark-narrow-still.png)。
