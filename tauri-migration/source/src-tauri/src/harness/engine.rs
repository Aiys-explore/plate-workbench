use super::{llm_provider as llm, policy::PermissionManifest, profiles, prompt_assembler::{self, AssembledPrompt}, staging};
use crate::{
    agent_log_harvester, brain_spaces::{self, SpaceScopePolicy}, context_compiler,
    notes::{now_ms, NoteFilters, NoteStore},
    provider_store, with_store, AppState,
};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::Path;
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::sync::oneshot;

const EVENT: &str = "harness:event";
const CANCELLED: &str = "任务已取消";

#[derive(Clone, Copy, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum BackendKind {
    LocalCli,
    ApiKey,
}

impl BackendKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::LocalCli => "local_cli",
            Self::ApiKey => "api_key",
        }
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RunRequest {
    title: String,
    prompt: String,
    backend_kind: BackendKind,
    backend_id: String,
    model_override: Option<String>,
    profile_id: Option<String>,
    seed_note_id: Option<String>,
    skill_id: Option<String>,
    prompt_version_id: Option<String>,
    attached_log_session_ids: Vec<String>,
    permissions: PermissionManifest,
    #[serde(default)]
    space_scope: SpaceScopePolicy,
}

#[derive(Default, Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct Usage {
    token_in: u64,
    token_out: u64,
    cost_usd: f64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HarnessRun {
    id: String,
    title: String,
    backend_kind: String,
    backend_id: String,
    model_name: String,
    status: String,
    token_in: i64,
    token_out: i64,
    cost_usd: f64,
    updated_at: i64,
}

#[derive(Serialize)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase"
)]
enum HarnessEvent<'a> {
    RunStarted {
        run_id: &'a str,
        prompt: &'a str,
    },
    ContextActivated {
        run_id: &'a str,
        wave: Option<&'a context_compiler::BrainActivationWave>,
        attached_log_count: usize,
    },
    PromptAssembled { run_id: &'a str, prompt: &'a AssembledPrompt, space_ids: &'a [String] },
    StepUsage { run_id: &'a str, step: u32, #[serde(flatten)] usage: Usage },
    TokenDelta {
        run_id: &'a str,
        delta: &'a str,
    },
    ToolCall {
        run_id: &'a str,
        tool_name: &'a str,
        summary: &'a str,
        allowed: bool,
    },
    DiffProposed {
        run_id: &'a str,
        diff_id: &'a str,
    },
    RunStatusChanged {
        run_id: &'a str,
        status: &'a str,
        #[serde(flatten)]
        usage: Usage,
        error: Option<&'a str>,
    },
}

impl HarnessEvent<'_> {
    fn run_id(&self) -> &str {
        match self {
            Self::RunStarted { run_id, .. }
            | Self::ContextActivated { run_id, .. }
            | Self::PromptAssembled { run_id, .. }
            | Self::StepUsage { run_id, .. }
            | Self::TokenDelta { run_id, .. }
            | Self::ToolCall { run_id, .. }
            | Self::DiffProposed { run_id, .. }
            | Self::RunStatusChanged { run_id, .. } => run_id,
        }
    }
}

#[derive(Default)]
pub struct HarnessState(Mutex<HashMap<String, Option<oneshot::Sender<()>>>>);
impl HarnessState {
    pub fn has_running(&self) -> bool {
        !self.0.lock().unwrap().is_empty()
    }
}

enum Backend {
    Api(provider_store::ProviderConfig, String),
    Local(crate::agent_plugins::Route),
}

struct Task {
    id: String,
    backend: Backend,
    user_prompt: String,
    system: AssembledPrompt,
    options: llm::ModelOptions,
    space_ids: Vec<String>,
    model: String,
    permissions: PermissionManifest,
    wave: Option<context_compiler::BrainActivationWave>,
    log_count: usize,
    scope: SpaceScopePolicy,
}

fn record(conn: &Connection, event: &HarnessEvent<'_>) -> Result<(), String> {
    let value = serde_json::to_value(event).map_err(db_error)?;
    let id = event.run_id();
    conn.execute(
        "INSERT INTO harness_events(run_id,seq,kind,payload_json,created_at)
         SELECT ?1,COALESCE(MAX(seq),0)+1,?2,?3,?4 FROM harness_events WHERE run_id=?1",
        params![
            id,
            value["kind"].as_str().unwrap_or(""),
            value.to_string(),
            now_ms()
        ],
    )
    .map_err(db_error)?;
    Ok(())
}

fn emit(app: &AppHandle, event: HarnessEvent<'_>) -> Result<(), String> {
    with_store(&app.state::<AppState>(), |store| {
        record(&store.conn.lock().unwrap(), &event)
    })?;
    let _ = app.emit(EVENT, &event);
    Ok(())
}

fn db_error(error: impl std::fmt::Display) -> String {
    error.to_string()
}

fn select_backend(
    app: &AppHandle,
    store: &NoteStore,
    request: &RunRequest,
) -> Result<(Backend, String, String), String> {
    match request.backend_kind {
        BackendKind::ApiKey => {
            if !request.permissions.allow_network {
                return Err("请先明确授权连接所选模型服务".into());
            }
            let cfg = {
                let conn = store.conn.lock().unwrap();
                if request.backend_id.is_empty() {
                    provider_store::for_role(&conn, provider_store::ModelRole::WorkbenchChat)?
                        .ok_or("请在设置中指定工作台任务模型")?
                } else {
                    provider_store::get(&conn, &request.backend_id)?
                }
            };
            if !cfg.enabled {
                return Err("该服务商已停用".into());
            }
            let id = cfg.id.clone();
            let model = request
                .model_override
                .as_deref()
                .unwrap_or(&cfg.default_model)
                .trim()
                .to_string();
            if model.is_empty() || model.len() > 240 {
                return Err("模型标识无效".into());
            }
            let key = provider_store::load_secret_key(&id)?;
            Ok((Backend::Api(cfg, key), id, model))
        }
        BackendKind::LocalCli => {
            #[cfg(not(windows))]
            {
                let _ = app;
                return Err("本机 CLI 隔离目前需要 Windows".into());
            }
            #[cfg(windows)]
            {
                let mut route = app
                    .state::<crate::agent_plugins::AgentPlugins>()
                    .route(app, Some(&request.backend_id))?
                    .ok_or("请先在本机 Agent 设置中启用 CLI")?;
                if !Path::new(&route.executable)
                    .extension()
                    .is_some_and(|ext| ext.eq_ignore_ascii_case("exe"))
                {
                    return Err("工作台隔离模式需要独立 Windows EXE".into());
                }
                if let Some(model) = &request.model_override {
                    if model.is_empty() || model.len() > 240 || model.starts_with('-') || model.chars().any(char::is_control) {
                        return Err("模型标识无效".into());
                    }
                    if route.model_flag.is_none() { return Err("该 CLI 无模型覆盖参数".into()); }
                    route.selected_model = model.clone();
                }
                let id = route.id.clone();
                let model = route.selected_model.clone();
                Ok((Backend::Local(route), id, model))
            }
        }
    }
}

fn apply_profile(conn: &Connection, request: &mut RunRequest) -> Result<llm::ModelOptions, String> {
    let Some(id) = request.profile_id.as_deref() else { return Ok(llm::ModelOptions::default()); };
    let profile = profiles::get(conn, id)?;
    request.backend_kind = profile.backend_kind;
    request.backend_id = profile.backend_id;
    request.model_override = (!profile.model_name.trim().is_empty()).then_some(profile.model_name);
    let template = profile.default_permissions;
    request.permissions.allow_all_notes_read &= template.allow_all_notes_read;
    request.permissions.allow_brain_note_propose &= template.allow_brain_note_propose;
    request.permissions.allow_network &= template.allow_network;
    request.permissions.allow_shell &= template.allow_shell;
    request.permissions.writable_dirs.retain(|path| template.writable_dirs.contains(path));
    request.permissions.max_steps = request.permissions.max_steps.min(profile.max_steps);
    request.permissions.max_budget_usd = request.permissions.max_budget_usd.min(profile.max_budget_usd);
    Ok(llm::ModelOptions {
        temperature: Some(profile.temperature), reasoning_effort: Some(profile.reasoning_effort),
    })
}

fn export_allowed(conn: &Connection, spaces: &[String]) -> Result<bool, String> {
    for space in spaces {
        let allowed: bool = conn.query_row("SELECT allow_export FROM brain_spaces WHERE id=?1",
            [space], |row| row.get(0)).map_err(db_error)?;
        if !allowed { return Ok(false); }
    }
    Ok(true)
}

struct Compiled {
    system: AssembledPrompt,
    wave: Option<context_compiler::BrainActivationWave>,
    log_count: usize,
    space_ids: Vec<String>,
    options: llm::ModelOptions,
}

fn load_context(
    store: &NoteStore,
    request: &mut RunRequest,
    id: &str,
) -> Result<Compiled, String> {
    let mut selected_skill = None;
    let (log_block, log_count, spaces, options, allow_export);
    request.permissions.validate()?;
    {
        let conn = store.conn.lock().unwrap();
        options = apply_profile(&conn, request)?;
        spaces = request.space_scope.allowed(&conn)?;
        allow_export = export_allowed(&conn, &spaces)?;
        (log_block, log_count) = context_compiler::compile_harness_logs(
            &conn,
            &request.attached_log_session_ids,
            &request.permissions,
        )?;
        if let Some(skill_id) = &request.skill_id {
            let (prompt, shell, network, space) = conn.query_row(
                "SELECT system_prompt,allow_shell,allow_network,space_id FROM procedural_skills WHERE id=?1", [skill_id],
                |row| Ok((row.get::<_, String>(0)?,row.get::<_, bool>(1)?,row.get::<_, bool>(2)?,row.get::<_, String>(3)?)),
            ).map_err(|_| "找不到所选技能")?;
            if !spaces.contains(&space) { return Err("所选技能不在任务脑区范围内".into()); }
            request.permissions.restrict_with_skill(shell, network);
            let version = match request.prompt_version_id.as_deref() {
                Some(id) => {
                    let version = super::prompt_versions::get(&conn,skill_id,id)?;
                    if version.status == "retired" { return Err("请先将已退役版本恢复为测试".into()); }
                    version
                }
                None => super::prompt_versions::production(&conn,skill_id)?,
            };
            selected_skill = Some(json!({"version":version.version_tag,"status":version.status,
                "instruction":if version.system_prompt.is_empty() { prompt } else { version.system_prompt }}));
        }
    }
    let mut compiled = String::new();
    let mut wave = None;
    if let Some(seed) = &request.seed_note_id {
        if !request.permissions.can_read_note(seed) {
            return Err("种子笔记未授权给本次任务".into());
        }
        if let Some(packet) =
            context_compiler::compile_harness_seed(store, seed, id, &request.permissions, &spaces)?
        {
            compiled.push_str("\n\n[授权笔记资料]\n");
            compiled.push_str(&packet.compiled_prompt);
            let mut activation = packet.wave;
            if let Some(skill) = &request.skill_id {
                activation.activated_skill_ids.push(skill.clone());
            }
            wave = Some(activation);
        }
    }
    if let Some(rule) = selected_skill {
        compiled.push_str(&format!("\n\n[所选技能说明]\n{}", json!(rule)));
    }
    compiled.push_str(&log_block);
    let system = prompt_assembler::assemble(store, &request.permissions, compiled, allow_export, &request.space_scope.target_space_id)?;
    Ok(Compiled { system, wave, log_count, space_ids: spaces, options })
}

#[tauri::command]
pub fn harness_preview_prompt(state: State<'_, AppState>, mut request: RunRequest) -> Result<AssembledPrompt, String> {
    with_store(&state, |store| Ok(load_context(store,&mut request,"preview")?.system))
}

fn insert(
    app: &AppHandle,
    request: &mut RunRequest,
    sender: oneshot::Sender<()>,
) -> Result<Task, String> {
    if request.title.trim().is_empty()
        || request.title.len() > 400
        || request.prompt.trim().is_empty()
        || request.prompt.len() > 24_000
        || request.attached_log_session_ids.len() > 32
    {
        return Err("请填写有效的任务标题、内容和引用".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let state = app.state::<AppState>();
    with_store(&state, |store| {
        let Compiled { system, wave, log_count, space_ids, options } = load_context(store, request, &id)?;
        let (backend, backend_id, model) = select_backend(app, store, request)?;
        let project = request
            .seed_note_id
            .as_deref()
            .map(|seed| store.read(seed))
            .transpose()?
            .map(|note| note.summary.project_id)
            .unwrap_or_else(|| crate::notes::DEFAULT_PROJECT.into());
        let json = serde_json::to_string(&request.permissions).map_err(db_error)?;
        let wave_json = wave
            .as_ref()
            .map(serde_json::to_string)
            .transpose()
            .map_err(db_error)?;
        let conn = store.conn.lock().unwrap();
        let tx = conn.unchecked_transaction().map_err(db_error)?;
        tx.execute(
            "INSERT INTO harness_runs(id,title,backend_kind,backend_id,model_name,skill_id,permission_manifest_json,
             activation_wave_json,status,created_at,updated_at,project_id,space_id)
             VALUES(?1,?2,?3,?4,?5,?6,?7,?8,'running',?9,?9,?10,?11)",
            params![id,request.title.trim(),request.backend_kind.as_str(),backend_id,model,request.skill_id,json,wave_json,now_ms(),project,request.space_scope.target_space_id],
        ).map_err(db_error)?;
        if let Some(skill) = &request.skill_id {
            tx.execute(
                "UPDATE procedural_skills SET usage_count=usage_count+1 WHERE id=?1",
                [skill],
            )
            .map_err(db_error)?;
        }
        record(
            &tx,
            &HarnessEvent::RunStarted {
                run_id: &id,
                prompt: &request.prompt,
            },
        )?;
        tx.commit().map_err(db_error)?;
        // Reserve the run while the workspace lock is still held.
        app.state::<HarnessState>()
            .0
            .lock()
            .unwrap()
            .insert(id.clone(), Some(sender));
        Ok(Task {
            id,
            backend,
            user_prompt: request.prompt.clone(),
            system,
            options,
            space_ids,
            model,
            permissions: request.permissions.clone(),
            wave,
            log_count,
            scope: request.space_scope.clone(),
        })
    })
}

fn use_tool(
    app: &AppHandle,
    run: &str,
    policy: &PermissionManifest,
    scope: &SpaceScopePolicy,
    call: &llm::ToolCall,
) -> Result<Value, String> {
    let args = serde_json::from_str::<Value>(&call.args).map_err(|_| "工具参数不是有效 JSON")?;
    let required = |field: &str| {
        args[field]
            .as_str()
            .ok_or_else(|| format!("工具缺少 {field}"))
    };
    let rationale = args["rationale"].as_str().unwrap_or("");
    let result = with_store(&app.state::<AppState>(), |store| {
        let spaces = scope.allowed(&store.conn.lock().unwrap())?;
        match call.name.as_str() {
        "read_workspace_file" => {
            let content =
                staging::read_workspace_file(policy, &store.root, Path::new(required("path")?))?;
            Ok(json!({"content":content}))
        }
        "propose_file_write" => {
            if !export_allowed(&store.conn.lock().unwrap(), &spaces)? {
                return Err("任务读取范围含禁止导出的脑区".into());
            }
            let id = staging::propose_workspace_file(
                store,
                policy,
                run,
                Path::new(required("path")?),
                required("content")?,
                rationale,
            )?;
            Ok(json!({"diffId":id}))
        }
        "search_notes" => {
            let query = required("query")?.trim().to_lowercase();
            if query.is_empty() || query.len() > 400 {
                return Err("请输入有效检索词".into());
            }
            let mut notes = Vec::new();
            for note in store
                .list(NoteFilters::default())?
                .into_iter()
                .filter(|note| policy.can_read_note(&note.id))
            {
                let space = brain_spaces::note_space(&store.conn.lock().unwrap(), &note.id)?;
                if !spaces.contains(&space) { continue; }
                let Ok(item) = store.read(&note.id) else {
                    continue;
                };
                if note.title.to_lowercase().contains(&query)
                    || item.content.to_lowercase().contains(&query)
                {
                    notes.push(json!({"id":note.id,"title":note.title,"excerpt":item.content.chars().take(800).collect::<String>()}));
                    if notes.len() == 8 {
                        break;
                    }
                }
            }
            Ok(json!({"notes":notes}))
        }
        "search_agent_logs" => {
            let query = required("query")?.trim();
            if query.is_empty() || query.len() > 400 {
                return Err("请输入有效检索词".into());
            }
            let conn = store.conn.lock().unwrap();
            Ok(
                json!({"sessions":agent_log_harvester::search_authorized(&conn,query,&policy.readable_log_session_ids)?}),
            )
        }
        "propose_note_update" => {
            let id = required("noteId")?;
            if !policy.allow_brain_note_propose || !policy.can_read_note(id) {
                return Err("当前任务未获准提出该笔记的变更".into());
            }
            if brain_spaces::note_space(&store.conn.lock().unwrap(), id)? != scope.target_space_id {
                return Err("跨脑区资料仅供读取".into());
            }
            let note = store.read(id)?;
            let id = staging::propose(
                &store.conn.lock().unwrap(),
                run,
                "brain_note",
                id,
                Some(&note.content),
                required("content")?,
                rationale,
            )?;
            Ok(json!({"diffId":id}))
        }
        _ => Err("任务工具未获授权".into()),
        }
    })?;
    if let Some(id) = result["diffId"].as_str() {
        emit(
            app,
            HarnessEvent::DiffProposed {
                run_id: run,
                diff_id: id,
            },
        )?;
    }
    Ok(result)
}

fn save_usage(app: &AppHandle, id: &str, usage: Usage) -> Result<(), String> {
    with_store(&app.state::<AppState>(), |store| {
        store.conn.lock().unwrap()
            .execute("UPDATE harness_runs SET token_in=?2,token_out=?3,cost_usd=?4,updated_at=?5 WHERE id=?1",
                params![id,usage.token_in,usage.token_out,usage.cost_usd,now_ms()]).map_err(db_error)?;
        Ok(())
    })
}

async fn api_task(
    app: &AppHandle,
    task: &Task,
    provider: &provider_store::ProviderConfig,
    key: &str,
) -> Result<(), String> {
    let id = &task.id;
    let mut history = vec![llm::Turn::User(task.user_prompt.clone())];
    let mut usage = Usage::default();
    let mut actions = 0;
    for step in 0..task.permissions.max_steps {
        let with_tools =
            step + 1 < task.permissions.max_steps && actions < task.permissions.max_steps;
        let (reply, cost) = llm::stream_configured(
            provider,
            key,
            &task.model,
            &history,
            (task.permissions.max_budget_usd - usage.cost_usd).max(0.0),
            with_tools,
            &task.system.final_prompt,
            &task.options,
            |text| {
                emit(
                    app,
                    HarnessEvent::TokenDelta {
                        run_id: id,
                        delta: text,
                    },
                )
            },
        )
        .await?;
        usage.token_in = usage.token_in.saturating_add(reply.input);
        usage.token_out = usage.token_out.saturating_add(reply.output);
        usage.cost_usd += cost;
        save_usage(app, id, usage)?;
        emit(app, HarnessEvent::StepUsage { run_id:id, step:step+1,
            usage:Usage { token_in:reply.input, token_out:reply.output, cost_usd:cost } })?;
        if usage.cost_usd > task.permissions.max_budget_usd {
            return Err("模型返回的计费已达到任务上限".into());
        }
        if reply.calls().next().is_none() {
            return Ok(());
        }
        if !with_tools {
            return Err("任务已达工具调用或推理步数上限".into());
        }
        let mut results = Vec::new();
        for call in reply.calls() {
            actions += 1;
            if actions > task.permissions.max_steps {
                return Err("任务已达工具调用上限".into());
            }
            let result = use_tool(app, id, &task.permissions, &task.scope, call);
            let allowed = result.is_ok();
            let (summary, value) = match result {
                Ok(value) => ("已执行受控工具".to_string(), value),
                Err(error) => (error.clone(), json!({"error":error})),
            };
            emit(
                app,
                HarnessEvent::ToolCall {
                    run_id: id,
                    tool_name: &call.name,
                    summary: &summary,
                    allowed,
                },
            )?;
            results.push(llm::ToolResult {
                call: call.clone(),
                result: value,
            });
        }
        history.push(llm::Turn::Assistant(reply));
        history.push(llm::Turn::Results(results));
    }
    Err("任务已达推理步数上限".into())
}

#[cfg(windows)]
async fn local_task(
    app: &AppHandle,
    id: &str,
    policy: &PermissionManifest,
    scope: &SpaceScopePolicy,
    route: crate::agent_plugins::Route,
    mut prompt: String,
    cancel: oneshot::Receiver<()>,
) -> Result<(), String> {
    prompt.push_str("\n\n可选：仅通过回复行 <plate-diffs>[{\"path\":\"绝对路径\",\"content\":\"UTF-8文本\",\"rationale\":\"原因\"}]</plate-diffs> 提议文件修改。真实文件变更由用户审阅处理。");
    let output = crate::agent_runner::run_harness_cli(
        route,
        prompt,
        policy.allow_network,
        policy.allow_shell,
        cancel,
        |delta| {
            let _ = emit(app, HarnessEvent::TokenDelta { run_id: id, delta });
        },
    )
    .await?;
    if let Some((_, tail)) = output.rsplit_once("<plate-diffs>") {
        let raw = tail
            .strip_suffix("</plate-diffs>")
            .or_else(|| tail.trim_end().strip_suffix("</plate-diffs>"))
            .ok_or("CLI 返回的暂存提议未完整结束")?;
        let proposals: Vec<Value> =
            serde_json::from_str(raw).map_err(|_| "CLI 暂存提议不是有效 JSON")?;
        if proposals.len() > policy.max_steps as usize {
            return Err("CLI 提议数量超限".into());
        }
        for proposal in proposals {
            let call = llm::ToolCall::proposal(proposal.to_string());
            let result = use_tool(app, id, policy, scope, &call);
            let allowed = result.is_ok();
            let status = result.err().unwrap_or_else(|| "已暂存，等待审阅".into());
            emit(
                app,
                HarnessEvent::ToolCall {
                    run_id: id,
                    tool_name: "propose_file_write",
                    summary: &status,
                    allowed,
                },
            )?;
        }
    }
    Ok(())
}

fn finish(app: &AppHandle, id: &str, result: Result<(), String>) -> Result<(), String> {
    let (status, usage) = with_store(&app.state::<AppState>(), |store| {
        let conn = store.conn.lock().unwrap();
        let tx = conn.unchecked_transaction().map_err(db_error)?;
        let pending: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM staged_diffs WHERE run_id=?1 AND status='pending'",
                [id],
                |row| row.get(0),
            )
            .map_err(db_error)?;
        let status = match &result {
            Err(error) if error == CANCELLED => "cancelled",
            Err(_) => "failed",
            Ok(()) if pending > 0 => "review_ready",
            Ok(()) => "completed",
        };
        tx.execute(
            "UPDATE harness_runs SET status=?2,updated_at=?3 WHERE id=?1",
            params![id, status, now_ms()],
        )
        .map_err(db_error)?;
        if status == "completed" {
            crate::memory_consolidator::harness_recap(&tx, id)?;
        }
        let usage = tx
            .query_row(
                "SELECT token_in,token_out,cost_usd FROM harness_runs WHERE id=?1",
                [id],
                |row| {
                    Ok(Usage {
                        token_in: row.get(0)?,
                        token_out: row.get(1)?,
                        cost_usd: row.get(2)?,
                    })
                },
            )
            .map_err(db_error)?;
        tx.commit().map_err(db_error)?;
        Ok((status, usage))
    })?;
    emit(
        app,
        HarnessEvent::RunStatusChanged {
            run_id: id,
            status,
            usage,
            error: result.as_ref().err().map(String::as_str),
        },
    )?;
    if status == "completed" {
        let _ = app.emit("brain://changed", ());
    }
    Ok(())
}

pub fn recover_interrupted(conn: &Connection) -> Result<(), String> {
    conn.execute(
        "UPDATE harness_runs SET status='failed',updated_at=?1 WHERE status='running'",
        [now_ms()],
    )
    .map_err(db_error)?;
    Ok(())
}

#[tauri::command]
pub fn harness_start_run(app: AppHandle, mut request: RunRequest) -> Result<String, String> {
    let (sender, mut cancel) = oneshot::channel();
    let task = insert(&app, &mut request, sender)?;
    let id = task.id.clone();
    tauri::async_runtime::spawn(async move {
        if let Some(wave) = &task.wave {
            let _ = app.emit("brain://activation-wave", wave);
        }
        let assembled = emit(&app, HarnessEvent::PromptAssembled { run_id:&task.id, prompt:&task.system, space_ids:&task.space_ids });
        let result = match assembled.and_then(|()| emit(
            &app,
            HarnessEvent::ContextActivated {
                run_id: &task.id,
                wave: task.wave.as_ref(),
                attached_log_count: task.log_count,
            },
        )) {
            Err(error) => Err(error),
            Ok(()) => match task.backend {
                Backend::Api(ref provider, ref key) => tokio::select! {
                    biased;
                    _ = &mut cancel => Err(CANCELLED.into()),
                    result = api_task(&app,&task,provider,key) => result,
                },
                #[cfg(windows)]
                Backend::Local(route) => {
                    local_task(
                        &app,
                        &task.id,
                        &task.permissions,
                        &task.scope,
                        route,
                        format!("{}\n\n[任务]\n{}", task.system.final_prompt, task.user_prompt),
                        cancel,
                    )
                    .await
                }
                #[cfg(not(windows))]
                Backend::Local(_) => Err("本机 CLI 隔离目前需要 Windows".into()),
            },
        };
        let _ = finish(&app, &task.id, result);
        app.state::<HarnessState>()
            .0
            .lock()
            .unwrap()
            .remove(&task.id);
    });
    Ok(id)
}

#[tauri::command]
pub fn harness_cancel_run(state: State<'_, HarnessState>, run_id: String) -> Result<(), String> {
    let mut running = state.0.lock().unwrap();
    let signal = running.get_mut(&run_id).ok_or("任务已结束")?.take();
    if let Some(signal) = signal {
        let _ = signal.send(());
    }
    Ok(())
}

#[tauri::command]
pub fn harness_list_runs(state: State<'_, AppState>) -> Result<Vec<HarnessRun>, String> {
    with_store(&state, |store| {
        let conn = store.conn.lock().unwrap();
        let mut statement = conn.prepare(
            "SELECT id,title,backend_kind,backend_id,model_name,status,token_in,token_out,cost_usd,updated_at
             FROM harness_runs ORDER BY created_at DESC,id LIMIT 100",
        ).map_err(db_error)?;
        let rows = statement
            .query_map([], |r| {
                Ok(HarnessRun {
                    id: r.get(0)?,
                    title: r.get(1)?,
                    backend_kind: r.get(2)?,
                    backend_id: r.get(3)?,
                    model_name: r.get(4)?,
                    status: r.get(5)?,
                    token_in: r.get(6)?,
                    token_out: r.get(7)?,
                    cost_usd: r.get(8)?,
                    updated_at: r.get(9)?,
                })
            })
            .map_err(db_error)?;
        rows.collect::<rusqlite::Result<_>>().map_err(db_error)
    })
}

#[tauri::command]
pub fn harness_get_events(
    state: State<'_, AppState>,
    run_id: String,
) -> Result<Vec<Value>, String> {
    with_store(&state, |store| {
        let conn = store.conn.lock().unwrap();
        let mut statement = conn
            .prepare("SELECT payload_json FROM harness_events WHERE run_id=?1 ORDER BY seq")
            .map_err(db_error)?;
        let rows = statement
            .query_map([run_id], |row| row.get::<_, String>(0))
            .map_err(db_error)?;
        let mut events = Vec::new();
        for row in rows {
            events.push(serde_json::from_str(&row.map_err(db_error)?).map_err(db_error)?);
        }
        Ok(events)
    })
}

#[tauri::command]
pub fn staging_list_diffs(
    state: State<'_, AppState>,
    run_id: String,
) -> Result<Vec<staging::StagedDiff>, String> {
    with_store(&state, |store| {
        staging::list(&store.conn.lock().unwrap(), &run_id)
    })
}

#[tauri::command]
pub fn staging_resolve_diff(
    app: AppHandle,
    state: State<'_, AppState>,
    diff_id: String,
    accept: bool,
) -> Result<(), String> {
    let completed = with_store(&state, |store| {
        let (diff, status, policy, space, project) = {
            let conn = store.conn.lock().unwrap();
            let diff = staging::get(&conn, &diff_id)?;
            let (status, raw, space, project): (String, String, String, String) = conn
                .query_row(
                    "SELECT status,permission_manifest_json,space_id,project_id FROM harness_runs WHERE id=?1",
                    [&diff.run_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
                .map_err(db_error)?;
            (
                diff,
                status,
                serde_json::from_str::<PermissionManifest>(&raw).map_err(db_error)?, space, project,
            )
        };
        if status == "running" || diff.status != "pending" {
            return Err("请等待任务结束并选择尚未处理的变更".into());
        }
        if accept {
            match diff.target_kind.as_str() {
                "workspace_file" => {
                    if !export_allowed(&store.conn.lock().unwrap(), &[space.clone()])? {
                        return Err("此脑区禁止导出文件".into());
                    }
                    staging::approve_file(store, &policy, &diff)?;
                }
                "brain_note" if diff.base_sha256 == "absent" && policy.allow_brain_note_propose =>
                    staging::approve_new_note(store, &diff, &project, &space)?,
                "brain_note" => {
                    if brain_spaces::note_space(&store.conn.lock().unwrap(), &diff.target_ref)? != space {
                        return Err("暂存笔记已不在任务写入脑区".into());
                    }
                    staging::approve_note(store, &policy, &diff)?;
                }
                _ => return Err("不支持该变更类型".into()),
            }
        }
        let conn = store.conn.lock().unwrap();
        let tx = conn.unchecked_transaction().map_err(db_error)?;
        staging::resolve_record(&tx, &diff, accept)?;
        if accept && diff.target_kind == "brain_note" {
            staging::record_note_evolution(&tx, &diff)?;
        }
        let pending: i64 = tx
            .query_row(
                "SELECT COUNT(*) FROM staged_diffs WHERE run_id=?1 AND status='pending'",
                [&diff.run_id],
                |row| row.get(0),
            )
            .map_err(db_error)?;
        let completed = status == "review_ready" && pending == 0;
        if completed {
            crate::memory_consolidator::harness_recap(&tx, &diff.run_id)?;
            tx.execute(
                "UPDATE harness_runs SET status='completed',updated_at=?2 WHERE id=?1",
                params![diff.run_id, now_ms()],
            )
            .map_err(db_error)?;
        }
        tx.commit().map_err(db_error)?;
        Ok(completed)
    })?;
    let _ = app.emit("harness:review-updated", completed);
    if accept || completed {
        let _ = app.emit("brain://changed", ());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preview_uses_profile_limits_and_only_authorized_rules() -> Result<(), String> {
        let root = std::env::temp_dir().join(format!("plate-s11-m2-{}",uuid::Uuid::new_v4()));
        let result = (|| {
            let workspace = root.join("notes");
            let rules = root.join("authorized");
            std::fs::create_dir_all(&rules).map_err(db_error)?;
            std::fs::write(rules.join("AGENTS.md"),"AUTHORIZED_WORK_RULE").map_err(db_error)?;
            std::fs::write(root.join("CLAUDE.md"),"OTHER_PRIVATE_RULE").map_err(db_error)?;
            let store = NoteStore::new(&workspace)?;
            let template = PermissionManifest { writable_dirs: vec![rules.canonicalize().map_err(db_error)?],
                allow_network:true, ..Default::default() };
            {
                let conn = store.conn.lock().unwrap();
                conn.execute("UPDATE brain_settings SET global_system_prompt='GLOBAL_FIXTURE' WHERE singleton=1",[]).map_err(db_error)?;
                conn.execute("INSERT INTO model_profiles(id,name,backend_kind,backend_id,max_steps,max_budget_usd,default_permissions_json,updated_at)
                    VALUES('p','Fixture','api_key','',3,0.2,?1,1)",[serde_json::to_string(&template).map_err(db_error)?]).map_err(db_error)?;
            }
            let mut req = RunRequest { title:"test".into(),prompt:"user input".into(), backend_kind:BackendKind::ApiKey,
                backend_id:String::new(),model_override:None,profile_id:Some("p".into()),seed_note_id:None,skill_id:None,prompt_version_id:None,
                attached_log_session_ids:vec![],space_scope:SpaceScopePolicy {
                    target_space_id:"work".into(),readable_space_ids:vec!["personal".into()],
                }, permissions:PermissionManifest { writable_dirs:vec![rules,root.clone()], ..template } };
            let preview = load_context(&store,&mut req,"preview")?;
            assert_eq!(preview.space_ids,["work"]);
            assert_eq!(req.permissions.max_steps,3);
            assert_eq!(req.permissions.max_budget_usd,0.2);
            assert_eq!(req.permissions.writable_dirs.len(),1);
            assert!(preview.system.final_prompt.contains("GLOBAL_FIXTURE"));
            assert!(preview.system.final_prompt.contains("AUTHORIZED_WORK_RULE"));
            assert!(!preview.system.final_prompt.contains("OTHER_PRIVATE_RULE"));
            assert_eq!(serde_json::to_value(&preview.system).map_err(db_error)?["layers"].as_array().unwrap().len(),4);
            Ok(())
        })();
        std::fs::remove_dir_all(root).map_err(db_error)?;
        result
    }
}
