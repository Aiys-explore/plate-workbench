#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod agent_runner;
mod agent_plugins;
mod agent_settings;
mod agent_store;
mod db;
mod graph_layout;
mod notes;
#[cfg(windows)]
mod process_job;

use notes::{Note, NoteFilters, NoteStore, SaveResult, SearchResult};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use agent_runner::{TaskCard, TaskEngine};
use tauri::{AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_opener::OpenerExt;

pub struct AppState {
    workspace: Mutex<Option<Workspace>>,
}

struct Workspace {
    store: NoteStore,
    generation: uuid::Uuid,
    _watcher: notify::RecommendedWatcher,
}

fn with_store<T>(state: &State<'_, AppState>, f: impl FnOnce(&NoteStore) -> Result<T, String>) -> Result<T, String> {
    let guard = state.workspace.lock().unwrap();
    match guard.as_ref() {
        Some(workspace) => f(&workspace.store),
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

fn with_engine<T>(engine: &State<'_, TaskEngine>, state: &State<'_, AppState>, f: impl FnOnce(&TaskEngine, &PathBuf) -> Result<T, String>) -> Result<T, String> {
    with_store(state, |store| f(engine, &store.root))
}

#[tauri::command]
fn tasks_list_by_note(state: State<'_, AppState>, note_id: String) -> Result<Vec<TaskCard>, String> {
    with_store(&state, |store| agent_runner::list_by_note(&store.root, &note_id))
}

#[tauri::command]
fn tasks_summary(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    with_store(&state, |store| agent_runner::summary_by_notes(&store.root))
}

#[tauri::command]
fn tasks_start(engine: State<'_, TaskEngine>, state: State<'_, AppState>, app: AppHandle,
    task_id: String, note_id: String, prompt_text: String, agent_selector: Option<String>) -> Result<TaskCard, String> {
    with_engine(&engine, &state, |engine, root| {
        engine.start(app, root.clone(), task_id, note_id, agent_selector, prompt_text)
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
fn startup_state(app: AppHandle, state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    if let Some(workspace) = state.workspace.lock().unwrap().as_ref() {
        return Ok(ready(&workspace.store.root));
    }
    let suggest = default_suggest();
    if suggest.join(MARKER).exists() && suggest.join("projects").is_dir() {
        return open_store(&app, &state, &suggest);
    }
    Ok(serde_json::json!({
        "phase": "choose",
        "suggested": suggest.to_string_lossy(),
        "candidate": workspace_candidate(&suggest)
    }))
}

fn ready(root: &Path) -> serde_json::Value {
    serde_json::json!({ "phase": "ready", "path": root.to_string_lossy(), "intro": false, "agent": "unconfigured" })
}

fn workspace_candidate(root: &Path) -> serde_json::Value {
    let kind = if root.join(MARKER).exists() || root.join("projects").is_dir() || root.join("index.sqlite").exists() {
        "existing"
    } else if root.is_dir() { "empty" } else { "new" };
    serde_json::json!({ "token": root.to_string_lossy(), "path": root.to_string_lossy(), "kind": kind })
}

fn open_store(app: &AppHandle, state: &State<'_, AppState>, root: &Path) -> Result<serde_json::Value, String> {
    if !root.is_absolute() { return Err("笔记位置必须是绝对路径".into()); }
    let mut current = state.workspace.lock().unwrap();
    if let Some(workspace) = current.as_ref() {
        if workspace.store.root == root { return Ok(ready(root)); }
        if app.state::<TaskEngine>().has_running(&workspace.store.root) {
            return Err("请先结束当前工作区的运行任务，再切换工作区".into());
        }
    }
    let store = NoteStore::new(root)?;
    let marker = root.join(MARKER);
    if !marker.exists() {
        std::fs::write(&marker, serde_json::json!({
            "version": app.package_info().version.to_string(), "createdAt": notes::now_ms()
        }).to_string()).map_err(|e| format!("无法写入工作区标记：{e}"))?;
    }
    let generation = uuid::Uuid::new_v4();
    let watcher = start_watcher(app.clone(), &store.projects_dir, generation)?;
    *current = Some(Workspace { store, generation, _watcher: watcher });
    Ok(ready(root))
}

#[tauri::command]
fn startup_submit(app: AppHandle, state: State<'_, AppState>, token: String) -> Result<serde_json::Value, String> {
    open_store(&app, &state, Path::new(&token))
}

#[tauri::command]
fn startup_rebuild(app: AppHandle, state: State<'_, AppState>, token: String) -> Result<serde_json::Value, String> {
    let root = PathBuf::from(&token);
    if !root.join("projects").is_dir() { return Err("该目录没有 projects 子目录，无法重建索引".into()); }
    let next = open_store(&app, &state, &root)?;
    with_store(&state, NoteStore::scan)?;
    Ok(next)
}

#[tauri::command]
async fn startup_browse(window: tauri::WebviewWindow) -> Result<Option<serde_json::Value>, String> {
    let (send, result) = tokio::sync::oneshot::channel();
    window.dialog().file().set_parent(&window).set_title("选择笔记位置")
        .pick_folder(move |path| { let _ = send.send(path); });
    result.await.map_err(|_| "目录选择器已关闭".to_string())?
        .map(|path| path.into_path().map(|path| workspace_candidate(&path))
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
fn graph_layout_set_collapsed(state: State<'_, AppState>, note_id: String, collapsed: bool) -> Result<(), String> {
    with_store(&state, |s| {
        let conn = s.conn.lock().unwrap();
        graph_layout::set_collapsed(&conn, &note_id, collapsed)
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

fn start_watcher(app: AppHandle, projects_dir: &Path, generation: uuid::Uuid) -> Result<notify::RecommendedWatcher, String> {
    use notify::{Event, EventKind, RecursiveMode, Watcher};
    use std::collections::BTreeSet;
    let (send, events) = std::sync::mpsc::channel::<Event>();
    let mut watcher = notify::recommended_watcher(move |event: notify::Result<Event>| {
        if let Ok(event) = event {
            if !matches!(event.kind, EventKind::Access(_)) { let _ = send.send(event); }
        }
    }).map_err(|error| format!("无法启动笔记文件监听：{error}"))?;
    watcher.watch(projects_dir, RecursiveMode::Recursive)
        .map_err(|error| format!("无法监听工作区：{error}"))?;
    let projects_dir = projects_dir.to_path_buf();
    std::thread::spawn(move || {
        while let Ok(event) = events.recv() {
            std::thread::sleep(std::time::Duration::from_millis(180));
            let mut changed = BTreeSet::new();
            for event in std::iter::once(event).chain(events.try_iter().take(1024)) {
                for path in event.paths {
                    let path = if path.is_absolute() { path } else { projects_dir.join(path) };
                    if path.starts_with(&projects_dir) &&
                        path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("md")) {
                        changed.insert(path);
                    }
                }
            }
            let state = app.state::<AppState>();
            let current = state.workspace.lock().unwrap();
            let Some(workspace) = current.as_ref().filter(|workspace| workspace.generation == generation) else { return };
            if workspace.store.scan().is_err() { continue; }
            if changed.is_empty() {
                let _ = app.emit("notes:changed", serde_json::json!({ "path": projects_dir.to_string_lossy(), "external": false }));
            } else {
                for path in changed {
                    let _ = app.emit("notes:changed", serde_json::json!({ "path": path.to_string_lossy(), "external": true }));
                }
            }
        }
    });
    Ok(watcher)
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .manage(AppState { workspace: Mutex::new(None) })
        .manage(agent_settings::AgentSettings::default())
        .manage(agent_plugins::AgentPlugins::default())
        .invoke_handler(tauri::generate_handler![
            startup_state, startup_browse, startup_submit, startup_rebuild, startup_exit,
            app_info, db_tables,
            notes_create, notes_read, notes_update, notes_update_strict, notes_delete, notes_list,
            notes_links, notes_search, notes_tags, notes_open_link,
            projects_list, projects_create,
            drafts_list, drafts_write, drafts_discard, drafts_restore, drafts_save_copy,
            graph_layout_get_all, graph_layout_save_batch, graph_layout_set_collapsed, graph_layout_reset, graph_layout_connect_nodes,
            agents_discover,
            agent_plugins::agent_plugins_list, agent_plugins::agent_plugins_active,
            agent_plugins::agent_plugins_resolve, agent_plugins::agent_plugin_install,
            agent_plugins::agent_plugin_uninstall, agent_plugins::agent_plugin_update,
            agent_plugins::agent_plugins_reorder, agent_plugins::agent_plugins_reset_order,
            agent_plugins::agent_plugin_import, agent_plugins::agent_plugin_browse,
            agent_settings::agent_settings_get, agent_settings::agent_settings_save,
            tasks_list_by_note, tasks_summary, tasks_start, tasks_stop, tasks_follow_up,
            tasks_mark_done, tasks_reject
        ])
        .manage(TaskEngine::new())
        .run(tauri::generate_context!())
        .expect("Tauri 应用启动失败");
}
