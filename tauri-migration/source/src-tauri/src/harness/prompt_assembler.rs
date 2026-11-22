use super::{policy::PermissionManifest, staging};
use crate::{notes::NoteStore, with_store, AppState};
use rusqlite::Connection;
use serde::Serialize;
use tauri::State;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptLayer {
    layer_name: &'static str,
    source_label: String,
    content: String,
    approx_tokens: usize,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssembledPrompt {
    layers: Vec<PromptLayer>,
    pub final_prompt: String,
    total_approx_tokens: usize,
}

fn global(conn: &Connection) -> Result<String, String> {
    conn.query_row("SELECT global_system_prompt FROM brain_settings WHERE singleton=1", [], |row| row.get(0))
        .map_err(|e| e.to_string())
}

pub fn assemble(store: &NoteStore, permissions: &PermissionManifest, context: String, allow_export: bool,
    target_space: &str) -> Result<AssembledPrompt, String> {
    let global = global(&store.conn.lock().unwrap())?;
    let mut sources = Vec::new();
    let mut workspace_rules = String::new();
    let mut remaining = 8_000;
    for directory in &permissions.writable_dirs {
        for name in ["AGENTS.md", "CLAUDE.md"] {
            let path = directory.join(name);
            if remaining == 0 || !path.is_file() { continue; }
            let Ok(content) = staging::read_workspace_file(permissions, &store.root, &path) else { continue; };
            let sample: String = content.chars().take(remaining.min(4_000)).collect();
            remaining -= sample.chars().count();
            sources.push(path.display().to_string());
            workspace_rules.push_str(&format!("[{}]\n{sample}\n\n",path.display()));
        }
    }
    let boundaries = format!("影子运行。任务写入脑区 {target_space}，跨脑区资料只读。所有文件与笔记变更必须经受控提案和人工审批。\n{}\n当前权限清单\n{}",
        if allow_export { "只在已授权目录内提出文件变更。" } else { "此上下文禁止文件导出。" },
        serde_json::to_string_pretty(permissions).map_err(|e| e.to_string())?);
    let layers = [
        ("global","全局系统提示词".to_string(), if global.trim().is_empty() {
            "按任务目标完成办公工作。区分来源、假设与推断，保留证据和不确定性。".into()
        } else { global }),
        ("workspace_rules",if sources.is_empty() { "授权目录暂无规则文件".into() } else { sources.join("、") },workspace_rules),
        ("brain_and_skill","授权记忆、所选技能与会话引用".into(),context),
        ("permissions","任务权限清单 · Shadow Run".into(),boundaries),
    ].into_iter().map(|(layer_name,source_label,content)| PromptLayer {
        layer_name, source_label, approx_tokens: (content.len() + 3) / 4, content,
    }).collect::<Vec<_>>();
    let final_prompt = layers.iter().map(|layer| format!("[{}]\n{}",layer.layer_name,layer.content)).collect::<Vec<_>>().join("\n\n");
    let total_approx_tokens = layers.iter().map(|layer| layer.approx_tokens).sum();
    Ok(AssembledPrompt { layers,final_prompt,total_approx_tokens })
}

#[tauri::command]
pub fn global_prompt_get(state: State<'_, AppState>) -> Result<String, String> {
    with_store(&state, |store| global(&store.conn.lock().unwrap()))
}

#[tauri::command]
pub fn global_prompt_set(state: State<'_, AppState>, prompt: String) -> Result<(), String> {
    if prompt.len() > 16_000 || prompt.contains('\0') { return Err("全局提示词超过 16 KB 或含无效字符".into()); }
    with_store(&state, |store| {
        store.conn.lock().unwrap().execute("UPDATE brain_settings SET global_system_prompt=?1 WHERE singleton=1",[prompt])
            .map_err(|e| e.to_string())?;
        Ok(())
    })
}
