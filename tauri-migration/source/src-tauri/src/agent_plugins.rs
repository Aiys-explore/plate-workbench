use crate::{agent_settings::AgentSettings, write_json};
use crate::agent_store::{self, BUILTINS};
use serde::{Deserialize, Serialize};
use std::{collections::{HashMap, HashSet}, fs, io::ErrorKind, path::Path, sync::Mutex};
use tauri::{AppHandle, Emitter, Manager};
use tauri_plugin_dialog::DialogExt;

const CHANGED: &str = "agent-plugins:changed";
const NOT_ENABLED: &str = "该 Agent 插件未启用，请先在「使用 / Agent」面板中开启接入";

#[derive(Default)]
pub struct AgentPlugins {
    storage: Mutex<()>,
    versions: Mutex<HashMap<String, String>>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Manifest {
    id: String,
    name: String,
    executable: String,
    #[serde(default)]
    args: Vec<String>,
    model_flag: Option<String>,
    #[serde(default)]
    models: Vec<String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Plugin {
    id: String,
    installed: bool,
    enabled: bool,
    priority: usize,
    #[serde(default)]
    selected_model: String,
    custom_executable: Option<String>,
    manifest: Option<Manifest>,
}

#[derive(Serialize, Deserialize)]
struct Registry {
    plugins: Vec<Plugin>,
}

impl Plugin {
    fn builtin(&self) -> Option<&'static agent_store::Builtin> {
        BUILTINS.iter().find(|entry| entry.id == self.id)
    }

    fn name(&self) -> &str {
        self.manifest.as_ref().map(|item| item.name.as_str())
            .or_else(|| self.builtin().map(|item| item.name)).unwrap_or(&self.id)
    }

    fn model_flag(&self) -> Option<&str> {
        self.manifest.as_ref().and_then(|item| item.model_flag.as_deref())
            .or_else(|| self.builtin().and_then(|item| item.model_flag))
    }

    fn executable(&self) -> Option<String> {
        self.custom_executable.as_ref().or_else(|| self.manifest.as_ref().map(|item| &item.executable))
            .map_or_else(|| agent_store::resolve(&self.id), |value| {
                validate_executable(value).ok().map(|()| value.clone())
            })
    }

    fn setup_issue(&self, executable: Option<&str>, deepseek_key: &str) -> Option<&'static str> {
        if self.manifest.is_none() && !self.builtin().is_some_and(|item| item.runnable) {
            Some("需要兼容的命令模板。可在下方导入自定义连接器")
        } else if executable.is_none() {
            Some("未检测到可用的 CLI，请在详情中浏览选择")
        } else if self.id == "dsh" && deepseek_key == "unset" {
            Some("缺少 DeepSeek API Key，请在详情中配置")
        } else {
            None
        }
    }
}

impl Registry {
    fn get_mut(&mut self, id: &str) -> Result<&mut Plugin, String> {
        self.plugins.iter_mut().find(|entry| entry.id == id).ok_or_else(|| "找不到该 Agent 插件".into())
    }
}

impl AgentPlugins {
    fn read(app: &AppHandle) -> Result<Registry, String> {
        let path = AgentSettings::path(app)?.with_file_name("agent-plugins.json");
        let mut registry: Registry = match fs::read(path) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| "本地 Agent 插件列表无法读取")?,
            Err(error) if error.kind() == ErrorKind::NotFound => Registry { plugins: Vec::new() },
            Err(error) => return Err(format!("无法读取 Agent 插件列表：{error}")),
        };
        let initial = registry.plugins.is_empty();
        let mut priority = registry.plugins.iter().map(|entry| entry.priority).max()
            .map_or(0, |value| value.saturating_add(1));
        for item in BUILTINS {
            if registry.plugins.iter().any(|entry| entry.id == item.id) { continue; }
            registry.plugins.push(Plugin {
                id: item.id.into(), installed: initial && item.default_installed,
                enabled: initial && item.default_installed, priority,
                selected_model: String::new(), custom_executable: None, manifest: None,
            });
            priority = priority.saturating_add(1);
        }
        if initial {
            if let Some(id) = app.state::<AgentSettings>().default_agent(app)? {
                let preferred = registry.get_mut(&id)?;
                preferred.installed = true;
                preferred.enabled = true;
                preferred.priority = 0;
                for entry in registry.plugins.iter_mut().filter(|entry| entry.id != id) {
                    entry.priority += 1;
                }
            }
        }
        registry.plugins.sort_by_key(|entry| entry.priority);
        Ok(registry)
    }

    fn snapshot(&self, app: &AppHandle) -> Result<Registry, String> {
        let _guard = self.storage.lock().unwrap();
        Self::read(app)
    }

    fn change(&self, app: &AppHandle, update: impl FnOnce(&mut Registry) -> Result<(), String>) -> Result<(), String> {
        let _guard = self.storage.lock().unwrap();
        let mut registry = Self::read(app)?;
        update(&mut registry)?;
        write_json(AgentSettings::path(app)?.with_file_name("agent-plugins.json"), &registry)?;
        let _ = app.emit(CHANGED, ());
        Ok(())
    }

    pub fn route(&self, app: &AppHandle, id: Option<&str>) -> Result<Option<Route>, String> {
        let registry = self.snapshot(app)?;
        let settings = app.state::<AgentSettings>().view(app)?;
        let selected = match id {
            Some(id) => Some(registry.plugins.into_iter().find(|entry| entry.id == id && entry.installed && entry.enabled)
                .ok_or(NOT_ENABLED)?),
            None => registry.plugins.into_iter().find(|entry| entry.installed && entry.enabled &&
                entry.setup_issue(entry.executable().as_deref(), settings.deepseek_key).is_none()),
        };
        selected.map(|entry| {
            let executable = entry.executable();
            if let Some(issue) = entry.setup_issue(executable.as_deref(), settings.deepseek_key) {
                return Err(issue.into());
            }
            if !valid_model(&entry.selected_model) { return Err("插件模型标识无效，请在「使用 / Agent」中重新选择".into()); }
            Ok(Route {
                executable: executable.ok_or("未检测到 CLI")?,
                model_flag: entry.model_flag().map(str::to_owned),
                selected_model: entry.selected_model,
                args: entry.manifest.map(|item| item.args),
                base_url: if entry.id == "dsh" { settings.base_url } else { None },
                id: entry.id,
            })
        }).transpose()
    }
}

pub struct Route {
    pub id: String,
    pub executable: String,
    pub selected_model: String,
    pub model_flag: Option<String>,
    pub args: Option<Vec<String>>,
    pub base_url: Option<String>,
}

fn valid_model(value: &str) -> bool {
    value.is_empty() || value.len() <= 128 &&
        value.as_bytes()[0].is_ascii_alphanumeric() &&
        value.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"-._:/@+".contains(&byte))
}

fn validate_executable(value: &str) -> Result<(), String> {
    let path = Path::new(value);
    if !path.is_absolute() || !path.is_file() ||
        (cfg!(windows) && !path.extension().is_some_and(|ext|
            ["exe", "cmd", "bat"].iter().any(|kind| ext.eq_ignore_ascii_case(kind)))) {
        return Err("请选择本机可用的 CLI 可执行文件".into());
    }
    Ok(())
}

pub fn batch_entry(path: &str) -> bool {
    cfg!(windows) && Path::new(path).extension()
        .is_some_and(|ext| ext.eq_ignore_ascii_case("cmd") || ext.eq_ignore_ascii_case("bat"))
}

pub fn validate_args(path: &str, args: &[String]) -> Result<(), String> {
    if batch_entry(path) && args.iter().any(|arg| arg != "{model}" && arg.bytes().any(|byte|
        !(byte.is_ascii_alphanumeric() || b"-._:/@+= ".contains(&byte)))) {
        return Err("批处理入口的参数只支持模型标识、选项和普通文本。其他参数请使用原生可执行文件".into());
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct View {
    id: String,
    name: String,
    icon: String,
    installed: bool,
    enabled: bool,
    priority: usize,
    selected_model: String,
    executable: Option<String>,
    custom_executable: Option<String>,
    cli_version: Option<String>,
    app_version: Option<String>,
    models: Vec<String>,
    model_source: &'static str,
    supports_model: bool,
    status: &'static str,
    hint: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    deepseek_key: Option<&'static str>,
    base_url: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    installed: Vec<View>,
    available: Vec<View>,
    default_agent: Option<String>,
}

fn views(app: &AppHandle, models: bool) -> Result<Snapshot, String> {
    let state = app.state::<AgentPlugins>();
    let registry = state.snapshot(app)?;
    let settings = app.state::<AgentSettings>().view(app)?;
    let versions = state.versions.lock().unwrap().clone();
    let mut snapshot = Snapshot { installed: Vec::new(), available: Vec::new(), default_agent: None };
    for item in registry.plugins {
        let builtin = item.builtin();
        let executable = item.executable();
        let cli_version = if item.installed && item.manifest.is_none() {
            executable.as_ref().and_then(|path| versions.get(path)).cloned()
        } else { None };
        let app_version = if models && item.installed && item.manifest.is_none() {
            executable.as_deref().and_then(|path| agent_store::desktop_version(&item.id, path))
        } else { None };
        let setup = item.setup_issue(executable.as_deref(), settings.deepseek_key);
        let (status, hint) = match (item.installed, item.enabled, setup) {
            (false, _, _) => ("available", setup.unwrap_or("安装后即可开启接入")),
            (_, false, _) => ("off", "开启接入后可在笔记中使用"),
            (_, true, Some(issue)) => ("setup", issue),
            (_, true, None) => ("connected", "使用本机 CLI 配置执行任务"),
        };
        if status == "connected" && snapshot.default_agent.is_none() { snapshot.default_agent = Some(item.id.clone()); }
        let supports_model = item.model_flag().is_some() && (item.manifest.is_some() || builtin.is_some_and(|entry| entry.runnable));
        let (mut choices, model_source) = if models && item.installed && supports_model {
            let local = if item.manifest.is_none() { agent_store::local_models(&item.id) } else { Vec::new() };
            if local.is_empty() {
                let presets: Vec<String> = item.manifest.as_ref().map(|entry| entry.models.clone())
                    .unwrap_or_else(|| builtin.into_iter().flat_map(|entry| entry.models)
                        .map(|value| (*value).to_owned()).collect());
                (presets, "preset")
            } else { (local, "local") }
        } else { (Vec::new(), "none") };
        choices.retain(|choice| !choice.is_empty() && valid_model(choice));
        if !item.selected_model.is_empty() && !choices.contains(&item.selected_model) {
            choices.push(item.selected_model.clone());
        }
        let row = View {
            name: item.name().into(), icon: builtin.map_or("custom", |entry| entry.icon).into(),
            cli_version, app_version, models: choices, model_source, supports_model, status, hint,
            deepseek_key: (item.id == "dsh").then_some(settings.deepseek_key),
            base_url: (item.id == "dsh").then(|| settings.base_url.clone()).flatten(),
            priority: item.priority, installed: item.installed, enabled: item.enabled, id: item.id,
            selected_model: item.selected_model, executable,
            custom_executable: item.custom_executable.or_else(|| item.manifest.map(|entry| entry.executable)),
        };
        if row.installed { snapshot.installed.push(row); } else { snapshot.available.push(row); }
    }
    Ok(snapshot)
}

async fn refresh_versions(app: &AppHandle, only: Option<&str>) -> Result<(), String> {
    let state = app.state::<AgentPlugins>();
    let candidates = state.snapshot(app)?.plugins.into_iter()
        .filter(|entry| entry.installed && entry.manifest.is_none() && only.is_none_or(|id| id == entry.id))
        .filter_map(|entry| entry.executable()).collect::<HashSet<_>>();
    let mut probes = tokio::task::JoinSet::new();
    for path in candidates {
        probes.spawn(async move {
            let version = crate::agent_runner::probe_version(&path).await;
            (path, version)
        });
    }
    while let Some(result) = probes.join_next().await {
        if let Ok((path, version)) = result {
            let mut versions = state.versions.lock().unwrap();
            if let Some(version) = version { versions.insert(path, version); } else { versions.remove(&path); }
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn agent_plugins_list(app: AppHandle, refresh: bool) -> Result<Snapshot, String> {
    if refresh { refresh_versions(&app, None).await?; }
    views(&app, true)
}

#[tauri::command]
pub fn agent_plugins_active(app: AppHandle) -> Result<serde_json::Value, String> {
    Ok(serde_json::json!(views(&app, false)?.installed.into_iter()
        .filter(|entry| entry.status == "connected")
        .map(|entry| serde_json::json!({
            "id": entry.id, "name": entry.name, "executable": entry.executable, "model": entry.selected_model,
        })).collect::<Vec<_>>()))
}

#[tauri::command]
pub fn agent_plugins_resolve(app: AppHandle, id: Option<String>) -> Result<Option<String>, String> {
    Ok(app.state::<AgentPlugins>().route(&app, id.as_deref())?.map(|route| route.id))
}

#[tauri::command]
pub async fn agent_plugin_install(app: AppHandle, id: String) -> Result<Snapshot, String> {
    app.state::<AgentPlugins>().change(&app, |registry| {
        let priority = registry.plugins.iter().map(|item| item.priority).max().unwrap_or(0).saturating_add(1);
        let item = registry.get_mut(&id)?;
        if !item.installed {
            item.priority = priority;
            item.installed = true;
            item.enabled = item.manifest.is_none();
        }
        Ok(())
    })?;
    refresh_versions(&app, Some(&id)).await?;
    views(&app, true)
}

#[tauri::command]
pub fn agent_plugin_uninstall(app: AppHandle, ids: Vec<String>) -> Result<Snapshot, String> {
    app.state::<AgentPlugins>().change(&app, |registry| {
        for id in ids {
            let item = registry.get_mut(&id)?;
            item.installed = false;
            item.enabled = false;
        }
        Ok(())
    })?;
    views(&app, true)
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Update {
    id: String,
    enabled: Option<bool>,
    selected_model: Option<String>,
    custom_executable: Option<String>,
    deepseek_key: Option<String>,
    clear_deepseek_key: Option<bool>,
    base_url: Option<String>,
}

#[tauri::command]
pub async fn agent_plugin_update(app: AppHandle, input: Update) -> Result<Snapshot, String> {
    let state = app.state::<AgentPlugins>();
    let credential_change = input.deepseek_key.is_some() || input.clear_deepseek_key == Some(true) || input.base_url.is_some();
    let path_changed = input.custom_executable.is_some();
    if credential_change {
        if input.id != "dsh" || input.enabled.is_some() || input.selected_model.is_some() || path_changed {
            return Err("请单独保存 DeepSeek 凭据和 Base URL".into());
        }
        return agent_plugin_save_deepseek(app, input.deepseek_key, input.clear_deepseek_key.unwrap_or(false), input.base_url);
    } else {
        state.change(&app, |registry| {
            let item = registry.get_mut(&input.id)?;
            if !item.installed { return Err(NOT_ENABLED.into()); }
            if let Some(value) = input.enabled { item.enabled = value; }
            if let Some(model) = input.selected_model {
                if !valid_model(&model) || (!model.is_empty() && item.model_flag().is_none()) {
                    return Err("请输入有效且受此插件支持的模型标识".into());
                }
                item.selected_model = model;
            }
            if let Some(path) = input.custom_executable {
                if !path.is_empty() {
                    validate_executable(&path)?;
                    if let Some(manifest) = &item.manifest { validate_args(&path, &manifest.args)?; }
                }
                item.custom_executable = (!path.is_empty()).then_some(path);
            }
            Ok(())
        })?;
    }
    if path_changed { refresh_versions(&app, Some(&input.id)).await?; }
    views(&app, true)
}

#[tauri::command]
pub fn agent_plugin_save_deepseek(app: AppHandle, key: Option<String>, clear: bool, base_url: Option<String>) -> Result<Snapshot, String> {
    {
        let state = app.state::<AgentPlugins>();
        let _guard = state.storage.lock().unwrap();
        if !AgentPlugins::read(&app)?.get_mut("dsh")?.installed { return Err(NOT_ENABLED.into()); }
        app.state::<AgentSettings>().set_deepseek(&app, key, clear, base_url)?;
    }
    let _ = app.emit(CHANGED, ());
    views(&app, true)
}

#[tauri::command]
pub fn agent_plugins_reorder(app: AppHandle, ids: Vec<String>) -> Result<Snapshot, String> {
    app.state::<AgentPlugins>().change(&app, |registry| {
        let installed = registry.plugins.iter().filter(|item| item.installed)
            .map(|item| item.id.as_str()).collect::<HashSet<_>>();
        if ids.len() != installed.len() || ids.iter().map(String::as_str).collect::<HashSet<_>>() != installed {
            return Err("已安装列表已更新，请刷新后排序".into());
        }
        for (priority, id) in ids.iter().enumerate() { registry.get_mut(id)?.priority = priority; }
        Ok(())
    })?;
    views(&app, true)
}

#[tauri::command]
pub fn agent_plugins_reset_order(app: AppHandle) -> Result<Snapshot, String> {
    app.state::<AgentPlugins>().change(&app, |registry| {
        registry.plugins.sort_by_cached_key(|item| (!item.installed, item.executable().is_none(),
            BUILTINS.iter().position(|entry| entry.id == item.id).unwrap_or(usize::MAX)));
        for (priority, item) in registry.plugins.iter_mut().enumerate() { item.priority = priority; }
        Ok(())
    })?;
    views(&app, true)
}

#[tauri::command]
pub fn agent_plugin_import(app: AppHandle, json: String) -> Result<Snapshot, String> {
    if json.len() > 32768 { return Err("插件清单超过 32 KB".into()); }
    let manifest: Manifest = serde_json::from_str(&json).map_err(|error| format!("无法读取插件清单：{error}"))?;
    let id = manifest.id.clone();
    if id.len() > 32 || !id.as_bytes().first().is_some_and(u8::is_ascii_lowercase) ||
        !id.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"-_".contains(&byte)) ||
        manifest.name.trim().is_empty() || manifest.name.chars().count() > 60 ||
        manifest.name.chars().any(char::is_control) || manifest.args.len() > 32 ||
        manifest.args.iter().any(|arg| arg.len() > 1024 || arg.chars().any(char::is_control)) ||
        manifest.model_flag.as_deref().is_some_and(|flag| {
            let name = flag.trim_start_matches('-');
            flag.len() - name.len() < 1 || flag.len() - name.len() > 2 ||
                name.is_empty() || !name.bytes().all(|byte| byte.is_ascii_alphanumeric() || b"-_".contains(&byte))
        }) ||
        manifest.models.len() > 50 || manifest.models.iter().any(|value| value.is_empty() || !valid_model(value)) {
        return Err("插件清单含无效的标识、名称、参数或模型".into());
    }
    let placeholders = manifest.args.iter().filter(|arg| *arg == "{model}").count();
    if placeholders > 1 || (placeholders != 0 && manifest.model_flag.is_none()) {
        return Err("清单可在 modelFlag 已配置时使用一个独立的 {model} 参数".into());
    }
    validate_executable(&manifest.executable)?;
    validate_args(&manifest.executable, &manifest.args)?;
    app.state::<AgentPlugins>().change(&app, |registry| {
        if registry.plugins.iter().any(|item| item.id == id) { return Err("已有相同标识的插件".into()); }
        let priority = registry.plugins.iter().map(|item| item.priority).max().unwrap_or(0).saturating_add(1);
        registry.plugins.push(Plugin {
            id, installed: true, enabled: false, priority,
            selected_model: String::new(), custom_executable: None, manifest: Some(manifest),
        });
        Ok(())
    })?;
    views(&app, true)
}

#[tauri::command]
pub async fn agent_plugin_browse(window: tauri::WebviewWindow) -> Result<Option<String>, String> {
    let (send, receive) = tokio::sync::oneshot::channel();
    window.dialog().file().set_parent(&window).add_filter("Agent CLI", &["exe", "cmd", "bat"])
        .pick_file(move |file| { let _ = send.send(file); });
    receive.await.map_err(|_| "未能打开本机文件选择器")?.map(|file|
        file.into_path().map(|path| path.to_string_lossy().into_owned()).map_err(|error| error.to_string())
    ).transpose()
}
