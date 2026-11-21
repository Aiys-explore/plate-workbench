# Plate Workbench S10 开发执行计划：个人工作台 + Harness + 双引擎 Agent

> **文档定位**：本文件为面向代码执行 Agent（如 Claude Code / Codex / Cursor）的工程级实施规范，基于仓库 [fundops-notes/plate-workbench (`tauri-migration`, commit `d6eccf45`)](https://github.com/fundops-notes/plate-workbench/tree/d6eccf45e468a7ba5cdba7d29e77ff9a238c5407/tauri-migration) 现有 Tauri v2 + React 19 + Rust SQLite 架构，借鉴 [Atlasnote Pro](https://atlasnote.ai/zh-CN/features) 的极简桌面工作台、权限隔离与 Wiki 差异审阅体验，完整保留现有大脑与记忆引擎，并统一重构前端视觉与图标体系。

## 1. 给执行 Agent 的前置约束与必读规则

1. **工作目录**：所有代码修改均位于 `tauri-migration/source/` 下（前端在 `src/`，Rust 后端在 `src-tauri/`）。
2. **严禁破坏的现有核心模块**（只做兼容扩展，不删除原有能力）：
   - Rust 大脑三件套：[vitality\_engine.rs](https://www.google.com/search?q=https://github.com/fundops-notes/plate-workbench/blob/d6eccf45e468a7ba5cdba7d29e77ff9a238c5407/tauri-migration/source/src-tauri/src/vitality_engine.rs)、[memory\_consolidator.rs](https://www.google.com/search?q=https://github.com/fundops-notes/plate-workbench/blob/d6eccf45e468a7ba5cdba7d29e77ff9a238c5407/tauri-migration/source/src-tauri/src/memory_consolidator.rs)、[context\_compiler.rs](https://www.google.com/search?q=https://github.com/fundops-notes/plate-workbench/blob/d6eccf45e468a7ba5cdba7d29e77ff9a238c5407/tauri-migration/source/src-tauri/src/context_compiler.rs)
   - Rust 进程与发现：[agent\_runner.rs](https://www.google.com/search?q=https://github.com/fundops-notes/plate-workbench/blob/d6eccf45e468a7ba5cdba7d29e77ff9a238c5407/tauri-migration/source/src-tauri/src/agent_runner.rs)、[agent\_store.rs](https://www.google.com/search?q=https://github.com/fundops-notes/plate-workbench/blob/d6eccf45e468a7ba5cdba7d29e77ff9a238c5407/tauri-migration/source/src-tauri/src/agent_store.rs)、`process_job.rs`（Windows JobObject）
   - 前端大脑与图谱：[brain-workbench.tsx](https://www.google.com/search?q=https://github.com/fundops-notes/plate-workbench/blob/d6eccf45e468a7ba5cdba7d29e77ff9a238c5407/tauri-migration/source/src/renderer/src/brain-workbench.tsx)、`relationship-graph.tsx`、[shared/brain.ts](https://www.google.com/search?q=https://github.com/fundops-notes/plate-workbench/blob/d6eccf45e468a7ba5cdba7d29e77ff9a238c5407/tauri-migration/source/src/shared/brain.ts)
3. **先读后改原则**：在修改 `src-tauri/src/main.rs`、`src-tauri/src/db.rs`、`src/shared/ipc.ts`、`src/renderer/src/tauri-bridge.ts`、`src/renderer/src/icon-action.tsx` 之前，先通读原文件，沿用仓库已有的 `AppState`（数据库连接池/Mutex）、错误返回类型 `Result<T, String>` 与 Tauri command 命名风格。
4. **安全底线**：
   - API Key 明文只能存入操作系统钥匙串（`keyring`），严禁写入 SQLite 或前端 `localStorage`。
   - Agent 对工作区文件与大脑笔记的写入，默认先写入 `staged_diffs` 暂存表，必须由用户在 UI 审阅确认后再落盘。
   - 加载任何 `Skill` 时，权限只能与当前任务 `PermissionManifest` 取交集，绝不允许自动扩权。
5. **UI 极简与统一图标硬约束**：
   - 统一引入开源图标库 `lucide-react`（[lucide-icons/lucide](https://github.com/lucide-icons/lucide)），全项目禁止混用 emoji、杂乱手写 `<svg>` 或成排冗余文字按钮。
   - 详见第 5 节的减按钮规则、图标映射表与 CSS 视觉规范。
6. **每阶段必跑校验命令**：
   ```bash
   cd tauri-migration/source
   cargo check --manifest-path src-tauri/Cargo.toml
   cargo test --manifest-path src-tauri/Cargo.toml
   npm run typecheck
   npm run build
   ```

---

## 2. 改动文件总览清单

| 层级 | 文件路径（相对 `tauri-migration/source/`） | 动作 | 核心职责 |
| :--- | :--- | :--- | :--- |
| 前端依赖 | `package.json` | 修改 | 新增 `lucide-react` 统一开源图标库 |
| Rust 依赖 | `src-tauri/Cargo.toml` | 修改 | 新增 `reqwest`、`keyring`、`futures-util`、`similar`、`dirs` |
| Rust 数据库 | `src-tauri/src/db.rs` | 修改 | 增量建表：`llm_providers`、`external_agent_sessions`、`external_agent_messages`（含 FTS5）、`harness_runs`、`harness_events`、`staged_diffs` |
| Rust 密钥与模型 | `src-tauri/src/provider_store.rs` | 新增 | 多服务商配置 CRUD、角色路由、OS 钥匙串存取 API Key |
| Rust 记录采集 | `src-tauri/src/agent_log_harvester.rs` | 新增 | 本机 CLI Agent 会话日志增量解析（Claude Code / Codex / 自定义）、FTS5 检索、一键转为 `EpisodicEvent` |
| Rust Harness | `src-tauri/src/harness/mod.rs` | 新增 | 模块导出与公共类型 `HarnessEvent`、`HarnessRunRequest`、`ExecutionBackend` |
| Rust Harness | `src-tauri/src/harness/policy.rs` | 新增 | `PermissionManifest`、路径规范化沙箱校验、与 `Skill` 权限求交 |
| Rust Harness | `src-tauri/src/harness/staging.rs` | 新增 | Unified Diff 生成、暂存队列 CRUD、乐观锁校验应用并触发大脑活力重算 |
| Rust Harness | `src-tauri/src/harness/llm_provider.rs` | 新增 | OpenAI / Anthropic / Gemini 流式 SSE 推理与受控 ReAct 工具调用循环 |
| Rust Harness | `src-tauri/src/harness/engine.rs` | 新增 | 统一任务编排：PPR 上下文编译 -> 双引擎执行 -> 实时事件推送 -> 记忆/技能回流 |
| Rust 适配 | `src-tauri/src/context_compiler.rs` | 修改 | 扩展 `BrainContextPacket`，支持附加本机 Agent 记录摘要块 |
| Rust 适配 | `src-tauri/src/memory_consolidator.rs` | 修改 | 支持调用 `BrainConsolidator` 角色对应的 BYOK 模型执行“做梦整理” |
| Rust 入口 | `src-tauri/src/main.rs` | 修改 | 注册新模块、挂载 `HarnessState`、注册新 Tauri commands |
| TS 共享类型 | `src/shared/harness.ts` | 新增 | 前端/IPC 共享的视图、服务商、本机记录、权限、Harness 事件与 Diff 类型 |
| TS IPC 桥接 | `src/shared/ipc.ts` & `src/renderer/src/tauri-bridge.ts` | 修改 | 新增 Harness / Provider / LogHarvester / Staging 的 `invoke` 与事件监听 |
| TS 图标与基础组件 | `src/renderer/src/components/icons.tsx` & `src/renderer/src/icon-action.tsx` | 新增/重构 | 统一封装 `lucide-react` 图标出口、固定 `strokeWidth` 与全局极简 `<IconAction>` |
| TS 状态与样式 | `src/renderer/src/store.ts` & `src/renderer/src/styles/workbench-shell.css` | 修改/新增 | 扩展 `activeView`/`pendingDiffCount` 状态，收敛 Atlasnote 风格极简 Token 与布局 |
| TS 壳层与视图 | `src/renderer/src/layout.tsx` + `src/renderer/src/components/activity-rail.tsx` | 修改/新增 | 52px 极窄纯图标主导航栏（工作台 / 大脑 / 资料与记录 / 技能 / 底部设置） |
| TS 新视图 | `src/renderer/src/views/{workbench,library-and-logs,skills,settings}-view.tsx` | 新增 | 极简三栏任务工作台、本机记录收件箱、技能库管理、双引擎与权限设置页 |

---

## 3. Rust 后端详细改造方案与参考代码

### 3.1 `src-tauri/Cargo.toml` 新增依赖

基于现有 [Cargo.toml](https://www.google.com/search?q=https://github.com/fundops-notes/plate-workbench/blob/d6eccf45e468a7ba5cdba7d29e77ff9a238c5407/tauri-migration/source/src-tauri/Cargo.toml)（已包含 `tauri = "2"`、`rusqlite`、`tokio`、`notify = "6"`、`serde`、`sha2`、`uuid`），仅追加以下 5 个轻量 crate：

```toml
# 追加到 [dependencies]
reqwest = { version = "0.12", default-features = false, features = ["json", "stream", "rustls-tls"] }
futures-util = "0.3"
keyring = "3"
similar = "2"
dirs = "5"
```

### 3.2 `src-tauri/src/db.rs` 增量建表 SQL

在 `db.rs` 的初始化/迁移函数中追加以下幂等建表语句（不改动现有 `note`、情景事件、技能表）：

```sql
CREATE TABLE IF NOT EXISTS llm_providers (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,              -- 'openai' | 'anthropic' | 'gemini' | 'openai_compatible'
    base_url TEXT NOT NULL,
    default_model TEXT NOT NULL,
    roles_json TEXT NOT NULL DEFAULT '[]', -- ["workbench_chat","brain_consolidator","embedding"]
    key_hint TEXT NOT NULL DEFAULT '',     -- 仅存脱敏后缀如 "...8f2a"
    input_price_per_1m REAL NOT NULL DEFAULT 0.0,
    output_price_per_1m REAL NOT NULL DEFAULT 0.0,
    enabled INTEGER NOT NULL DEFAULT 1,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS external_agent_sessions (
    id TEXT PRIMARY KEY,
    source_tool TEXT NOT NULL,       -- 'claude_code' | 'codex_cli' | 'gemini_cli' | 'custom'
    source_path TEXT NOT NULL UNIQUE,
    workspace_cwd TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL,
    summary TEXT NOT NULL DEFAULT '',
    message_count INTEGER NOT NULL DEFAULT 0,
    file_mtime INTEGER NOT NULL DEFAULT 0,
    byte_offset INTEGER NOT NULL DEFAULT 0,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS external_agent_messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES external_agent_sessions(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    role TEXT NOT NULL,              -- 'user' | 'assistant' | 'tool'
    content TEXT NOT NULL,
    tool_name TEXT,
    touched_files_json TEXT NOT NULL DEFAULT '[]',
    created_at INTEGER NOT NULL
);

CREATE VIRTUAL TABLE IF NOT EXISTS external_agent_messages_fts USING fts5(
    session_id UNINDEXED,
    role UNINDEXED,
    content,
    tokenize='unicode61'
);

CREATE TABLE IF NOT EXISTS harness_runs (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    backend_kind TEXT NOT NULL,      -- 'local_cli' | 'api_key'
    backend_id TEXT NOT NULL,        -- CLI agent_id 或 provider_id
    model_name TEXT NOT NULL DEFAULT '',
    skill_id TEXT,
    permission_manifest_json TEXT NOT NULL,
    activation_wave_json TEXT,       -- BrainActivationWave JSON
    status TEXT NOT NULL,            -- 'running' | 'review_ready' | 'completed' | 'failed' | 'cancelled'
    token_in INTEGER NOT NULL DEFAULT 0,
    token_out INTEGER NOT NULL DEFAULT 0,
    cost_usd REAL NOT NULL DEFAULT 0.0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS harness_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    run_id TEXT NOT NULL REFERENCES harness_runs(id) ON DELETE CASCADE,
    seq INTEGER NOT NULL,
    kind TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS staged_diffs (
    id TEXT PRIMARY KEY,
    run_id TEXT NOT NULL REFERENCES harness_runs(id) ON DELETE CASCADE,
    target_kind TEXT NOT NULL,       -- 'workspace_file' | 'brain_note'
    target_ref TEXT NOT NULL,        -- 文件绝对路径或 note_id
    base_sha256 TEXT NOT NULL,
    proposed_content TEXT NOT NULL,
    unified_diff TEXT NOT NULL,
    rationale TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending', -- 'pending' | 'accepted' | 'rejected'
    created_at INTEGER NOT NULL,
    resolved_at INTEGER
);
```

### 3.3 新增 `src-tauri/src/provider_store.rs`（BYOK API Key 管理）

```rust
use keyring::Entry;
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};

const KEYRING_SERVICE: &str = "local.plate.workbench.providers";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind {
    Openai,
    Anthropic,
    Gemini,
    OpenaiCompatible,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ModelRole {
    WorkbenchChat,
    BrainConsolidator,
    Embedding,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    pub id: String,
    pub name: String,
    pub kind: ProviderKind,
    pub base_url: String,
    pub default_model: String,
    pub roles: Vec<ModelRole>,
    pub key_hint: String,
    pub input_price_per_1m: f64,
    pub output_price_per_1m: f64,
    pub enabled: bool,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertProviderInput {
    pub id: Option<String>,
    pub name: String,
    pub kind: ProviderKind,
    pub base_url: String,
    pub default_model: String,
    pub roles: Vec<ModelRole>,
    pub api_key: Option<String>,
    pub input_price_per_1m: f64,
    pub output_price_per_1m: f64,
    pub enabled: bool,
}

pub fn save_secret_key(provider_id: &str, api_key: &str) -> Result<String, String> {
    let entry = Entry::new(KEYRING_SERVICE, provider_id).map_err(|e| e.to_string())?;
    entry.set_password(api_key).map_err(|e| e.to_string())?;
    let trimmed = api_key.trim();
    let hint = if trimmed.len() >= 4 {
        format!("...{}", &trimmed[trimmed.len() - 4..])
    } else {
        "***".to_string()
    };
    Ok(hint)
}

pub fn load_secret_key(provider_id: &str) -> Result<String, String> {
    let entry = Entry::new(KEYRING_SERVICE, provider_id).map_err(|e| e.to_string())?;
    entry.get_password().map_err(|e| format!("未找到该服务商的 API Key: {e}"))
}

pub fn delete_secret_key(provider_id: &str) -> Result<(), String> {
    if let Ok(entry) = Entry::new(KEYRING_SERVICE, provider_id) {
        let _ = entry.delete_credential();
    }
    Ok(())
}

pub fn upsert_provider(
    conn: &Connection,
    input: UpsertProviderInput,
    now_ms: i64,
) -> Result<ProviderConfig, String> {
    let id = input.id.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let existing_hint: String = conn
        .query_row("SELECT key_hint FROM llm_providers WHERE id = ?1", params![id], |r| r.get(0))
        .unwrap_or_default();

    let key_hint = match input.api_key.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        Some(raw_key) => save_secret_key(&id, raw_key)?,
        None => existing_hint,
    };

    let kind_str = serde_json::to_string(&input.kind)
        .map_err(|e| e.to_string())?
        .trim_matches('"')
        .to_string();
    let roles_json = serde_json::to_string(&input.roles).map_err(|e| e.to_string())?;

    conn.execute(
        "INSERT INTO llm_providers
         (id, name, kind, base_url, default_model, roles_json, key_hint, input_price_per_1m, output_price_per_1m, enabled, updated_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)
         ON CONFLICT(id) DO UPDATE SET
            name=excluded.name,
            kind=excluded.kind,
            base_url=excluded.base_url,
            default_model=excluded.default_model,
            roles_json=excluded.roles_json,
            key_hint=excluded.key_hint,
            input_price_per_1m=excluded.input_price_per_1m,
            output_price_per_1m=excluded.output_price_per_1m,
            enabled=excluded.enabled,
            updated_at=excluded.updated_at",
        params![
            id,
            input.name,
            kind_str,
            input.base_url,
            input.default_model,
            roles_json,
            key_hint,
            input.input_price_per_1m,
            input.output_price_per_1m,
            if input.enabled { 1 } else { 0 },
            now_ms
        ],
    )
    .map_err(|e| e.to_string())?;

    Ok(ProviderConfig {
        id,
        name: input.name,
        kind: input.kind,
        base_url: input.base_url,
        default_model: input.default_model,
        roles: input.roles,
        key_hint,
        input_price_per_1m: input.input_price_per_1m,
        output_price_per_1m: input.output_price_per_1m,
        enabled: input.enabled,
        updated_at: now_ms,
    })
}

pub fn list_providers(conn: &Connection) -> Result<Vec<ProviderConfig>, String> {
    let mut stmt = conn
        .prepare(
            "SELECT id, name, kind, base_url, default_model, roles_json, key_hint,
                    input_price_per_1m, output_price_per_1m, enabled, updated_at
             FROM llm_providers ORDER BY updated_at DESC",
        )
        .map_err(|e| e.to_string())?;

    let rows = stmt
        .query_map([], |row| {
            let kind_raw: String = row.get(2)?;
            let roles_raw: String = row.get(5)?;
            let kind: ProviderKind =
                serde_json::from_str(&format!("\"{kind_raw}\"")).unwrap_or(ProviderKind::OpenaiCompatible);
            let roles: Vec<ModelRole> = serde_json::from_str(&roles_raw).unwrap_or_default();
            Ok(ProviderConfig {
                id: row.get(0)?,
                name: row.get(1)?,
                kind,
                base_url: row.get(3)?,
                default_model: row.get(4)?,
                roles,
                key_hint: row.get(6)?,
                input_price_per_1m: row.get(7)?,
                output_price_per_1m: row.get(8)?,
                enabled: row.get::<_, i64>(9)? != 0,
                updated_at: row.get(10)?,
            })
        })
        .map_err(|e| e.to_string())?;

    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

pub fn find_provider_for_role(conn: &Connection, role: ModelRole) -> Result<Option<ProviderConfig>, String> {
    let providers = list_providers(conn)?;
    Ok(providers.into_iter().find(|p| p.enabled && p.roles.contains(&role)))
}
```

### 3.4 新增 `src-tauri/src/agent_log_harvester.rs`（本机 Agent 记录采集）

负责增量扫描本机常见 Agent 日志目录（Claude Code `~/.claude/projects`、Codex CLI `~/.codex/sessions` 及用户自定义目录），解析为统一会话与消息，支持 FTS5 全文搜索和上下文压缩摘要生成：

```rust
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::fs::{self, File};
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalAgentSession {
    pub id: String,
    pub source_tool: String,
    pub source_path: String,
    pub workspace_cwd: String,
    pub title: String,
    pub summary: String,
    pub message_count: i64,
    pub updated_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExternalAgentMessage {
    pub id: String,
    pub session_id: String,
    pub seq: i64,
    pub role: String,
    pub content: String,
    pub tool_name: Option<String>,
    pub touched_files: Vec<String>,
    pub created_at: i64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarvestScanResult {
    pub scanned_files: usize,
    pub updated_sessions: usize,
    pub new_messages: usize,
}

pub fn default_scan_roots() -> Vec<(String, PathBuf)> {
    let mut roots = Vec::new();
    if let Some(home) = dirs::home_dir() {
        roots.push(("claude_code".to_string(), home.join(".claude").join("projects")));
        roots.push(("codex_cli".to_string(), home.join(".codex").join("sessions")));
        roots.push(("gemini_cli".to_string(), home.join(".gemini").join("tmp")));
    }
    roots
}

fn collect_jsonl_files(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        if path.is_dir() {
            collect_jsonl_files(&path, out);
        } else if path.extension().and_then(|e| e.to_str()) == Some("jsonl") {
            out.push(path);
        }
    }
}

fn parse_jsonl_record(val: &Value) -> Option<(String, String, Option<String>, Option<String>)> {
    let cwd = val.get("cwd").and_then(|v| v.as_str()).map(str::to_string);
    if let Some(msg) = val.get("message") {
        let role = msg.get("role").and_then(|v| v.as_str()).unwrap_or("assistant").to_string();
        let text = extract_text_field(msg.get("content")?)?;
        let tool_name = msg.get("name").and_then(|v| v.as_str()).map(str::to_string);
        return Some((role, text, tool_name, cwd));
    }
    let node = val.get("payload").unwrap_or(val);
    let role = node.get("role").and_then(|v| v.as_str())?.to_string();
    let text = extract_text_field(node.get("content")?)?;
    let tool_name = node.get("name").and_then(|v| v.as_str()).map(str::to_string);
    Some((role, text, tool_name, cwd))
}

fn extract_text_field(content: &Value) -> Option<String> {
    if let Some(s) = content.as_str() {
        let trimmed = s.trim();
        return if trimmed.is_empty() { None } else { Some(trimmed.to_string()) };
    }
    if let Some(arr) = content.as_array() {
        let joined: Vec<String> = arr
            .iter()
            .filter_map(|item| {
                item.get("text")
                    .or_else(|| item.get("input_text"))
                    .or_else(|| item.get("output_text"))
                    .and_then(|v| v.as_str())
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .map(str::to_string)
            })
            .collect();
        if !joined.is_empty() {
            return Some(joined.join("\n"));
        }
    }
    None
}

pub fn scan_local_agent_logs(
    conn: &mut Connection,
    extra_roots: &[(String, PathBuf)],
    now_ms: i64,
) -> Result<HarvestScanResult, String> {
    let mut roots = default_scan_roots();
    roots.extend_from_slice(extra_roots);

    let mut result = HarvestScanResult {
        scanned_files: 0,
        updated_sessions: 0,
        new_messages: 0,
    };

    for (source_tool, root) in roots {
        if !root.exists() {
            continue;
        }
        let mut files = Vec::new();
        collect_jsonl_files(&root, &mut files);

        for path in files {
            result.scanned_files += 1;
            let Ok(meta) = fs::metadata(&path) else { continue };
            let mtime = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_secs() as i64)
                .unwrap_or(0);
            let path_str = path.to_string_lossy().to_string();

            let prev_mtime: Option<i64> = conn
                .query_row(
                    "SELECT file_mtime FROM external_agent_sessions WHERE source_path = ?1",
                    params![path_str],
                    |r| r.get(0),
                )
                .ok();
            if prev_mtime == Some(mtime) {
                continue;
            }

            let Ok(file) = File::open(&path) else { continue };
            let reader = BufReader::new(file);
            let mut parsed = Vec::new();
            let mut detected_cwd = String::new();

            for line in reader.lines().map_while(Result::ok) {
                let Ok(val) = serde_json::from_str::<Value>(&line) else { continue };
                if let Some((role, text, tool_name, cwd)) = parse_jsonl_record(&val) {
                    if detected_cwd.is_empty() {
                        if let Some(c) = cwd {
                            detected_cwd = c;
                        }
                    }
                    parsed.push((role, text, tool_name));
                }
            }
            if parsed.is_empty() {
                continue;
            }

            let session_id = uuid::Uuid::new_v5(&uuid::Uuid::NAMESPACE_URL, path_str.as_bytes()).to_string();
            let title = parsed
                .iter()
                .find(|(r, _, _)| r == "user")
                .map(|(_, t, _)| t.chars().take(64).collect::<String>())
                .unwrap_or_else(|| path.file_stem().unwrap_or_default().to_string_lossy().to_string());
            let summary = build_compact_summary(&parsed);

            let tx = conn.transaction().map_err(|e| e.to_string())?;
            tx.execute(
                "INSERT INTO external_agent_sessions
                 (id, source_tool, source_path, workspace_cwd, title, summary, message_count, file_mtime, byte_offset, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, ?9)
                 ON CONFLICT(source_path) DO UPDATE SET
                    workspace_cwd=excluded.workspace_cwd,
                    title=excluded.title,
                    summary=excluded.summary,
                    message_count=excluded.message_count,
                    file_mtime=excluded.file_mtime,
                    updated_at=excluded.updated_at",
                params![session_id, source_tool, path_str, detected_cwd, title, summary, parsed.len() as i64, mtime, now_ms],
            )
            .map_err(|e| e.to_string())?;

            tx.execute("DELETE FROM external_agent_messages WHERE session_id = ?1", params![session_id])
                .map_err(|e| e.to_string())?;
            tx.execute("DELETE FROM external_agent_messages_fts WHERE session_id = ?1", params![session_id])
                .map_err(|e| e.to_string())?;

            for (idx, (role, content, tool_name)) in parsed.iter().enumerate() {
                let msg_id = format!("{session_id}:{idx}");
                tx.execute(
                    "INSERT INTO external_agent_messages
                     (id, session_id, seq, role, content, tool_name, touched_files_json, created_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, '[]', ?7)",
                    params![msg_id, session_id, idx as i64, role, content, tool_name, now_ms],
                )
                .map_err(|e| e.to_string())?;
                tx.execute(
                    "INSERT INTO external_agent_messages_fts (session_id, role, content) VALUES (?1, ?2, ?3)",
                    params![session_id, role, content],
                )
                .map_err(|e| e.to_string())?;
            }
            tx.commit().map_err(|e| e.to_string())?;

            result.updated_sessions += 1;
            result.new_messages += parsed.len();
        }
    }

    Ok(result)
}

fn build_compact_summary(messages: &[(String, String, Option<String>)]) -> String {
    let first_user = messages
        .iter()
        .find(|(r, _, _)| r == "user")
        .map(|(_, t, _)| t.chars().take(240).collect::<String>())
        .unwrap_or_default();
    let last_assistant = messages
        .iter()
        .rev()
        .find(|(r, _, _)| r == "assistant")
        .map(|(_, t, _)| t.chars().take(360).collect::<String>())
        .unwrap_or_default();
    format!("目标: {first_user}\n最终结论: {last_assistant}")
}
```

### 3.5 新增 `src-tauri/src/harness/policy.rs`（权限沙箱与技能权限交集）

```rust
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionManifest {
    pub readable_note_ids: Vec<String>,
    pub allow_all_notes_read: bool,
    pub readable_log_session_ids: Vec<String>,
    pub writable_dirs: Vec<String>,
    pub allow_brain_note_propose: bool,
    pub allow_shell: bool,
    pub allow_network: bool,
    pub max_steps: u32,
    pub max_budget_usd: f64,
}

impl Default for PermissionManifest {
    fn default() -> Self {
        Self {
            readable_note_ids: vec![],
            allow_all_notes_read: false,
            readable_log_session_ids: vec![],
            writable_dirs: vec![],
            allow_brain_note_propose: true,
            allow_shell: false,
            allow_network: false,
            max_steps: 12,
            max_budget_usd: 0.50,
        }
    }
}

impl PermissionManifest {
    pub fn assert_can_write_path(&self, target: &Path) -> Result<PathBuf, String> {
        let parent = target.parent().ok_or_else(|| "目标路径缺少父目录".to_string())?;
        let canon_parent = parent.canonicalize().map_err(|e| format!("无法解析父目录: {e}"))?;
        let file_name = target.file_name().ok_or_else(|| "目标路径缺少文件名".to_string())?;
        let resolved = canon_parent.join(file_name);

        for allowed in &self.writable_dirs {
            if let Ok(canon_allowed) = Path::new(allowed).canonicalize() {
                if resolved.starts_with(&canon_allowed) {
                    return Ok(resolved);
                }
            }
        }
        Err(format!("权限拒绝：{} 不在当前任务授权的可写目录内", target.display()))
    }

    pub fn assert_can_read_note(&self, note_id: &str) -> Result<(), String> {
        if self.allow_all_notes_read || self.readable_note_ids.iter().any(|id| id == note_id) {
            Ok(())
        } else {
            Err(format!("权限拒绝：笔记 {note_id} 未授权给当前任务"))
        }
    }

    pub fn intersect_with_skill_caps(&self, skill_needs_shell: bool, skill_needs_network: bool) -> Self {
        let mut out = self.clone();
        out.allow_shell = self.allow_shell && skill_needs_shell;
        out.allow_network = self.allow_network && skill_needs_network;
        out
    }
}
```

### 3.6 新增 `src-tauri/src/harness/staging.rs`（产物与 Wiki Diff 暂存审阅）

```rust
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use similar::TextDiff;
use std::fs;
use std::path::Path;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedDiff {
    pub id: String,
    pub run_id: String,
    pub target_kind: String, // "workspace_file" | "brain_note"
    pub target_ref: String,
    pub base_sha256: String,
    pub proposed_content: String,
    pub unified_diff: String,
    pub rationale: String,
    pub status: String,      // "pending" | "accepted" | "rejected"
    pub created_at: i64,
}

fn sha256_hex(text: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(text.as_bytes());
    format!("{:x}", hasher.finalize())
}

pub fn create_staged_diff(
    conn: &Connection,
    run_id: &str,
    target_kind: &str,
    target_ref: &str,
    original_content: &str,
    proposed_content: &str,
    rationale: &str,
    now_ms: i64,
) -> Result<StagedDiff, String> {
    let id = uuid::Uuid::new_v4().to_string();
    let base_sha256 = sha256_hex(original_content);
    let unified_diff = TextDiff::from_lines(original_content, proposed_content)
        .unified_diff()
        .header("current", "proposed")
        .to_string();

    conn.execute(
        "INSERT INTO staged_diffs
         (id, run_id, target_kind, target_ref, base_sha256, proposed_content, unified_diff, rationale, status, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending', ?9)",
        params![id, run_id, target_kind, target_ref, base_sha256, proposed_content, unified_diff, rationale, now_ms],
    )
    .map_err(|e| e.to_string())?;

    Ok(StagedDiff {
        id,
        run_id: run_id.to_string(),
        target_kind: target_kind.to_string(),
        target_ref: target_ref.to_string(),
        base_sha256,
        proposed_content: proposed_content.to_string(),
        unified_diff,
        rationale: rationale.to_string(),
        status: "pending".to_string(),
        created_at: now_ms,
    })
}

pub fn resolve_staged_diff(
    conn: &Connection,
    diff_id: &str,
    accept: bool,
    now_ms: i64,
) -> Result<StagedDiff, String> {
    let diff = conn
        .query_row(
            "SELECT id, run_id, target_kind, target_ref, base_sha256, proposed_content, unified_diff, rationale, status, created_at
             FROM staged_diffs WHERE id = ?1",
            params![diff_id],
            |r| {
                Ok(StagedDiff {
                    id: r.get(0)?,
                    run_id: r.get(1)?,
                    target_kind: r.get(2)?,
                    target_ref: r.get(3)?,
                    base_sha256: r.get(4)?,
                    proposed_content: r.get(5)?,
                    unified_diff: r.get(6)?,
                    rationale: r.get(7)?,
                    status: r.get(8)?,
                    created_at: r.get(9)?,
                })
            },
        )
        .map_err(|e| format!("未找到暂存 Diff: {e}"))?;

    if diff.status != "pending" {
        return Err("该 Diff 已被处理".to_string());
    }

    if accept && diff.target_kind == "workspace_file" {
        let path = Path::new(&diff.target_ref);
        let current = fs::read_to_string(path).unwrap_or_default();
        if sha256_hex(&current) != diff.base_sha256 {
            return Err("目标文件在暂存后已被外部修改，请重新生成 Diff".to_string());
        }
        fs::write(path, &diff.proposed_content).map_err(|e| format!("写入文件失败: {e}"))?;
    }

    let next_status = if accept { "accepted" } else { "rejected" };
    conn.execute(
        "UPDATE staged_diffs SET status = ?1, resolved_at = ?2 WHERE id = ?3",
        params![next_status, now_ms, diff_id],
    )
    .map_err(|e| e.to_string())?;

    Ok(StagedDiff {
        status: next_status.to_string(),
        ..diff
    })
}
```

### 3.7 新增 `src-tauri/src/harness/mod.rs`、`llm_provider.rs` 与 `engine.rs`

```rust
// src-tauri/src/harness/mod.rs
pub mod engine;
pub mod llm_provider;
pub mod policy;
pub mod staging;

use serde::{Deserialize, Serialize};
use policy::PermissionManifest;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum BackendKind {
    LocalCli,
    ApiKey,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessRunRequest {
    pub title: String,
    pub prompt: String,
    pub backend_kind: BackendKind,
    pub backend_id: String,
    pub model_override: Option<String>,
    pub seed_note_id: Option<String>,
    pub skill_id: Option<String>,
    pub attached_log_session_ids: Vec<String>,
    pub permissions: PermissionManifest,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum HarnessEvent {
    ContextActivated {
        run_id: String,
        activated_note_ids: Vec<String>,
        activated_skill_ids: Vec<String>,
        attached_log_count: usize,
    },
    TokenDelta {
        run_id: String,
        delta: String,
    },
    ToolCall {
        run_id: String,
        tool_name: String,
        summary: String,
        allowed: bool,
    },
    DiffProposed {
        run_id: String,
        diff_id: String,
        target_kind: String,
        target_ref: String,
    },
    RunStatusChanged {
        run_id: String,
        status: String,
        token_in: i64,
        token_out: i64,
        cost_usd: f64,
    },
}
```

**`harness/engine.rs` 编排主流程（执行 Agent 按此 5 步实现）**：

1. **创建 Run 记录**：向 `harness_runs` 写入 `status = 'running'`，并通过 `app_handle.emit("harness:event", ...)` 广播。
2. **大脑上下文编译**：若 `seed_note_id` 存在，调用现有 `context_compiler.rs` 获取 `BrainContextPacket`；对 `attached_log_session_ids` 从 `external_agent_sessions` 读取压缩 `summary`；若绑定 `skill_id` 则加载 `system_prompt` 并做权限交集；推送 `HarnessEvent::ContextActivated`。
3. **双引擎分发**：
   - `BackendKind::LocalCli`：把编译好的上下文写入任务临时目录，复用现有 `agent_runner.rs`（含 Windows `process_job.rs`）启动本地 CLI，把 `stdout/stderr` 增量转为 `HarnessEvent::TokenDelta`。
   - `BackendKind::ApiKey`：从 `provider_store::load_secret_key(&req.backend_id)` 取密钥，调用 `llm_provider.rs` 启动受控 ReAct 循环（最多 `permissions.max_steps` 步），开放 5 个受控工具：`read_workspace_file`、`propose_file_write`、`search_notes`、`search_agent_logs`、`propose_note_update`。
4. **状态流转**：若产生待审阅的 `staged_diffs`，状态置为 `review_ready`；否则置为 `completed`。
5. **大脑记忆回流**：任务完成后自动插入一条 `EpisodicEvent` 到海马体；若使用了 `skill_id`，递增 `usage_count`（审阅通过后递增 `success_count`）。

### 3.8 `src-tauri/src/main.rs` 新增注册命令清单

在 `tauri::generate_handler![]` 中追加以下命令（不删除已有命令）：

- **Provider / API Key**：`provider_list`、`provider_upsert`、`provider_delete`、`provider_test_connection`
- **Local Agent Logs**：`agent_logs_scan`、`agent_logs_list`、`agent_logs_get_messages`、`agent_logs_search`、`agent_logs_send_to_hippocampus`
- **Harness & Staging**：`harness_start_run`、`harness_cancel_run`、`harness_list_runs`、`harness_get_events`、`staging_list_diffs`、`staging_resolve_diff`

---

## 4. TypeScript 共享类型与状态改造

### 4.1 新增 `src/shared/harness.ts`

```ts
export type ActiveView = 'workbench' | 'brain' | 'library' | 'skills' | 'settings';

export type ProviderKind = 'openai' | 'anthropic' | 'gemini' | 'openai_compatible';
export type ModelRole = 'workbench_chat' | 'brain_consolidator' | 'embedding';
export type BackendKind = 'local_cli' | 'api_key';

export interface ProviderConfig {
  id: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  defaultModel: string;
  roles: ModelRole[];
  keyHint: string;
  inputPricePer1m: number;
  outputPricePer1m: number;
  enabled: boolean;
  updatedAt: number;
}

export interface UpsertProviderInput {
  id?: string;
  name: string;
  kind: ProviderKind;
  baseUrl: string;
  defaultModel: string;
  roles: ModelRole[];
  apiKey?: string;
  inputPricePer1m: number;
  outputPricePer1m: number;
  enabled: boolean;
}

export interface ExternalAgentSession {
  id: string;
  sourceTool: string;
  sourcePath: string;
  workspaceCwd: string;
  title: string;
  summary: string;
  messageCount: number;
  updatedAt: number;
}

export interface ExternalAgentMessage {
  id: string;
  sessionId: string;
  seq: number;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  toolName?: string;
  touchedFiles: string[];
  createdAt: number;
}

export interface PermissionManifest {
  readableNoteIds: string[];
  allowAllNotesRead: boolean;
  readableLogSessionIds: string[];
  writableDirs: string[];
  allowBrainNotePropose: boolean;
  allowShell: boolean;
  allowNetwork: boolean;
  maxSteps: number;
  maxBudgetUsd: number;
}

export interface HarnessRunRequest {
  title: string;
  prompt: string;
  backendKind: BackendKind;
  backendId: string;
  modelOverride?: string;
  seedNoteId?: string;
  skillId?: string;
  attachedLogSessionIds: string[];
  permissions: PermissionManifest;
}

export interface StagedDiff {
  id: string;
  runId: string;
  targetKind: 'workspace_file' | 'brain_note';
  targetRef: string;
  baseSha256: string;
  proposedContent: string;
  unifiedDiff: string;
  rationale: string;
  status: 'pending' | 'accepted' | 'rejected';
  createdAt: number;
}

export type HarnessEvent =
  | {
      kind: 'context_activated';
      runId: string;
      activatedNoteIds: string[];
      activatedSkillIds: string[];
      attachedLogCount: number;
    }
  | { kind: 'token_delta'; runId: string; delta: string }
  | { kind: 'tool_call'; runId: string; toolName: string; summary: string; allowed: boolean }
  | { kind: 'diff_proposed'; runId: string; diffId: string; targetKind: string; targetRef: string }
  | { kind: 'run_status_changed'; runId: string; status: string; tokenIn: number; tokenOut: number; costUsd: number };
```

### 4.2 扩展 `src/renderer/src/store.ts`

保留现有 [store.ts](https://www.google.com/search?q=https://github.com/fundops-notes/plate-workbench/blob/d6eccf45e468a7ba5cdba7d29e77ff9a238c5407/tauri-migration/source/src/renderer/src/store.ts) 中的 `theme`、`sidebarCollapsed`、`sidebarWidth`、`noteDrawerWidth`、`agentCollapsed`，仅追加以下切片字段与方法：

```ts
import type { ActiveView } from '../../shared/harness';

export interface WorkbenchV2Slice {
  activeView: ActiveView;
  activeRunId: string | null;
  pendingDiffCount: number;
  draftAttachedLogIds: string[];
  inspectorOpen: boolean; // 右侧产物/Diff 面板默认折叠，有 Diff 或点击图标才展开
  setActiveView: (view: ActiveView) => void;
  setActiveRunId: (runId: string | null) => void;
  setPendingDiffCount: (count: number) => void;
  toggleInspector: () => void;
  attachLogToWorkbench: (sessionId: string) => void;
  clearDraftAttachedLogs: () => void;
}
```

---

## 5. UI 视觉精修、减按钮原则与统一开源图标库规范

当前版本界面显简陋的主要原因是**文字按钮过多、图标风格不统一、工具栏堆砌且缺少层级留白**。参考 [Atlasnote Pro](https://atlasnote.ai/zh-CN/features) 的克制桌面设计，执行 Agent 必须严格按以下规范重构界面：

### 5.1 统一引入 GitHub 开源图标库：`lucide-react`

- **选型理由**：[lucide-icons/lucide](https://github.com/lucide-icons/lucide)（ISC 开源协议，2000+ 矢量图标，全量支持 Tree-shaking，线条统一干净，最贴合 macOS / Linear / Atlasnote 风格；如需双色激活态也可选 [phosphor-icons/react](https://github.com/phosphor-icons/react)）。
- **安装命令**（在 `tauri-migration/source/` 下执行）：
  ```bash
  npm install lucide-react
  ```
- **统一封装出口（新增 `src/renderer/src/components/icons.tsx`）**：禁止各页面零散手写 `<svg>` 或使用 emoji 替代图标；统一从 `icons.tsx` 导入并锁定视觉规范（默认 `strokeWidth={1.65}`，尺寸仅限 `14 / 16 / 18` 三档）：

```tsx
// src/renderer/src/components/icons.tsx
export {
  // 主导航（52px ActivityRail）
  LayoutGrid as IconWorkbench,
  Brain as IconBrain,
  BookOpen as IconLibrary,
  Wand2 as IconSkills,
  SlidersHorizontal as IconSettings,
  // 工作台复合输入岛 & 任务流
  Plus as IconNew,
  ArrowUp as IconSend,
  Square as IconStop,
  Paperclip as IconAttachNote,
  TerminalSquare as IconAttachLog,
  FolderLock as IconPermission,
  Cpu as IconModel,
  Sparkles as IconDream,
  GitCompare as IconDiff,
  PanelRight as IconInspector,
  // 通用微操作（全部纯图标按钮，hover 显提示）
  Search as IconSearch,
  RefreshCw as IconRefresh,
  Check as IconAccept,
  X as IconReject,
  MoreHorizontal as IconMore,
  KeyRound as IconApiKey,
  ShieldCheck as IconShield,
  ChevronRight as IconChevron,
} from 'lucide-react';
export type { LucideIcon } from 'lucide-react';
```

### 5.2 重构全局 `<IconAction>`（改造现有 `src/renderer/src/icon-action.tsx`）

用统一的 28×28px 无边框纯图标按钮替换页面里散落的文字按钮，仅在 hover/active 时出现低对比底色，并通过原生 `title` 或轻量 Tooltip 展示名称与快捷键：

```tsx
// src/renderer/src/icon-action.tsx（改造参考）
import React from 'react';
import type { LucideIcon } from './components/icons';

interface IconActionProps {
  icon: LucideIcon;
  label: string;
  shortcut?: string;
  active?: boolean;
  danger?: boolean;
  badge?: number;
  size?: 14 | 16 | 18;
  disabled?: boolean;
  onClick?: () => void;
}

export const IconAction: React.FC<IconActionProps> = ({
  icon: Icon,
  label,
  shortcut,
  active = false,
  danger = false,
  badge,
  size = 16,
  disabled = false,
  onClick,
}) => {
  const tip = shortcut ? `${label} (${shortcut})` : label;
  return (
    <button
      type="button"
      className={[
        'plate-icon-btn',
        active ? 'is-active' : '',
        danger ? 'is-danger' : '',
      ].filter(Boolean).join(' ')}
      title={tip}
      aria-label={label}
      disabled={disabled}
      onClick={onClick}
    >
      <Icon size={size} strokeWidth={1.65} />
      {badge !== undefined && badge > 0 && (
        <span className="plate-icon-badge">{badge > 99 ? '99+' : badge}</span>
      )}
    </button>
  );
};
```

### 5.3 “减按钮”重构清单（每个区域严格限制可见控件数量）

| 界面区域 | 旧版/常见臃肿做法（禁止） | S10 极简重构要求（对齐 Atlasnote Pro） |
| :--- | :--- | :--- |
| **左侧主导航 `ActivityRail`** | 宽侧边栏 + 图标配长中文按钮 + 多个独立入口 | 收敛为 **52px 极窄纯图标栏**：顶部仅放 4 个核心图标（工作台、大脑、资料与记录、技能），底部固定 1 个设置图标；激活项用左侧 2px 指示条 + 图标高亮，不显示常驻文字。 |
| **顶部 Header 工具栏** | 一整排“新建 / 刷新 / 扫描 / 导出 / 折叠 / 帮助 / 费用 / 设置”文字按钮 | **取消冗余顶部大工具栏**：仅保留极简 40px 顶栏（左侧当前视图标题/面包屑，右侧最多 2 个图标：`IconSearch` 唤起命令面板、`IconInspector` 折叠右侧 Diff 抽屉），其余低频操作全部收进命令面板（`palette.tsx`）或 `IconMore` 菜单。 |
| **工作台输入区（Composer Island）** | 表单式选择框 + 顶部/侧边堆叠“选择笔记 / 选择日志 / 配置权限 / 选模型 / 运行”按钮 | 收口为一个居中圆角 **复合输入岛**：输入框下方左排仅放 4 个轻量图标触发器（`IconAttachNote`、`IconAttachLog`、`IconPermission`、`IconModel`），选中项显示为可点 `×` 去除的小胶囊；右排仅放 1 个圆形实心主按钮（运行 `IconSend` / 停止 `IconStop`）。 |
| **大脑 HUD (`brain-workbench.tsx`)** | 多个大按钮平铺在图谱上方遮挡画布 | 收敛为右下角悬浮胶囊条，仅保留 3 个图标动作：分区切换、活力热力开关、`IconDream`（做梦整理），其余操作通过节点右键或 `quick-node-popover.tsx` 触发。 |
| **列表项操作（任务/本机记录/技能）** | 每行常驻“查看 / 引用 / 送入海马体 / 编辑 / 删除”一排文字按钮 | **默认零按钮**：列表行只显示标题、来源小图标与时间；仅在 **Hover 当前行** 时右侧浮现最多 2 个高频纯图标（如“引用到工作台”与“送入海马体”），删除/重命名折叠进 `IconMore`。 |
| **Diff 审阅抽屉** | 大段文字说明配多个表单按钮 | 每条变更卡片头部只展示文件路径 + 两个纯图标按钮（`IconAccept` 接受、`IconReject` 拒绝），正文直接展示简洁的红绿 Unified Diff。 |

### 5.4 52px 极窄纯图标 `ActivityRail` 与 `layout.tsx` 代码

```tsx
// src/renderer/src/components/activity-rail.tsx
import React from 'react';
import type { ActiveView } from '../../../shared/harness';
import { useWorkbench } from '../store';
import { IconAction } from '../icon-action';
import {
  IconWorkbench,
  IconBrain,
  IconLibrary,
  IconSkills,
  IconSettings,
  type LucideIcon,
} from './icons';

const PRIMARY_NAV: Array<{ id: ActiveView; icon: LucideIcon; label: string; shortcut: string }> = [
  { id: 'workbench', icon: IconWorkbench, label: '工作台', shortcut: '⌘1' },
  { id: 'brain', icon: IconBrain, label: '大脑与记忆', shortcut: '⌘2' },
  { id: 'library', icon: IconLibrary, label: '资料与本机记录', shortcut: '⌘3' },
  { id: 'skills', icon: IconSkills, label: '技能', shortcut: '⌘4' },
];

export const ActivityRail: React.FC = () => {
  const activeView = useWorkbench((s) => s.activeView);
  const pendingDiffCount = useWorkbench((s) => s.pendingDiffCount);
  const setActiveView = useWorkbench((s) => s.setActiveView);

  return (
    <aside className="plate-activity-rail" aria-label="主导航">
      <div className="rail-group">
        {PRIMARY_NAV.map((item) => (
          <IconAction
            key={item.id}
            icon={item.icon}
            label={item.label}
            shortcut={item.shortcut}
            size={18}
            active={activeView === item.id}
            badge={item.id === 'workbench' ? pendingDiffCount : undefined}
            onClick={() => setActiveView(item.id)}
          />
        ))}
      </div>
      <div className="rail-footer">
        <IconAction
          icon={IconSettings}
          label="模型与权限设置"
          shortcut="⌘,"
          size={18}
          active={activeView === 'settings'}
          onClick={() => setActiveView('settings')}
        />
      </div>
    </aside>
  );
};
```

在 [layout.tsx](https://www.google.com/search?q=https://github.com/fundops-notes/plate-workbench/blob/d6eccf45e468a7ba5cdba7d29e77ff9a238c5407/tauri-migration/source/src/renderer/src/layout.tsx) 中，索引就绪后改为按 `activeView` 切换渲染（保留现有 `NotesWorkspace` 与 `BrainWorkbench`）：

```tsx
const activeView = useWorkbench((s) => s.activeView);

return (
  <div className="plate-shell">
    <ActivityRail />
    <main className="plate-shell-main">
      {activeView === 'workbench' && <WorkbenchView />}
      {activeView === 'brain' && <BrainWorkbench />}
      {activeView === 'library' && <LibraryAndLogsView />}
      {activeView === 'skills' && <SkillsView />}
      {activeView === 'settings' && <SettingsView />}
    </main>
  </div>
);
```

### 5.5 极简桌面视觉 Token（新增 `src/renderer/src/styles/workbench-shell.css`）

```css
:root {
  --surface-rail: #F5F6F8;
  --surface-sidebar: #FAFAFB;
  --surface-canvas: #FFFFFF;
  --surface-hover: rgba(15, 23, 42, 0.055);
  --surface-active: rgba(37, 99, 235, 0.10);
  --border-subtle: rgba(15, 23, 42, 0.08);
  --text-primary: #111827;
  --text-secondary: #4B5563;
  --text-muted: #6B7280;
  --accent-primary: #2563EB;
  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 14px;
}

.plate-shell {
  display: grid;
  grid-template-columns: 52px minmax(0, 1fr);
  height: 100vh;
  background: var(--surface-canvas);
  color: var(--text-primary);
}

.plate-activity-rail {
  display: flex;
  flex-direction: column;
  justify-content: space-between;
  align-items: center;
  padding: 12px 0;
  background: var(--surface-rail);
  border-right: 1px solid var(--border-subtle);
}

.rail-group,
.rail-footer {
  display: flex;
  flex-direction: column;
  gap: 6px;
  align-items: center;
}

.plate-icon-btn {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease;
}

.plate-icon-btn:hover:not(:disabled) {
  background: var(--surface-hover);
  color: var(--text-primary);
}

.plate-icon-btn.is-active {
  background: var(--surface-active);
  color: var(--accent-primary);
}

.plate-icon-badge {
  position: absolute;
  top: 2px;
  right: 2px;
  min-width: 14px;
  height: 14px;
  padding: 0 3px;
  border-radius: 999px;
  background: var(--accent-primary);
  color: #FFFFFF;
  font-size: 10px;
  font-weight: 600;
  line-height: 14px;
  text-align: center;
}
```

### 5.6 四个新前端视图的组件结构契约

| 视图文件 | 极简布局结构 | 必须调用的 IPC / 复用组件 |
| :--- | :--- | :--- |
| `views/workbench-view.tsx` | 左 240px 历史任务列表（默认无按钮，hover 显示操作图标） / 中间主画布（对话与 `BrainActivationWave` 紧凑胶囊 + 底部居中复合输入岛） / 右侧可折叠 Diff 抽屉（默认折叠，产生 `StagedDiff` 时点亮徽标） | `harness_start_run`、`harness_list_runs`、`harness_get_events`、`staging_list_diffs`、`staging_resolve_diff`，监听 `harness:event` |
| `views/library-and-logs-view.tsx` | 顶部极简双段分段控件（`本地笔记` / `本机记录`）：前者直接挂载现有 `NotesWorkspace`；后者左侧会话列表（来源图标 + 标题 + 时间，hover 显 `IconWorkbench` 引用与 `IconBrain` 送入海马体），右侧阅读区 | `agent_logs_scan`、`agent_logs_list`、`agent_logs_get_messages`、`agent_logs_search`、`agent_logs_send_to_hippocampus` |
| `views/skills-view.tsx` | 左列表 + 右极简编辑区：展示现有 `memory_consolidator.rs` 沉淀的 `Skill`（`title`、`tags`、`preferred_agent_id`、`system_prompt`、`usage_count/success_count`），右上角仅放 `IconNew` 与 `IconMore`（导入 `SKILL.md`） | 复用现有 `brain` 技能 IPC 命令 + `setActiveView('workbench')` |
| `views/settings-view.tsx` | 左窄分类目录 + 右表单画布：① 本机 CLI Agent（复用 `agent-settings.tsx`）；② BYOK API Key 服务商与角色路由；③ 本机日志扫描目录；④ 默认 `PermissionManifest` 沙箱上限 | `provider_list`、`provider_upsert`、`provider_delete`、`provider_test_connection` |

---

## 6. 执行 Agent 分阶段实施与验收顺序

请执行 Agent 严格按 M1 -> M4 顺序提交，每完成一个里程碑必须跑通构建与单测后再进入下一阶段：

| 里程碑 | 执行任务 | 验收标准（DoD） |
| :--- | :--- | :--- |
| **M1 · 极简图标壳层与 BYOK 基础** | 1. 安装 `lucide-react`，创建 `components/icons.tsx`、重构 `icon-action.tsx`、新增 `workbench-shell.css` 与 52px `ActivityRail`；<br>2. 更新 `Cargo.toml`、`db.rs` 建表与 `provider_store.rs`；<br>3. 改造 `store.ts`、`layout.tsx` 与 `settings-view.tsx`。 | `cargo check` 与 `npm run build` 通过；界面无成排冗余文字按钮且图标风格统一来自 `lucide-react`；设置页可保存/更新 BYOK API Key 且 SQLite 不含明文密钥；原有 `BrainWorkbench` 与 `NotesWorkspace` 切换正常。 |
| **M2 · 本机 Agent 记录采集** | 1. 实现 `agent_log_harvester.rs`（Claude Code / Codex / 自定义 JSONL）与 FTS5 检索；<br>2. 注册 `agent_logs_*` 命令与 `agent_logs_send_to_hippocampus`；<br>3. 实现 `library-and-logs-view.tsx`（列表行默认无按钮，hover 显图标）并接通 `tauri-bridge.ts`。 | 单元测试覆盖 Claude Code 与 Codex 样本 JSONL 解析；点击扫描图标可入库并支持关键词 FTS5 检索；hover 点击 `IconBrain` 后在 `BrainWorkbench` 的 `EpisodicLane` 可见新增情景事件。 |
| **M3 · 统一 Harness 与双引擎** | 1. 实现 `harness/policy.rs`、`harness/staging.rs`、`harness/llm_provider.rs` 与 `harness/engine.rs`；<br>2. 将现有 `agent_runner.rs` 接入 `BackendKind::LocalCli`；<br>3. 实现 `workbench-view.tsx`（复合输入岛 + 可折叠 Diff 抽屉 + 实时流式事件）。 | `policy.rs` 路径穿越与越权写入单测通过；分别用本机 CLI 与 API Key 发起任务均可流式输出并落库 `harness_runs`；Agent 写入文件只生成 `staged_diffs` 而未直接覆盖磁盘。 |
| **M4 · 大脑闭环与技能面板** | 1. 扩展 `context_compiler.rs` 合并 `@log` 摘要并在工作台展示 `BrainActivationWave`；<br>2. 接通 `staging_resolve_diff` 审阅更新 `brain_note` 并触发 `vitality_engine::recalculate`；<br>3. 让 `memory_consolidator.rs` 支持调用 `BrainConsolidator` 角色 API 模型执行“做梦整理”；<br>4. 实现 `skills-view.tsx` 并按第 5.3 节精简 `BrainHudBar`。 | 完整跑通闭环：引用本机记录 -> 发起工作台任务 -> 实时看到激活的长期记忆节点 -> 审阅通过 Diff 写入笔记 -> 活力分更新并回写 `EpisodicEvent` 与 `Skill` 统计；全应用无杂乱 emoji/手写按钮，Playwright 冒烟无报错。 |
