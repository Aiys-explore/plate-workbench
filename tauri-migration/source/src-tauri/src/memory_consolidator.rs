use crate::notes::{now_ms, Note, NoteStore, SaveResult};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};
use uuid::Uuid;

fn id() -> String { Uuid::new_v4().to_string() }
fn err(error: impl std::fmt::Display) -> String { error.to_string() }

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Skill {
    pub id: String,
    pub title: String,
    pub tags: Vec<String>,
    pub preferred_agent_id: Option<String>,
    pub system_prompt: String,
    pub usage_count: i64,
    pub success_count: i64,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SkillInput {
    title: String,
    tags: Vec<String>,
    system_prompt: String,
}

fn save_skill(conn: &Connection, input: &SkillInput, agent: Option<&str>) -> Result<String, String> {
    let title = input.title.trim();
    if title.is_empty() || title.chars().count() > 100 || title.chars().any(char::is_control)
        || input.system_prompt.trim().is_empty() || input.system_prompt.len() > 12_000
        || input.tags.len() > 20 || input.tags.iter().any(|tag| tag.len() > 120 || tag.chars().any(char::is_control)) {
        return Err("请检查技能名称、标签及指令长度".into());
    }
    let tags: BTreeSet<_> = input.tags.iter().map(|tag| tag.trim().trim_start_matches('#').to_lowercase())
        .filter(|tag| !tag.is_empty()).collect();
    let slug = title.to_lowercase();
    conn.query_row(
        "INSERT INTO procedural_skills(id,slug,title,trigger_tags_json,preferred_agent_id,system_prompt,created_at,updated_at)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?7) ON CONFLICT(slug) DO NOTHING RETURNING id",
        params![id(), slug, title, serde_json::to_string(&tags).map_err(err)?, agent, input.system_prompt.trim(), now_ms()],
        |row| row.get(0),
    ).optional().map_err(err)?.ok_or_else(|| "已有同名技能，请使用其他名称".to_string())
}

pub fn skills(conn: &Connection) -> rusqlite::Result<Vec<Skill>> {
    let mut stmt = conn.prepare("SELECT id,title,trigger_tags_json,preferred_agent_id,system_prompt,usage_count,success_count
        FROM procedural_skills ORDER BY updated_at DESC,id")?;
    let rows = stmt.query_map([], |r| {
        let raw: String = r.get(2)?;
        let tags = serde_json::from_str(&raw).map_err(|e| rusqlite::Error::FromSqlConversionFailure(2, rusqlite::types::Type::Text, Box::new(e)))?;
        Ok(Skill { id: r.get(0)?, title: r.get(1)?, tags, preferred_agent_id: r.get(3)?,
            system_prompt: r.get(4)?, usage_count: r.get(5)?, success_count: r.get(6)? })
    })?;
    rows.collect()
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SuggestedLink {
    target_note_id: String,
    reason: String,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct AssertionUpdate {
    note_id: String,
    old_claim_id: Option<String>,
    new_claim: String,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct NoteEvolution {
    target_note_id: String,
    append_insight: String,
    delta_summary: String,
}
#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct MemoryDeltaProposal {
    #[serde(default)]
    suggested_links: Vec<SuggestedLink>,
    #[serde(default)]
    assertion_updates: Vec<AssertionUpdate>,
    #[serde(default)]
    note_evolutions: Vec<NoteEvolution>,
    suggested_skill: Option<SkillInput>,
}

impl MemoryDeltaProposal {
    fn validate(&self) -> Result<(), String> {
        let valid = |s: &str| !s.trim().is_empty() && s.len() <= 12_000 && !s.contains('\0');
        if self.suggested_links.len() > 10 || self.assertion_updates.len() > 10 || self.note_evolutions.len() > 10
            || self.suggested_links.iter().any(|item| !valid(&item.reason))
            || self.assertion_updates.iter().any(|item| !valid(&item.new_claim))
            || self.note_evolutions.iter().any(|item| !valid(&item.append_insight) || !valid(&item.delta_summary)) {
            return Err("记忆提案超出长度上限或包含空字段".into());
        }
        Ok(())
    }
}

pub fn parse_delta_from_output(output: &str) -> Option<(&str, MemoryDeltaProposal)> {
    let trimmed = output.trim_end().strip_suffix("</brain-delta>")?;
    for (start, marker) in trimmed.rmatch_indices("<brain-delta>").take(32) {
        let block = &trimmed[start + marker.len()..];
        if block.len() > 64_000 { break; }
        let Ok(delta) = serde_json::from_str::<MemoryDeltaProposal>(block) else { continue };
        delta.validate().ok()?;
        if delta.suggested_links.is_empty() && delta.assertion_updates.is_empty()
            && delta.note_evolutions.is_empty() && delta.suggested_skill.is_none() { return None; }
        return Some((trimmed[..start].trim_end(), delta));
    }
    None
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EpisodicEvent {
    pub id: String,
    pub project_id: String,
    pub raw_text: String,
    pub source_type: String,
    pub salience_score: f64,
    pub created_at: i64,
}

fn episodic(conn: &Connection, project: Option<&str>, dream: bool) -> rusqlite::Result<Vec<EpisodicEvent>> {
    let order = if dream { "salience_score DESC,created_at ASC,id" } else { "created_at DESC,id" };
    let mut stmt = conn.prepare(&format!("SELECT id,project_id,raw_text,source_type,salience_score,created_at
        FROM episodic_events WHERE archived_at IS NULL AND (?1 IS NULL OR project_id=?1) ORDER BY {order} LIMIT 150"))?;
    let rows = stmt.query_map([project], |r| Ok(EpisodicEvent {
        id: r.get(0)?, project_id: r.get(1)?, raw_text: r.get(2)?, source_type: r.get(3)?,
        salience_score: r.get(4)?, created_at: r.get(5)?,
    }))?;
    rows.collect()
}

pub(crate) fn capture(conn: &Connection, project: &str, raw: &str, source: &str) -> Result<String, String> {
    let raw = raw.trim();
    if raw.is_empty() || raw.len() > 24_000 || raw.contains('\0') { return Err("请输入 1–24 KB 的闪念内容".into()); }
    if !matches!(source, "capture" | "web_clip" | "agent_trace" | "task_intent") {
        return Err("闪念来源类型无效".into());
    }
    let id = id();
    let inserted = conn.execute(
        "INSERT INTO episodic_events(id,project_id,raw_text,source_type,created_at)
         SELECT ?1,id,?3,?4,?5 FROM project WHERE id=?2 AND archived_at IS NULL",
        params![id, project, raw, source, now_ms()],
    ).map_err(err)?;
    if inserted == 0 { return Err("请选择有效的未归档项目".into()); }
    Ok(id)
}

struct NoteWrite {
    id: String,
    note_id: String,
    project_id: String,
    title: Option<String>,
    appendix: String,
    events: String,
}

pub fn flush_note_writes(store: &NoteStore) -> Result<Vec<Note>, String> {
    let writes = {
        let conn = store.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT id,note_id,project_id,title,appendix,episodic_ids_json
            FROM brain_note_writes ORDER BY created_at,id").map_err(err)?;
        let rows = stmt.query_map([], |r| Ok(NoteWrite {
            id: r.get(0)?, note_id: r.get(1)?, project_id: r.get(2)?, title: r.get(3)?, appendix: r.get(4)?, events: r.get(5)?,
        })).map_err(err)?;
        rows.collect::<rusqlite::Result<Vec<_>>>().map_err(err)?
    };
    let mut updated = Vec::new();
    for write in writes {
        let marker = format!("<!-- plate-brain-write:{} -->", write.id);
        let append = format!("\n\n{marker}\n{}\n", write.appendix);
        let note = if let Some(title) = &write.title {
            store.create_memory_note(&write.note_id, &write.project_id, title, &append, &marker)?
        } else {
            let note = store.read(&write.note_id)?;
            if note.summary.project_id != write.project_id { return Err("目标笔记已移动到其他项目".into()); }
            if note.content.lines().any(|line| line == marker) { note } else {
                if store.has_unsaved_draft(&note)? { return Err("有待写入的记忆。请先保存或处理目标笔记的草稿，再打开做梦整理重试。".into()); }
                let content = format!("{}{append}", note.content);
                match store.update_strict(&write.note_id, &content, note.revision)? {
                    SaveResult::Saved { note } => note,
                    SaveResult::Conflict { .. } => return Err("目标笔记版本已变化，请重试记忆写入".into()),
                }
            }
        };
        let conn = store.conn.lock().unwrap();
        let tx = conn.unchecked_transaction().map_err(err)?;
        let event_ids: Vec<String> = serde_json::from_str(&write.events).map_err(err)?;
        for event in event_ids {
            tx.execute("UPDATE episodic_events SET consolidated_note_id=?2,archived_at=?3 WHERE id=?1",
                params![event, write.note_id, now_ms()]).map_err(err)?;
        }
        tx.execute("DELETE FROM brain_note_writes WHERE id=?1", [&write.id]).map_err(err)?;
        tx.commit().map_err(err)?;
        updated.push(note);
    }
    Ok(updated)
}

fn consolidate(store: &NoteStore, event_ids: Vec<String>, target: Option<String>, title: &str) -> Result<String, String> {
    let event_ids: BTreeSet<_> = event_ids.into_iter().collect();
    if event_ids.is_empty() || event_ids.len() > 20 { return Err("请选择 1–20 条闪念".into()); }
    flush_note_writes(store)?;
    let target = target.map(|id| store.read(&id)).transpose()?;
    if let Some(note) = &target {
        if store.has_unsaved_draft(note)? { return Err("请先处理目标笔记的草稿".into()); }
    } else if title.trim().is_empty() || title.len() > 240 || title.contains(['\r', '\n', '\0']) {
        return Err("请输入有效的单行笔记标题".into());
    }
    let note_id = target.as_ref().map_or_else(id, |note| note.summary.id.clone());
    {
        let conn = store.conn.lock().unwrap();
        let tx = conn.unchecked_transaction().map_err(err)?;
        let mut rows = Vec::new();
        for event in &event_ids {
            let row = tx.query_row("SELECT e.project_id,e.raw_text,e.created_at FROM episodic_events e JOIN project p
                ON p.id=e.project_id WHERE e.id=?1 AND e.archived_at IS NULL AND p.archived_at IS NULL", [event],
                |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?)))
                .optional().map_err(err)?.ok_or("闪念不存在、已固化或项目已归档")?;
            rows.push(row);
        }
        let project = &rows[0].0;
        if rows.iter().any(|row| &row.0 != project) || target.as_ref().is_some_and(|n| n.summary.project_id != *project) {
            return Err("请在同一项目内固化闪念".into());
        }
        let project = project.clone();
        rows.sort_by_key(|row| row.2);
        let text = rows.into_iter().map(|(_, text, _)| text.lines().map(|line| format!("> {line}"))
            .collect::<Vec<_>>().join("\n")).collect::<Vec<_>>().join("\n\n");
        tx.execute("INSERT INTO brain_note_writes(id,note_id,project_id,title,appendix,episodic_ids_json,created_at)
            VALUES (?1,?2,?3,?4,?5,?6,?7)", params![id(),note_id,project,target.is_none().then_some(title.trim()),
                format!("## 固化闪念\n\n{text}"),serde_json::to_string(&event_ids).map_err(err)?,now_ms()]).map_err(err)?;
        tx.commit().map_err(err)?;
    }
    flush_note_writes(store)?;
    Ok(note_id)
}

fn apply(store: &NoteStore, run_id: &str) -> Result<(), String> {
    flush_note_writes(store)?;
    let (seed, agent, raw) = {
        let conn = store.conn.lock().unwrap();
        let applied: bool = conn.query_row("SELECT EXISTS(SELECT 1 FROM brain_applied_runs WHERE run_id=?1)",
            [run_id], |r| r.get(0)).map_err(err)?;
        if applied { return Ok(()); }
        conn.query_row("SELECT note_id,agent_id,output_draft FROM task_runs WHERE task_id=?1 AND state='DONE'",
            [run_id], |r| Ok((r.get::<_, String>(0)?,r.get::<_, String>(1)?,r.get::<_, String>(2)?)))
            .optional().map_err(err)?.ok_or("请先采纳任务回执")?
    };
    let (_, proposal) = parse_delta_from_output(&raw).ok_or("此回执没有可用的记忆提案")?;
    let seed_note = store.read(&seed)?;
    let project = &seed_note.summary.project_id;
    let get_note = |id: &str| -> Result<Note, String> {
        let note = store.read(id)?;
        if note.summary.project_id != *project { return Err("记忆提案的目标必须和任务属于同一项目".into()); }
        Ok(note)
    };
    let mut targets = BTreeMap::new();
    targets.insert(seed.clone(), seed_note.clone());
    for id in proposal.suggested_links.iter().map(|item| &item.target_note_id)
        .chain(proposal.note_evolutions.iter().map(|item| &item.target_note_id))
        .chain(proposal.assertion_updates.iter().map(|item| &item.note_id)) {
        if !targets.contains_key(id) { targets.insert(id.clone(), get_note(id)?); }
    }
    let mut appends = BTreeMap::<String, Vec<String>>::new();
    let mut summaries = BTreeMap::<String, Vec<String>>::new();
    let now = now_ms();
    for evolution in &proposal.note_evolutions {
        appends.entry(evolution.target_note_id.clone()).or_default()
            .push(format!("<!-- plate-evolution -->\n{}\n<!-- /plate-evolution -->", evolution.append_insight.trim()));
        summaries.entry(evolution.target_note_id.clone()).or_default().push(evolution.delta_summary.trim().into());
    }
    let linked = {
        let conn = store.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT target_note_id FROM note_link WHERE source_note_id=?1").map_err(err)?;
        let rows = stmt.query_map([&seed], |row| row.get::<_, String>(0)).map_err(err)?;
        rows.collect::<rusqlite::Result<BTreeSet<_>>>().map_err(err)?
    };
    let mut linked = linked;
    for link in &proposal.suggested_links {
        if link.target_note_id == seed { return Err("记忆提案不能创建指向来源自身的链接".into()); }
        if !linked.insert(link.target_note_id.clone()) { continue; }
        let title = targets[&link.target_note_id].summary.title.replace(['[', ']', '|', '\n', '\r'], " ");
        appends.entry(seed.clone()).or_default().push(format!("- [[{}|{title}]]", link.target_note_id));
        summaries.entry(seed.clone()).or_default().push(link.reason.trim().into());
    }
    for note_id in appends.keys() {
        if store.has_unsaved_draft(&targets[note_id])? { return Err("请先处理记忆提案目标笔记的草稿".into()); }
    }
    {
        let conn = store.conn.lock().unwrap();
        let tx = conn.unchecked_transaction().map_err(err)?;
        for claim in &proposal.assertion_updates {
            let new_id = id();
            if let Some(old) = &claim.old_claim_id {
                let count = tx.execute("UPDATE semantic_assertions SET valid_to=?1,superseded_by_id=?2
                    WHERE id=?3 AND note_id=?4 AND valid_to IS NULL AND valid_from<=?1",
                    params![now,new_id,old,claim.note_id]).map_err(err)?;
                if count != 1 { return Err("被替换的断言已失效或不属于目标笔记".into()); }
            }
            tx.execute("INSERT INTO semantic_assertions(id,note_id,claim_text,observed_at,valid_from)
                VALUES (?1,?2,?3,?4,?4)", params![new_id,claim.note_id,claim.new_claim.trim(),now]).map_err(err)?;
            summaries.entry(claim.note_id.clone()).or_default().push(format!("更新事实 · {}", claim.new_claim.trim()));
        }
        for (note_id, changes) in summaries {
            let version: i64 = tx.query_row("UPDATE note SET evolution_version=evolution_version+1 WHERE id=?1
                RETURNING evolution_version", [&note_id], |r| r.get(0)).map_err(err)?;
            let previous: String = targets[&note_id].content.chars().take(600).collect();
            tx.execute("INSERT INTO memory_evolution_logs(id,target_note_id,source_run_id,version,delta_summary,previous_excerpt,created_at)
                VALUES (?1,?2,?3,?4,?5,?6,?7)", params![id(),note_id,run_id,version,changes.join("\n"),previous,now]).map_err(err)?;
        }
        for (note_id, mut lines) in appends {
            lines.dedup();
            tx.execute("INSERT INTO brain_note_writes(id,note_id,project_id,appendix,source_run_id,created_at)
                VALUES (?1,?2,?3,?4,?5,?6)", params![id(),note_id,project,lines.join("\n\n"),run_id,now]).map_err(err)?;
        }
        if let Some(skill) = &proposal.suggested_skill { save_skill(&tx, skill, Some(&agent))?; }
        tx.execute("INSERT INTO brain_applied_runs(run_id,applied_at) VALUES (?1,?2)", params![run_id,now]).map_err(err)?;
        tx.commit().map_err(err)?;
    }
    flush_note_writes(store)?;
    Ok(())
}

fn history(conn: &Connection, note_id: &str) -> rusqlite::Result<Value> {
    let mut stmt = conn.prepare("SELECT version,delta_summary,previous_excerpt,created_at,source_run_id FROM memory_evolution_logs
        WHERE target_note_id=?1 ORDER BY version DESC LIMIT 100")?;
    let rows = stmt.query_map([note_id], |r| Ok(json!({
        "version": r.get::<_, i64>(0)?, "summary": r.get::<_, String>(1)?,
        "previousExcerpt": r.get::<_, String>(2)?, "createdAt": r.get::<_, i64>(3)?, "sourceRunId": r.get::<_, Option<String>>(4)?,
    })))?;
    let evolutions = rows.collect::<rusqlite::Result<Vec<_>>>()?;
    let mut stmt = conn.prepare("SELECT id,claim_text,observed_at,valid_from,valid_to,superseded_by_id,confidence
        FROM semantic_assertions WHERE note_id=?1 ORDER BY valid_to IS NULL DESC,observed_at DESC,id LIMIT 250")?;
    let rows = stmt.query_map([note_id], |r| Ok(json!({
        "id": r.get::<_, String>(0)?, "claim": r.get::<_, String>(1)?, "observedAt": r.get::<_, i64>(2)?,
        "validFrom": r.get::<_, i64>(3)?, "validTo": r.get::<_, Option<i64>>(4)?,
        "supersededById": r.get::<_, Option<String>>(5)?, "confidence": r.get::<_, f64>(6)?,
    })))?;
    Ok(json!({"evolutions":evolutions,"assertions":rows.collect::<rusqlite::Result<Vec<_>>>()?}))
}

use crate::{with_store, AppState};
use tauri::{AppHandle, Emitter, State};

fn changed(app: &AppHandle) { let _ = app.emit("brain://changed", ()); }

#[tauri::command]
pub fn brain_status(state: State<'_, AppState>) -> Result<Value, String> {
    with_store(&state, |store| {
        let conn = store.conn.lock().unwrap();
        let enabled: bool = conn.query_row("SELECT context_enabled FROM brain_settings WHERE singleton=1", [], |r| r.get(0)).map_err(err)?;
        let pending: i64 = conn.query_row("SELECT COUNT(*) FROM brain_note_writes", [], |r| r.get(0)).map_err(err)?;
        Ok(json!({"contextEnabled":enabled,"pendingWrites":pending}))
    })
}

#[tauri::command]
pub fn set_brain_context(app: AppHandle, state: State<'_, AppState>, enabled: bool) -> Result<(), String> {
    with_store(&state, |store| {
        store.conn.lock().unwrap().execute("UPDATE brain_settings SET context_enabled=?1 WHERE singleton=1", [enabled]).map_err(err)?;
        Ok(())
    })?;
    changed(&app);
    Ok(())
}

#[tauri::command]
pub fn brain_note_metadata(state: State<'_, AppState>) -> Result<BTreeMap<String, Value>, String> {
    with_store(&state, |store| {
        let conn = store.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT id,memory_zone,vitality_score,is_dormant,evolution_version FROM note").map_err(err)?;
        let rows = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?,json!({
            "zone":r.get::<_, String>(1)?,"vitality":r.get::<_, f64>(2)?,"dormant":r.get::<_, bool>(3)?,"version":r.get::<_, i64>(4)?,
        })))).map_err(err)?;
        rows.collect::<rusqlite::Result<_>>().map_err(err)
    })
}

#[tauri::command]
pub fn capture_episodic_event(app: AppHandle, state: State<'_, AppState>, project_id: String, raw_text: String,
    source_type: Option<String>) -> Result<String, String> {
    let id = with_store(&state, |store| capture(&store.conn.lock().unwrap(), &project_id, &raw_text, source_type.as_deref().unwrap_or("capture")))?;
    changed(&app);
    Ok(id)
}

#[tauri::command]
pub fn list_episodic_events(state: State<'_, AppState>, project_id: Option<String>) -> Result<Vec<EpisodicEvent>, String> {
    with_store(&state, |store| episodic(&store.conn.lock().unwrap(), project_id.as_deref(), false).map_err(err))
}

#[tauri::command]
pub fn consolidate_episodic_to_note(app: AppHandle, state: State<'_, AppState>, event_ids: Vec<String>,
    target_note_id: Option<String>, title: String) -> Result<String, String> {
    let result = with_store(&state, |store| consolidate(store, event_ids, target_note_id, &title));
    changed(&app);
    result
}

#[tauri::command]
pub fn list_procedural_skills(state: State<'_, AppState>) -> Result<Vec<Skill>, String> {
    with_store(&state, |store| skills(&store.conn.lock().unwrap()).map_err(err))
}

#[tauri::command]
pub fn save_procedural_skill(app: AppHandle, state: State<'_, AppState>, input: SkillInput, preferred_agent_id: Option<String>)
    -> Result<String, String> {
    let skill = with_store(&state, |store| save_skill(&store.conn.lock().unwrap(), &input, preferred_agent_id.as_deref()))?;
    changed(&app);
    Ok(skill)
}

#[tauri::command]
pub fn apply_memory_delta(app: AppHandle, state: State<'_, AppState>, run_id: String) -> Result<(), String> {
    let result = with_store(&state, |store| apply(store, &run_id));
    changed(&app);
    result
}

#[tauri::command]
pub fn get_note_evolution_history(state: State<'_, AppState>, note_id: String) -> Result<Value, String> {
    with_store(&state, |store| history(&store.conn.lock().unwrap(), &note_id).map_err(err))
}

#[tauri::command]
pub fn recalculate_brain_vitality(app: AppHandle, state: State<'_, AppState>) -> Result<(), String> {
    with_store(&state, |store| crate::vitality_engine::recalculate(&store.conn.lock().unwrap(), now_ms()).map_err(err))?;
    changed(&app);
    Ok(())
}

#[tauri::command]
pub fn trigger_dream_consolidation(app: AppHandle, state: State<'_, AppState>, project_id: Option<String>)
    -> Result<Vec<EpisodicEvent>, String> {
    let result = with_store(&state, |store| {
        flush_note_writes(store)?;
        episodic(&store.conn.lock().unwrap(), project_id.as_deref(), true).map_err(err)
    });
    changed(&app);
    result
}
