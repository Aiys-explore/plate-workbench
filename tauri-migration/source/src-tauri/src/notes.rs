use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{SystemTime, UNIX_EPOCH};

pub const DEFAULT_PROJECT: &str = "default";

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct NoteSummary {
    pub id: String,
    pub path: String,
    pub title: String,
    pub project_id: String,
    pub kind: String,
    pub created_at: i64,
    pub updated_at: i64,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct Note {
    #[serde(flatten)]
    pub summary: NoteSummary,
    pub content: String,
    pub revision: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct ProjectSummary {
    pub id: String,
    pub name: String,
    pub archived_at: Option<i64>,
    pub color: Option<String>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct RelationshipNote {
    #[serde(flatten)]
    pub summary: NoteSummary,
    pub preview: Option<String>,
    pub tags: Option<Vec<String>>,
}

#[derive(Serialize, Clone)]
pub struct NoteEdge {
    pub source: String,
    pub target: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct LinkBinding {
    pub source: String,
    pub r#ref: String,
    pub target: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct LinkIndex {
    pub nodes: Vec<RelationshipNote>,
    pub edges: Vec<NoteEdge>,
    pub bindings: Vec<LinkBinding>,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct DraftSummary {
    pub id: String,
    pub title: String,
    pub path: String,
    pub revision: String,
    pub version: String,
    pub written_at: i64,
    pub source: String,
}

#[derive(Serialize, Clone)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum DraftRecovery {
    Restored { note: Note, content: String, version: String },
    Preview { draft: DraftSummary, content: String, disk_revision: Option<String> },
    Missing,
}

#[derive(Serialize, Clone)]
#[serde(tag = "status", rename_all = "camelCase")]
pub enum SaveResult {
    Saved { note: Note },
    Conflict { current: Option<Note>, copy: Note },
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SearchMatch {
    pub field: String,
    pub before: String,
    pub r#match: String,
    pub after: String,
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub note: NoteSummary,
    pub r#match: Option<SearchMatch>,
}

#[derive(serde::Deserialize, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct NoteFilters {
    pub project_id: Option<String>,
    pub kind: Option<String>,
    pub tag: Option<String>,
    pub tags: Vec<String>,
    pub query: Option<String>,
    pub links_to: Option<String>,
    pub linked_from: Option<String>,
}

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as i64
}

pub fn check_project(id: &str) -> Result<(), String> {
    let ok = !id.is_empty()
        && id.len() <= 80
        && id.chars().next().map_or(false, |c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && id.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_' || c == '-');
    if ok { Ok(()) } else { Err("项目 ID 无效".into()) }
}

pub fn check_note_id(id: &str) -> Result<(), String> {
    let ok = id.len() == 36
        && id.chars().filter(|&c| c == '-').count() == 4
        && id.chars().all(|c| c.is_ascii_hexdigit() || c == '-');
    if ok { Ok(()) } else { Err("笔记 ID 无效".into()) }
}

fn percent_decode(s: &str) -> Option<String> {
    let bytes = s.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[i + 1..i + 3]).ok()?;
            let value = u8::from_str_radix(hex, 16).ok()?;
            out.push(value);
            i += 3;
        } else {
            out.push(bytes[i]);
            i += 1;
        }
    }
    String::from_utf8(out).ok()
}

pub struct Disk { pub content: String, pub revision: String }

fn snapshot(path: &Path) -> Result<Option<Disk>, String> {
    match fs::read(path) {
        Ok(bytes) => {
            let content = String::from_utf8(bytes).map_err(|_| "笔记不是有效的 UTF-8 文本".to_string())?;
            let mut hasher = Sha256::new();
            hasher.update(content.as_bytes());
            let revision = format!("{:x}", hasher.finalize());
            Ok(Some(Disk { content, revision }))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(format!("读取笔记失败：{e}")),
    }
}

fn plate_title_line(content: &str) -> Option<(usize, usize, String)> {
    let start = if content.starts_with('\u{FEFF}') { '\u{FEFF}'.len_utf8() } else { 0 };
    let rest = &content[start..];
    let end = rest.find('\n')?;
    let line = rest[..end].trim_end_matches('\r');
    let inner = line.strip_prefix("<!-- plate-title:")?.strip_suffix(" -->")?;
    let title = percent_decode(inner)?;
    Some((start, start + end + 1, title))
}

pub struct Metadata {
    pub title: String,
    pub tags: HashSet<String>,
    pub references: Vec<String>,
    pub downstream_refs: HashSet<String>,
    pub body: String,
}

fn extract_metadata(content: &str, fallback: &str) -> Metadata {
    let mut title = None;
    let mut body = content.strip_prefix('\u{FEFF}').unwrap_or(content).to_string();
    if let Some((_, end, t)) = plate_title_line(content) {
        title = Some(if t.trim().is_empty() { "未命名笔记".to_string() } else { t.trim().to_string() });
        body = content[end..].to_string();
    }
    if title.is_none() {
        if let Some(rest) = body.strip_prefix("---\n") {
            if let Some(pos) = rest.find("\n---") {
                body = rest[pos + 4..].trim_start_matches(['\r', '\n']).to_string();
            }
        }
    }
    if title.is_none() {
        title = body.lines().next().and_then(|l| l.strip_prefix("# "))
            .map(|t| t.trim().trim_end_matches('#').trim().to_string())
            .filter(|t| !t.is_empty());
    }
    let title = title.unwrap_or_else(|| fallback.to_string());

    let mut tags = HashSet::new();
    let mut references = Vec::new();
    let mut downstream_refs = HashSet::new();
    let mut in_fence = false;
    for line in body.lines() {
        let trimmed = line.trim_start();
        if trimmed.starts_with("```") || trimmed.starts_with("~~~") { in_fence = !in_fence; continue; }
        if in_fence { continue; }
        let mut rest = line;
        while let Some(pos) = rest.find("[[") {
            let after = &rest[pos + 2..];
            if let Some(end) = after.find("]]") {
                let inner = &after[..end];
                let r#ref = inner.split('|').next().unwrap_or("").trim().to_string();
                if !r#ref.is_empty() {
                    if &rest[..pos] == "- " && after[end + 2..].trim() == "<!-- plate-downstream -->" {
                        downstream_refs.insert(r#ref.clone());
                    }
                    references.push(r#ref);
                }
                rest = &after[end + 2..];
            } else { break; }
        }
        let chars: Vec<char> = line.chars().collect();
        let mut i = 0;
        while i < chars.len() {
            if chars[i] == '#' && (i == 0 || chars[i - 1].is_whitespace() || chars[i - 1] == '(') {
                let mut j = i + 1;
                let mut tag = String::new();
                while j < chars.len() && (chars[j].is_alphanumeric() || chars[j] == '_' || chars[j] == '/' || chars[j] == '-') {
                    tag.push(chars[j]);
                    j += 1;
                }
                if !tag.is_empty() && chars.get(i + 1).map_or(false, |c| c.is_alphanumeric() || *c == '_') {
                    tags.insert(tag.to_lowercase());
                    i = j;
                    continue;
                }
            }
            i += 1;
        }
    }
    Metadata { title, tags, references, downstream_refs, body }
}

pub fn is_brain_metadata(line: &str) -> bool {
    let line = line.trim();
    matches!(line, "<!-- plate-evolution -->" | "<!-- /plate-evolution -->")
        || line.strip_prefix("<!-- plate-brain-write:").and_then(|id| id.strip_suffix(" -->"))
            .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok())
}

fn preview_of(body: &str) -> Option<String> {
    for line in body.lines() {
        let t = line.trim();
        if t.is_empty() || t.starts_with('#') || t.starts_with("```") || is_brain_metadata(t) { continue; }
        let chars: Vec<char> = t.chars().collect();
        return Some(if chars.len() > 113 { chars[..112].iter().collect::<String>() + "…" } else { t.to_string() });
    }
    None
}

fn conflict_kind(path: &Path) -> &'static str {
    let name = path.file_name().map(|s| s.to_string_lossy().to_string()).unwrap_or_default();
    if name.contains("-conflict-") && name.to_lowercase().ends_with(".md") { "conflict" } else { "note" }
}

fn file_times(path: &Path) -> (i64, i64) {
    match fs::metadata(path) {
        Ok(meta) => {
            let created = meta.created().ok()
                .or_else(|| meta.modified().ok())
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or_else(now_ms);
            let modified = meta.modified().ok()
                .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
                .map(|d| d.as_millis() as i64)
                .unwrap_or_else(now_ms);
            (created, modified)
        }
        Err(_) => (now_ms(), now_ms()),
    }
}

/// 把小写化文本里的字节偏移映射回原文的字符边界偏移。
fn lower_byte_to_orig(orig: &str, lower_pos: usize) -> usize {
    let mut lower_acc = 0usize;
    for (i, ch) in orig.char_indices() {
        if lower_acc >= lower_pos { return i; }
        lower_acc += ch.to_lowercase().to_string().len();
    }
    orig.len()
}

pub struct NoteStore {
    pub root: PathBuf,
    pub projects_dir: PathBuf,
    pub conn: Mutex<Connection>,
    refs: Mutex<HashMap<String, Vec<String>>>,
    _lease: fs::File,
}

const SUMMARY_COLUMNS: &str = "id, path, title, project_id, kind, created_at, updated_at";

impl NoteStore {
    pub fn new(root: &Path) -> Result<Self, String> {
        fs::create_dir_all(root).map_err(|e| format!("无法创建工作区：{e}"))?;
        let lease = fs::OpenOptions::new().read(true).write(true).create(true).truncate(false)
            .open(root.join(".plate-runtime.lock")).map_err(|e| format!("无法打开工作区锁：{e}"))?;
        lease.try_lock().map_err(|e| format!("工作区正在被另一个 Plate 实例使用，或无法加锁：{e}"))?;
        let projects_dir = root.join("projects");
        fs::create_dir_all(&projects_dir).map_err(|e| format!("无法创建 projects 目录：{e}"))?;
        let conn = crate::db::open(root)?;
        let store = NoteStore {
            root: root.to_path_buf(),
            projects_dir,
            conn: Mutex::new(conn),
            refs: Mutex::new(HashMap::new()),
            _lease: lease,
        };
        store.ensure_project(DEFAULT_PROJECT, "默认")?;
        store.scan()?;
        crate::agent_runner::recover_interrupted(&store.conn.lock().unwrap())?;
        crate::harness::engine::recover_interrupted(&store.conn.lock().unwrap())?;
        // A conflicting draft can leave an approved write queued for user retry.
        let _ = crate::memory_consolidator::flush_note_writes(&store);
        crate::vitality_engine::recalculate(&store.conn.lock().unwrap(), now_ms()).map_err(|e| e.to_string())?;
        Ok(store)
    }

    pub fn ensure_project(&self, id: &str, name: &str) -> Result<(), String> {
        check_project(id)?;
        fs::create_dir_all(self.projects_dir.join(id)).map_err(|e| format!("无法创建项目目录：{e}"))?;
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO project (id, name, root_path, created_at) VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(id) DO NOTHING",
            params![id, name, self.root.to_string_lossy(), now_ms()],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    /// 全量重建索引：两遍扫描（先 upsert 全部 note 行，再按标题解析链接）。
    pub fn scan(&self) -> Result<(), String> {
        struct Found { path: PathBuf, id: String, project: String, disk: Disk, meta: Metadata }
        let mut found: Vec<Found> = Vec::new();
        for entry in fs::read_dir(&self.projects_dir).map_err(|e| e.to_string())? {
            let project_dir = entry.map_err(|e| e.to_string())?.path();
            if !project_dir.is_dir() { continue; }
            let project_id = project_dir.file_name().unwrap().to_string_lossy().to_string();
            if check_project(&project_id).is_err() { continue; }
            for file in fs::read_dir(&project_dir).map_err(|e| e.to_string())? {
                let path = file.map_err(|e| e.to_string())?.path();
                if !path.is_file() { continue; }
                if !path.extension().map_or(false, |e| e.eq_ignore_ascii_case("md")) { continue; }
                let disk = match snapshot(&path)? { Some(d) => d, None => continue };
                let stem = path.file_stem().unwrap().to_string_lossy().to_string().to_lowercase();
                if check_note_id(&stem).is_err() { continue; }
                let meta = extract_metadata(&disk.content, &stem);
                found.push(Found { path, id: stem, project: project_id.clone(), disk, meta });
            }
        }
        for f in &found {
            self.index_upsert(&f.path, &f.id, &f.project, &f.disk, &f.meta)?;
        }
        for f in &found {
            self.index_links(&f.id, &f.meta)?;
        }
        let seen: HashSet<String> = found.iter().map(|f| f.id.clone()).collect();
        let conn = self.conn.lock().unwrap();
        let ids: Vec<String> = {
            let mut stmt = conn.prepare("SELECT id FROM note").map_err(|e| e.to_string())?;
            let rows = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
            rows.filter_map(Result::ok).collect()
        };
        for id in ids {
            if !seen.contains(&id) {
                conn.execute("DELETE FROM note WHERE id = ?1", params![id]).map_err(|e| e.to_string())?;
            }
        }
        drop(conn);
        *self.refs.lock().unwrap() = found.iter()
            .map(|f| (f.id.clone(), f.meta.references.clone())).collect();
        Ok(())
    }

    fn index_upsert(&self, path: &Path, id: &str, project_id: &str, _disk: &Disk, meta: &Metadata) -> Result<(), String> {
        let (created_at, updated_at) = file_times(path);
        let kind = conflict_kind(path);
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO note (id, path, title, project_id, kind, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
             ON CONFLICT(id) DO UPDATE SET path=?2, title=?3, kind=?5, project_id=?4, updated_at=?7",
            params![id, path.to_string_lossy(), meta.title, project_id, kind, created_at, updated_at],
        ).map_err(|e| e.to_string())?;
        Ok(())
    }

    fn index_links(&self, id: &str, meta: &Metadata) -> Result<(), String> {
        let conn = self.conn.lock().unwrap();
        conn.execute("DELETE FROM note_tag WHERE note_id = ?1", params![id]).map_err(|e| e.to_string())?;
        for tag in &meta.tags {
            conn.execute("INSERT OR IGNORE INTO note_tag (note_id, tag) VALUES (?1, ?2)", params![id, tag])
                .map_err(|e| e.to_string())?;
        }
        conn.execute("DELETE FROM note_link WHERE source_note_id = ?1", params![id]).map_err(|e| e.to_string())?;
        for r#ref in &meta.references {
            let target: Option<String> = conn
                .query_row(
                    "SELECT id FROM note WHERE id = ?1 OR title = ?1 ORDER BY (id = ?1) DESC, id LIMIT 1",
                    params![r#ref], |r| r.get(0),
                )
                .optional().map_err(|e| e.to_string())?;
            if let Some(target) = target {
                conn.execute(
                    "INSERT OR IGNORE INTO note_link (source_note_id, target_note_id) VALUES (?1, ?2)",
                    params![id, target],
                ).map_err(|e| e.to_string())?;
            }
        }
        Ok(())
    }

    fn row_to_summary(row: &rusqlite::Row<'_>) -> rusqlite::Result<NoteSummary> {
        Ok(NoteSummary {
            id: row.get("id")?,
            path: row.get("path")?,
            title: row.get("title")?,
            project_id: row.get("project_id")?,
            kind: row.get("kind")?,
            created_at: row.get("created_at")?,
            updated_at: row.get("updated_at")?,
        })
    }

    fn query_summaries(conn: &Connection, where_clause: &str, args: &[&dyn rusqlite::ToSql]) -> Result<Vec<NoteSummary>, String> {
        let sql = format!("SELECT {SUMMARY_COLUMNS} FROM note {where_clause} ORDER BY updated_at DESC");
        let mut stmt = conn.prepare(&sql).map_err(|e| e.to_string())?;
        let rows = stmt.query_map(args, |r| Self::row_to_summary(r)).map_err(|e| e.to_string())?;
        Ok(rows.filter_map(Result::ok).collect())
    }

    fn get_row(&self, id: &str) -> Result<NoteSummary, String> {
        let conn = self.conn.lock().unwrap();
        conn.query_row(&format!("SELECT {SUMMARY_COLUMNS} FROM note WHERE id = ?1"), params![id], |r| Self::row_to_summary(r))
            .optional().map_err(|e| e.to_string())?
            .ok_or_else(|| "笔记不存在".to_string())
    }

    pub fn create(&self, title: &str, project_id: &str, template: &str) -> Result<Note, String> {
        if title.len() > 240 || title.contains(['\r', '\n', '\0']) {
            return Err("请输入 1–240 个字符的单行标题".into());
        }
        let body = match template {
            "blank" => "",
            "plan" => "## 目标\n\n## 步骤\n\n- [ ] \n\n## 截止日期\n",
            "review" => "## 结果\n\n## 做得好的地方\n\n## 下一步改进\n",
            "journal" => "## 今天发生了什么\n\n## 感想\n\n## 明天想做的事\n",
            _ => return Err("笔记模板无效".into()),
        };
        self.ensure_project(project_id, project_id)?;
        {
            let conn = self.conn.lock().unwrap();
            let archived: Option<i64> = conn.query_row(
                "SELECT 1 FROM project WHERE id = ?1 AND archived_at IS NOT NULL", params![project_id], |r| r.get(0))
                .optional().map_err(|e| e.to_string())?;
            if matches!(archived, Some(_)) { return Err("不能在已归档项目中新建笔记".into()); }
        }
        let dir = self.projects_dir.join(project_id);
        let id = uuid::Uuid::new_v4().to_string();
        let path = dir.join(format!("{id}.md"));
        let content = format!("<!-- plate-title:{} -->\n{}", urlencoding_min(title.trim()), body);
        write_new_file(&path, &content)?;
        self.scan()?;
        self.read(&id)
    }

    pub fn has_unsaved_draft(&self, note: &Note) -> Result<bool, String> {
        Ok(self.draft_row(&note.summary.id)?.is_some_and(|draft| draft.content != note.content))
    }

    pub fn create_memory_note(&self, id: &str, project: &str, title: &str, body: &str, marker: &str) -> Result<Note, String> {
        check_note_id(id)?;
        check_project(project)?;
        let path = self.projects_dir.join(project).join(format!("{id}.md"));
        match snapshot(&path)? {
            Some(disk) if disk.content.lines().any(|line| line == marker) => {}
            Some(_) => return Err("闪念固化目标文件已存在".into()),
            None => write_new_file(&path, &format!("<!-- plate-title:{} -->\n{body}", urlencoding_min(title.trim())))?,
        }
        self.scan()?;
        self.read(id)
    }

    pub fn read(&self, id: &str) -> Result<Note, String> {
        check_note_id(id)?;
        let row = self.get_row(id)?;
        let disk = snapshot(Path::new(&row.path))?.ok_or("笔记文件已在磁盘上移除")?;
        Ok(Note { summary: row, content: disk.content, revision: disk.revision })
    }

    pub fn update(&self, id: &str, content: &str, revision: Option<String>, draft_version: Option<String>) -> Result<SaveResult, String> {
        self.update_note(id, content, revision, draft_version, false)
    }

    pub fn update_strict(&self, id: &str, content: &str, revision: String) -> Result<SaveResult, String> {
        self.update_note(id, content, Some(revision), None, true)
    }

    fn update_note(&self, id: &str, content: &str, revision: Option<String>, draft_version: Option<String>, strict: bool) -> Result<SaveResult, String> {
        check_note_id(id)?;
        let row = self.get_row(id)?;
        let disk = snapshot(Path::new(&row.path))?;
        let expected = revision.ok_or("缺少保存基准版本")?;
        let draft = self.draft_row(id)?;
        let cleanup = draft.as_ref().filter(|d| {
            d.path == row.path && d.base_revision == expected && d.content == content
                && draft_version.map_or(true, |v| v == d.version)
        }).map(|d| d.version.clone());
        let on_conflict = || {
            if strict { Err("笔记磁盘版本已变化，草稿已保留。请核对后再试。".into()) }
            else { self.keep_both(&row, content) }
        };
        match &disk {
            Some(d) if d.revision == expected => {
                if d.content == content {
                    if let Some(v) = cleanup { let _ = self.draft_discard(id, &v); }
                    return Ok(SaveResult::Saved { note: self.read(id)? });
                }
                let temp = Path::new(&row.path).with_file_name(format!(".{}.notes-tmp", uuid::Uuid::new_v4()));
                write_new_file(&temp, content)?;
                let latest = snapshot(Path::new(&row.path))?;
                match latest {
                    Some(l) if l.revision == expected => {
                        fs::rename(&temp, &row.path).map_err(|e| format!("保存失败：{e}"))?;
                        self.scan()?;
                        if let Some(v) = cleanup { let _ = self.draft_discard(id, &v); }
                        Ok(SaveResult::Saved { note: self.read(id)? })
                    }
                    _ => {
                        let _ = fs::remove_file(&temp);
                        on_conflict()
                    }
                }
            }
            _ => on_conflict(),
        }
    }

    fn keep_both(&self, row: &NoteSummary, content: &str) -> Result<SaveResult, String> {
        let src = Path::new(&row.path);
        let dir = src.parent().unwrap();
        let stem = src.file_stem().unwrap().to_string_lossy().to_string();
        let stamp = chrono_stamp();
        let copy_path = dir.join(format!("{stem}-conflict-{stamp}.md"));
        write_new_file(&copy_path, content)?;
        self.scan()?;
        let copy_id = copy_path.file_stem().unwrap().to_string_lossy().to_string().to_lowercase();
        Ok(SaveResult::Conflict { current: self.read(&row.id).ok(), copy: self.read(&copy_id)? })
    }

    pub fn delete(&self, id: &str, revision: Option<String>) -> Result<String, String> {
        check_note_id(id)?;
        let row = self.get_row(id)?;
        let disk = snapshot(Path::new(&row.path))?;
        if let (Some(expected), Some(d)) = (&revision, &disk) {
            if d.revision != *expected { self.scan()?; return Ok("changed".into()); }
        }
        if disk.is_some() {
            fs::remove_file(&row.path).map_err(|e| format!("删除失败：{e}"))?;
        }
        {
            let conn = self.conn.lock().unwrap();
            conn.execute("DELETE FROM note_draft WHERE note_id = ?1 AND path = ?2", params![row.id, row.path])
                .map_err(|e| e.to_string())?;
        }
        self.scan()?;
        Ok("deleted".into())
    }

    pub fn list(&self, filters: NoteFilters) -> Result<Vec<NoteSummary>, String> {
        let conn = self.conn.lock().unwrap();
        let mut all = Self::query_summaries(&conn, "", &[])?;
        drop(conn);
        if let Some(p) = &filters.project_id { all.retain(|n| &n.project_id == p); }
        if let Some(k) = &filters.kind { all.retain(|n| &n.kind == k); }
        let tags = filters.tag.iter().chain(&filters.tags).collect::<HashSet<_>>();
        if !tags.is_empty() {
            let conn = self.conn.lock().unwrap();
            let mut kept = Vec::new();
            for n in all {
                let mut matches = true;
                for tag in &tags {
                    let hit: Option<i64> = conn.query_row(
                        "SELECT 1 FROM note_tag WHERE note_id = ?1 AND tag = ?2", params![n.id, tag],
                        |r| r.get(0)).optional().map_err(|e| e.to_string())?;
                    if hit.is_none() { matches = false; break; }
                }
                if matches { kept.push(n); }
            }
            all = kept;
        }
        if let Some(q) = &filters.query {
            let needle = q.to_lowercase();
            all.retain(|n| n.title.to_lowercase().contains(&needle));
        }
        if let Some(t) = &filters.links_to {
            let conn = self.conn.lock().unwrap();
            let mut kept = Vec::new();
            for n in all {
                let hit: Option<i64> = conn.query_row(
                    "SELECT 1 FROM note_link WHERE target_note_id = ?1 AND source_note_id = ?2", params![t, n.id],
                    |r| r.get(0)).optional().map_err(|e| e.to_string())?;
                if hit.is_some() { kept.push(n); }
            }
            all = kept;
        }
        if let Some(t) = &filters.linked_from {
            let conn = self.conn.lock().unwrap();
            let mut kept = Vec::new();
            for n in all {
                let hit: Option<i64> = conn.query_row(
                    "SELECT 1 FROM note_link WHERE source_note_id = ?1 AND target_note_id = ?2", params![t, n.id],
                    |r| r.get(0)).optional().map_err(|e| e.to_string())?;
                if hit.is_some() { kept.push(n); }
            }
            all = kept;
        }
        Ok(all)
    }

    pub fn projects(&self) -> Result<Vec<ProjectSummary>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT id, name, archived_at, color FROM project ORDER BY created_at").map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| Ok(ProjectSummary {
            id: r.get(0)?, name: r.get(1)?, archived_at: r.get(2)?, color: r.get(3)?,
        })).map_err(|e| e.to_string())?;
        Ok(rows.filter_map(Result::ok).collect())
    }

    pub fn create_project(&self, name: &str) -> Result<ProjectSummary, String> {
        let trimmed = name.trim();
        if trimmed.is_empty() { return Err("项目名称不能为空".into()); }
        let id = uuid::Uuid::new_v4().to_string().to_lowercase();
        self.ensure_project(&id, trimmed)?;
        Ok(ProjectSummary { id, name: trimmed.to_string(), archived_at: None, color: None })
    }

    pub fn tags(&self) -> Result<Vec<String>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT DISTINCT tag FROM note_tag ORDER BY tag").map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| r.get::<_, String>(0)).map_err(|e| e.to_string())?;
        Ok(rows.filter_map(Result::ok).collect())
    }

    pub fn search(&self, filters: NoteFilters) -> Result<Vec<SearchResult>, String> {
        let needle = filters.query.as_deref().unwrap_or_default().trim().to_lowercase();
        let notes = self.list(NoteFilters { query: None, ..filters })?;
        if needle.is_empty() {
            return Ok(notes.into_iter().map(|note| SearchResult { note, r#match: None }).collect());
        }
        let mut out = Vec::new();
        for n in notes {
            let disk = match snapshot(Path::new(&n.path))? { Some(d) => d, None => continue };
            let lower_title = n.title.to_lowercase();
            if let Some(pos) = lower_title.find(&needle) {
                let start = lower_byte_to_orig(&n.title, pos);
                let end = lower_byte_to_orig(&n.title, pos + needle.len());
                out.push(SearchResult {
                    note: n.clone(),
                    r#match: Some(SearchMatch {
                        field: "title".into(),
                        before: n.title[..start].to_string(),
                        r#match: n.title[start..end].to_string(),
                        after: String::new(),
                    }),
                });
                continue;
            }
            let lower_body = disk.content.to_lowercase();
            if let Some(pos) = lower_body.find(&needle) {
                let start = lower_byte_to_orig(&disk.content, pos);
                let end = lower_byte_to_orig(&disk.content, pos + needle.len());
                let ctx_from = disk.content[..start].char_indices().rev().take(40).last().map(|(i, _)| i).unwrap_or(0);
                let after_text: String = disk.content[end..].chars().take(40).collect();
                out.push(SearchResult {
                    note: n.clone(),
                    r#match: Some(SearchMatch {
                        field: "body".into(),
                        before: disk.content[ctx_from..start].to_string(),
                        r#match: disk.content[start..end].to_string(),
                        after: after_text,
                    }),
                });
            }
        }
        Ok(out)
    }

    pub fn links(&self) -> Result<LinkIndex, String> {
        let conn = self.conn.lock().unwrap();
        let summaries = Self::query_summaries(&conn, "", &[])?;
        drop(conn);
        let mut nodes = Vec::new();
        let mut downstream = HashSet::new();
        for s in &summaries {
            let disk = snapshot(Path::new(&s.path))?;
            let meta = disk.map(|d| extract_metadata(&d.content, &s.id));
            if let Some(meta) = &meta {
                for target in &meta.downstream_refs {
                    downstream.insert((s.id.clone(), target.clone()));
                }
            }
            nodes.push(RelationshipNote {
                summary: s.clone(),
                preview: meta.as_ref().and_then(|m| preview_of(&m.body)),
                tags: meta.as_ref().map(|m| {
                    let mut t: Vec<String> = m.tags.iter().cloned().collect();
                    t.sort();
                    t
                }),
            });
        }
        let mut edges = Vec::new();
        {
            let conn = self.conn.lock().unwrap();
            let mut stmt = conn.prepare("SELECT source_note_id, target_note_id FROM note_link").map_err(|e| e.to_string())?;
            let rows = stmt.query_map([], |r| Ok(NoteEdge { source: r.get(0)?, target: r.get(1)? }))
                .map_err(|e| e.to_string())?;
            edges.extend(rows.filter_map(Result::ok));
        }
        // The graph's existing edge direction represents material flow from target to source.
        for edge in &mut edges {
            if downstream.contains(&(edge.source.clone(), edge.target.clone())) {
                std::mem::swap(&mut edge.source, &mut edge.target);
            }
        }
        let mut seen_edges = HashSet::new();
        edges.retain(|edge| seen_edges.insert((edge.source.clone(), edge.target.clone())));
        let refs = self.refs.lock().unwrap().clone();
        let mut bindings = Vec::new();
        for (source, list) in &refs {
            for r#ref in list {
                let target = summaries.iter().find(|s| &s.id == r#ref)
                    .or_else(|| summaries.iter().filter(|s| &s.title == r#ref).min_by_key(|s| &s.id))
                    .map(|s| s.id.clone());
                bindings.push(LinkBinding { source: source.clone(), r#ref: r#ref.clone(), target });
            }
        }
        Ok(LinkIndex { nodes, edges, bindings })
    }

    pub fn draft_list(&self) -> Result<Vec<DraftSummary>, String> {
        let stored = self.draft_rows()?;
        let mut out = Vec::new();
        for d in stored {
            let disk = snapshot(Path::new(&d.path))?;
            let source = match &disk {
                None => "missing",
                Some(disk) if disk.content == d.content => "same-content",
                Some(disk) if disk.revision == d.base_revision => "unchanged",
                _ => "changed",
            };
            out.push(DraftSummary {
                id: d.id, title: d.title, path: d.path, revision: d.base_revision,
                version: d.version, written_at: d.written_at, source: source.into(),
            });
        }
        Ok(out)
    }

    fn draft_rows(&self) -> Result<Vec<StoredDraft>, String> {
        let conn = self.conn.lock().unwrap();
        let mut stmt = conn.prepare(
            "SELECT note_id, path, title, project_id, kind, created_at, base_revision, content, written_at, version FROM note_draft")
            .map_err(|e| e.to_string())?;
        let rows = stmt.query_map([], |r| Ok(StoredDraft {
            id: r.get(0)?, path: r.get(1)?, title: r.get(2)?, project_id: r.get(3)?,
            kind: r.get(4)?, created_at: r.get(5)?, base_revision: r.get(6)?,
            content: r.get(7)?, written_at: r.get(8)?, version: r.get(9)?,
        })).map_err(|e| e.to_string())?;
        Ok(rows.filter_map(Result::ok).collect())
    }

    fn draft_row(&self, id: &str) -> Result<Option<StoredDraft>, String> {
        Ok(self.draft_rows()?.into_iter().find(|d| d.id == id))
    }

    pub fn draft_write(&self, id: &str, content: &str, revision: &str, version: Option<String>) -> Result<bool, String> {
        check_note_id(id)?;
        let row = self.get_row(id)?;
        if let Some(prior) = self.draft_row(id)? {
            if prior.path != row.path || prior.base_revision != revision {
                return Err("请先处理现有恢复草稿".into());
            }
        }
        let version = version.unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
        let conn = self.conn.lock().unwrap();
        conn.execute(
            "INSERT INTO note_draft (note_id, path, title, project_id, kind, created_at, base_revision, content, written_at, version)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
             ON CONFLICT(note_id) DO UPDATE SET content=?8, written_at=?9, version=?10, base_revision=?7",
            params![row.id, row.path, row.title, row.project_id, row.kind, row.created_at, revision, content, now_ms(), version],
        ).map_err(|e| e.to_string())?;
        Ok(true)
    }

    pub fn draft_discard(&self, id: &str, version: &str) -> Result<bool, String> {
        let conn = self.conn.lock().unwrap();
        let n = conn.execute("DELETE FROM note_draft WHERE note_id = ?1 AND version = ?2", params![id, version])
            .map_err(|e| e.to_string())?;
        Ok(n > 0)
    }

    pub fn draft_restore(&self, id: &str) -> Result<DraftRecovery, String> {
        let summaries = self.draft_list()?;
        let summary = match summaries.into_iter().find(|d| d.id == id) {
            Some(s) => s,
            None => return Ok(DraftRecovery::Missing),
        };
        let stored = self.draft_row(id)?.unwrap();
        let disk = snapshot(Path::new(&stored.path))?;
        match &disk {
            Some(d) if d.revision == stored.base_revision => Ok(DraftRecovery::Restored {
                note: self.read(id)?, content: stored.content.clone(), version: stored.version.clone(),
            }),
            _ => Ok(DraftRecovery::Preview {
                draft: summary, content: stored.content.clone(),
                disk_revision: disk.map(|d| d.revision),
            }),
        }
    }

    pub fn draft_save_copy(&self, id: &str, version: &str) -> Result<Note, String> {
        let stored = self.draft_row(id)?.ok_or("恢复草稿不存在")?;
        if stored.version != version { return Err("草稿版本已变化，请刷新后重试".into()); }
        let src = Path::new(&stored.path);
        let dir = src.parent().unwrap();
        let stem = src.file_stem().unwrap().to_string_lossy().to_string();
        let copy_path = dir.join(format!("{stem}-conflict-{}.md", chrono_stamp()));
        write_new_file(&copy_path, &stored.content)?;
        self.scan()?;
        let copy_id = copy_path.file_stem().unwrap().to_string_lossy().to_string().to_lowercase();
        self.read(&copy_id)
    }

    pub fn connect_nodes(&self, source_id: &str, target_id: &str, downstream: bool) -> Result<Note, String> {
        check_note_id(source_id)?;
        check_note_id(target_id)?;
        let source = self.read(source_id)?;
        let target = self.read(target_id)?;
        if self.draft_row(source_id)?.is_some_and(|draft| draft.content != source.content) {
            return Err("请先处理来源笔记的草稿".into())
        }
        let display = target.summary.title.replace(['[', ']', '|', '\n', '\r'], " ");
        let suffix = if downstream { " <!-- plate-downstream -->" } else { "" };
        let link_line = format!("- [[{target_id}|{display}]]{suffix}");
        let existing = extract_metadata(&source.content, source_id);
        if existing.references.iter().any(|reference| reference == target_id) &&
            existing.downstream_refs.contains(target_id) == downstream {
            return Ok(source);
        }
        if source.content.contains(&link_line) { return Ok(source); }
        let mut next = source.content.clone();
        if !next.ends_with('\n') { next.push('\n'); }
        next.push('\n');
        next.push_str(&link_line);
        next.push('\n');
        let revision = source.revision.clone();
        match self.update_strict(source_id, &next, revision)? {
            SaveResult::Saved { note } => Ok(note),
            SaveResult::Conflict { .. } => Err("连接节点时检测到外部修改，未建立链接".into()),
        }
    }
}

struct StoredDraft {
    id: String,
    path: String,
    title: String,
    project_id: String,
    kind: String,
    created_at: i64,
    base_revision: String,
    content: String,
    written_at: i64,
    version: String,
}

fn write_new_file(path: &Path, content: &str) -> Result<(), String> {
    use std::io::Write;
    if path.exists() { return Err("目标文件已存在".into()); }
    let mut file = fs::File::create_new(path).map_err(|e| format!("写入失败：{e}"))?;
    file.write_all(content.as_bytes()).and_then(|_| file.sync_all()).map_err(|e| {
        let _ = fs::remove_file(path);
        format!("写入失败：{e}")
    })
}

fn chrono_stamp() -> String {
    let secs = now_ms() / 1000;
    let days = secs / 86400;
    let rem = secs % 86400;
    let (h, m, s) = (rem / 3600, (rem % 3600) / 60, rem % 60);
    let z = days + 719468;
    let era = z / 146097;
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let mth = if mp < 10 { mp + 3 } else { mp - 9 };
    let year = if mth <= 2 { y + 1 } else { y };
    format!("{year:04}{mth:02}{d:02}T{h:02}{m:02}{s:02}Z")
}

fn urlencoding_min(s: &str) -> String {
    let mut out = String::new();
    for b in s.as_bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')' => out.push(*b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}
