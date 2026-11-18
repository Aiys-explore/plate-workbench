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
    Ok(conn)
}
