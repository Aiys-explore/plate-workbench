use rusqlite::Connection;

// 核心五表与 Electron 版 notes.ts 的 DDL 完全一致（非 STRICT），
// 保证同一个 index.sqlite 可被两端打开；graph_layout / task_runs 为新增 STRICT 表。
pub fn open(root: &std::path::Path) -> Result<Connection, String> {
    let path = root.join("index.sqlite");
    let conn = Connection::open(&path).map_err(|e| format!("无法打开索引数据库：{e}"))?;
    conn.pragma_update(None, "journal_mode", "WAL").map_err(|e| e.to_string())?;
    conn.pragma_update(None, "foreign_keys", "ON").map_err(|e| e.to_string())?;
    conn.pragma_update(None, "synchronous", "FULL").map_err(|e| e.to_string())?;
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS project (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, root_path TEXT NOT NULL, color TEXT,
          archived_at INTEGER, created_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS note (
          id TEXT PRIMARY KEY, path TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
          project_id TEXT NOT NULL REFERENCES project(id), kind TEXT NOT NULL,
          created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS note_link (
          source_note_id TEXT REFERENCES note(id) ON DELETE CASCADE,
          target_note_id TEXT REFERENCES note(id) ON DELETE CASCADE,
          PRIMARY KEY (source_note_id, target_note_id)
        );
        CREATE TABLE IF NOT EXISTS note_tag (
          note_id TEXT REFERENCES note(id) ON DELETE CASCADE, tag TEXT,
          PRIMARY KEY (note_id, tag)
        );
        CREATE INDEX IF NOT EXISTS note_project_updated ON note(project_id, updated_at);
        CREATE INDEX IF NOT EXISTS note_link_target ON note_link(target_note_id);
        CREATE INDEX IF NOT EXISTS note_tag_value ON note_tag(tag);
        CREATE TABLE IF NOT EXISTS note_draft (
          note_id TEXT PRIMARY KEY NOT NULL, path TEXT NOT NULL, title TEXT NOT NULL,
          project_id TEXT NOT NULL, kind TEXT NOT NULL, created_at INTEGER NOT NULL,
          base_revision TEXT NOT NULL, content TEXT NOT NULL, written_at INTEGER NOT NULL,
          version TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS graph_layout (
          note_id TEXT PRIMARY KEY REFERENCES note(id) ON DELETE CASCADE,
          x REAL NOT NULL,
          y REAL NOT NULL,
          pinned INTEGER NOT NULL DEFAULT 1,
          parent_note_id TEXT REFERENCES note(id) ON DELETE SET NULL,
          collapsed INTEGER NOT NULL DEFAULT 0,
          updated_at INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS task_runs (
          task_id TEXT PRIMARY KEY,
          note_id TEXT NOT NULL REFERENCES note(id) ON DELETE CASCADE,
          agent_id TEXT NOT NULL,
          state TEXT NOT NULL CHECK(state IN ('TODO', 'DOING', 'PENDING', 'DONE', 'ERROR')),
          pending_kind TEXT CHECK(pending_kind IN ('review_ready', 'approval_needed') OR pending_kind IS NULL),
          prompt_text TEXT NOT NULL,
          output_draft TEXT NOT NULL DEFAULT '',
          log_tail TEXT NOT NULL DEFAULT '',
          error_msg TEXT,
          external_session_id TEXT,
          started_at INTEGER,
          ended_at INTEGER,
          duration_ms INTEGER,
          tokens_used INTEGER,
          updated_at INTEGER NOT NULL,
          review_prompt TEXT,
          follow_context TEXT
        ) STRICT;
        CREATE INDEX IF NOT EXISTS idx_task_runs_note ON task_runs(note_id, updated_at DESC);
        CREATE INDEX IF NOT EXISTS idx_task_runs_state ON task_runs(state);
        "#,
    )
    .map_err(|e| format!("初始化 schema 失败：{e}"))?;
    for column in ["review_prompt", "follow_context"] {
        let exists: bool = conn.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('task_runs') WHERE name = ?1)",
            [column], |row| row.get(0),
        ).map_err(|e| e.to_string())?;
        if !exists {
            conn.execute(&format!("ALTER TABLE task_runs ADD COLUMN {column} TEXT"), [])
                .map_err(|e| e.to_string())?;
        }
    }
    migrate_brain(&conn).map_err(|error| format!("初始化 Brain schema 失败：{error}"))?;
    migrate_s10(&conn).map_err(|error| format!("初始化 S10 schema 失败：{error}"))?;
    migrate_s11(&conn).map_err(|error| format!("初始化 S11 schema 失败：{error}"))?;
    Ok(conn)
}

pub(crate) fn migrate_brain(conn: &Connection) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    for (name, definition) in [
        ("memory_zone", "TEXT NOT NULL DEFAULT 'semantic'"),
        ("vitality_score", "REAL NOT NULL DEFAULT 1.0"),
        ("access_count", "INTEGER NOT NULL DEFAULT 1"),
        ("last_accessed_at", "INTEGER NOT NULL DEFAULT 0"),
        ("evolution_version", "INTEGER NOT NULL DEFAULT 1"),
        ("is_dormant", "INTEGER NOT NULL DEFAULT 0"),
    ] {
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('note') WHERE name=?1)",
            [name], |row| row.get(0),
        )?;
        if !exists { tx.execute(&format!("ALTER TABLE note ADD COLUMN {name} {definition}"), [])?; }
    }
    tx.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS episodic_events (
            id TEXT PRIMARY KEY, project_id TEXT NOT NULL REFERENCES project(id),
            raw_text TEXT NOT NULL, source_type TEXT NOT NULL DEFAULT 'capture',
            salience_score REAL NOT NULL DEFAULT 1.0,
            consolidated_note_id TEXT REFERENCES note(id) ON DELETE SET NULL,
            created_at INTEGER NOT NULL, archived_at INTEGER
        );
        CREATE INDEX IF NOT EXISTS idx_episodic_project_created ON episodic_events(project_id, created_at DESC);
        CREATE TABLE IF NOT EXISTS semantic_assertions (
            id TEXT PRIMARY KEY, note_id TEXT NOT NULL REFERENCES note(id) ON DELETE CASCADE,
            claim_text TEXT NOT NULL, confidence REAL NOT NULL DEFAULT 1.0,
            observed_at INTEGER NOT NULL, valid_from INTEGER NOT NULL, valid_to INTEGER,
            superseded_by_id TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_assertions_note_valid ON semantic_assertions(note_id, valid_to);
        CREATE TABLE IF NOT EXISTS procedural_skills (
            id TEXT PRIMARY KEY, slug TEXT NOT NULL UNIQUE, title TEXT NOT NULL,
            trigger_tags_json TEXT NOT NULL DEFAULT '[]', preferred_agent_id TEXT,
            system_prompt TEXT NOT NULL, usage_count INTEGER NOT NULL DEFAULT 0,
            success_count INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS memory_evolution_logs (
            id TEXT PRIMARY KEY, target_note_id TEXT NOT NULL REFERENCES note(id) ON DELETE CASCADE,
            source_run_id TEXT, version INTEGER NOT NULL, delta_summary TEXT NOT NULL,
            previous_excerpt TEXT NOT NULL, created_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_evolution_note ON memory_evolution_logs(target_note_id, version DESC);
        CREATE TABLE IF NOT EXISTS brain_settings (
            singleton INTEGER PRIMARY KEY CHECK(singleton=1),
            context_enabled INTEGER NOT NULL DEFAULT 0
        );
        INSERT OR IGNORE INTO brain_settings(singleton) VALUES(1);
        CREATE TABLE IF NOT EXISTS brain_skill_usage (
            task_id TEXT NOT NULL, skill_id TEXT NOT NULL REFERENCES procedural_skills(id) ON DELETE CASCADE,
            PRIMARY KEY(task_id, skill_id)
        );
        CREATE TABLE IF NOT EXISTS brain_applied_runs (
            run_id TEXT PRIMARY KEY, applied_at INTEGER NOT NULL
        );
        CREATE TABLE IF NOT EXISTS brain_note_writes (
            id TEXT PRIMARY KEY, note_id TEXT NOT NULL, project_id TEXT NOT NULL,
            title TEXT, appendix TEXT NOT NULL, source_run_id TEXT,
            episodic_ids_json TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL
        );
        "#,
    )?;
    tx.commit()
}

pub(crate) fn migrate_s10(conn: &Connection) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS llm_providers (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,
            base_url TEXT NOT NULL, default_model TEXT NOT NULL, roles_json TEXT NOT NULL DEFAULT '[]',
            key_hint TEXT NOT NULL DEFAULT '', input_price_per_1m REAL NOT NULL DEFAULT 0.0,
            output_price_per_1m REAL NOT NULL DEFAULT 0.0, enabled INTEGER NOT NULL DEFAULT 1,
            updated_at INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS external_agent_sessions (
            id TEXT PRIMARY KEY, source_tool TEXT NOT NULL, source_path TEXT NOT NULL UNIQUE,
            workspace_cwd TEXT NOT NULL DEFAULT '', title TEXT NOT NULL, summary TEXT NOT NULL DEFAULT '',
            message_count INTEGER NOT NULL DEFAULT 0, file_mtime INTEGER NOT NULL DEFAULT 0,
            byte_offset INTEGER NOT NULL DEFAULT 0, updated_at INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS external_agent_messages (
            id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES external_agent_sessions(id) ON DELETE CASCADE,
            seq INTEGER NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, tool_name TEXT,
            touched_files_json TEXT NOT NULL DEFAULT '[]', created_at INTEGER NOT NULL, UNIQUE (session_id, seq)
        ) STRICT;
        CREATE VIRTUAL TABLE IF NOT EXISTS external_agent_messages_fts USING fts5(
            session_id UNINDEXED, role UNINDEXED, content
        );
        CREATE TABLE IF NOT EXISTS harness_runs (
            id TEXT PRIMARY KEY, title TEXT NOT NULL, backend_kind TEXT NOT NULL, backend_id TEXT NOT NULL,
            model_name TEXT NOT NULL DEFAULT '', skill_id TEXT, permission_manifest_json TEXT NOT NULL,
            activation_wave_json TEXT, status TEXT NOT NULL, token_in INTEGER NOT NULL DEFAULT 0,
            token_out INTEGER NOT NULL DEFAULT 0, cost_usd REAL NOT NULL DEFAULT 0.0,
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
        ) STRICT;
        CREATE TABLE IF NOT EXISTS harness_events (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            run_id TEXT NOT NULL REFERENCES harness_runs(id) ON DELETE CASCADE, seq INTEGER NOT NULL,
            kind TEXT NOT NULL, payload_json TEXT NOT NULL, created_at INTEGER NOT NULL, UNIQUE (run_id, seq)
        ) STRICT;
        CREATE TABLE IF NOT EXISTS staged_diffs (
            id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES harness_runs(id) ON DELETE CASCADE,
            target_kind TEXT NOT NULL, target_ref TEXT NOT NULL, base_sha256 TEXT NOT NULL,
            proposed_content TEXT NOT NULL, unified_diff TEXT NOT NULL, rationale TEXT NOT NULL DEFAULT '',
            status TEXT NOT NULL DEFAULT 'pending', created_at INTEGER NOT NULL, resolved_at INTEGER
        ) STRICT;
        CREATE INDEX IF NOT EXISTS idx_staged_diffs_run ON staged_diffs(run_id, status, created_at);
        "#,
    )?;
    for (name, definition) in [("prefix_signature", "TEXT NOT NULL DEFAULT ''"), ("file_bytes", "INTEGER NOT NULL DEFAULT 0")] {
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('external_agent_sessions') WHERE name=?1)",
            [name], |row| row.get(0),
        )?;
        if !exists {
            tx.execute(&format!("ALTER TABLE external_agent_sessions ADD COLUMN {name} {definition}"), [])?;
        }
    }
    for name in ["allow_shell", "allow_network"] {
        // The M1 schema tests run without the earlier Brain migrations.
        let exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='procedural_skills')", [],
            |row| row.get(0),
        )?;
        if !exists { break; }
        let field: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM pragma_table_info('procedural_skills') WHERE name=?1)",
            [name], |row| row.get(0),
        )?;
        if !field {
            tx.execute(&format!("ALTER TABLE procedural_skills ADD COLUMN {name} INTEGER NOT NULL DEFAULT 0"), [])?;
        }
    }
    for (table, column, definition) in [
        ("harness_runs","project_id","TEXT NOT NULL DEFAULT 'default'"),
        ("staged_diffs","previous_excerpt","TEXT NOT NULL DEFAULT ''"),
    ] {
        let exists: bool = tx.query_row(
            &format!("SELECT EXISTS(SELECT 1 FROM pragma_table_info('{table}') WHERE name=?1)"),
            [column], |row| row.get(0),
        )?;
        if !exists { tx.execute(&format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"), [])?; }
    }
    tx.commit()
}

pub(crate) fn migrate_s11(conn: &Connection) -> rusqlite::Result<()> {
    let tx = conn.unchecked_transaction()?;
    tx.execute_batch("
        CREATE TABLE IF NOT EXISTS brain_spaces (
          id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,
          description TEXT NOT NULL DEFAULT '', isolated INTEGER NOT NULL DEFAULT 0,
          allow_export INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL
        ) STRICT;
    ")?;
    for (id, name, isolated) in [("work", "工作", false), ("learning", "学习", false), ("personal", "个人", true)] {
        tx.execute("INSERT OR IGNORE INTO brain_spaces(id,name,kind,isolated,allow_export,created_at)
            VALUES(?1,?2,?1,?3,NOT ?3,?4)", rusqlite::params![id,name,isolated,crate::notes::now_ms()])?;
    }
    for (table, column, definition) in [
        ("note", "space_id", "TEXT NOT NULL DEFAULT 'learning'"),
        ("episodic_events", "space_id", "TEXT NOT NULL DEFAULT 'learning'"),
        ("episodic_events", "review_status", "TEXT NOT NULL DEFAULT 'candidate'"),
        ("episodic_events", "source_run_id", "TEXT"),
        ("procedural_skills", "space_id", "TEXT NOT NULL DEFAULT 'learning'"),
        ("brain_note_writes", "space_id", "TEXT NOT NULL DEFAULT 'learning'"),
        ("harness_runs", "space_id", "TEXT NOT NULL DEFAULT 'learning'"),
        ("staged_diffs", "execution_mode", "TEXT NOT NULL DEFAULT 'shadow'"),
    ] {
        let exists: bool = tx.query_row(
            &format!("SELECT EXISTS(SELECT 1 FROM pragma_table_info('{table}') WHERE name=?1)"),
            [column], |row| row.get(0),
        )?;
        if !exists {
            tx.execute(&format!("ALTER TABLE {table} ADD COLUMN {column} {definition}"), [])?;
            if column == "review_status" {
                tx.execute("UPDATE episodic_events SET review_status='promoted' WHERE consolidated_note_id IS NOT NULL", [])?;
            }
        }
    }
    tx.execute_batch("
        CREATE INDEX IF NOT EXISTS idx_note_space ON note(space_id,updated_at);
        CREATE INDEX IF NOT EXISTS idx_episodic_space ON episodic_events(space_id,archived_at,created_at);
    ")?;
    tx.commit()
}

#[cfg(test)]
mod s11_tests {
    use super::*;

    #[test]
    fn s10_rows_survive_repeated_s11_migration() {
        let conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("CREATE TABLE project(id TEXT PRIMARY KEY);
            CREATE TABLE note(id TEXT PRIMARY KEY, updated_at INTEGER);
            INSERT INTO project VALUES('default');
            INSERT INTO note VALUES('legacy',123);").unwrap();
        migrate_brain(&conn).unwrap();
        migrate_s10(&conn).unwrap();
        conn.execute("INSERT INTO episodic_events(id,project_id,raw_text,created_at)
            VALUES('e','default','legacy memory',123)", []).unwrap();
        conn.execute("INSERT INTO procedural_skills(id,slug,title,system_prompt,created_at,updated_at)
            VALUES('s','s','legacy skill','prompt',123,123)", []).unwrap();
        migrate_s11(&conn).unwrap();
        migrate_s11(&conn).unwrap();
        let legacy: (String, String, String, String, String) = conn.query_row(
            "SELECT n.space_id,e.space_id,e.raw_text,s.space_id,s.system_prompt
            FROM note n CROSS JOIN episodic_events e CROSS JOIN procedural_skills s",
            [], |r| Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?,r.get(4)?)),
        ).unwrap();
        assert_eq!(legacy, ("learning".into(),"learning".into(),"legacy memory".into(),"learning".into(),"prompt".into()));
        let policy = crate::brain_spaces::SpaceScopePolicy {
            target_space_id:"work".into(), readable_space_ids:vec!["learning".into(),"personal".into()],
        };
        assert_eq!(policy.allowed(&conn).unwrap(), ["work","learning"]);
    }
}
