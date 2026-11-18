// 任务执行引擎：tokio 异步状态机，stdout/stderr 250ms 节流写入 log_tail，
// 退出后 PENDING(review_ready) / ERROR，并通过 `task:state-changed` 通知前端。
use rusqlite::Connection;
use serde::Serialize;
use std::collections::HashMap;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, async_runtime};
use tokio::io::AsyncReadExt;
use tokio::process::Command;

pub const EVENT_TASK_STATE: &str = "task:state-changed";
const LOG_TAIL_LIMIT: usize = 4000;
const OUTPUT_LIMIT: usize = 200_000;
const RUN_TIMEOUT: Duration = Duration::from_secs(900);

#[derive(Serialize, Clone)]
pub struct TaskCard {
    #[serde(rename = "taskId")]
    pub task_id: String,
    #[serde(rename = "noteId")]
    pub note_id: String,
    #[serde(rename = "agentId")]
    pub agent_id: String,
    pub state: String,
    #[serde(rename = "pendingKind")]
    pub pending_kind: Option<String>,
    #[serde(rename = "promptText")]
    pub prompt_text: String,
    #[serde(rename = "outputDraft")]
    pub output_draft: String,
    #[serde(rename = "logTail")]
    pub log_tail: String,
    #[serde(rename = "errorMsg")]
    pub error_msg: Option<String>,
    #[serde(rename = "externalSessionId")]
    pub external_session_id: Option<String>,
    #[serde(rename = "startedAt")]
    pub started_at: Option<i64>,
    #[serde(rename = "endedAt")]
    pub ended_at: Option<i64>,
    #[serde(rename = "durationMs")]
    pub duration_ms: Option<i64>,
    #[serde(rename = "tokensUsed")]
    pub tokens_used: Option<i64>,
    #[serde(rename = "updatedAt")]
    pub updated_at: i64,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

fn tail(text: &str, limit: usize) -> String {
    if text.len() <= limit { return text.to_string() }
    let mut start = text.len() - limit;
    while start < text.len() && (text.as_bytes()[start] & 0xC0) == 0x80 { start += 1 }
    text[start..].to_string()
}

const CARD_COLUMNS: &str =
    "task_id, note_id, agent_id, state, pending_kind, prompt_text, output_draft, log_tail, \
     error_msg, external_session_id, started_at, ended_at, duration_ms, tokens_used, updated_at";

fn row_to_card(row: &rusqlite::Row<'_>) -> rusqlite::Result<TaskCard> {
    Ok(TaskCard {
        task_id: row.get(0)?,
        note_id: row.get(1)?,
        agent_id: row.get(2)?,
        state: row.get(3)?,
        pending_kind: row.get(4)?,
        prompt_text: row.get(5)?,
        output_draft: row.get(6)?,
        log_tail: row.get(7)?,
        error_msg: row.get(8)?,
        external_session_id: row.get(9)?,
        started_at: row.get(10)?,
        ended_at: row.get(11)?,
        duration_ms: row.get(12)?,
        tokens_used: row.get(13)?,
        updated_at: row.get(14)?,
    })
}

fn read_card(root: &PathBuf, task_id: &str) -> Result<TaskCard, String> {
    let conn = Connection::open(root.join("index.sqlite")).map_err(|e| e.to_string())?;
    conn.query_row(
        &format!("SELECT {CARD_COLUMNS} FROM task_runs WHERE task_id = ?1"),
        [task_id],
        row_to_card,
    )
    .map_err(|e| format!("任务不存在或读取失败：{e}"))
}

pub fn list_by_note(root: &PathBuf, note_id: &str) -> Result<Vec<TaskCard>, String> {
    let conn = Connection::open(root.join("index.sqlite")).map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare(&format!(
            "SELECT {CARD_COLUMNS} FROM task_runs WHERE note_id = ?1 ORDER BY updated_at DESC"
        ))
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([note_id], row_to_card)
        .map_err(|e| e.to_string())?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|e| e.to_string())
}

pub fn summary_by_notes(root: &PathBuf) -> Result<serde_json::Value, String> {
    let conn = Connection::open(root.join("index.sqlite")).map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT note_id, state, COUNT(*) FROM task_runs GROUP BY note_id, state")
        .map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, i64>(2)?))
        })
        .map_err(|e| e.to_string())?;
    let mut result: std::collections::BTreeMap<String, serde_json::Value> = Default::default();
    for row in rows {
        let (note_id, state, count) = row.map_err(|e| e.to_string())?;
        let entry = result.entry(note_id).or_insert_with(|| serde_json::json!({
            "todo": 0, "doing": 0, "pending": 0, "done": 0, "error": 0
        }));
        let key = state.to_lowercase();
        entry[&key] = serde_json::json!(entry[&key].as_i64().unwrap_or(0) + count);
    }
    Ok(serde_json::Value::Object(result.into_iter().collect()))
}

/// 适配器：把 agent 类型映射为无界面执行参数与环境变量。
fn build_invocation(agent_type: &str, prompt: &str) -> (Vec<String>, Vec<(String, String)>) {
    match agent_type {
        // dsh 桌面版自带 CLI：headless 档 + 全权限模式，稳定执行并捕获完整输出。
        "dsh" | "deepseek" | "deepseek-harness" => (
            vec!["--profile".into(), "headless".into(), prompt.into()],
            vec![("DSH_PERMISSION_MODE".into(), "danger-full-access".into())],
        ),
        "codex" => (
            vec!["exec".into(), "--skip-git-repo-check".into(), prompt.into()],
            vec![],
        ),
        "claude" => (
            vec!["-p".into(), prompt.into(), "--output-format".into(), "text".into()],
            vec![],
        ),
        "opencode" => (vec!["run".into(), prompt.into()], vec![]),
        _ => (vec![prompt.into()], vec![]),
    }
}

pub struct TaskEngine {
    handles: Mutex<HashMap<String, tauri::async_runtime::JoinHandle<()>>>,
}

impl TaskEngine {
    pub fn new() -> Self {
        Self { handles: Mutex::new(HashMap::new()) }
    }

    pub fn start(
        &self,
        app: AppHandle,
        root: PathBuf,
        task_id: String,
        note_id: String,
        agent_type: String,
        prompt: String,
    ) -> Result<TaskCard, String> {
        let executable = crate::agent_store::resolve(&agent_type)
            .ok_or_else(|| format!("本机未发现 {agent_type}，请先安装或在插件中心登记"))?;
        let conn = Connection::open(root.join("index.sqlite")).map_err(|e| e.to_string())?;
        let started = now_ms();
        conn.execute(
            "INSERT INTO task_runs (task_id, note_id, agent_id, state, pending_kind, prompt_text,
                output_draft, log_tail, error_msg, started_at, updated_at)
             VALUES (?1, ?2, ?3, 'DOING', NULL, ?4, '', '', NULL, ?5, ?5)
             ON CONFLICT(task_id) DO UPDATE SET state='DOING', pending_kind=NULL, prompt_text=?4,
                log_tail='', output_draft='', error_msg=NULL, started_at=?5, ended_at=NULL,
                duration_ms=NULL, updated_at=?5",
            rusqlite::params![task_id, note_id, agent_type, prompt, started],
        )
        .map_err(|e| e.to_string())?;
        let card = read_card(&root, &task_id)?;
        let handle = async_runtime::spawn(async move {
            run_task(app, root, task_id, agent_type, executable, prompt).await;
        });
        self.handles.lock().unwrap().insert(card.task_id.clone(), handle);
        Ok(card)
    }

    pub fn stop(&self, app: AppHandle, root: &PathBuf, task_id: &str) -> Result<TaskCard, String> {
        if let Some(handle) = self.handles.lock().unwrap().remove(task_id) {
            handle.abort();
        }
        let conn = Connection::open(root.join("index.sqlite")).map_err(|e| e.to_string())?;
        let ended = now_ms();
        conn.execute(
            "UPDATE task_runs SET state='TODO', pending_kind=NULL, error_msg='已手动停止，退回待办',
                ended_at=?2, updated_at=?2 WHERE task_id=?1 AND state IN ('DOING','PENDING')",
            rusqlite::params![task_id, ended],
        )
        .map_err(|e| e.to_string())?;
        let card = read_card(root, task_id)?;
        let _ = app.emit(EVENT_TASK_STATE, &card);
        Ok(card)
    }

    pub fn follow_up(&self, app: AppHandle, root: &PathBuf, task_id: &str, instruction: &str) -> Result<TaskCard, String> {
        let previous = read_card(root, task_id)?;
        let prompt = format!("{}\n\n补充指令：{}", previous.prompt_text, instruction);
        self.start(app, root.clone(), task_id.to_string(), previous.note_id, previous.agent_id, prompt)
    }

    pub fn mark_done(&self, app: AppHandle, root: &PathBuf, task_id: &str) -> Result<TaskCard, String> {
        let conn = Connection::open(root.join("index.sqlite")).map_err(|e| e.to_string())?;
        let ended = now_ms();
        conn.execute(
            "UPDATE task_runs SET state='DONE', pending_kind=NULL, ended_at=?2, updated_at=?2 WHERE task_id=?1",
            rusqlite::params![task_id, ended],
        )
        .map_err(|e| e.to_string())?;
        let card = read_card(root, task_id)?;
        let _ = app.emit(EVENT_TASK_STATE, &card);
        Ok(card)
    }

    pub fn reject(&self, app: AppHandle, root: &PathBuf, task_id: &str) -> Result<TaskCard, String> {
        let conn = Connection::open(root.join("index.sqlite")).map_err(|e| e.to_string())?;
        let updated = now_ms();
        conn.execute(
            "UPDATE task_runs SET state='TODO', pending_kind=NULL, updated_at=?2 WHERE task_id=?1",
            rusqlite::params![task_id, updated],
        )
        .map_err(|e| e.to_string())?;
        let card = read_card(root, task_id)?;
        let _ = app.emit(EVENT_TASK_STATE, &card);
        Ok(card)
    }
}

async fn drain_stream<R: tokio::io::AsyncRead + Unpin>(mut stream: R, sink: Arc<Mutex<String>>) {
    let mut buffer = vec![0u8; 4096];
    loop {
        match stream.read(&mut buffer).await {
            Ok(0) | Err(_) => break,
            Ok(read) => {
                let text = String::from_utf8_lossy(&buffer[..read]).into_owned();
                if let Ok(mut guard) = sink.lock() {
                    guard.push_str(&text);
                    if guard.len() > OUTPUT_LIMIT * 2 {
                        let cut = guard.len() - OUTPUT_LIMIT * 2;
                        guard.drain(..cut);
                    }
                }
            }
        }
    }
}

fn finalize(
    app: &AppHandle,
    root: &PathBuf,
    task_id: &str,
    state: &str,
    pending_kind: Option<&str>,
    error_msg: Option<&str>,
    output: &str,
) {
    let conn = match Connection::open(root.join("index.sqlite")) { Ok(c) => c, Err(_) => return };
    let ended = now_ms();
    let _ = conn.execute(
        "UPDATE task_runs SET state=?2, pending_kind=?3, error_msg=?4, output_draft=?5, log_tail=?7,
            ended_at=?6, duration_ms=?6 - started_at, updated_at=?6 WHERE task_id=?1",
        rusqlite::params![task_id, state, pending_kind, error_msg, tail(output, OUTPUT_LIMIT), ended, tail(output, LOG_TAIL_LIMIT)],
    );
    if let Ok(card) = read_card(root, task_id) {
        let _ = app.emit(EVENT_TASK_STATE, &card);
    }
}

async fn run_task(app: AppHandle, root: PathBuf, task_id: String, agent_type: String, executable: String, prompt: String) {
    let (argv, envs) = build_invocation(&agent_type, &prompt);
    let mut cmd = Command::new(&executable);
    cmd.args(&argv)
        .current_dir(&root)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    for (key, value) in &envs {
        cmd.env(key, value);
    }
    #[cfg(windows)]
    {
        // CREATE_NO_WINDOW：后台执行不弹终端窗。
        cmd.creation_flags(0x0800_0000);
    }
    let mut child = match cmd.spawn() {
        Ok(child) => child,
        Err(error) => {
            finalize(&app, &root, &task_id, "ERROR", None, Some(&format!("启动失败：{error}")), "");
            return;
        }
    };

    let collected: Arc<Mutex<String>> = Arc::new(Mutex::new(String::new()));
    let mut readers = Vec::new();
    if let Some(stream) = child.stdout.take() {
        let sink = collected.clone();
        readers.push(tokio::spawn(drain_stream(stream, sink)));
    }
    if let Some(stream) = child.stderr.take() {
        let sink = collected.clone();
        readers.push(tokio::spawn(drain_stream(stream, sink)));
    }

    let db = root.clone();
    let emitter = app.clone();
    let flush_task_id = task_id.clone();
    let flush_sink = collected.clone();
    let flush = tokio::spawn(async move {
        let mut last = String::new();
        loop {
            tokio::time::sleep(Duration::from_millis(250)).await;
            let snapshot = {
                let Ok(guard) = flush_sink.lock() else { continue };
                tail(&guard, LOG_TAIL_LIMIT)
            };
            if snapshot == last { continue }
            last = snapshot.clone();
            if let Ok(conn) = Connection::open(db.join("index.sqlite")) {
                let _ = conn.execute(
                    "UPDATE task_runs SET log_tail=?2, updated_at=?3 WHERE task_id=?1",
                    rusqlite::params![flush_task_id, snapshot, now_ms()],
                );
            }
            if let Ok(card) = read_card(&db, &flush_task_id) {
                let _ = emitter.emit(EVENT_TASK_STATE, &card);
            }
        }
    });

    let wait = child.wait();
    let status = tokio::time::timeout(RUN_TIMEOUT, wait).await;
    flush.abort();
    for reader in readers {
        let _ = reader.await;
    }
    let output = collected.lock().map(|guard| guard.clone()).unwrap_or_default();
    match status {
        Ok(Ok(exit)) if exit.success() => {
            finalize(&app, &root, &task_id, "PENDING", Some("review_ready"), None, &output);
        }
        Ok(Ok(exit)) => {
            finalize(&app, &root, &task_id, "ERROR", None,
                Some(&format!("进程退出码 {}，输出见日志", exit.code().unwrap_or(-1))), &output);
        }
        Ok(Err(error)) => {
            finalize(&app, &root, &task_id, "ERROR", None, Some(&format!("执行失败：{error}")), &output);
        }
        Err(_) => {
            let _ = child.kill().await;
            finalize(&app, &root, &task_id, "ERROR", None, Some("执行超时（15 分钟），进程已终止"), &output);
        }
    }
}


