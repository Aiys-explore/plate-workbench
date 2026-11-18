use rusqlite::{params, Connection};
use serde::Serialize;
use std::collections::HashMap;

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct GraphLayoutEntry {
    pub x: f64,
    pub y: f64,
    pub pinned: bool,
    pub parent_note_id: Option<String>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphLayoutItem {
    pub note_id: String,
    pub x: f64,
    pub y: f64,
    #[serde(default = "default_pinned")]
    pub pinned: bool,
    pub parent_note_id: Option<String>,
}

fn default_pinned() -> bool { true }

pub fn get_all(conn: &Connection) -> Result<HashMap<String, GraphLayoutEntry>, String> {
    let mut stmt = conn.prepare(
        "SELECT note_id, x, y, pinned, parent_note_id FROM graph_layout").map_err(|e| e.to_string())?;
    let rows = stmt.query_map([], |r| {
        Ok((r.get::<_, String>(0)?, GraphLayoutEntry {
            x: r.get(1)?, y: r.get(2)?,
            pinned: r.get::<_, i64>(3)? != 0,
            parent_note_id: r.get(4)?,
        }))
    }).map_err(|e| e.to_string())?;
    let mut out = HashMap::new();
    for row in rows {
        let (id, entry) = row.map_err(|e| e.to_string())?;
        out.insert(id, entry);
    }
    Ok(out)
}

pub fn save_batch(conn: &Connection, items: Vec<GraphLayoutItem>) -> Result<(), String> {
    for item in items {
        conn.execute(
            "INSERT INTO graph_layout (note_id, x, y, pinned, parent_note_id, collapsed, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 0, ?6)
             ON CONFLICT(note_id) DO UPDATE SET x=?2, y=?3, pinned=?4, parent_note_id=?5, updated_at=?6",
            params![item.note_id, item.x, item.y, item.pinned as i64, item.parent_note_id, crate::notes::now_ms()],
        ).map_err(|e| e.to_string())?;
    }
    Ok(())
}

pub fn reset_all(conn: &Connection) -> Result<(), String> {
    conn.execute("DELETE FROM graph_layout", []).map_err(|e| e.to_string())?;
    Ok(())
}
