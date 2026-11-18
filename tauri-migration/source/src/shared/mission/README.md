# Mission 领域契约（R0-B 原型）

本目录是独立的本地领域契约层：纯函数、零依赖、不连 SQLite、不接应用入口、不能发车。供 R1 Mission 核心在主进程内复用。

## 文件

- `ids.ts` — 品牌化 ID：`MissionId`、`SlotId`、`CommandRequestId`、`TerminalHandleId`、`ProviderId`、`ProviderSessionId`、`ContextVersionId`、`Sha256Hash`（`sha256:<64hex>`）、`EventId`、`EventSeq`、`ArtifactId`。构造函数做非空与格式校验。
- `contract.ts` — `MissionStatus`、`SlotStatus`、`SlotOutcome`、`CommandKind`、`CommandRequest`、`TerminalHandle`（含 `ProviderSessionRef`）、`ProviderDescriptor`、`SlotSpec`（角色、提供方、明确 cwd、逐槽权限、上下文版本引用）、`Crew`、`ContextVersion`、`SlotState`、`MissionState`。权限是封闭集合的全量记录（`permissionSpec`）。
- `events.ts` — `MissionEvent` 判别联合：创建/确认/取消/归档、`host-restarted`、`command-requested/acknowledged/failed/uncertain`、`terminal-receipt`、等待输入/阻塞/角色报告/完成/产物登记/用户决策。
- `reduce.ts` — 纯归并：`applyEvent`、`reduceEvents`、`rebuildMissionState`、`snapshotMissionState`、`emptyMissionState`、`nextSeq`。

## 归并与幂等规则

1. 事件流按 Mission 内 `seq` 严格连续；`seq <= lastAppliedSeq` 拒绝（`stale-seq`），跳号拒绝（`seq-gap`），重放已应用事件拒绝（`duplicate-event`）。
2. `missionId` 不匹配直接拒绝（`mission-mismatch`）。
3. `CommandRequestId` 全局唯一：重复请求拒绝（`duplicate-request`）；请求一旦 `acknowledged/failed/uncertain`，后续同 ID 结果事件拒绝（`request-already-resolved`）；结果事件必须落回请求所属槽位（`request-slot-mismatch`）。
4. 终态保护：槽位终态（`failed/uncertain/completed/stopped`）不接受迟到完成/报告/确认（`slot-status-conflict`）；Mission `cancelled/archived` 后拒绝再取消/确认（`cancel-not-allowed`/`confirm-not-allowed`）。
5. 失败与不确定是两种结果：`failed` 可由用户决策 `retry-launch` 复位为 `confirmed` 后重新请求；`uncertain` 置 `autoRetryBlocked`，自动重发直接拒绝（`uncertain-no-auto-retry`），只有显式用户决策解锁或 `abandon` 关闭。
6. 槽位隔离：所有槽位状态、句柄、请求、产物都按 `slotId` 分桶；事件只能写自己的槽位。
7. 重启重建：`rebuildMissionState(missionId, events)` 从事件日志纯回放；`host-restarted` 把所有未确认 `exited` 的句柄重置为 `unverified` 并给活跃槽位打 `livenessUnverified`。句柄存活只能由重启后的 `terminal-receipt` 确认，旧 PID 永远只是记录的事实，不是活会话。

检查与证据见 `../../reports/R0-B/REPORT.md`。
