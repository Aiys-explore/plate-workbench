use super::engine::{self, HarnessEvent};
use crate::{notes::now_ms, with_store, AppState};
use regex::Regex;
use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    io::Read,
    path::{Path, PathBuf},
    sync::Mutex,
    time::Duration,
};
use tauri::{AppHandle, Manager, State};

pub const BUILTIN: &str = "builtin-session-memory";
const MAX_SCRIPT: usize = 64_000;
const MAX_SPILLS: usize = 24;

fn err(error: impl std::fmt::Display) -> String {
    error.to_string()
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Event {
    UserPromptSubmit,
    PreToolUse,
    PostToolUse,
    Stop,
    SessionEnd,
}
impl Event {
    fn as_str(self) -> &'static str {
        match self {
            Self::UserPromptSubmit => "UserPromptSubmit",
            Self::PreToolUse => "PreToolUse",
            Self::PostToolUse => "PostToolUse",
            Self::Stop => "Stop",
            Self::SessionEnd => "SessionEnd",
        }
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Hook {
    id: String,
    name: String,
    event_name: Event,
    matcher: String,
    handler_kind: String,
    command_or_ref: String,
    script_sha256: String,
    trusted_sha256: String,
    timeout_sec: u64,
    async_run: bool,
    enabled: bool,
    #[serde(default)]
    source_preview: String,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct HookDecision {
    pub allow: bool,
    pub reason: Option<String>,
    pub additional_context: Option<String>,
    pub rewritten_input: Option<Value>,
    pub should_continue: bool,
}
impl Default for HookDecision {
    fn default() -> Self {
        Self {
            allow: true,
            reason: None,
            additional_context: None,
            rewritten_input: None,
            should_continue: false,
        }
    }
}

fn row_hook(row: &Row<'_>) -> rusqlite::Result<Hook> {
    let event: String = row.get(2)?;
    let event_name = serde_json::from_value(json!(event)).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(2, rusqlite::types::Type::Text, Box::new(error))
    })?;
    Ok(Hook {
        id: row.get(0)?,
        name: row.get(1)?,
        event_name,
        matcher: row.get(3)?,
        handler_kind: row.get(4)?,
        command_or_ref: row.get(5)?,
        script_sha256: row.get(6)?,
        trusted_sha256: row.get(7)?,
        timeout_sec: row.get(8)?,
        async_run: row.get(9)?,
        enabled: row.get(10)?,
        source_preview: String::new(),
    })
}
const SELECT: &str =
    "SELECT id,name,event_name,matcher,handler_kind,command_or_ref,script_sha256,trusted_sha256,
    timeout_sec,async_run,enabled FROM harness_hooks";

fn script(hook: &Hook) -> Result<Vec<u8>, String> {
    let source = hook.command_or_ref.trim();
    let data = if hook.handler_kind == "command" {
        if let Some(path) = source.strip_prefix("file:") {
            let path = Path::new(path.trim());
            if !path.is_absolute()
                || !path
                    .extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("rhai"))
            {
                return Err("请使用 file: 后跟 .rhai 文件的绝对路径".into());
            }
            if !std::fs::metadata(path).map_err(err)?.is_file() {
                return Err("Hook 路径必须指向普通文件".into());
            }
            let mut buffer = Vec::new();
            std::fs::File::open(path)
                .map_err(err)?
                .take((MAX_SCRIPT + 1) as u64)
                .read_to_end(&mut buffer)
                .map_err(err)?;
            buffer
        } else {
            hook.command_or_ref.as_bytes().to_vec()
        }
    } else if hook.handler_kind == "mcp_tool" {
        super::hook_mcp::parse(source)?;
        source.as_bytes().to_vec()
    } else {
        return Err("Hook 类型无效".into());
    };
    if data.is_empty()
        || data.len() > MAX_SCRIPT
        || std::str::from_utf8(&data).is_err()
        || data.contains(&0)
    {
        return Err("Hook 需要 1–64 KB 的 UTF-8 文本".into());
    }
    Ok(data)
}

fn sha(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

enum Verdict {
    Trusted(Vec<u8>),
    NeedsTrust(String),
}

fn verify(hook: &Hook) -> Result<Verdict, String> {
    let bytes = script(hook)?;
    let hash = sha(&bytes);
    if hash != hook.trusted_sha256 {
        return Ok(Verdict::NeedsTrust(hash));
    }
    Ok(Verdict::Trusted(bytes))
}

fn describe(mut hook: Hook) -> Hook {
    if hook.handler_kind != "builtin" {
        match script(&hook) {
            Ok(bytes) => {
                hook.script_sha256 = sha(&bytes);
                hook.source_preview = String::from_utf8_lossy(&bytes).into_owned();
            }
            Err(error) => {
                hook.script_sha256.clear();
                hook.source_preview = error;
            }
        }
    }
    hook
}

fn get(conn: &Connection, id: &str) -> Result<Hook, String> {
    conn.query_row(&format!("{SELECT} WHERE id=?1"), [id], row_hook)
        .map_err(err)
}

#[tauri::command]
pub fn hooks_list(state: State<'_, AppState>) -> Result<Vec<Hook>, String> {
    with_store(&state, |store| {
        let conn = store.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(&format!("{SELECT} ORDER BY id<>?1,event_name,name,id"))
            .map_err(err)?;
        let rows = stmt.query_map([BUILTIN], row_hook).map_err(err)?;
        Ok(rows
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(err)?
            .into_iter()
            .map(describe)
            .collect())
    })
}

#[tauri::command]
pub fn hooks_upsert(state: State<'_, AppState>, mut hook: Hook) -> Result<Hook, String> {
    if hook.id.is_empty() {
        hook.id = uuid::Uuid::new_v4().to_string();
    }
    if uuid::Uuid::parse_str(&hook.id).is_err()
        || hook.name.trim().is_empty()
        || hook.name.len() > 200
        || hook.command_or_ref.len() > MAX_SCRIPT
        || hook.matcher.len() > 500
        || !(1..=120).contains(&hook.timeout_sec)
    {
        return Err("请核对 Hook 名称、匹配条件、脚本和超时".into());
    }
    if !matches!(hook.matcher.as_str(), "" | "*") {
        Regex::new(&hook.matcher).map_err(err)?;
    }
    if hook.async_run && !matches!(hook.event_name, Event::PostToolUse | Event::SessionEnd) {
        return Err("只有工具执行后和会话结束事件可异步运行".into());
    }
    let hash = sha(&script(&hook)?);
    with_store(&state, |store| {
        let conn = store.conn.lock().unwrap();
        conn.execute("INSERT INTO harness_hooks(id,name,event_name,matcher,handler_kind,command_or_ref,script_sha256,
             trusted_sha256,timeout_sec,async_run,enabled,updated_at)
             VALUES(?1,?2,?3,?4,?5,?6,?7,'',?8,?9,?10,?11) ON CONFLICT(id) DO UPDATE SET
             name=excluded.name,event_name=excluded.event_name,matcher=excluded.matcher,handler_kind=excluded.handler_kind,
             command_or_ref=excluded.command_or_ref,script_sha256=excluded.script_sha256,
             trusted_sha256=CASE WHEN harness_hooks.handler_kind=excluded.handler_kind AND
                harness_hooks.command_or_ref=excluded.command_or_ref AND harness_hooks.event_name=excluded.event_name AND
                harness_hooks.matcher=excluded.matcher AND harness_hooks.script_sha256=excluded.script_sha256
                THEN harness_hooks.trusted_sha256 ELSE '' END,
             timeout_sec=excluded.timeout_sec,async_run=excluded.async_run,enabled=excluded.enabled,updated_at=excluded.updated_at",
            params![hook.id,hook.name.trim(),hook.event_name.as_str(),hook.matcher,hook.handler_kind,hook.command_or_ref,hash,
               hook.timeout_sec,hook.async_run,hook.enabled,now_ms()]).map_err(err)?;
        Ok(describe(get(&conn, &hook.id)?))
    })
}

#[tauri::command]
pub fn hooks_trust(
    state: State<'_, AppState>,
    id: String,
    expected_sha256: String,
) -> Result<Hook, String> {
    with_store(&state, |store| {
        let conn = store.conn.lock().unwrap();
        let hook = describe(get(&conn, &id)?);
        if hook.handler_kind == "builtin"
            || hook.script_sha256.is_empty()
            || hook.script_sha256 != expected_sha256
        {
            return Err("Hook 内容已发生变化，请刷新后重新审阅".into());
        }
        conn.execute(
            "UPDATE harness_hooks SET trusted_sha256=?2,script_sha256=?2,updated_at=?3 WHERE id=?1",
            params![id, hook.script_sha256, now_ms()],
        )
        .map_err(err)?;
        Ok(describe(get(&conn, &id)?))
    })
}

#[tauri::command]
pub fn hooks_toggle(state: State<'_, AppState>, id: String, enabled: bool) -> Result<Hook, String> {
    with_store(&state, |store| {
        let conn = store.conn.lock().unwrap();
        conn.execute(
            "UPDATE harness_hooks SET enabled=?2,updated_at=?3 WHERE id=?1",
            params![id, enabled, now_ms()],
        )
        .map_err(err)?;
        Ok(describe(get(&conn, &id)?))
    })
}

pub fn memory_enabled(conn: &Connection) -> rusqlite::Result<bool> {
    conn.query_row(
        "SELECT enabled FROM harness_hooks WHERE id=?1",
        [BUILTIN],
        |row| row.get(0),
    )
}

#[derive(Default)]
pub struct Spills(Mutex<Vec<PathBuf>>);

impl Spills {
    fn compact(&self, text: String) -> Result<String, String> {
        if text.len() <= 10_000 {
            return Ok(text);
        }
        let head: String = text.chars().take(1000).collect();
        let tail: String = text
            .chars()
            .rev()
            .take(500)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        let mut paths = self.0.lock().unwrap();
        if paths.len() >= MAX_SPILLS {
            return Ok(format!("{head}\n[已达暂存上限]\n{tail}"));
        }
        let path =
            std::env::temp_dir().join(format!("plate-hook-context-{}.txt", uuid::Uuid::new_v4()));
        let mut file = std::fs::OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&path)
            .map_err(err)?;
        paths.push(path.clone());
        use std::io::Write;
        file.write_all(text.as_bytes()).map_err(err)?;
        Ok(format!(
            "{head}\n[完整 Hook 资料：{}。使用 read_hook_context 按字符偏移读取。]\n{tail}",
            path.display()
        ))
    }

    pub fn read(&self, path: &str, offset: usize) -> Result<Value, String> {
        let paths = self.0.lock().unwrap();
        let path = paths
            .iter()
            .find(|entry| entry.as_os_str() == path)
            .ok_or("此路径不属于当前任务的 Hook 资料")?;
        let body = std::fs::read_to_string(path).map_err(err)?;
        let count = body.chars().count();
        let content = body.chars().skip(offset).take(8000).collect::<String>();
        Ok(
            json!({"content":content,"nextOffset":(offset.saturating_add(8000)<count).then(||offset+8000)}),
        )
    }
}
impl Drop for Spills {
    fn drop(&mut self) {
        for path in self.0.get_mut().unwrap() {
            let _ = std::fs::remove_file(path);
        }
    }
}

fn matches(hook: &Hook, subject: &str) -> bool {
    matches!(hook.matcher.as_str(), "" | "*")
        || hook.matcher == subject
        || Regex::new(&hook.matcher).is_ok_and(|pattern| pattern.is_match(subject))
}

fn trace(app: &AppHandle, run: &str, hook: &Hook, status: &str, message: &str) {
    let _ = engine::emit(
        app,
        HarnessEvent::HookStatus {
            run_id: run,
            hook_id: &hook.id,
            name: &hook.name,
            event_name: hook.event_name,
            status,
            message,
        },
    );
}

// Hook scripts can transform the event and return a decision. The evaluator exposes no host functions.
fn execute_script(source: &[u8], input: &Value, timeout: Duration) -> Result<HookDecision, String> {
    let source = std::str::from_utf8(source)
        .map_err(err)?
        .trim_start_matches('\u{feff}');
    let mut engine = rhai::Engine::new();
    let deadline = std::time::Instant::now() + timeout;
    engine
        .set_max_operations(60_000)
        .set_max_call_levels(20)
        .set_max_expr_depths(40, 24)
        .set_max_string_size(196_608)
        .set_max_array_size(400)
        .set_max_map_size(400)
        .disable_symbol("eval")
        .on_print(|_| {})
        .on_debug(|_, _, _| {})
        .on_progress(move |_| {
            (std::time::Instant::now() >= deadline).then(|| "Hook 已超时".into())
        });
    let mut scope = rhai::Scope::new();
    scope.push_constant("hook", rhai::serde::to_dynamic(input).map_err(err)?);
    let value = engine
        .eval_with_scope::<rhai::Dynamic>(&mut scope, source)
        .map_err(err)?;
    if value.is_unit() {
        return Ok(HookDecision::default());
    }
    rhai::serde::from_dynamic(&value).map_err(err)
}

async fn dispatch(
    app: &AppHandle,
    run: &str,
    hook: &Hook,
    input: &Value,
    allow_network: bool,
) -> HookDecision {
    let bytes = match verify(hook) {
        Ok(Verdict::Trusted(bytes)) => bytes,
        Ok(Verdict::NeedsTrust(hash)) => {
            let _ = engine::emit(
                app,
                HarnessEvent::HookNeedsTrust {
                    run_id: run,
                    hook_id: &hook.id,
                    name: &hook.name,
                    event_name: hook.event_name,
                    script_sha256: &hash,
                },
            );
            return HookDecision::default();
        }
        Err(error) => {
            trace(app, run, hook, "skipped", &error);
            return HookDecision::default();
        }
    };
    let timeout = Duration::from_secs(hook.timeout_sec);
    let result = if hook.handler_kind == "mcp_tool" {
        if allow_network {
            match tokio::time::timeout(timeout, super::hook_mcp::call(&bytes, input)).await {
                Ok(value) => value,
                Err(_) => Err("MCP Hook 请求超时".into()),
            }
        } else {
            trace(app, run, hook, "skipped", "任务未授权联网");
            return HookDecision::default();
        }
    } else {
        let input = input.clone();
        match tokio::task::spawn_blocking(move || execute_script(&bytes, &input, timeout)).await {
            Ok(value) => value,
            Err(error) => Err(error.to_string()),
        }
    };
    match result {
        Ok(decision) => {
            let reason: String = decision
                .reason
                .as_deref()
                .unwrap_or("")
                .chars()
                .take(500)
                .collect();
            trace(
                app,
                run,
                hook,
                if decision.allow { "executed" } else { "denied" },
                &reason,
            );
            decision
        }
        Err(error) => {
            trace(app, run, hook, "error", &error);
            if matches!(hook.event_name, Event::UserPromptSubmit | Event::PreToolUse) {
                HookDecision {
                    allow: false,
                    reason: Some(format!("Hook {} 无法完成检查：{error}", hook.name)),
                    ..Default::default()
                }
            } else {
                HookDecision::default()
            }
        }
    }
}

pub async fn fire(
    app: &AppHandle,
    run: &str,
    event: Event,
    subject: &str,
    input: Value,
    allow_network: bool,
    spills: &Spills,
) -> Result<HookDecision, String> {
    let hooks = with_store(&app.state::<AppState>(), |store| {
        let conn = store.conn.lock().unwrap();
        let mut stmt=conn.prepare(&format!("{SELECT} WHERE event_name=?1 AND enabled=1 AND handler_kind<>'builtin' ORDER BY updated_at,id LIMIT 24"))
            .map_err(err)?;
        let rows = stmt.query_map([event.as_str()], row_hook).map_err(err)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(err)
    })?;
    let mut decision = HookDecision::default();
    let mut contexts = Vec::new();
    let mut payload = json!({"eventName":event,"runId":run,"subject":subject,"input":input});
    for hook in hooks.into_iter().filter(|hook| matches(hook, subject)) {
        if hook.async_run {
            let (app, run, payload) = (app.clone(), run.to_string(), payload.clone());
            tauri::async_runtime::spawn(async move {
                dispatch(&app, &run, &hook, &payload, allow_network).await;
            });
            continue;
        }
        let next = dispatch(app, run, &hook, &payload, allow_network).await;
        if let Some(context) = next.additional_context {
            contexts.push(spills.compact(context)?);
        }
        if !next.allow {
            decision.allow = false;
            decision.reason = next.reason.map(|text| text.chars().take(1000).collect());
            break;
        }
        if let Some(value) = next.rewritten_input {
            if value.to_string().len() <= 64_000 {
                payload["input"] = value.clone();
                decision.rewritten_input = Some(value);
            }
        }
        decision.should_continue |= next.should_continue;
        if next.reason.is_some() {
            decision.reason = next.reason;
        }
    }
    if !contexts.is_empty() {
        decision.additional_context = Some(contexts.join("\n\n"));
    }
    Ok(decision)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(source: String) -> Hook {
        Hook {
            id: "fixture".into(),
            name: "Hook".into(),
            event_name: Event::PreToolUse,
            matcher: "*".into(),
            handler_kind: "command".into(),
            command_or_ref: source,
            script_sha256: String::new(),
            trusted_sha256: String::new(),
            timeout_sec: 5,
            async_run: false,
            enabled: true,
            source_preview: String::new(),
        }
    }

    #[test]
    fn modified_file_cannot_pass_execution_gate() {
        let path =
            std::env::temp_dir().join(format!("plate-s11-hook-{}.rhai", uuid::Uuid::new_v4()));
        std::fs::write(&path, "'{}'").unwrap();
        let mut hook = fixture(format!("file:{}", path.display()));
        assert!(matches!(verify(&hook).unwrap(), Verdict::NeedsTrust(_)));
        hook.trusted_sha256 = sha(b"'{}'");
        let verified = match verify(&hook).unwrap() {
            Verdict::Trusted(bytes) => bytes,
            _ => panic!("missing trust"),
        };
        std::fs::write(&path, "'changed'").unwrap();
        assert_eq!(verified, b"'{}'");
        assert!(matches!(verify(&hook).unwrap(), Verdict::NeedsTrust(_)));
        std::fs::remove_file(path).unwrap();
    }

    #[test]
    fn script_input_drives_decision_and_host_imports_are_unavailable() {
        let source=br#"if hook.subject == "propose_file_write" { #{ allow:false, reason:"review" } } else { #{} }"#;
        let input = json!({"subject":"propose_file_write"});
        let value = execute_script(source, &input, Duration::from_secs(2)).unwrap();
        assert!(!value.allow);
        assert_eq!(value.reason.as_deref(), Some("review"));
        assert!(execute_script(
            br#"import "local" as local;"#,
            &input,
            Duration::from_secs(2)
        )
        .is_err());
        assert!(execute_script(b"loop {}", &input, Duration::from_secs(2)).is_err());
    }

    #[test]
    fn large_context_is_spilled_and_removed_when_run_ends() {
        let spills = Spills::default();
        let content = "证据".repeat(6000);
        let preview = spills.compact(content.clone()).unwrap();
        let path = spills.0.lock().unwrap()[0].clone();
        assert!(preview.contains(&path.to_string_lossy().to_string()));
        assert_eq!(std::fs::read_to_string(&path).unwrap(), content);
        assert_eq!(
            spills.read(path.to_str().unwrap(), 0).unwrap()["nextOffset"],
            8000
        );
        drop(spills);
        assert!(!path.exists());
    }
}
