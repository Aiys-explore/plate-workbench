use crate::{memory_consolidator, notes::now_ms, with_store, AppState};
use rusqlite::{params, Connection, OptionalExtension, Row, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashSet;
use std::fs::{self, File, Metadata};
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;
use tauri::{AppHandle, Emitter, State};

const SESSION_FIELDS: &str =
    "id, source_tool, source_path, workspace_cwd, title, summary, message_count, updated_at";
const MAX_LINE_BYTES: u64 = 2 * 1024 * 1024;
const MAX_TEXT_CHARS: usize = 32_000;
const PAGE_SIZE: i64 = 100;
const SAMPLE_BYTES: u64 = 4096;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExternalAgentSession {
    id: String,
    source_tool: String,
    source_path: String,
    workspace_cwd: String,
    title: String,
    summary: String,
    message_count: i64,
    updated_at: i64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ExternalAgentMessage {
    id: String,
    session_id: String,
    seq: i64,
    role: String,
    content: String,
    tool_name: Option<String>,
    touched_files: Vec<String>,
    created_at: i64,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct HarvestScanResult {
    scanned_files: usize,
    updated_sessions: usize,
    new_messages: usize,
    skipped_paths: usize,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ScanInput {
    include_defaults: bool,
    custom_directory: Option<PathBuf>,
}

struct Message {
    role: &'static str,
    content: String,
    tool: Option<String>,
    files: Vec<String>,
    time: Option<i64>,
}

type ScanRoot = (&'static str, PathBuf);
fn default_roots() -> Vec<ScanRoot> {
    let Some(home) = dirs::home_dir() else {
        return Vec::new();
    };
    let codex = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .unwrap_or_else(|| home.join(".codex"));
    let claude = std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .filter(|path| path.is_absolute())
        .unwrap_or_else(|| home.join(".claude"));
    vec![
        ("claude_code", claude.join("projects")),
        ("codex_cli", codex.join("sessions")),
    ]
}

fn reparse(metadata: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        metadata.file_type().is_symlink()
    }
}

fn compact(value: &str, max: usize) -> String {
    value.trim().chars().take(max).collect()
}

fn as_text(content: &Value) -> String {
    if let Some(text) = content.as_str() {
        return compact(text, MAX_TEXT_CHARS);
    }
    let Some(blocks) = content.as_array() else {
        return String::new();
    };
    let parts = blocks.iter().filter_map(|block| {
        if matches!(
            block["type"].as_str(),
            Some("thinking" | "redacted_thinking")
        ) {
            return None;
        }
        block.as_str().or_else(|| block["text"].as_str())
    });
    let mut output = String::new();
    let mut remaining = MAX_TEXT_CHARS;
    for part in parts {
        if remaining == 0 {
            break;
        }
        let part = compact(part, remaining);
        remaining = remaining.saturating_sub(part.chars().count() + 1);
        if !output.is_empty() {
            output.push('\n');
        }
        output.push_str(&part);
    }
    output
}

fn paths(input: &Value) -> Vec<String> {
    ["file_path", "path", "notebook_path"]
        .into_iter()
        .filter_map(|key| input[key].as_str())
        .map(|path| compact(path, 1024))
        .filter(|path| !path.is_empty())
        .collect()
}

fn parse(record: &Value) -> Vec<Message> {
    let value = record
        .get("message")
        .or_else(|| record.get("payload"))
        .unwrap_or(record);
    let time_value = record.get("timestamp").or_else(|| value.get("timestamp"));
    let time = time_value.and_then(|time| {
        time.as_i64()
            .filter(|value| (1..=8_640_000_000_000_000).contains(value))
            .map(|value| {
                if value < 10_000_000_000 {
                    value * 1000
                } else {
                    value
                }
            })
            .or_else(|| {
                chrono::DateTime::parse_from_rfc3339(time.as_str()?)
                    .ok()
                    .map(|date| date.timestamp_millis())
            })
    });
    let mut result = Vec::new();
    let mut push = |role, content: String, tool: Option<&str>, files| {
        if !content.is_empty() || tool.is_some() {
            result.push(Message {
                role,
                content,
                tool: tool.map(|name| compact(name, 100)),
                files,
                time,
            });
        }
    };
    match value["type"].as_str() {
        Some("function_call" | "custom_tool_call") => {
            let arguments = value["arguments"]
                .as_str()
                .or(value["input"].as_str())
                .unwrap_or_default();
            let input: Value = serde_json::from_str(arguments).unwrap_or_default();
            push(
                "tool",
                compact(arguments, MAX_TEXT_CHARS),
                value["name"].as_str(),
                paths(&input),
            );
            return result;
        }
        Some("function_call_output" | "custom_tool_call_output") => {
            push(
                "tool",
                as_text(&value["output"]),
                value["name"].as_str(),
                Vec::new(),
            );
            return result;
        }
        _ => (),
    }
    if let Some(role @ ("user" | "assistant" | "tool")) = value["role"].as_str() {
        let role = match role {
            "user" => "user",
            "assistant" => "assistant",
            _ => "tool",
        };
        push(
            role,
            as_text(&value["content"]),
            value["name"].as_str(),
            paths(value),
        );
        if let Some(content) = value["content"].as_array() {
            for block in content {
                match block["type"].as_str() {
                    Some("tool_use") => push(
                        "tool",
                        String::new(),
                        block["name"].as_str(),
                        paths(&block["input"]),
                    ),
                    Some("tool_result") => {
                        push("tool", as_text(&block["content"]), None, Vec::new())
                    }
                    _ => (),
                }
            }
        }
    }
    result
}

fn index_text(text: &str) -> String {
    let mut indexed = String::new();
    for ch in text.chars() {
        if matches!(ch, '\u{3400}'..='\u{9fff}' | '\u{3040}'..='\u{30ff}' | '\u{ac00}'..='\u{d7af}')
        {
            indexed.push(' ');
            indexed.push(ch);
            indexed.push(' ');
        } else {
            indexed.push(ch);
        }
    }
    indexed
}

fn sample_prefix(file: &mut File, offset: u64) -> std::io::Result<String> {
    let len = offset.min(SAMPLE_BYTES) as usize;
    let mut sample = vec![0; len];
    let mut sha = Sha256::new();
    file.seek(SeekFrom::Start(0))?;
    file.read_exact(&mut sample)?;
    sha.update(&sample);
    file.seek(SeekFrom::Start(offset - len as u64))?;
    file.read_exact(&mut sample)?;
    sha.update(&sample);
    Ok(format!("{:x}", sha.finalize()))
}

fn db_error(error: rusqlite::Error) -> String {
    format!("会话索引操作失败：{error}")
}
fn file_error(error: std::io::Error) -> String {
    format!("读取会话文件失败：{error}")
}

fn scan_file(
    conn: &mut Connection,
    path: &Path,
    source: &str,
    mut file: File,
) -> Result<Option<usize>, String> {
    let metadata = file.metadata().map_err(file_error)?;
    let size = metadata.len();
    let mtime = metadata
        .modified()
        .ok()
        .and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .and_then(|duration| i64::try_from(duration.as_nanos()).ok())
        .unwrap_or(0);
    let path = path.to_string_lossy();
    let tx = conn
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(db_error)?;
    let previous: Option<(String, u64, i64, String, i64, String, u64)> = tx.query_row(
        "SELECT id, byte_offset, file_mtime, prefix_signature, message_count, workspace_cwd, file_bytes
         FROM external_agent_sessions WHERE source_path=?1", [path.as_ref()],
        |row| Ok((row.get(0)?,row.get(1)?,row.get(2)?,row.get(3)?,row.get(4)?,row.get(5)?,row.get(6)?))
    ).optional().map_err(db_error)?;
    let had_record = previous.is_some();
    let (id, mut offset, previous_mtime, mut signature, mut count, mut cwd, previous_size) =
        previous.unwrap_or_else(|| {
            (
                uuid::Uuid::new_v4().to_string(),
                0,
                0,
                String::new(),
                0,
                String::new(),
                0,
            )
        });
    let reset = offset > size
        || (offset > 0 && sample_prefix(&mut file, offset).map_err(file_error)? != signature)
        || (offset == size && mtime != previous_mtime && had_record);
    if !reset && had_record && previous_size == size && previous_mtime == mtime {
        return Ok(None);
    }

    if reset {
        tx.execute(
            "DELETE FROM external_agent_messages WHERE session_id=?1",
            [&id],
        )
        .map_err(db_error)?;
        tx.execute(
            "DELETE FROM external_agent_messages_fts WHERE session_id=?1",
            [&id],
        )
        .map_err(db_error)?;
        offset = 0;
        count = 0;
        cwd.clear();
        signature.clear();
    }
    tx.execute(
        "INSERT OR IGNORE INTO external_agent_sessions(id, source_tool, source_path, title, updated_at)
         VALUES(?1,?2,?3,'',?4)", params![id, source, path, now_ms()],
    ).map_err(db_error)?;
    file.seek(SeekFrom::Start(offset)).map_err(file_error)?;
    let mut input = BufReader::new((&mut file).take(size - offset));
    let mut line = Vec::new();
    let mut imported = 0usize;
    let timestamp = if mtime > 0 {
        mtime / 1_000_000
    } else {
        now_ms()
    };
    loop {
        line.clear();
        let read = (&mut input)
            .take(MAX_LINE_BYTES + 1)
            .read_until(b'\n', &mut line)
            .map_err(file_error)?;
        if read == 0 {
            break;
        }
        if read as u64 > MAX_LINE_BYTES {
            let remainder = if line.last() == Some(&b'\n') {
                0
            } else {
                input.skip_until(b'\n').map_err(file_error)?
            };
            offset += (read + remainder) as u64;
            continue;
        }
        let data = line.strip_prefix(b"\xef\xbb\xbf").unwrap_or(&line);
        let parsed = serde_json::from_slice::<Value>(data);
        if line.last() != Some(&b'\n') && parsed.is_err() {
            break;
        }
        offset += read as u64;
        let Ok(record) = parsed else {
            continue;
        };
        if cwd.is_empty() {
            cwd = record["cwd"]
                .as_str()
                .or_else(|| record["payload"]["cwd"].as_str())
                .map(|text| compact(text, 1024))
                .unwrap_or_default();
        }
        for message in parse(&record) {
            let message_id = format!("{id}:{count}");
            let files = serde_json::to_string(&message.files).map_err(|error| error.to_string())?;
            tx.execute(
                "INSERT INTO external_agent_messages(id,session_id,seq,role,content,tool_name,touched_files_json,created_at)
                 VALUES(?1,?2,?3,?4,?5,?6,?7,?8)",
                params![message_id,id,count,message.role,message.content,message.tool,files,message.time.unwrap_or(timestamp)],
            ).map_err(db_error)?;
            tx.execute(
                "INSERT INTO external_agent_messages_fts(session_id,role,content) VALUES(?1,?2,?3)",
                params![id, message.role, index_text(&message.content)],
            )
            .map_err(db_error)?;
            count += 1;
            imported += 1;
        }
    }
    if offset > 0 {
        signature = sample_prefix(&mut file, offset).map_err(file_error)?;
    }
    let first = tx.query_row(
        "SELECT content FROM external_agent_messages WHERE session_id=?1 AND role='user' ORDER BY seq LIMIT 1",
        [&id], |row| row.get::<_, String>(0)
    ).optional().map_err(db_error)?.unwrap_or_default();
    let last = tx.query_row(
        "SELECT content FROM external_agent_messages WHERE session_id=?1 AND role='assistant' ORDER BY seq DESC LIMIT 1",
        [&id], |row| row.get::<_, String>(0)
    ).optional().map_err(db_error)?.unwrap_or_default();
    let title = if first.is_empty() {
        compact(
            Path::new(path.as_ref())
                .file_stem()
                .unwrap_or_default()
                .to_string_lossy()
                .as_ref(),
            96,
        )
    } else {
        compact(first.lines().next().unwrap_or(""), 96)
    };
    let summary = format!(
        "目标：{}\n最近回复：{}",
        compact(&first, 240),
        compact(&last, 360)
    );
    tx.execute(
        "UPDATE external_agent_sessions SET workspace_cwd=?2, title=?3, summary=?4, message_count=?5,
         file_mtime=?6, byte_offset=?7, updated_at=?8, prefix_signature=?9, file_bytes=?10 WHERE id=?1",
        params![id,cwd,title,summary,count,mtime,offset,timestamp,signature,size],
    ).map_err(db_error)?;
    tx.commit().map_err(db_error)?;
    Ok((imported > 0 || reset).then_some(imported))
}

fn scan(conn: &mut Connection, roots: Vec<ScanRoot>) -> Result<HarvestScanResult, String> {
    let mut result = HarvestScanResult::default();
    let mut visited = HashSet::new();
    for (source, root) in roots {
        let root = match root.canonicalize() {
            Ok(path) => path,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && source != "custom" => {
                continue
            }
            Err(error) => return Err(file_error(error)),
        };
        if !root.is_dir() {
            return Err("扫描路径必须是目录".into());
        }
        let mut directories = vec![root.clone()];
        while let Some(directory) = directories.pop() {
            let Ok(entries) = fs::read_dir(directory) else {
                result.skipped_paths += 1;
                continue;
            };
            for entry in entries {
                let Ok(entry) = entry else {
                    result.skipped_paths += 1;
                    continue;
                };
                let path = entry.path();
                let Ok(metadata) = path.symlink_metadata() else {
                    result.skipped_paths += 1;
                    continue;
                };
                if reparse(&metadata) {
                    result.skipped_paths += 1;
                    continue;
                }
                if metadata.is_dir() {
                    directories.push(path);
                } else if metadata.is_file()
                    && path
                        .extension()
                        .is_some_and(|ext| ext.eq_ignore_ascii_case("jsonl"))
                {
                    let Ok(resolved) = path.canonicalize() else {
                        result.skipped_paths += 1;
                        continue;
                    };
                    if !resolved.starts_with(&root) || !visited.insert(resolved.clone()) {
                        continue;
                    }
                    let Ok(file) = File::open(&resolved) else {
                        result.skipped_paths += 1;
                        continue;
                    };
                    result.scanned_files += 1;
                    if let Some(added) = scan_file(conn, &resolved, source, file)? {
                        result.updated_sessions += 1;
                        result.new_messages += added;
                    }
                }
            }
        }
    }
    Ok(result)
}

fn session(row: &Row<'_>) -> rusqlite::Result<ExternalAgentSession> {
    Ok(ExternalAgentSession {
        id: row.get(0)?,
        source_tool: row.get(1)?,
        source_path: row.get(2)?,
        workspace_cwd: row.get(3)?,
        title: row.get(4)?,
        summary: row.get(5)?,
        message_count: row.get(6)?,
        updated_at: row.get(7)?,
    })
}

fn find_sessions(
    conn: &Connection,
    query: Option<&str>,
    before: u32,
) -> Result<Vec<ExternalAgentSession>, String> {
    let filter = compact(query.unwrap_or(""), 240);
    let query =
        (!filter.is_empty()).then(|| format!("\"{}\"", index_text(&filter).replace('"', "\"\"")));
    let mut stmt = conn.prepare(&format!(
        "SELECT {SESSION_FIELDS} FROM external_agent_sessions WHERE message_count>0 AND
         (?1 IS NULL OR id IN (SELECT session_id FROM external_agent_messages_fts WHERE external_agent_messages_fts MATCH ?1))
         ORDER BY updated_at DESC, id LIMIT ?2 OFFSET ?3"
    )).map_err(db_error)?;
    let rows = stmt
        .query_map(params![query, PAGE_SIZE, before], session)
        .map_err(db_error)?;
    rows.collect::<rusqlite::Result<_>>().map_err(db_error)
}

pub fn summary(conn: &Connection, id: &str) -> Result<String, String> {
    conn.query_row(
        "SELECT summary FROM external_agent_sessions WHERE id=?1 AND message_count>0",
        [id],
        |row| row.get(0),
    )
    .optional()
    .map_err(db_error)?
    .ok_or_else(|| "找不到本机 Agent 会话".into())
}

#[tauri::command]
pub(crate) async fn agent_logs_scan(
    state: State<'_, AppState>,
    input: ScanInput,
) -> Result<HarvestScanResult, String> {
    let root = with_store(&state, |store| Ok(store.root.clone()))?;
    let mut roots = if input.include_defaults {
        default_roots()
    } else {
        Vec::new()
    };
    if let Some(directory) = input.custom_directory {
        if !directory.is_absolute() {
            return Err("自定义扫描目录必须是绝对路径".into());
        }
        roots.push(("custom", directory));
    }
    if roots.is_empty() {
        return Err("请选择本机 Agent 目录或填写自定义目录".into());
    }
    tauri::async_runtime::spawn_blocking(move || scan(&mut crate::db::open(&root)?, roots))
        .await
        .map_err(|_| "本机会话扫描中断".to_string())?
}

#[tauri::command]
pub(crate) fn agent_logs_list(
    state: State<'_, AppState>,
    offset: u32,
) -> Result<Vec<ExternalAgentSession>, String> {
    with_store(&state, |store| {
        find_sessions(&store.conn.lock().unwrap(), None, offset)
    })
}

#[tauri::command]
pub(crate) fn agent_logs_search(
    state: State<'_, AppState>,
    query: String,
    offset: u32,
) -> Result<Vec<ExternalAgentSession>, String> {
    with_store(&state, |store| {
        find_sessions(&store.conn.lock().unwrap(), Some(&query), offset)
    })
}

#[tauri::command]
pub(crate) fn agent_logs_get_messages(
    state: State<'_, AppState>,
    session_id: String,
    offset: u32,
) -> Result<Vec<ExternalAgentMessage>, String> {
    with_store(&state, |store| {
        let conn = store.conn.lock().unwrap();
        let mut stmt = conn
            .prepare(
                "SELECT id,session_id,seq,role,content,tool_name,touched_files_json,created_at
             FROM external_agent_messages WHERE session_id=?1 AND seq>=?2 ORDER BY seq LIMIT ?3",
            )
            .map_err(db_error)?;
        let rows = stmt
            .query_map(params![session_id, offset, PAGE_SIZE], |row| {
                let files: String = row.get(6)?;
                Ok(ExternalAgentMessage {
                    id: row.get(0)?,
                    session_id: row.get(1)?,
                    seq: row.get(2)?,
                    role: row.get(3)?,
                    content: row.get(4)?,
                    tool_name: row.get(5)?,
                    touched_files: serde_json::from_str(&files).unwrap_or_default(),
                    created_at: row.get(7)?,
                })
            })
            .map_err(db_error)?;
        rows.collect::<rusqlite::Result<_>>().map_err(db_error)
    })
}

#[tauri::command]
pub(crate) fn agent_logs_send_to_hippocampus(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    project_id: String,
) -> Result<String, String> {
    let event = with_store(&state, |store| {
        let conn = store.conn.lock().unwrap();
        let text = summary(&conn, &session_id)?;
        memory_consolidator::capture(&conn, &project_id, &text, "agent_trace")
    })?;
    let _ = app.emit("brain://changed", ());
    Ok(event)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::io::Write;

    #[test]
    fn parses_claude_code_user_assistant_and_file_tools() {
        let user = parse(&json!({"type":"user","message":{"role":"user","content":"Fix fixture"}}));
        assert_eq!(user[0].content, "Fix fixture");
        let output = parse(
            &json!({"type":"assistant","message":{"role":"assistant","content":[
                {"type":"thinking","text":"private reasoning"},
                {"type":"text","text":"Fixture complete"},
                {"type":"tool_use","name":"Read","input":{"file_path":"fixture.md"}}
            ]}}),
        );
        assert_eq!(output.len(), 2);
        assert_eq!(output[0].content, "Fixture complete");
        assert_eq!(output[1].tool.as_deref(), Some("Read"));
        assert_eq!(output[1].files, ["fixture.md"]);
    }

    #[test]
    fn parses_codex_response_items_with_timestamps_and_ignores_duplicate_event_entries() {
        let output = parse(
            &json!({"timestamp":"2026-11-22T01:02:03.000Z","type":"response_item",
            "payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Accepted"}]}}),
        );
        assert_eq!(output[0].content, "Accepted");
        assert_eq!(output[0].time, Some(1795309323000));
        assert!(parse(
            &json!({"type":"event_msg","payload":{"type":"agent_message","message":"Accepted"}})
        )
        .is_empty());
    }

    #[test]
    fn incrementally_indexes_appends_and_replaces_rotated_content() -> Result<(), String> {
        let mut conn = Connection::open_in_memory().map_err(db_error)?;
        crate::db::migrate_s10(&conn).map_err(db_error)?;
        let path = std::env::temp_dir().join(format!("plate-log-{}.jsonl", uuid::Uuid::new_v4()));
        let result = (|| {
            let first = "{\"role\":\"user\",\"content\":\"alpha 测试甲\"}\n";
            let partial = "{\"role\":\"assistant\",\"content\":\"beta";
            fs::write(&path, format!("{first}{partial}")).map_err(file_error)?;
            let update = |conn: &mut Connection| {
                scan_file(
                    conn,
                    &path,
                    "custom",
                    File::open(&path).map_err(file_error)?,
                )
            };
            assert_eq!(update(&mut conn)?, Some(1));
            assert_eq!(update(&mut conn)?, None);
            assert_eq!(find_sessions(&conn, Some("试甲"), 0)?.len(), 1);
            let id = find_sessions(&conn, None, 0)?.remove(0).id;
            fs::OpenOptions::new()
                .append(true)
                .open(&path)
                .map_err(file_error)?
                .write_all(b" outcome\"}\n")
                .map_err(file_error)?;
            assert_eq!(update(&mut conn)?, Some(1));
            assert_eq!(find_sessions(&conn, Some("beta"), 0)?[0].id, id);
            assert!(summary(&conn, &id)?.contains("beta outcome"));
            fs::write(&path, "{\"role\":\"user\",\"content\":\"gamma\"}\n").map_err(file_error)?;
            assert_eq!(update(&mut conn)?, Some(1));
            assert!(find_sessions(&conn, Some("alpha"), 0)?.is_empty());
            assert_eq!(find_sessions(&conn, Some("gamma"), 0)?[0].id, id);
            Ok(())
        })();
        let _ = fs::remove_file(path);
        result
    }
}
