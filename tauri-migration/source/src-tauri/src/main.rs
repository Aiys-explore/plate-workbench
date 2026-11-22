#![cfg_attr(all(windows, not(debug_assertions)), windows_subsystem = "windows")]

mod agent_runner;
mod agent_plugins;
mod agent_settings;
mod agent_store;
mod db;
mod brain_spaces;
mod context_compiler;
mod memory_consolidator;
mod vitality_engine;
mod graph_layout;
mod harness;
mod notes;
mod provider_store;
mod agent_log_harvester;
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

const MARKER: &str = "plate-workbench.json";
const WORKSPACE_DIRECTORY: &str = "Plate Workbench S10 Preview";

fn workspace_override() -> Option<PathBuf> {
    std::env::var_os("PLATE_WORKSPACE_ROOT")
        .filter(|path| !path.to_string_lossy().trim().is_empty())
        .map(PathBuf::from)
}

fn workspace_registration(app: &AppHandle) -> Result<PathBuf, String> {
    app.path().app_local_data_dir().map(|dir| dir.join("workspace.json"))
        .map_err(|error| format!("无法定位本机工作区登记：{error}"))
}

fn read_registered_workspace(path: &Path) -> Result<Option<PathBuf>, String> {
    match std::fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes).map(Some)
            .map_err(|_| "本机工作区登记已损坏，请重新选择笔记目录。".into()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("无法读取本机工作区登记：{error}")),
    }
}

fn write_json(path: PathBuf, value: &impl serde::Serialize) -> Result<(), String> {
    let directory = path.parent().ok_or("找不到本机设置目录")?;
    std::fs::create_dir_all(directory).map_err(|error| format!("无法创建本机设置目录：{error}"))?;
    let temporary = directory.join(format!("plate-state-{}.tmp", uuid::Uuid::new_v4()));
    let bytes = serde_json::to_vec(value).map_err(|error| error.to_string())?;
    if let Err(error) = std::fs::write(&temporary, bytes).and_then(|()| std::fs::rename(&temporary, &path)) {
        let _ = std::fs::remove_file(&temporary);
        return Err(format!("无法保存本机设置：{error}"));
    }
    Ok(())
}

fn is_registered_workspace(root: &Path) -> bool {
    root.is_absolute() && root.join(MARKER).is_file() && root.join("projects").is_dir()
}

#[cfg(test)]
#[test]
fn saved_workspace_preserves_unicode_and_can_be_replaced() -> Result<(), String> {
    let fixture = std::env::temp_dir().join(format!("plate-workspace-{}", uuid::Uuid::new_v4()));
    let registration = fixture.join("workspace.json");
    let first = fixture.join("中文 笔记");
    let second = fixture.join("日本語 자료");
    let result = (|| {
        assert_eq!(read_registered_workspace(&registration)?, None);
        write_json(registration.clone(), &first)?;
        assert_eq!(read_registered_workspace(&registration)?.as_ref(), Some(&first));
        assert!(!is_registered_workspace(&first));
        write_json(registration.clone(), &second)?;
        assert_eq!(read_registered_workspace(&registration)?.as_ref(), Some(&second));
        assert!(!first.exists() && !second.exists());
        Ok(())
    })();
    let _ = std::fs::remove_file(registration);
    let _ = std::fs::remove_dir(fixture);
    result
}

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
    with_store(&state, |store| engine.start(app, store, task_id, note_id, agent_selector, prompt_text))
}

#[tauri::command]
async fn tasks_stop(engine: State<'_, TaskEngine>, state: State<'_, AppState>, task_id: String) -> Result<TaskCard, String> {
    let root = with_engine(&engine, &state, |_, root| Ok(root.clone()))?;
    engine.stop(&root, &task_id).await
}

#[tauri::command]
fn tasks_follow_up(engine: State<'_, TaskEngine>, state: State<'_, AppState>, app: AppHandle,
    task_id: String, instruction: String) -> Result<TaskCard, String> {
    with_store(&state, |store| engine.follow_up(app, store, &task_id, &instruction))
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
    if let Some(root) = workspace_override() {
        return if is_registered_workspace(&root) {
            Ok(reopen_workspace(&app, &state, &root, true))
        } else {
            Ok(choose_workspace(Some(&root)))
        };
    }
    match workspace_registration(&app).and_then(|path| read_registered_workspace(&path)) {
        Ok(Some(root)) => return Ok(reopen_workspace(&app, &state, &root, false)),
        Ok(None) => (),
        Err(error) => return Ok(serde_json::json!({ "phase": "blocked", "error": error })),
    }
    let suggested = app.path().document_dir().ok()
        .filter(|path| path.is_absolute())
        .map(|path| path.join(WORKSPACE_DIRECTORY));
    if let Some(root) = suggested.as_deref().filter(|root| is_registered_workspace(root)) {
        return Ok(reopen_workspace(&app, &state, root, false));
    }
    Ok(choose_workspace(suggested.as_deref()))
}

fn choose_workspace(suggested: Option<&Path>) -> serde_json::Value {
    serde_json::json!({
        "phase": "choose",
        "suggested": suggested,
        "candidate": suggested.map(workspace_candidate)
    })
}

fn reopen_workspace(app: &AppHandle, state: &State<'_, AppState>, root: &Path, override_root: bool) -> serde_json::Value {
    let result = if is_registered_workspace(root) {
        open_store(app, state, root, false)
    } else {
        Err("已登记的工作区当前不可用。请恢复原目录，或选择另一个笔记目录。".into())
    };
    result.unwrap_or_else(|error| serde_json::json!({
        "phase": "blocked", "path": root, "error": error, "override": override_root
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

fn open_store(app: &AppHandle, state: &State<'_, AppState>, root: &Path, remember: bool) -> Result<serde_json::Value, String> {
    if !root.is_absolute() { return Err("笔记位置必须是绝对路径".into()); }
    let mut current = state.workspace.lock().unwrap();
    if let Some(workspace) = current.as_ref() {
        if workspace.store.root == root { return Ok(ready(root)); }
        if app.state::<TaskEngine>().has_running(&workspace.store.root)
            || app.state::<harness::engine::HarnessState>().has_running() {
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
    if remember {
        write_json(workspace_registration(app)?, &root)?;
    }
    *current = Some(Workspace { store, generation, _watcher: watcher });
    Ok(ready(root))
}

#[tauri::command]
fn startup_submit(app: AppHandle, state: State<'_, AppState>, token: String) -> Result<serde_json::Value, String> {
    let root = Path::new(&token);
    match open_store(&app, &state, root, workspace_override().is_none()) {
        Ok(ready) => Ok(ready),
        Err(error) => Ok(serde_json::json!({
            "phase": "blocked", "path": root, "candidate": workspace_candidate(root), "error": error
        })),
    }
}

#[tauri::command]
fn startup_rebuild(app: AppHandle, state: State<'_, AppState>, token: String) -> Result<serde_json::Value, String> {
    let root = PathBuf::from(&token);
    if !root.join("projects").is_dir() { return Err("该目录没有 projects 子目录，无法重建索引".into()); }
    let next = open_store(&app, &state, &root, false)?;
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
fn update_can_install(
    state: State<'_, AppState>,
    engine: State<'_, TaskEngine>,
    harness: State<'_, harness::engine::HarnessState>,
) -> bool {
    let workspace = state.workspace.lock().unwrap();
    !harness.has_running()
        && !workspace.as_ref().is_some_and(|current| engine.has_running(&current.store.root))
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
fn notes_create(app: AppHandle, state: State<'_, AppState>, title: String, project_id: String,
    template: Option<String>, space_id: Option<String>) -> Result<Note, String> {
    let result = with_store(&state, |store| {
        let space = space_id.as_deref().unwrap_or("learning");
        crate::memory_consolidator::require_space(&store.conn.lock().unwrap(), space)?;
        let note = store.create(&title, &project_id, template.as_deref().unwrap_or("blank"))?;
        if space != "learning" {
            store.conn.lock().unwrap().execute("UPDATE note SET space_id=?2 WHERE id=?1",
                rusqlite::params![note.summary.id,space]).map_err(|e| e.to_string())?;
        }
        Ok(note)
    })?;
    memory_consolidator::changed(&app);
    Ok(result)
}

#[tauri::command]
fn notes_read(app: AppHandle, state: State<'_, AppState>, id: String, touch: Option<bool>) -> Result<Note, String> {
    with_store(&state, |store| {
        let note = store.read(&id)?;
        if touch == Some(true) { boost_note(&app, store, &note.summary.id); }
        Ok(note)
    })
}

fn boost_note(app: &AppHandle, store: &NoteStore, id: &str) {
    if vitality_engine::boost(&store.conn.lock().unwrap(), id, notes::now_ms()).is_ok() {
        let _ = app.emit("brain://changed", ());
    }
}

#[tauri::command]
fn notes_update(app: AppHandle, state: State<'_, AppState>, id: String, content: String, revision: Option<String>, draft_version: Option<String>) -> Result<SaveResult, String> {
    with_store(&state, |store| {
        let result = store.update(&id, &content, revision, draft_version)?;
        if matches!(result, SaveResult::Saved { .. }) { boost_note(&app, store, &id); }
        Ok(result)
    })
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
    #[cfg(windows)]
    harness::local_cli::run_if_requested();
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState { workspace: Mutex::new(None) })
        .manage(agent_settings::AgentSettings::default())
        .manage(agent_plugins::AgentPlugins::default())
        .invoke_handler(tauri::generate_handler![
            startup_state, startup_browse, startup_submit, startup_rebuild, startup_exit,
            app_info, db_tables, update_can_install,
            notes_create, notes_read, notes_update, notes_update_strict, notes_delete, notes_list,
            notes_links, notes_search, notes_tags, notes_open_link,
            projects_list, projects_create,
            drafts_list, drafts_write, drafts_discard, drafts_restore, drafts_save_copy,
            graph_layout_get_all, graph_layout_save_batch, graph_layout_set_collapsed, graph_layout_reset, graph_layout_connect_nodes,
            agents_discover,
            provider_store::provider_list, provider_store::provider_upsert,
            provider_store::provider_delete, provider_store::provider_test_connection,
            agent_log_harvester::agent_logs_scan, agent_log_harvester::agent_logs_list,
            agent_log_harvester::agent_logs_get_messages, agent_log_harvester::agent_logs_search,
            agent_log_harvester::agent_logs_send_to_hippocampus,
            harness::profiles::profile_list, harness::profiles::profile_upsert, harness::profiles::profile_delete,
            harness::prompt_assembler::global_prompt_get, harness::prompt_assembler::global_prompt_set,
            harness::engine::harness_preview_prompt, harness::engine::harness_start_run, harness::engine::harness_cancel_run,
            harness::engine::harness_list_runs, harness::engine::harness_get_events,
            harness::engine::staging_list_diffs, harness::engine::staging_resolve_diff,
            agent_plugins::agent_plugins_list, agent_plugins::agent_plugins_active,
            agent_plugins::agent_plugins_resolve, agent_plugins::agent_plugin_install,
            agent_plugins::agent_plugin_uninstall, agent_plugins::agent_plugin_update,
            agent_plugins::agent_plugin_save_deepseek,
            agent_plugins::agent_plugins_reorder, agent_plugins::agent_plugins_reset_order,
            agent_plugins::agent_plugin_import, agent_plugins::agent_plugin_browse,
            agent_settings::agent_settings_get, agent_settings::agent_settings_save,
            tasks_list_by_note, tasks_summary, tasks_start, tasks_stop, tasks_follow_up,
            tasks_mark_done, tasks_reject,
            brain_spaces::brain_spaces_list, brain_spaces::brain_space_upsert,
            memory_consolidator::episodic_update_candidate, memory_consolidator::episodic_promote_to_note,
            memory_consolidator::episodic_discard, vitality_engine::brain_scan_context_rot,
            memory_consolidator::brain_status, memory_consolidator::set_brain_context,
            memory_consolidator::brain_note_metadata, memory_consolidator::capture_episodic_event,
            memory_consolidator::list_episodic_events, memory_consolidator::consolidate_episodic_to_note,
            memory_consolidator::list_procedural_skills, memory_consolidator::save_procedural_skill,
            memory_consolidator::save_workbench_skill, memory_consolidator::dream_model_suggestion, memory_consolidator::dream_stage,
            memory_consolidator::apply_memory_delta, memory_consolidator::get_note_evolution_history,
            memory_consolidator::recalculate_brain_vitality, memory_consolidator::trigger_dream_consolidation
        ])
        .manage(TaskEngine::new())
        .manage(harness::engine::HarnessState::default())
        .run(tauri::generate_context!())
        .expect("Tauri 应用启动失败");
}
