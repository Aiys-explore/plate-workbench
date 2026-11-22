use crate::{notes::now_ms, with_store, AppState};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, State};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BrainSpace {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub description: String,
    pub isolated: bool,
    pub allow_export: bool,
}

pub fn list(conn: &Connection) -> rusqlite::Result<Vec<BrainSpace>> {
    let mut stmt = conn.prepare("SELECT id,name,kind,description,isolated,allow_export
        FROM brain_spaces ORDER BY CASE id WHEN 'work' THEN 0 WHEN 'learning' THEN 1 WHEN 'personal' THEN 2 ELSE 3 END,name,id")?;
    let rows = stmt.query_map([], |row| Ok(BrainSpace {
        id: row.get(0)?, name: row.get(1)?, kind: row.get(2)?, description: row.get(3)?,
        isolated: row.get(4)?, allow_export: row.get(5)?,
    }))?;
    rows.collect()
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SpaceScopePolicy {
    pub target_space_id: String,
    #[serde(default)]
    pub readable_space_ids: Vec<String>,
}

impl Default for SpaceScopePolicy {
    fn default() -> Self {
        Self { target_space_id: "learning".into(), readable_space_ids: vec![] }
    }
}

impl SpaceScopePolicy {
    pub fn allowed(&self, conn: &Connection) -> Result<Vec<String>, String> {
        let spaces = list(conn).map_err(|e| e.to_string())?;
        if !spaces.iter().any(|space| space.id == self.target_space_id) || self.readable_space_ids.len() > 32 {
            return Err("请选择有效的脑区范围".into());
        }
        let mut allowed = vec![self.target_space_id.clone()];
        allowed.extend(spaces.into_iter().filter(|space| {
            !space.isolated && space.kind != "personal" && space.id != self.target_space_id
                && self.readable_space_ids.contains(&space.id)
        }).map(|space| space.id));
        Ok(allowed)
    }
}

pub fn note_space(conn: &Connection, id: &str) -> Result<String, String> {
    conn.query_row("SELECT COALESCE((SELECT space_id FROM brain_note_writes
        WHERE note_id=note.id AND title IS NOT NULL LIMIT 1), space_id) FROM note WHERE id=?1",
        [id], |row| row.get(0)).optional().map_err(|e| e.to_string())?.ok_or("笔记不存在".into())
}

#[tauri::command]
pub fn brain_spaces_list(state: State<'_, AppState>) -> Result<Vec<BrainSpace>, String> {
    with_store(&state, |store| list(&store.conn.lock().unwrap()).map_err(|e| e.to_string()))
}

#[tauri::command]
pub fn brain_space_upsert(app: AppHandle, state: State<'_, AppState>, mut space: BrainSpace) -> Result<String, String> {
    if space.name.trim().is_empty() || space.name.len() > 240 || space.description.len() > 4000
        || !matches!(space.kind.as_str(), "work" | "learning" | "personal") {
        return Err("请填写有效的脑区名称、类型和说明".into());
    }
    if space.id.is_empty() { space.id = uuid::Uuid::new_v4().to_string(); }
    let builtin = matches!(space.id.as_str(), "work" | "learning" | "personal");
    if (!builtin && uuid::Uuid::parse_str(&space.id).is_err()) || (builtin && space.kind != space.id) {
        return Err("脑区标识或预设类型无效".into());
    }
    if space.kind == "personal" { space.isolated = true; space.allow_export = false; }
    with_store(&state, |store| {
        store.conn.lock().unwrap().execute(
            "INSERT INTO brain_spaces(id,name,kind,description,isolated,allow_export,created_at)
             VALUES(?1,?2,?3,?4,?5,?6,?7) ON CONFLICT(id) DO UPDATE SET
             name=excluded.name,description=excluded.description,isolated=excluded.isolated,allow_export=excluded.allow_export
             WHERE brain_spaces.kind=excluded.kind",
            params![space.id,space.name.trim(),space.kind,space.description,space.isolated,space.allow_export,now_ms()],
        ).map_err(|e| e.to_string()).and_then(|changed| {
            if changed == 0 { Err("已有脑区不能变更类型".into()) } else { Ok(()) }
        })
    })?;
    crate::memory_consolidator::changed(&app);
    Ok(space.id)
}
