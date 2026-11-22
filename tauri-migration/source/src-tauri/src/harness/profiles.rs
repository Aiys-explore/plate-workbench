use super::policy::PermissionManifest;
use crate::{notes::now_ms, with_store, AppState};
use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};
use tauri::State;

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelProfile {
    pub id: String,
    pub name: String,
    pub backend_kind: super::engine::BackendKind,
    pub backend_id: String,
    pub model_name: String,
    pub reasoning_effort: String,
    pub temperature: f64,
    pub max_steps: u32,
    pub max_budget_usd: f64,
    pub default_space_id: String,
    pub default_permissions: PermissionManifest,
}

const SELECT: &str = "SELECT id,name,backend_kind,backend_id,model_name,reasoning_effort,temperature,max_steps,
    max_budget_usd,default_space_id,default_permissions_json FROM model_profiles";

fn read(row: &Row<'_>) -> rusqlite::Result<ModelProfile> {
    let kind: String = row.get(2)?;
    let raw: String = row.get(10)?;
    let backend_kind = match kind.as_str() {
        "local_cli" => super::engine::BackendKind::LocalCli,
        "api_key" => super::engine::BackendKind::ApiKey,
        _ => return Err(rusqlite::Error::InvalidQuery),
    };
    let default_permissions = serde_json::from_str(&raw).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(10,rusqlite::types::Type::Text,Box::new(error))
    })?;
    Ok(ModelProfile { id:row.get(0)?, name:row.get(1)?, backend_kind, backend_id:row.get(3)?,
        model_name:row.get(4)?, reasoning_effort:row.get(5)?, temperature:row.get(6)?, max_steps:row.get(7)?,
        max_budget_usd:row.get(8)?, default_space_id:row.get(9)?, default_permissions })
}

pub fn get(conn: &Connection, id: &str) -> Result<ModelProfile, String> {
    conn.query_row(&format!("{SELECT} WHERE id=?1"), [id], read).map_err(|e| e.to_string())
}

#[tauri::command]
pub fn profile_list(state: State<'_, AppState>) -> Result<Vec<ModelProfile>, String> {
    with_store(&state, |store| {
        let conn = store.conn.lock().unwrap();
        let mut stmt = conn.prepare(&format!("{SELECT} ORDER BY updated_at DESC,id")).map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], read).map_err(|e| e.to_string())?;
        rows.collect::<rusqlite::Result<_>>().map_err(|e| e.to_string())
    })
}

#[tauri::command]
pub fn profile_upsert(state: State<'_, AppState>, mut profile: ModelProfile) -> Result<ModelProfile, String> {
    if profile.id.is_empty() { profile.id = uuid::Uuid::new_v4().to_string(); }
    if uuid::Uuid::parse_str(&profile.id).is_err() || profile.name.trim().is_empty() || profile.name.len() > 180
        || profile.model_name.len() > 240 || profile.backend_id.len() > 240
        || !matches!(profile.reasoning_effort.as_str(), "low" | "medium" | "high")
        || !(0.0..=1.0).contains(&profile.temperature)
        || (profile.backend_kind == super::engine::BackendKind::LocalCli && profile.backend_id.trim().is_empty()) {
        return Err("请检查 Profile 名称、后端及模型参数".into());
    }
    profile.default_permissions.max_steps = profile.max_steps;
    profile.default_permissions.max_budget_usd = profile.max_budget_usd;
    // Concrete note and conversation attachments belong to the individual run.
    profile.default_permissions.readable_note_ids.clear();
    profile.default_permissions.readable_log_session_ids.clear();
    profile.default_permissions.validate()?;
    with_store(&state, |store| {
        let conn = store.conn.lock().unwrap();
        crate::memory_consolidator::require_space(&conn, &profile.default_space_id)?;
        if profile.backend_kind == super::engine::BackendKind::ApiKey && !profile.backend_id.is_empty() {
            crate::provider_store::get(&conn, &profile.backend_id)?;
        }
        let permissions = serde_json::to_string(&profile.default_permissions).map_err(|e| e.to_string())?;
        conn.execute("INSERT INTO model_profiles(id,name,backend_kind,backend_id,model_name,reasoning_effort,temperature,
                max_steps,max_budget_usd,default_space_id,default_permissions_json,updated_at)
            VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
            ON CONFLICT(id) DO UPDATE SET name=excluded.name,backend_kind=excluded.backend_kind,backend_id=excluded.backend_id,
            model_name=excluded.model_name,reasoning_effort=excluded.reasoning_effort,temperature=excluded.temperature,
            max_steps=excluded.max_steps,max_budget_usd=excluded.max_budget_usd,default_space_id=excluded.default_space_id,
            default_permissions_json=excluded.default_permissions_json,updated_at=excluded.updated_at",
            params![profile.id,profile.name.trim(),profile.backend_kind.as_str(),profile.backend_id,profile.model_name,
                profile.reasoning_effort,profile.temperature,profile.max_steps,profile.max_budget_usd,profile.default_space_id,
                permissions,now_ms()]).map_err(|e| e.to_string())?;
        get(&conn, &profile.id)
    })
}

#[tauri::command]
pub fn profile_delete(state: State<'_, AppState>, id: String) -> Result<(), String> {
    with_store(&state, |store| {
        let conn = store.conn.lock().unwrap();
        let tx = conn.unchecked_transaction().map_err(|e|e.to_string())?;
        tx.execute("UPDATE procedural_skills SET default_profile_id=NULL WHERE default_profile_id=?1", [&id]).map_err(|e|e.to_string())?;
        tx.execute("DELETE FROM model_profiles WHERE id=?1", [id]).map_err(|e|e.to_string())?;
        tx.commit().map_err(|e|e.to_string())
    })
}
