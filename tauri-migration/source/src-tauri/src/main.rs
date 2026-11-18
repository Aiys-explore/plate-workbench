mod agent_runner;
mod agent_store;
mod db;
mod graph_layout;
mod notes;
#[cfg(windows)]
mod process_job;

use notes::{Note, NoteFilters, NoteStore, SaveResult, SearchResult};
use std::path::PathBuf;
use std::sync::Mutex;
use agent_runner::{TaskCard, TaskEngine};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

pub struct AppState {
    pub root: Mutex<Option<PathBuf>>,
    pub store: Mutex<Option<NoteStore>>,
}

fn with_store<T>(state: &State<'_, AppState>, f: impl FnOnce(&NoteStore) -> Result<T, String>) -> Result<T, String> {
    let guard = state.store.lock().unwrap();
    match guard.as_ref() {
        Some(store) => f(store),
        None => Err("工作区尚未打开".into()),
    }
}

fn default_suggest() -> PathBuf {
    if let Ok(isolated) = std::env::var("PLATE_WORKSPACE_ROOT") {
        if !isolated.trim().is_empty() {
            return PathBuf::from(isolated);
        }
    }
    let home = std::env::var("USERPROFILE").map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."));
    home.join("Documents").join("Plate-Tauri-S7-试用笔记")
}

const MARKER: &str = "plate-workbench.json";

// ── Agent 发现与任务执行（S5）────────────────────────────────────

#[tauri::command]
fn agents_discover() -> Result<serde_json::Value, String> {
    Ok(serde_json::json!(agent_store::discover()
        .into_iter()
        .map(|agent| serde_json::json!({
            "type": agent.agent_type, "name": agent.name, "executable": agent.executable
        }))
        .collect::<Vec<_>>()))
}

fn with_engine<T>(engine: &State<'_, TaskEngine>, root: &State<'_, AppState>, f: impl FnOnce(&TaskEngine, &PathBuf) -> Result<T, String>) -> Result<T, String> {
    let guard = root.store.lock().unwrap();
    match guard.as_ref() {
        Some(_) => {
            let path = root.root.lock().unwrap().clone().unwrap_or_default();
            f(engine, &path)
        }
        None => Err("工作区尚未打开".into()),
    }
}

#[tauri::command]
fn tasks_list_by_note(state: State<'_, AppState>, note_id: String) -> Result<Vec<TaskCard>, String> {
    let guard = state.store.lock().unwrap();
    if guard.is_none() { return Err("工作区尚未打开".into()) }
    let root = state.root.lock().unwrap().clone().unwrap_or_default();
    agent_runner::list_by_note(&root, &note_id)
}

#[tauri::command]
fn tasks_summary(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let guard = state.store.lock().unwrap();
    if guard.is_none() { return Err("工作区尚未打开".into()) }
    let root = state.root.lock().unwrap().clone().unwrap_or_default();
    agent_runner::summary_by_notes(&root)
}

#[tauri::command]
fn tasks_start(engine: State<'_, TaskEngine>, state: State<'_, AppState>, app: AppHandle,
    task_id: String, note_id: String, prompt_text: String, agent_selector: Option<String>) -> Result<TaskCard, String> {
    let agent = agent_selector.unwrap_or_else(|| "dsh".into());
    with_engine(&engine, &state, |engine, root| {
        engine.start(app, root.clone(), task_id, note_id, agent, prompt_text)
    })
}

#[tauri::command]
async fn tasks_stop(engine: State<'_, TaskEngine>, state: State<'_, AppState>, task_id: String) -> Result<TaskCard, String> {
    let root = with_engine(&engine, &state, |_, root| Ok(root.clone()))?;
    engine.stop(&root, &task_id).await
}

#[tauri::command]
fn tasks_follow_up(engine: State<'_, TaskEngine>, state: State<'_, AppState>, app: AppHandle,
    task_id: String, instruction: String) -> Result<TaskCard, String> {
    with_engine(&engine, &state, |engine, root| engine.follow_up(app, root, &task_id, &instruction))
}

#[tauri::command]
fn tasks_mark_done(engine: State<'_, TaskEngine>, state: State<'_, AppState>, app: AppHandle, task_id: String) -> Result<TaskCard, String> {
        with_engine(&engine, &state, |engine, root| engine.mark_done(app, root, &task_id))
}

#[tauri::command]
fn tasks_reject(engine: State<'_, TaskEngine>, state: State<'_, AppState>, app: AppHandle, task_id: String) -> Result<TaskCard, String> {
        with_engine(&engine, &state, |engine, root| engine.reject(app, root, &task_id))
}

#[tauri::command]
fn startup_state(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    if state.store.lock().unwrap().is_some() {
        let root = state.root.lock().unwrap().clone().unwrap_or_default();
        return Ok(serde_json::json!({
            "phase": "ready", "path": root.to_string_lossy(), "intro": false, "agent": "unconfigured"
        }));
    }
    let suggest = default_suggest();
    if suggest.join(MARKER).exists() && suggest.join("projects").is_dir() {
        open_store(&state, &suggest)?;
        let root = state.root.lock().unwrap().clone().unwrap_or_default();
        return Ok(serde_json::json!({
            "phase": "ready", "path": root.to_string_lossy(), "intro": false, "agent": "unconfigured"
        }));
    }
    Ok(serde_json::json!({
        "phase": "choose",
        "suggested": suggest.to_string_lossy(),
        "candidate": { "token": suggest.to_string_lossy(), "path": suggest.to_string_lossy(), "kind": "new" }
    }))
}

fn open_store(state: &State<'_, AppState>, root: &PathBuf) -> Result<(), String> {
    let store = NoteStore::new(root)?;
    *state.root.lock().unwrap() = Some(root.clone());
    *state.store.lock().unwrap() = Some(store);
    Ok(())
}

#[tauri::command]
fn startup_submit(state: State<'_, AppState>, token: String) -> Result<serde_json::Value, String> {
    let root = PathBuf::from(&token);
    if !root.is_absolute() { return Err("笔记位置必须是绝对路径".into()); }
    std::fs::create_dir_all(root.join("projects")).map_err(|e| format!("无法创建工作区：{e}"))?;
    let marker = root.join(MARKER);
    if !marker.exists() {
        std::fs::write(&marker, serde_json::json!({
            "version": "0.3.0-s2", "createdAt": notes::now_ms()
        }).to_string()).map_err(|e| format!("无法写入工作区标记：{e}"))?;
    }
    open_store(&state, &root)?;
    Ok(serde_json::json!({
        "phase": "ready", "path": token, "intro": false, "agent": "unconfigured"
    }))
}

#[tauri::command]
fn startup_rebuild(state: State<'_, AppState>, token: String) -> Result<serde_json::Value, String> {
    let root = PathBuf::from(&token);
    if !root.join("projects").is_dir() { return Err("该目录没有 projects 子目录，无法重建索引".into()); }
    open_store(&state, &root)?;
    let store = state.store.lock().unwrap();
    store.as_ref().unwrap().scan()?;
    drop(store);
    Ok(serde_json::json!({
        "phase": "ready", "path": token, "intro": false, "agent": "unconfigured"
    }))
}

#[tauri::command]
async fn startup_browse(window: tauri::WebviewWindow) -> Result<Option<String>, String> {
    let (send, result) = tokio::sync::oneshot::channel();
    window.dialog().file().set_parent(&window).set_title("选择笔记位置")
        .pick_folder(move |path| { let _ = send.send(path); });
    result.await.map_err(|_| "目录选择器已关闭".to_string())?
        .map(|path| path.into_path().map(|path| path.to_string_lossy().into_owned())
            .map_err(|error| error.to_string()))
        .transpose()
}

#[tauri::command]
fn startup_exit() -> Result<(), String> {
    std::process::exit(0);
}

#[tauri::command]
fn app_info(app: AppHandle) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!({ "name": "Plate Workbench", "version": app.package_info().version.to_string() }))
}

fn external_url(address: &str) -> Result<tauri::Url, String> {
    if address.chars().any(char::is_control) { return Err("链接包含控制字符".into()) }
    let url = tauri::Url::parse(address).map_err(|_| "链接格式无效".to_string())?;
    if !matches!(url.scheme(), "https" | "http") || url.host_str().is_none() ||
        !url.username().is_empty() || url.password().is_some() {
        return Err("仅支持打开普通 HTTP 或 HTTPS 链接".into());
    }
    Ok(url)
}

#[tauri::command]
fn notes_open_link(app: AppHandle, address: String) -> Result<(), String> {
    let url = external_url(&address)?;
    app.opener().open_url(url.as_str(), None::<&str>).map_err(|error| error.to_string())
}

#[tauri::command]
fn notes_create(state: State<'_, AppState>, title: String, project_id: String, template: Option<String>) -> Result<Note, String> {
    with_store(&state, |s| s.create(&title, &project_id, template.as_deref().unwrap_or("blank")))
}

#[tauri::command]
fn notes_read(state: State<'_, AppState>, id: String) -> Result<Note, String> {
    with_store(&state, |s| s.read(&id))
}

#[tauri::command]
fn notes_update(state: State<'_, AppState>, id: String, content: String, revision: Option<String>, draft_version: Option<String>) -> Result<SaveResult, String> {
    with_store(&state, |s| s.update(&id, &content, revision, draft_version))
}

#[tauri::command]
fn notes_update_strict(state: State<'_, AppState>, id: String, content: String, revision: String) -> Result<SaveResult, String> {
    with_store(&state, |store| store.update_strict(&id, &content, revision))
}

#[tauri::command]
fn notes_delete(state: State<'_, AppState>, id: String, revision: Option<String>) -> Result<String, String> {
    with_store(&state, |s| s.delete(&id, revision))
}

#[tauri::command]
fn notes_list(state: State<'_, AppState>, filters: Option<NoteFilters>) -> Result<Vec<notes::NoteSummary>, String> {
    with_store(&state, |s| s.list(filters.unwrap_or_default()))
}

#[tauri::command]
fn notes_links(state: State<'_, AppState>) -> Result<notes::LinkIndex, String> {
    with_store(&state, |s| s.links())
}

#[tauri::command]
fn notes_search(state: State<'_, AppState>, filters: NoteFilters) -> Result<Vec<SearchResult>, String> {
    with_store(&state, |s| s.search(filters))
}

#[tauri::command]
fn notes_tags(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    with_store(&state, |s| s.tags())
}

#[tauri::command]
fn projects_list(state: State<'_, AppState>) -> Result<Vec<notes::ProjectSummary>, String> {
    with_store(&state, |s| s.projects())
}

#[tauri::command]
fn projects_create(state: State<'_, AppState>, name: String) -> Result<notes::ProjectSummary, String> {
    with_store(&state, |s| s.create_project(&name))
}

#[tauri::command]
fn drafts_list(state: State<'_, AppState>) -> Result<Vec<notes::DraftSummary>, String> {
    with_store(&state, |s| s.draft_list())
}

#[tauri::command]
fn drafts_write(state: State<'_, AppState>, id: String, content: String, revision: String, version: Option<String>) -> Result<bool, String> {
    with_store(&state, |s| s.draft_write(&id, &content, &revision, version))
}

#[tauri::command]
fn drafts_discard(state: State<'_, AppState>, id: String, version: String) -> Result<bool, String> {
    with_store(&state, |s| s.draft_discard(&id, &version))
}

#[tauri::command]
fn drafts_restore(state: State<'_, AppState>, id: String) -> Result<notes::DraftRecovery, String> {
    with_store(&state, |s| s.draft_restore(&id))
}

#[tauri::command]
fn drafts_save_copy(state: State<'_, AppState>, id: String, version: String) -> Result<Note, String> {
    with_store(&state, |s| s.draft_save_copy(&id, &version))
}

#[tauri::command]
fn graph_layout_get_all(state: State<'_, AppState>) -> Result<std::collections::HashMap<String, graph_layout::GraphLayoutEntry>, String> {
    with_store(&state, |s| {
        let conn = s.conn.lock().unwrap();
        graph_layout::get_all(&conn)
    })
}

#[tauri::command]
fn graph_layout_save_batch(state: State<'_, AppState>, items: Vec<graph_layout::GraphLayoutItem>) -> Result<(), String> {
    with_store(&state, |s| {
        let conn = s.conn.lock().unwrap();
        graph_layout::save_batch(&conn, items)
    })
}

#[tauri::command]
fn graph_layout_reset(state: State<'_, AppState>) -> Result<(), String> {
    with_store(&state, |s| {
        let conn = s.conn.lock().unwrap();
        graph_layout::reset_all(&conn)
    })
}

#[tauri::command]
fn graph_layout_connect_nodes(state: State<'_, AppState>, source_id: String, target_id: String, downstream: Option<bool>) -> Result<Note, String> {
    with_store(&state, |s| s.connect_nodes(&source_id, &target_id, downstream.unwrap_or(false)))
}

#[tauri::command]
fn db_tables(state: State<'_, AppState>) -> Result<Vec<String>, String> {
    with_store(&state, |s| {
        let conn = s.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
        Ok(rows.filter_map(Result::ok).collect())
    })
}

fn start_watcher(app: AppHandle, projects_dir: PathBuf) {
    std::thread::spawn(move || {
        use notify::{Watcher, RecursiveMode};
        let (tx, rx) = std::sync::mpsc::channel();
        let mut watcher = match notify::recommended_watcher(tx) {
            Ok(w) => w,
            Err(_) => return,
        };
        if watcher.watch(&projects_dir, RecursiveMode::Recursive).is_err() { return; }
        // 简单防抖：事件到达后静置 400ms 再广播一次
        loop {
            match rx.recv() {
                Ok(_) => {
                    std::thread::sleep(std::time::Duration::from_millis(400));
                    while rx.try_recv().is_ok() {}
                    if let Some(store) = app.state::<AppState>().store.lock().unwrap().as_ref() {
                        if store.scan().is_ok() {
                            let _ = app.emit("notes:changed", serde_json::json!({ "path": projects_dir.to_string_lossy(), "external": true }));
                        }
                    }
                }
                Err(_) => return,
            }
        }
    });
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState { root: Mutex::new(None), store: Mutex::new(None) })
        .setup(|app| {
            let handle = app.handle().clone();
            std::thread::spawn(move || {
                // 等 startup 完成后再启动监听；此处轮询根目录出现即挂 watcher
                loop {
                    let root = handle.state::<AppState>().root.lock().unwrap().clone();
                    if let Some(root) = root {
                        start_watcher(handle.clone(), root.join("projects"));
                        return;
                    }
                    std::thread::sleep(std::time::Duration::from_millis(500));
                }
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            startup_state, startup_browse, startup_submit, startup_rebuild, startup_exit,
            app_info, db_tables,
            notes_create, notes_read, notes_update, notes_update_strict, notes_delete, notes_list,
            notes_links, notes_search, notes_tags, notes_open_link,
            projects_list, projects_create,
            drafts_list, drafts_write, drafts_discard, drafts_restore, drafts_save_copy,
            graph_layout_get_all, graph_layout_save_batch, graph_layout_reset, graph_layout_connect_nodes,
            agents_discover,
            tasks_list_by_note, tasks_summary, tasks_start, tasks_stop, tasks_follow_up,
            tasks_mark_done, tasks_reject
        ])
        .manage(TaskEngine::new())
        .run(tauri::generate_context!())
        .expect("Tauri 应用启动失败");
}
