use super::policy::PermissionManifest;
use crate::notes::{now_ms, NoteStore};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::path::Path;

const MAX_BYTES: usize = 64 * 1024;
const ABSENT: &str = "absent";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StagedDiff {
    pub id: String,
    pub run_id: String,
    pub target_kind: String,
    pub target_ref: String,
    pub base_sha256: String,
    pub proposed_content: String,
    pub unified_diff: String,
    pub rationale: String,
    pub status: String,
    pub execution_mode: String,
    pub created_at: i64,
    #[serde(skip)]
    previous_excerpt: String,
}

const SELECT: &str = "SELECT id,run_id,target_kind,target_ref,base_sha256,proposed_content,
    unified_diff,rationale,status,created_at,previous_excerpt,execution_mode FROM staged_diffs";

fn row_to_diff(row: &Row<'_>) -> rusqlite::Result<StagedDiff> {
    Ok(StagedDiff {
        id: row.get(0)?,
        run_id: row.get(1)?,
        target_kind: row.get(2)?,
        target_ref: row.get(3)?,
        base_sha256: row.get(4)?,
        proposed_content: row.get(5)?,
        unified_diff: row.get(6)?,
        rationale: row.get(7)?,
        status: row.get(8)?,
        created_at: row.get(9)?,
        previous_excerpt: row.get(10)?,
        execution_mode: row.get(11)?,
    })
}

fn checksum(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

fn bounded_read(resolved: &Path) -> Result<Option<String>, String> {
    let file = match File::open(resolved) {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    #[cfg(windows)]
    verify_handle(&file, resolved)?;
    let mut content = String::new();
    file.take((MAX_BYTES + 1) as u64)
        .read_to_string(&mut content)
        .map_err(|_| "只支持读取 UTF-8 文本文件".to_string())?;
    if content.len() > MAX_BYTES {
        return Err("文件超出 64 KiB 审阅上限".into());
    }
    Ok(Some(content))
}

#[cfg(windows)]
fn verify_handle(file: &File, path: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStringExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::GetFinalPathNameByHandleW;
    let mut name = vec![0u16; 32768];
    let length = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle(),
            name.as_mut_ptr(),
            name.len() as u32,
            0,
        )
    } as usize;
    if length == 0
        || length >= name.len()
        || Path::new(&std::ffi::OsString::from_wide(&name[..length])) != path
    {
        return Err("实际打开的文件路径发生变化".into());
    }
    Ok(())
}

pub fn read_workspace_file(
    policy: &PermissionManifest,
    workspace: &Path,
    path: &Path,
) -> Result<String, String> {
    let path = policy.authorized_path(path, workspace)?;
    bounded_read(&path)?.ok_or_else(|| "文件不存在".into())
}

pub fn propose_workspace_file(
    store: &NoteStore,
    policy: &PermissionManifest,
    run_id: &str,
    path: &Path,
    content: &str,
    rationale: &str,
) -> Result<String, String> {
    let resolved = policy.authorized_path(path, &store.root)?;
    let base = bounded_read(&resolved)?;
    propose(
        &store.conn.lock().unwrap(),
        run_id,
        "workspace_file",
        &resolved.to_string_lossy(),
        base.as_deref(),
        content,
        rationale,
    )
}

pub fn propose(
    conn: &Connection,
    run_id: &str,
    kind: &str,
    target: &str,
    base: Option<&str>,
    content: &str,
    rationale: &str,
) -> Result<String, String> {
    if content.len() > MAX_BYTES
        || base.is_some_and(|text| text.len() > MAX_BYTES)
        || content.contains('\0')
    {
        return Err("只支持暂存不超过 64 KiB 的文本变更".into());
    }
    if base == Some(content) {
        return Err("提议与现有内容相同".into());
    }
    let version = base.map(checksum).unwrap_or_else(|| ABSENT.into());
    let diff = similar::TextDiff::from_lines(base.unwrap_or(""), content)
        .unified_diff()
        .header("当前", "提议")
        .to_string();
    let id = uuid::Uuid::new_v4().to_string();
    let rationale: String = rationale.chars().take(500).collect();
    let previous_excerpt: String = base.unwrap_or_default().chars().take(600).collect();
    conn.execute(
        "INSERT INTO staged_diffs(id,run_id,target_kind,target_ref,base_sha256,proposed_content,unified_diff,rationale,created_at,previous_excerpt)
         VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
        params![id,run_id,kind,target,version,content,diff,rationale,now_ms(),previous_excerpt],
    ).map_err(|error| error.to_string())?;
    Ok(id)
}

pub fn list(conn: &Connection, run_id: &str) -> Result<Vec<StagedDiff>, String> {
    let mut statement = conn
        .prepare(&format!("{SELECT} WHERE run_id=?1 ORDER BY created_at,id"))
        .map_err(|error| error.to_string())?;
    let rows = statement
        .query_map([run_id], row_to_diff)
        .map_err(|error| error.to_string())?;
    rows.collect::<rusqlite::Result<_>>()
        .map_err(|error| error.to_string())
}

pub fn get(conn: &Connection, id: &str) -> Result<StagedDiff, String> {
    conn.query_row(&format!("{SELECT} WHERE id=?1"), [id], row_to_diff)
        .optional()
        .map_err(|error| error.to_string())?
        .ok_or_else(|| "找不到暂存变更".into())
}

pub fn approve_file(
    store: &NoteStore,
    policy: &PermissionManifest,
    diff: &StagedDiff,
) -> Result<(), String> {
    let path = policy.authorized_path(Path::new(&diff.target_ref), &store.root)?;
    let parent = path.parent().ok_or("目标文件没有父目录")?;
    let base = bounded_read(&path)?;
    if base.as_deref() == Some(&diff.proposed_content) {
        return Ok(());
    }
    let revision = base
        .as_deref()
        .map(checksum)
        .unwrap_or_else(|| ABSENT.into());
    if revision != diff.base_sha256 {
        return Err("目标在暂存后已变化，请重新生成变更".into());
    }
    let temp = parent.join(format!(".plate-stage-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> Result<(), String> {
        let mut output = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temp)
            .map_err(|error| error.to_string())?;
        #[cfg(windows)]
        verify_handle(&output, &temp)?;
        output
            .write_all(diff.proposed_content.as_bytes())
            .and_then(|()| output.sync_all())
            .map_err(|error| error.to_string())?;
        if let Ok(metadata) = fs::metadata(&path) {
            fs::set_permissions(&temp, metadata.permissions())
                .map_err(|error| error.to_string())?;
        }
        drop(output);
        let checked = policy.authorized_path(&path, &store.root)?;
        if checked != path || bounded_read(&path)? != base {
            return Err("目标在审阅时已变化".into());
        }
        if base.is_none() {
            // A plain rename can overwrite a file another process just created.
            fs::hard_link(&temp, &path).map_err(|error| error.to_string())?;
        } else {
            fs::rename(&temp, &path).map_err(|error| error.to_string())?;
        }
        Ok(())
    })();
    let _ = fs::remove_file(&temp);
    result
}

pub fn resolve_record(conn: &Connection, diff: &StagedDiff, accepted: bool) -> Result<(), String> {
    let status = if accepted { "accepted" } else { "rejected" };
    let changed = conn
        .execute(
            "UPDATE staged_diffs SET status=?1,resolved_at=?2 WHERE id=?3 AND status='pending'",
            params![status, now_ms(), diff.id],
        )
        .map_err(|error| error.to_string())?;
    if changed == 0 {
        return Err("该条变更已处理".into());
    }
    Ok(())
}

pub fn approve_new_note(store: &NoteStore, diff: &StagedDiff, project: &str, space: &str) -> Result<(), String> {
    let (title, body) = diff.proposed_content.split_once('\n').ok_or("缺少新笔记标题")?;
    let title = title.strip_prefix("# ").ok_or("缺少新笔记标题")?;
    let marker = format!("<!-- plate-brain-write:{} -->",diff.id);
    store.create_memory_note(&diff.target_ref,project,title,&format!("{marker}\n{body}"),&marker,space)?;
    Ok(())
}

pub fn approve_note(
    store: &NoteStore,
    policy: &PermissionManifest,
    diff: &StagedDiff,
) -> Result<(), String> {
    use crate::notes::SaveResult;
    if !policy.allow_brain_note_propose || !policy.can_read_note(&diff.target_ref) {
        return Err("该笔记不在当前任务的审阅权限内".into());
    }
    let note = store.read(&diff.target_ref)?;
    if store.has_unsaved_draft(&note)? {
        return Err("请先处理目标笔记的未保存草稿".into());
    }
    if note.content == diff.proposed_content {
        return Ok(());
    }
    if note.revision != diff.base_sha256 {
        return Err("笔记在暂存后已变化，请重新生成变更".into());
    }
    match store.update_strict(&diff.target_ref, &diff.proposed_content, note.revision)? {
        SaveResult::Saved { .. } => Ok(()),
        SaveResult::Conflict { .. } => Err("笔记版本已变化".into()),
    }
}

pub fn record_note_evolution(conn: &Connection, diff: &StagedDiff) -> Result<(), String> {
    let now = now_ms();
    crate::vitality_engine::boost(conn, &diff.target_ref, now)
        .map_err(|error| error.to_string())?;
    let version: i64 = conn.query_row(
        "UPDATE note SET evolution_version=evolution_version+1 WHERE id=?1 RETURNING evolution_version",
        [&diff.target_ref], |row| row.get(0),
    ).map_err(|error| error.to_string())?;
    let rationale = if diff.rationale.is_empty() {
        "采纳工作台笔记变更"
    } else {
        &diff.rationale
    };
    conn.execute(
        "INSERT INTO memory_evolution_logs(id,target_note_id,source_run_id,version,delta_summary,previous_excerpt,created_at)
         VALUES(?1,?2,?3,?4,?5,?6,?7)",
        params![uuid::Uuid::new_v4().to_string(),diff.target_ref,diff.run_id,version,rationale,diff.previous_excerpt,now],
    ).map_err(|error| error.to_string())?;
    crate::vitality_engine::recalculate_rows(conn, now).map_err(|error| error.to_string())?;
    Ok(())
}
