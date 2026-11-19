// 任务执行引擎：tokio 异步状态机，stdout/stderr 250ms 节流写入 log_tail，
// 退出后 PENDING(review_ready) / ERROR，并通过 `task:state-changed` 通知前端。
use rusqlite::{params, Connection};
use crate::notes::NoteStore;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, async_runtime};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::process::Command;
use tokio::sync::{oneshot, watch};

pub const EVENT_TASK_STATE: &str = "task:state-changed";
const LOG_TAIL_LIMIT: usize = 4000;
const OUTPUT_LIMIT: usize = 200_000;
const RUN_TIMEOUT: Duration = Duration::from_secs(900);
const CLEANUP_TIMEOUT: Duration = Duration::from_secs(4);
const INSTRUCTION_LIMIT: usize = 24_000;

#[derive(Serialize, Deserialize)]
struct FollowContext {
    task: String,
    instructions: Vec<String>,
}

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
    #[serde(rename = "memoryDelta", skip_serializing_if = "Option::is_none")]
    pub memory_delta: Option<serde_json::Value>,
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
    #[serde(skip)]
    follow_context: Option<String>,
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
     error_msg, external_session_id, started_at, ended_at, duration_ms, tokens_used, updated_at, follow_context";

fn row_to_card(row: &rusqlite::Row<'_>) -> rusqlite::Result<TaskCard> {
    let state: String = row.get(3)?;
    let raw: String = row.get(6)?;
    let proposal = matches!(state.as_str(), "PENDING" | "DONE")
        .then(|| crate::memory_consolidator::parse_delta_from_output(&raw)).flatten();
    let (output_draft, memory_delta) = match proposal {
        Some((body, delta)) => (body.to_owned(), serde_json::to_value(delta).ok()),
        None => (raw, None),
    };
    Ok(TaskCard {
        task_id: row.get(0)?,
        note_id: row.get(1)?,
        agent_id: row.get(2)?,
        state,
        pending_kind: row.get(4)?,
        prompt_text: row.get(5)?,
        output_draft,
        memory_delta,
        log_tail: row.get(7)?,
        error_msg: row.get(8)?,
        external_session_id: row.get(9)?,
        started_at: row.get(10)?,
        ended_at: row.get(11)?,
        duration_ms: row.get(12)?,
        tokens_used: row.get(13)?,
        updated_at: row.get(14)?,
        follow_context: row.get(15)?,
    })
}

fn read_card(root: &Path, task_id: &str) -> Result<TaskCard, String> {
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

pub fn summary_by_notes(root: &Path) -> Result<serde_json::Value, String> {
    let conn = Connection::open(root.join("index.sqlite")).map_err(|e| e.to_string())?;
    let mut stmt = conn
        .prepare("SELECT note_id, state, COUNT(*) FROM task_runs WHERE state <> 'TODO' GROUP BY note_id, state")
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

// Called only after the caller has acquired the workspace's exclusive lease.
pub fn recover_interrupted(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "UPDATE task_runs SET
            state=CASE WHEN review_prompt IS NULL THEN 'ERROR' ELSE 'PENDING' END,
            pending_kind=CASE WHEN review_prompt IS NULL THEN NULL ELSE 'review_ready' END,
            prompt_text=COALESCE(review_prompt,prompt_text), review_prompt=NULL,
            error_msg='上次运行随 Plate 退出而中断', ended_at=?1,
            duration_ms=MAX(0,?1-started_at), updated_at=?1 WHERE state='DOING'",
        [now_ms()],
    ).map_err(|error| error.to_string())?;
    Ok(())
}

fn prepare_follow(previous: &TaskCard, instruction: &str) -> Result<(String, String), String> {
    let instruction = instruction.trim();
    if instruction.is_empty() { return Err("请输入修改意见".into()); }
    let mut context = match &previous.follow_context {
        Some(value) => serde_json::from_str::<FollowContext>(value).map_err(|error| error.to_string())?,
        None => FollowContext { task: previous.prompt_text.clone(), instructions: vec![] },
    };
    let size = context.instructions.iter().map(String::len).sum::<usize>() + instruction.len();
    if size > INSTRUCTION_LIMIT { return Err("追加意见已超过长度上限，请采纳结果后新建任务".into()); }
    let mut prompt = context.task.clone();
    for prior in &context.instructions {
        prompt.push_str("\n\n先前修改意见：\n");
        prompt.push_str(prior);
    }
    if !previous.output_draft.is_empty() {
        prompt.push_str("\n\n上一轮回答（供参考）：\n");
        prompt.push_str(&previous.output_draft);
    }
    prompt.push_str("\n\n补充指令：");
    prompt.push_str(instruction);
    context.instructions.push(instruction.to_string());
    Ok((prompt, serde_json::to_string(&context).map_err(|error| error.to_string())?))
}

fn build_command(route: &crate::agent_plugins::Route) -> Result<Command, String> {
    let mut command = Command::new(&route.executable);
    if let Some(args) = &route.args {
        let mut args = args.clone();
        let placement = args.iter().position(|arg| arg == "{model}");
        let index = placement.or_else(|| args.iter().position(|arg| arg == "--")).unwrap_or(args.len());
        let model = route.model_flag.as_ref().filter(|_| !route.selected_model.is_empty())
            .map(|flag| [flag.clone(), route.selected_model.clone()]);
        args.splice(index..index + usize::from(placement.is_some()), model.into_iter().flatten());
        crate::agent_plugins::validate_args(&route.executable, &args)?;
        command.args(args);
        return Ok(command);
    } else { match route.id.as_str() {
        "dsh" => { command.args(["--profile", "headless"]); }
        "codex" => { command.args(["exec", "--skip-git-repo-check"]); }
        "claude" => { command.args(["-p", "--output-format", "text"]); }
        "opencode" => { command.arg("run"); }
        _ => return Err(format!("不支持的 Agent：{}", route.id)),
    }}
    if let Some(flag) = route.model_flag.as_deref().filter(|_| !route.selected_model.is_empty()) {
        command.args([flag, &route.selected_model]);
    }
    if route.id == "codex" { command.arg("-"); }
    Ok(command)
}

type RunKey = (PathBuf, String);
struct RunningTask {
    cancel: Option<oneshot::Sender<()>>,
    done: watch::Receiver<Option<Result<(), String>>>,
}

pub struct TaskEngine {
    running: Arc<Mutex<HashMap<RunKey, RunningTask>>>,
}

impl TaskEngine {
    pub fn new() -> Self {
        Self { running: Arc::new(Mutex::new(HashMap::new())) }
    }

    pub fn start(
        &self,
        app: AppHandle,
        store: &NoteStore,
        task_id: String,
        note_id: String,
        agent_type: Option<String>,
        prompt: String,
    ) -> Result<TaskCard, String> {
        self.launch(app, store, task_id, note_id, agent_type, prompt, None)
    }

    fn launch(
        &self, app: AppHandle, store: &NoteStore, task_id: String, note_id: String,
        agent_type: Option<String>, prompt: String, follow_context: Option<String>,
    ) -> Result<TaskCard, String> {
        let route = app.state::<crate::agent_plugins::AgentPlugins>().route(&app, agent_type.as_deref())?
            .ok_or("请先在「使用 / Agent」中启用并配置至少一个 Agent 插件")?;
        let mut command = build_command(&route)?;
        let agent_type = route.id;
        let deepseek_key = if agent_type == "dsh" {
            use crate::agent_settings::{AgentSettings, DSH_KEY_ENV, DSH_URL_ENV};
            let stored = app.state::<AgentSettings>().deepseek_key(&app)?;
            if let Some(key) = &stored { command.env(DSH_KEY_ENV, key); }
            if let Some(url) = route.base_url { command.env(DSH_URL_ENV, url); }
            stored.or_else(|| std::env::var(DSH_KEY_ENV).ok().filter(|key| !key.trim().is_empty()))
        } else {
            None
        };
        let root = store.root.clone();
        let key = (root.clone(), task_id.clone());
        let packet = crate::context_compiler::compile(store, &note_id, &task_id, &agent_type, &prompt)?;
        let mut running = self.running.lock().unwrap();
        if running.contains_key(&key) { return Err("此任务正在执行".into()) }
        let conn = store.conn.lock().unwrap();
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        let started = now_ms();
        let changed = if follow_context.is_some() {
            tx.execute(
                "UPDATE task_runs SET state='DOING', pending_kind=NULL,
                 review_prompt=prompt_text, prompt_text=?4, log_tail='', error_msg=NULL, started_at=?5, ended_at=NULL,
                 duration_ms=NULL, updated_at=?5 WHERE task_id=?1 AND note_id=?2
                 AND agent_id=?3 AND state='PENDING'",
                rusqlite::params![task_id, note_id, agent_type, prompt, started],
            )
        } else {
            tx.execute(
                "INSERT OR IGNORE INTO task_runs (task_id, note_id, agent_id, state, pending_kind,
                 prompt_text, output_draft, log_tail, error_msg, started_at, updated_at)
                 VALUES (?1, ?2, ?3, 'DOING', NULL, ?4, '', '', NULL, ?5, ?5)",
                rusqlite::params![task_id, note_id, agent_type, prompt, started],
            )
        }.map_err(|e| e.to_string())?;
        if changed != 1 { return Err("任务已存在或当前状态不允许续跑".into()) }
        if let Some(packet) = &packet {
            for id in packet.wave.activated_note_ids.iter().chain(std::iter::once(&note_id)) {
                crate::vitality_engine::boost(&tx, id, started).map_err(|e| e.to_string())?;
            }
            for id in &packet.wave.activated_skill_ids {
                tx.execute("UPDATE procedural_skills SET usage_count=usage_count+1 WHERE id=?1", [id])
                    .map_err(|e| e.to_string())?;
                tx.execute("INSERT OR IGNORE INTO brain_skill_usage(task_id,skill_id) VALUES(?1,?2)", params![task_id,id])
                    .map_err(|e| e.to_string())?;
            }
        }
        let card = tx.query_row(&format!("SELECT {CARD_COLUMNS} FROM task_runs WHERE task_id=?1"), [&task_id], row_to_card)
            .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        let (cancel, signal) = oneshot::channel();
        let (completed, done) = watch::channel(None);
        running.insert(key.clone(), RunningTask { cancel: Some(cancel), done });
        let _ = app.emit(EVENT_TASK_STATE, &card);
        let input = match packet {
            Some(packet) => {
                let _ = app.emit("brain://activation-wave", &packet.wave);
                let _ = app.emit("brain://changed", ());
                packet.compiled_prompt
            }
            None => prompt,
        };
        let registry = self.running.clone();
        async_runtime::spawn(async move {
            let result = run_task(
                &app, &root, &task_id, command, Some(input), signal,
                follow_context.as_deref(), &agent_type, deepseek_key.as_deref(),
            ).await;
            let mut running = registry.lock().unwrap();
            running.remove(&key);
            if let Ok(card) = &result { let _ = app.emit(EVENT_TASK_STATE, card); }
            let _ = completed.send(Some(result.map(|_| ())));
        });
        Ok(card)
    }

    pub fn has_running(&self, root: &Path) -> bool {
        self.running.lock().unwrap().keys().any(|(path, _)| path == root)
    }

    pub async fn stop(&self, root: &Path, task_id: &str) -> Result<TaskCard, String> {
        let done = {
            let mut running = self.running.lock().unwrap();
            running.get_mut(&(root.to_path_buf(), task_id.to_string())).map(|run| {
                if let Some(cancel) = run.cancel.take() { let _ = cancel.send(()); }
                run.done.clone()
            })
        };
        if let Some(mut done) = done {
            done.wait_for(Option::is_some).await
                .map_err(|_| "任务结束状态未能确认".to_string())?
                .as_ref().expect("completion value").clone()?;
        }
        let card = read_card(root, task_id)?;
        match card.state.as_str() {
            "TODO" => Ok(card),
            "PENDING" if card.error_msg.is_some() => Ok(card),
            "ERROR" => Err(card.error_msg.unwrap_or_else(|| "无法确认任务已停止".into())),
            _ => Err("任务已结束或不在当前进程中运行".into()),
        }
    }

    pub fn follow_up(&self, app: AppHandle, store: &NoteStore, task_id: &str, instruction: &str) -> Result<TaskCard, String> {
        let previous = read_card(&store.root, task_id)?;
        let (prompt, context) = prepare_follow(&previous, instruction)?;
        self.launch(app, store, task_id.to_string(), previous.note_id, Some(previous.agent_id), prompt, Some(context))
    }

    pub fn mark_done(&self, app: AppHandle, root: &PathBuf, task_id: &str) -> Result<TaskCard, String> {
        let conn = Connection::open(root.join("index.sqlite")).map_err(|e| e.to_string())?;
        let ended = now_ms();
        let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
        let changed = tx.execute(
            "UPDATE task_runs SET state='DONE', pending_kind=NULL, ended_at=?2, updated_at=?2 WHERE task_id=?1 AND state='PENDING'",
            params![task_id, ended],
        ).map_err(|e| e.to_string())?;
        if changed == 1 {
            tx.execute("UPDATE procedural_skills SET success_count=success_count+1 WHERE id IN
                (SELECT skill_id FROM brain_skill_usage WHERE task_id=?1)", [task_id]).map_err(|e| e.to_string())?;
        }
        let count: i64 = tx.query_row("SELECT COUNT(*) FROM task_runs WHERE state='DONE'", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
        let card = read_card(root, task_id)?;
        if card.state != "DONE" { return Err("此任务尚未进入审阅".into()); }
        let _ = app.emit(EVENT_TASK_STATE, &card);
        if changed == 1 {
            if count % 10 == 0 { let _ = crate::vitality_engine::recalculate(&conn, ended); }
            let _ = app.emit("brain://changed", ());
        }
        Ok(card)
    }

    pub fn reject(&self, app: AppHandle, root: &PathBuf, task_id: &str) -> Result<TaskCard, String> {
        let conn = Connection::open(root.join("index.sqlite")).map_err(|e| e.to_string())?;
        let updated = now_ms();
        let changed = conn.execute(
            "UPDATE task_runs SET state='TODO', pending_kind=NULL, updated_at=?2 WHERE task_id=?1 AND state IN ('PENDING','ERROR','TODO')",
            rusqlite::params![task_id, updated],
        )
        .map_err(|e| e.to_string())?;
        if changed != 1 { return Err("运行中的任务请先停止".into()) }
        let card = read_card(root, task_id)?;
        let _ = app.emit(EVENT_TASK_STATE, &card);
        Ok(card)
    }
}

async fn drain_stream<R: tokio::io::AsyncRead + Unpin>(mut stream: R, sink: &Mutex<Vec<u8>>) {
    let mut buffer = [0; 4096];
    loop {
        match stream.read(&mut buffer).await {
            Ok(0) | Err(_) => return,
            Ok(read) => {
                let mut bytes = sink.lock().unwrap();
                bytes.extend_from_slice(&buffer[..read]);
                let excess = bytes.len().saturating_sub(OUTPUT_LIMIT + 4);
                if excess != 0 { bytes.drain(..excess); }
            }
        }
    }
}

async fn write_prompt(stdin: Option<tokio::process::ChildStdin>, prompt: Option<String>) -> std::io::Result<()> {
    if let (Some(mut stdin), Some(prompt)) = (stdin, prompt) {
        stdin.write_all(prompt.as_bytes()).await?;
        stdin.shutdown().await?;
    }
    Ok(())
}

fn snapshot(sink: &Mutex<Vec<u8>>, limit: usize, report_truncation: bool) -> String {
    let bytes = sink.lock().unwrap();
    if report_truncation && bytes.len() > limit {
        let prefix = "[输出超出存储上限，保留末尾]\n";
        return format!("{prefix}{}", tail(&String::from_utf8_lossy(&bytes), limit - prefix.len()));
    }
    tail(&String::from_utf8_lossy(&bytes), limit)
}

fn log_snapshot(stdout: &Mutex<Vec<u8>>, stderr: &Mutex<Vec<u8>>) -> String {
    let stdout = snapshot(stdout, LOG_TAIL_LIMIT / 2, false);
    let stderr = snapshot(stderr, LOG_TAIL_LIMIT / 2, false);
    if stderr.is_empty() { stdout } else { format!("{stdout}\n{stderr}") }
}

fn publish_log(app: &AppHandle, root: &Path, task_id: &str, log: &str) {
    if let Ok(conn) = Connection::open(root.join("index.sqlite")) {
        let changed = conn.execute("UPDATE task_runs SET log_tail=?2, updated_at=?3 WHERE task_id=?1 AND state='DOING'",
            rusqlite::params![task_id, log, now_ms()]);
        if matches!(changed, Ok(1)) {
            if let Ok(card) = read_card(root, task_id) { let _ = app.emit(EVENT_TASK_STATE, &card); }
        }
    }
}

fn finalize(root: &Path, task_id: &str, state: &str, error: Option<&str>, output: &str, log: &str, follow_context: Option<&str>) -> Result<TaskCard, String> {
    let conn = Connection::open(root.join("index.sqlite")).map_err(|error| error.to_string())?;
    let pending_kind = (state == "PENDING").then_some("review_ready");
    let ended = now_ms();
    let changed = conn.execute(
        "UPDATE task_runs SET
         state=CASE WHEN review_prompt IS NOT NULL AND ?2<>'PENDING' THEN 'PENDING' ELSE ?2 END,
         pending_kind=CASE WHEN review_prompt IS NOT NULL THEN 'review_ready' ELSE ?3 END,
         error_msg=?4, log_tail=?7,
         output_draft=CASE WHEN review_prompt IS NOT NULL AND ?2<>'PENDING' THEN output_draft ELSE ?5 END,
         prompt_text=CASE WHEN review_prompt IS NOT NULL AND ?2<>'PENDING' THEN review_prompt ELSE prompt_text END,
         follow_context=CASE WHEN ?2='PENDING' THEN ?8 ELSE follow_context END, review_prompt=NULL,
         ended_at=?6, duration_ms=?6 - started_at, updated_at=?6 WHERE task_id=?1 AND state='DOING'",
        rusqlite::params![task_id, state, pending_kind, error, output, ended, log, follow_context],
    ).map_err(|error| error.to_string())?;
    if changed != 1 { return Err("任务已被其他操作更新".into()); }
    read_card(root, task_id)
}

#[derive(Debug)]
enum Outcome {
    Exit(std::io::Result<std::process::ExitStatus>),
    Cancelled,
    Timeout,
}

struct SupervisedOutput {
    outcome: Outcome,
    stdout: String,
    log: String,
    input: std::io::Result<()>,
}

async fn supervise(
    root: &Path, mut command: Command, prompt: Option<String>, mut cancel: oneshot::Receiver<()>,
    run_timeout: Duration, mut publish: impl FnMut(&str),
) -> Result<SupervisedOutput, String> {
    if cancel.try_recv().is_ok() {
        return Ok(SupervisedOutput { outcome: Outcome::Cancelled, stdout: String::new(), log: String::new(), input: Ok(()) });
    }
    command.current_dir(root)
        .kill_on_drop(true)
        .stdin(if prompt.is_some() { Stdio::piped() } else { Stdio::null() })
        .stdout(Stdio::piped()).stderr(Stdio::piped());
    #[cfg(windows)]
    let job = {
        use windows_sys::Win32::System::Threading::{CREATE_NO_WINDOW, CREATE_SUSPENDED};
        command.creation_flags(CREATE_NO_WINDOW | CREATE_SUSPENDED);
        crate::process_job::ProcessJob::new().map_err(|e| format!("无法建立任务进程组：{e}"))?
    };
    let mut child = command.spawn().map_err(|e| format!("启动失败：{e}"))?;
    #[cfg(windows)]
    if let Err(error) = job.attach_before_resume(&child) {
        let _ = child.kill().await;
        return Err(format!("无法管理 Agent 进程树：{error}"));
    }
    let stdout = Mutex::new(Vec::new());
    let stderr = Mutex::new(Vec::new());
    let child_stdout = child.stdout.take().expect("piped stdout");
    let child_stderr = child.stderr.take().expect("piped stderr");
    let stdin = child.stdin.take();
    let mut pipes = std::pin::pin!(async {
        let (_, _, input) = tokio::join!(
            drain_stream(child_stdout, &stdout),
            drain_stream(child_stderr, &stderr),
            write_prompt(stdin, prompt),
        );
        input
    });
    let mut input = None;
    let mut last = String::new();
    let mut tick = tokio::time::interval(Duration::from_millis(250));
    tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
    let deadline = tokio::time::sleep(run_timeout);
    tokio::pin!(deadline);
    let outcome = loop {
        tokio::select! {
            biased;
            _ = &mut cancel => break Outcome::Cancelled,
            _ = &mut deadline => break Outcome::Timeout,
            status = child.wait() => break Outcome::Exit(status),
            result = &mut pipes, if input.is_none() => input = Some(result),
            _ = tick.tick() => {
                let log = log_snapshot(&stdout, &stderr);
                if log != last { publish(&log); last = log; }
            }
        }
    };

    // Terminate descendants before draining pipes: descendants may still hold them open.
    #[cfg(windows)]
    job.terminate().map_err(|e| format!("无法终止任务进程树：{e}"))?;
    #[cfg(not(windows))]
    if !matches!(outcome, Outcome::Exit(Ok(_))) {
        child.start_kill().map_err(|e| format!("无法终止任务进程：{e}"))?;
    }
    tokio::time::timeout(CLEANUP_TIMEOUT, async {
        child.wait().await?;
        #[cfg(windows)]
        while job.active_count()? != 0 { tokio::time::sleep(Duration::from_millis(20)).await; }
        Ok::<_, std::io::Error>(())
    }).await.map_err(|_| "未能确认任务进程树已退出".to_string())?
        .map_err(|e| format!("无法核对任务进程退出状态：{e}"))?;

    let input = match input {
        Some(result) => result,
        None => tokio::time::timeout(CLEANUP_TIMEOUT, &mut pipes).await
            .map_err(|_| "Agent 进程已结束，输出管道未及时关闭".to_string())?,
    };
    Ok(SupervisedOutput {
        outcome,
        stdout: snapshot(&stdout, OUTPUT_LIMIT, true),
        log: log_snapshot(&stdout, &stderr),
        input,
    })
}

pub async fn probe_version(path: &str) -> Option<String> {
    let mut command = Command::new(path);
    command.arg("--version").env_remove(crate::agent_settings::DSH_KEY_ENV);
    let (_send, cancel) = oneshot::channel();
    let deadline = Duration::from_millis(1500);
    let output = tokio::time::timeout(deadline, supervise(&std::env::temp_dir(),
        command, None, cancel, deadline, |_| {})).await.ok()?.ok()?;
    if !matches!(output.outcome, Outcome::Exit(Ok(status)) if status.success()) { return None; }
    output.stdout.split_whitespace().chain(output.log.split_whitespace()).find_map(|word| {
        let value = word.trim_matches(|ch| matches!(ch, '(' | ')' | ',' | 'v'));
        let release = value.split(['-', '+']).next()?;
        let mut segments = release.split('.');
        if segments.clone().count() < 2 || !segments.all(|part| !part.is_empty() && part.bytes().all(|ch| ch.is_ascii_digit()))
            || value.len() > 48 || !value.bytes().all(|ch| ch.is_ascii_alphanumeric() || b".-+".contains(&ch)) {
            return None;
        }
        Some(value.to_owned())
    })
}

async fn run_task(
    app: &AppHandle, root: &Path, task_id: &str, command: Command,
    prompt: Option<String>, cancel: oneshot::Receiver<()>, follow_context: Option<&str>,
    agent_type: &str, deepseek_key: Option<&str>,
) -> Result<TaskCard, String> {
    let redact = |value: &str| match deepseek_key {
        Some(key) => value.replace(key, "[已隐藏密钥]"),
        None => value.to_owned(),
    };
    let result = supervise(root, command, prompt, cancel, RUN_TIMEOUT, |log| {
        publish_log(app, root, task_id, &redact(log));
    }).await;
    let result = match result {
        Ok(result) => result,
        Err(error) => return finalize(root, task_id, "ERROR", Some(&error), "", "", follow_context),
    };
    let SupervisedOutput { outcome, stdout, log, input } = result;
    let (state, error) = match outcome {
        Outcome::Cancelled => ("TODO", Some(if follow_context.is_some() {
            "已停止追加，上一轮结果可继续审阅"
        } else { "已停止，退回待办" }.to_string())),
        Outcome::Timeout => ("ERROR", Some("执行超时（15 分钟），进程树已终止".to_string())),
        Outcome::Exit(Ok(exit)) if exit.success() => match input {
            Ok(()) => ("PENDING", None),
            Err(error) => ("ERROR", Some(format!("Agent 未完整接收任务：{error}"))),
        },
        Outcome::Exit(Ok(_)) if agent_type == "dsh" && log.contains("MISSING_CREDENTIAL") => (
            "ERROR", Some("DeepSeek Harness 缺少 API Key。请打开 Agent 设置，保存 DeepSeek API Key 后重试。".into()),
        ),
        Outcome::Exit(Ok(exit)) => ("ERROR", Some(format!("进程退出码 {}，输出见日志", exit.code().unwrap_or(-1)))),
        Outcome::Exit(Err(error)) => ("ERROR", Some(format!("执行失败：{error}"))),
    };
    finalize(root, task_id, state, error.as_deref(), &redact(&stdout), &redact(&log), follow_context)
}

#[cfg(all(test, windows))]
mod tests {
    use super::*;
    use std::fs;
    use std::io;
    use windows_sys::Win32::Foundation::{CloseHandle, WAIT_OBJECT_0, WAIT_TIMEOUT};
    use windows_sys::Win32::System::Threading::{OpenProcess, WaitForSingleObject, PROCESS_SYNCHRONIZE};

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!("plate-s7-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&root).unwrap();
            Self(root)
        }

        fn shim(&self, source: &str) -> String {
            fs::write(self.0.join("fixture.js"), source).unwrap();
            let shim = self.0.join("fixture.cmd");
            fs::write(&shim, "@echo off\r\nnode \"%~dp0fixture.js\" %*\r\n").unwrap();
            shim.to_string_lossy().into_owned()
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_file(self.0.join("fixture.js"));
            let _ = fs::remove_file(self.0.join("fixture.cmd"));
            let _ = fs::remove_file(self.0.join("pids"));
            let _ = fs::remove_dir(&self.0);
        }
    }

    #[tokio::test]
    async fn vendor_adapters_pipe_multiline_utf8_through_cmd() {
        let fixture = Fixture::new();
        let shim = fixture.shim("process.stdin.pipe(process.stdout); console.error('diagnostic');");
        let input = "任务正文\r\n第二行 & | > < % \"\n\n补充指令：新的一行\n第二条追问 😀";
        let long_input = input.repeat(430);
        for kind in ["codex", "claude", "dsh", "opencode"] {
            let input = if kind == "opencode" { &long_input[..] } else { input };
            let (_sender, signal) = oneshot::channel();
            let route = crate::agent_plugins::Route {
                id: kind.into(), executable: shim.clone(), selected_model: "model-fixture".into(),
                model_flag: Some(if kind == "codex" { "-m" } else { "--model" }.into()),
                args: None, base_url: None,
            };
            let command = build_command(&route).unwrap();
            let result = supervise(&fixture.0, command, Some(input.into()), signal, Duration::from_secs(10), |_| {}).await.unwrap();
            assert!(matches!(result.outcome, Outcome::Exit(Ok(status)) if status.success()));
            result.input.unwrap();
            assert_eq!(result.stdout, input);
            assert!(result.log.contains("diagnostic"));
        }
    }

    fn wait_for_process(pid: u32, millis: u32) -> bool {
        let handle = unsafe { OpenProcess(PROCESS_SYNCHRONIZE, 0, pid) };
        if handle.is_null() {
            assert_eq!(io::Error::last_os_error().raw_os_error(), Some(87), "PID {pid}");
            return true;
        }
        let result = unsafe { WaitForSingleObject(handle, millis) };
        unsafe { CloseHandle(handle) };
        assert!(matches!(result, WAIT_OBJECT_0 | WAIT_TIMEOUT), "PID {pid}, wait result {result}");
        result == WAIT_OBJECT_0
    }

    #[tokio::test]
    async fn stop_timeout_and_exit_leave_no_managed_descendants() {
        let mut unrelated = Command::new("node");
        unrelated.args(["-e", "setInterval(()=>{},1000)"]).kill_on_drop(true);
        let unrelated = unrelated.spawn().unwrap();
        for mode in ["stop", "timeout", "exit"] {
            let fixture = Fixture::new();
            let shim = fixture.shim(r#"
const {spawn} = require('node:child_process');
const child = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], {stdio:'inherit'});
require('node:fs').writeFileSync('pids', process.pid + ' ' + child.pid);
if (process.argv[2] === 'exit') process.exit(0);
setInterval(()=>{},1000);
"#);
            let (send, signal) = oneshot::channel();
            let mut command = Command::new(shim);
            command.arg(mode);
            let root = fixture.0.clone();
            let runner = tokio::spawn(async move {
                let budget = Duration::from_secs(if mode == "timeout" { 2 } else { 10 });
                supervise(&root, command, None, signal, budget, |_| {}).await
            });
            let pids = tokio::time::timeout(Duration::from_secs(8), async {
                loop {
                    if let Ok(text) = fs::read_to_string(fixture.0.join("pids")) {
                        let pids: Vec<u32> = text.split_whitespace().filter_map(|s| s.parse().ok()).collect();
                        if pids.len() == 2 { break pids; }
                    }
                    tokio::time::sleep(Duration::from_millis(15)).await;
                }
            }).await.unwrap();
            if mode == "stop" {
                assert!(pids.iter().all(|&pid| !wait_for_process(pid, 0)));
                send.send(()).unwrap();
            }
            let result = runner.await.unwrap().unwrap();
            match mode {
                "stop" => assert!(matches!(result.outcome, Outcome::Cancelled)),
                "timeout" => assert!(matches!(result.outcome, Outcome::Timeout)),
                _ => assert!(matches!(result.outcome, Outcome::Exit(Ok(status)) if status.success())),
            }
            assert!(pids.iter().all(|&pid| wait_for_process(pid, 3000)), "{mode}: {pids:?}");
            assert!(!wait_for_process(unrelated.id().unwrap(), 0));
        }
    }
}

