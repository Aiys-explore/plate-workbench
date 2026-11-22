use crate::{notes::now_ms, with_store, AppState};
use rusqlite::{params, Connection, Row};
use serde::Serialize;
use tauri::State;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PromptVersion {
    pub id: String,
    pub skill_id: String,
    pub version_tag: String,
    pub status: String,
    pub system_prompt: String,
    pub change_note: String,
    pub created_at: i64,
}

const SELECT: &str = "SELECT id,skill_id,version_tag,status,system_prompt,change_note,created_at FROM prompt_versions";

fn read(row: &Row<'_>) -> rusqlite::Result<PromptVersion> {
    Ok(PromptVersion { id:row.get(0)?, skill_id:row.get(1)?, version_tag:row.get(2)?, status:row.get(3)?,
        system_prompt:row.get(4)?, change_note:row.get(5)?, created_at:row.get(6)? })
}

pub(crate) fn get(conn: &Connection, skill: &str, id: &str) -> Result<PromptVersion, String> {
    conn.query_row(&format!("{SELECT} WHERE id=?1 AND skill_id=?2"), params![id,skill], read)
        .map_err(|_| "版本不存在或不属于当前技能".into())
}

pub(crate) fn production(conn: &Connection, skill: &str) -> Result<PromptVersion, String> {
    conn.query_row(&format!("{SELECT} WHERE skill_id=?1 AND status='production'"), [skill], read)
        .map_err(|_| "当前技能没有生产版本".into())
}

pub(crate) fn baseline(conn: &Connection, skill: &str) -> rusqlite::Result<()> {
    conn.execute("INSERT INTO prompt_versions(id,skill_id,version_tag,status,system_prompt,created_at)
        SELECT id || ':v1',id,'v1','production',system_prompt,created_at FROM procedural_skills WHERE id=?1", [skill])?;
    conn.execute("UPDATE procedural_skills SET active_prompt_version_id=id || ':v1' WHERE id=?1", [skill])?;
    Ok(())
}

fn set_status(conn: &Connection, id: &str, status: &str) -> Result<(), String> {
    if !matches!(status, "testing" | "retired" | "production") { return Err("版本状态无效".into()); }
    let tx = conn.unchecked_transaction().map_err(|e| e.to_string())?;
    let skill: String = tx.query_row("SELECT skill_id FROM prompt_versions WHERE id=?1",[id],|r|r.get(0)).map_err(|e|e.to_string())?;
    let active = production(&tx,&skill)?;
    if active.id == id && status != "production" { return Err("请先指定替代的生产版本".into()); }
    if status == "production" {
        if active.id == id { return Ok(()); }
        tx.execute("UPDATE prompt_versions SET status='retired' WHERE id=?1",[&active.id]).map_err(|e|e.to_string())?;
        tx.execute("UPDATE procedural_skills SET active_prompt_version_id=?2,updated_at=?3 WHERE id=?1",
            params![skill,id,now_ms()]).map_err(|e|e.to_string())?;
    }
    tx.execute("UPDATE prompt_versions SET status=?2 WHERE id=?1",params![id,status]).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e|e.to_string())
}

#[tauri::command]
pub fn prompt_version_list(state: State<'_, AppState>, skill_id: String) -> Result<Vec<PromptVersion>, String> {
    with_store(&state, |store| {
        let conn = store.conn.lock().unwrap();
        let mut stmt = conn.prepare(&format!("{SELECT} WHERE skill_id=?1 ORDER BY created_at DESC,id")).map_err(|e|e.to_string())?;
        let rows = stmt.query_map([skill_id],read).map_err(|e|e.to_string())?;
        rows.collect::<rusqlite::Result<_>>().map_err(|e|e.to_string())
    })
}

#[tauri::command]
pub fn prompt_version_create(state: State<'_, AppState>, skill_id: String, version_tag: String, system_prompt: String,
    change_note: String) -> Result<PromptVersion, String> {
    let tag = version_tag.trim();
    if tag.is_empty() || tag.len() > 100 || tag.chars().any(char::is_control) || system_prompt.trim().is_empty()
        || system_prompt.len() > 12_000 || change_note.len() > 2000 || system_prompt.contains('\0') {
        return Err("请检查版本标签、提示词和说明".into());
    }
    with_store(&state, |store| {
        let conn = store.conn.lock().unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let rows = conn.execute("INSERT INTO prompt_versions(id,skill_id,version_tag,status,system_prompt,change_note,created_at)
            VALUES(?1,?2,?3,'testing',?4,?5,?6) ON CONFLICT(skill_id,version_tag) DO NOTHING",
            params![id,skill_id,tag,system_prompt,change_note,now_ms()]).map_err(|e|e.to_string())?;
        if rows == 0 { return Err("该技能已有同名版本".into()); }
        get(&conn,&skill_id,&id)
    })
}

#[tauri::command]
pub fn prompt_version_set_status(app: tauri::AppHandle, state: State<'_, AppState>, id: String, status: String) -> Result<(), String> {
    with_store(&state, |store| set_status(&store.conn.lock().unwrap(),&id,&status))?;
    crate::memory_consolidator::changed(&app);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn promotion_and_rollback_keep_exactly_one_production() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE project(id TEXT PRIMARY KEY); CREATE TABLE note(id TEXT PRIMARY KEY,updated_at INTEGER);").unwrap();
        crate::db::migrate_brain(&conn).unwrap();
        crate::db::migrate_s10(&conn).unwrap();
        conn.execute("INSERT INTO procedural_skills(id,slug,title,system_prompt,created_at,updated_at)
            VALUES('s','s','Skill','baseline',1,1)",[]).unwrap();
        crate::db::migrate_s11(&conn).unwrap();
        assert_eq!(production(&conn,"s").unwrap().id,"s:v1");
        conn.execute("INSERT INTO prompt_versions(id,skill_id,version_tag,status,system_prompt,created_at)
            VALUES('second','s','v2','testing','updated',2)",[]).unwrap();
        set_status(&conn,"second","production").unwrap();
        assert_eq!(production(&conn,"s").unwrap().system_prompt,"updated");
        assert!(set_status(&conn,"second","retired").is_err());
        assert_eq!(get(&conn,"s","s:v1").unwrap().status,"retired");
        set_status(&conn,"s:v1","production").unwrap();
        assert_eq!(production(&conn,"s").unwrap().system_prompt,"baseline");
        assert_eq!(get(&conn,"s","second").unwrap().status,"retired");
    }
}
