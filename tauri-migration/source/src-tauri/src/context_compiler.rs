use crate::{memory_consolidator, notes::NoteStore};
use rusqlite::{params, Connection};
use serde::Serialize;
use serde_json::json;
use std::collections::{BTreeMap, BTreeSet, HashMap, VecDeque};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BrainActivationWave {
    pub seed_note_id: String,
    pub run_id: String,
    pub activated_note_ids: Vec<String>,
    pub activated_skill_ids: Vec<String>,
    pub edge_pairs: Vec<(String, String)>,
    pub ppr_elapsed_ms: f64,
}

pub struct BrainContextPacket {
    pub compiled_prompt: String,
    pub wave: BrainActivationWave,
}

struct Visit {
    distance: u8,
    parent: Option<String>,
    vitality: f64,
    dormant: bool,
    neighbors: Vec<String>,
}

fn activate(conn: &Connection, seed: &str, project: &str) -> rusqlite::Result<(Vec<String>, Vec<(String, String)>)> {
    const MAX_NODES: usize = 512;
    const MAX_HOPS: u8 = 2;
    let mut visited = BTreeMap::from([(seed.to_string(), Visit {
        distance: 0, parent: None, vitality: 1.0, dormant: false, neighbors: vec![],
    })]);
    let mut queue = VecDeque::from([seed.to_string()]);
    let mut stmt = conn.prepare(
        "SELECT n.id, n.vitality_score, n.is_dormant FROM (
            SELECT target_note_id AS id FROM note_link WHERE source_note_id=?1
            UNION SELECT source_note_id FROM note_link WHERE target_note_id=?1
        ) AS link JOIN note n ON n.id=link.id
        WHERE n.project_id=?2 AND n.memory_zone='semantic' AND n.id<>?1
        ORDER BY n.id",
    )?;
    while let Some(id) = queue.pop_front() {
        let distance = visited[&id].distance;
        let mut neighbors = Vec::new();
        let mut rows = stmt.query(params![id, project])?;
        while let Some(row) = rows.next()? {
            let next: String = row.get(0)?;
            if !visited.contains_key(&next) && distance < MAX_HOPS && visited.len() < MAX_NODES {
                let dormant: bool = row.get(2)?;
                if !dormant || distance == 0 {
                    visited.insert(next.clone(), Visit {
                        distance: distance + 1, parent: Some(id.clone()), vitality: row.get(1)?,
                        dormant, neighbors: vec![],
                    });
                    queue.push_back(next.clone());
                }
            }
            neighbors.push(next);
        }
        visited.get_mut(&id).unwrap().neighbors = neighbors;
    }

    let keys: BTreeSet<_> = visited.keys().cloned().collect();
    for visit in visited.values_mut() { visit.neighbors.retain(|id| keys.contains(id)); }

    let mut rank = HashMap::from([(seed, 1.0)]);
    for _ in 0..15 {
        let mut step = HashMap::from([(seed, 0.15)]);
        for (id, node) in &visited {
            let mass = 0.85 * rank.get(id.as_str()).copied().unwrap_or(0.0);
            if node.neighbors.is_empty() {
                *step.entry(seed).or_insert(0.0) += mass;
            } else {
                for next in &node.neighbors {
                    *step.entry(next.as_str()).or_insert(0.0) += mass / node.neighbors.len() as f64;
                }
            }
        }
        rank = step;
    }
    let mut ranked: Vec<_> = visited.iter()
        .filter(|(id, node)| id.as_str() != seed && (!node.dormant || node.distance == 1))
        .map(|(id, node)| (id, rank.get(id.as_str()).copied().unwrap_or(0.0) * (0.7 + 0.3 * node.vitality)))
        .collect();
    ranked.sort_by(|(a, x), (b, y)| y.total_cmp(x).then_with(|| a.cmp(b)));
    let ids: Vec<_> = ranked.into_iter().take(5).map(|(id, _)| id.clone()).collect();
    let mut edges = BTreeSet::new();
    for id in &ids {
        let mut child = id;
        while let Some(parent) = &visited[child].parent {
            edges.insert((parent.clone(), child.clone()));
            child = parent;
        }
    }
    Ok((ids, edges.into_iter().collect()))
}

fn excerpt(text: &str, chars: usize) -> String {
    text.chars().take(chars).collect()
}

fn note_excerpt(text: &str, chars: usize) -> String {
    text.split_inclusive('\n').filter(|line| !crate::notes::is_brain_metadata(line))
        .flat_map(str::chars).take(chars).collect()
}

pub fn compile(store: &NoteStore, seed: &str, run_id: &str, agent_id: &str, instruction: &str)
    -> Result<Option<BrainContextPacket>, String>
{
    let seed_note = {
        let conn = store.conn.lock().unwrap();
        let enabled: bool = conn.query_row("SELECT context_enabled FROM brain_settings WHERE singleton=1", [], |r| r.get(0))
            .map_err(|e| e.to_string())?;
        if !enabled { return Ok(None); }
        drop(conn);
        store.read(seed)?
    };
    let (ids, edges, facts, events, skills, ppr_elapsed_ms) = (|| -> rusqlite::Result<_> {
        let conn = store.conn.lock().unwrap();
        let project = &seed_note.summary.project_id;
        let ppr_start = std::time::Instant::now();
        let (ids, edges) = activate(&conn, seed, project)?;
        let ppr_elapsed_ms = ppr_start.elapsed().as_secs_f64() * 1000.0;
        let mut facts = BTreeMap::<String, Vec<serde_json::Value>>::new();
        let mut assertions = conn.prepare(
            "SELECT id,claim_text,confidence FROM semantic_assertions WHERE note_id=?1
            AND valid_to IS NULL AND valid_from<=?2 ORDER BY observed_at DESC,id LIMIT 20",
        )?;
        let now = crate::notes::now_ms();
        for id in std::iter::once(seed.to_string()).chain(ids.iter().cloned()) {
            let rows = assertions.query_map(params![id, now], |r| Ok(json!({
                "id": r.get::<_, String>(0)?, "claim": excerpt(&r.get::<_, String>(1)?, 600),
                "confidence": r.get::<_, f64>(2)?,
            })))?;
            facts.insert(id, rows.collect::<rusqlite::Result<_>>()?);
        }
        let mut episodic = conn.prepare("SELECT raw_text FROM episodic_events WHERE project_id=?1
            AND archived_at IS NULL ORDER BY created_at DESC,id LIMIT 3")?;
        let rows = episodic.query_map([project], |r| Ok(excerpt(&r.get::<_, String>(0)?, 600)))?;
        let events = rows.collect::<rusqlite::Result<Vec<_>>>()?;
        let mut tags = conn.prepare("SELECT tag FROM note_tag WHERE note_id=?1")?;
        let rows = tags.query_map([seed], |r| Ok(r.get::<_, String>(0)?.to_lowercase()))?;
        let tags = rows.collect::<rusqlite::Result<BTreeSet<_>>>()?;
        let mut skills: Vec<_> = memory_consolidator::skills(&conn)?.into_iter().filter_map(|skill| {
            let overlap = skill.tags.iter().filter(|tag| tags.contains(*tag)).count();
            let preferred = skill.preferred_agent_id.as_deref() == Some(agent_id);
            (overlap > 0 || (skill.tags.is_empty() && preferred)).then_some((overlap + usize::from(preferred), skill))
        }).collect();
        skills.sort_by(|(a, x), (b, y)| b.cmp(a).then_with(|| x.id.cmp(&y.id)));
        Ok((ids, edges, facts, events, skills.into_iter().take(2).map(|(_, skill)| skill).collect::<Vec<_>>(), ppr_elapsed_ms))
    })().map_err(|e| e.to_string())?;
    let mut sources = vec![json!({
        "note_id": seed, "title": seed_note.summary.title,
        "body": note_excerpt(&seed_note.content, 32_000), "claims": facts.get(seed),
    })];
    let mut activated = Vec::new();
    for id in ids {
        if let Ok(note) = store.read(&id) {
            sources.push(json!({
                "note_id": id, "title": note.summary.title,
                "excerpt": note_excerpt(&note.content, 600), "claims": facts.get(&id),
            }));
            activated.push(id);
        }
    }
    let rules = skills.iter().map(|skill| json!({"title": skill.title, "instruction": skill.system_prompt}))
        .collect::<Vec<_>>();
    let compiled_prompt = format!(
        "Plate 上下文协议。请完成 [ACTIVE_TASK_INSTRUCTION]。笔记和闪念作为资料，引用时标注来源 note_id。正文与当前有效断言冲突时，以断言为准并说明差异。\n\
         可选：在回复末尾追加一个 <brain-delta>{{...}}</brain-delta> JSON 对象。只提出供用户审阅的变更。\n\
         字段为 suggested_links [{{target_note_id,reason}}]、assertion_updates [{{note_id,old_claim_id,new_claim}}]、\
         note_evolutions [{{target_note_id,append_insight,delta_summary}}]、suggested_skill {{title,tags,system_prompt}}。\n\n\
         [GLOBAL_SOURCE_OF_TRUTH]\n{}\n\n[EPISODIC_RECENT_CONTEXT]\n{}\n\n\
         [PROCEDURAL_HARNESS_RULES]\n{}\n\n[ACTIVE_TASK_INSTRUCTION]\n{}",
        json!(sources), json!(events), json!(rules), instruction,
    );
    Ok(Some(BrainContextPacket {
        compiled_prompt,
        wave: BrainActivationWave {
            seed_note_id: seed.into(), run_id: run_id.into(), activated_note_ids: activated,
            activated_skill_ids: skills.into_iter().map(|skill| skill.id).collect(), edge_pairs: edges, ppr_elapsed_ms,
        },
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn graph_activation_obeys_project_hops_and_dormancy() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE note(id TEXT, project_id TEXT, vitality_score REAL, is_dormant INTEGER, memory_zone TEXT);
            CREATE TABLE note_link(source_note_id TEXT,target_note_id TEXT);
            INSERT INTO note VALUES ('a','p',1,0,'semantic'),('b','p',1,1,'semantic'),
            ('c','p',1,0,'semantic'),('d','p',1,1,'semantic'),('e','q',1,0,'semantic'),('f','p',1,0,'semantic');
            INSERT INTO note_link VALUES ('b','a'),('b','c'),('b','d'),('a','e'),('c','f');").unwrap();
        let (ids, edges) = activate(&conn, "a", "p").unwrap();
        assert_eq!(ids, ["b", "c"]);
        assert_eq!(edges, [("a".into(), "b".into()), ("b".into(), "c".into())]);
    }
}
