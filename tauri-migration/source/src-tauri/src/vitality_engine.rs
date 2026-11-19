use rusqlite::{params, Connection};

fn score(days: f64, access: i64, degree: i64) -> f64 {
    (0.55 * (-0.045 * days).exp()
        + 0.25 * (access.max(0) as f64).ln_1p() / 51.0_f64.ln()
        + 0.20 * (degree.max(0) as f64).ln_1p() / 21.0_f64.ln()).clamp(0.05, 1.0)
}

const DEGREE: &str = "(SELECT COUNT(*) FROM note_link WHERE source_note_id=note.id)
    + (SELECT COUNT(*) FROM note_link WHERE target_note_id=note.id)";

pub fn recalculate(conn: &Connection, now: i64) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    let rows = {
        let mut stmt = tx.prepare(&format!("SELECT id, last_accessed_at, access_count, {DEGREE}
            FROM note WHERE last_accessed_at>0"))?;
        let rows = stmt.query_map([], |row| Ok((
            row.get::<_, String>(0)?, row.get::<_, i64>(1)?, row.get::<_, i64>(2)?, row.get::<_, i64>(3)?,
        )))?;
        rows.collect::<rusqlite::Result<Vec<_>>>()?
    };
    let mut update = tx.prepare_cached("UPDATE note SET vitality_score=?2,is_dormant=?3 WHERE id=?1")?;
    for (id, last, access, degree) in rows {
        let days = now.saturating_sub(last).max(0) as f64 / 86_400_000.0;
        let vitality = score(days, access, degree);
        update.execute(params![id, vitality, vitality < 0.22 && days > 30.0 && degree <= 1])?;
    }
    drop(update);
    tx.commit()
}

pub fn boost(conn: &Connection, id: &str, now: i64) -> rusqlite::Result<()> {
    let (access, degree): (i64, i64) = conn.query_row(
        &format!("SELECT access_count,{DEGREE} FROM note WHERE id=?1"), [id],
        |row| Ok((row.get(0)?, row.get(1)?)),
    )?;
    let access = access.saturating_add(1);
    conn.execute("UPDATE note SET access_count=?2,last_accessed_at=?3,vitality_score=?4,is_dormant=0 WHERE id=?1",
        params![id, access, now, score(0.0, access, degree)])?;
    Ok(())
}
