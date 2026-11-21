use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Component, Path, PathBuf};

#[derive(Clone, Deserialize, Serialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct PermissionManifest {
    pub readable_note_ids: Vec<String>,
    pub allow_all_notes_read: bool,
    pub readable_log_session_ids: Vec<String>,
    pub writable_dirs: Vec<PathBuf>,
    pub allow_brain_note_propose: bool,
    pub allow_shell: bool,
    pub allow_network: bool,
    pub max_steps: u32,
    pub max_budget_usd: f64,
}

impl Default for PermissionManifest {
    fn default() -> Self {
        Self {
            readable_note_ids: vec![],
            allow_all_notes_read: false,
            readable_log_session_ids: vec![],
            writable_dirs: vec![],
            allow_brain_note_propose: true,
            allow_shell: false,
            allow_network: false,
            max_steps: 12,
            max_budget_usd: 0.50,
        }
    }
}

impl PermissionManifest {
    pub fn validate(&mut self) -> Result<(), String> {
        if !(1..=40).contains(&self.max_steps)
            || !self.max_budget_usd.is_finite()
            || !(0.0..=1000.0).contains(&self.max_budget_usd)
            || self.writable_dirs.len() > 16
            || self.readable_note_ids.len() > 512
            || self.readable_log_session_ids.len() > 32
        {
            return Err("权限清单的步数、预算或授权范围超限".into());
        }
        for root in &mut self.writable_dirs {
            validate_path(root)?;
            let absolute = root.canonicalize().map_err(|_| "无法打开授权目录")?;
            if !absolute.is_dir() {
                return Err("授权路径必须是现有目录".into());
            }
            *root = absolute;
        }
        self.writable_dirs.sort();
        self.writable_dirs.dedup();
        Ok(())
    }

    pub fn restrict_with_skill(&mut self, shell: bool, network: bool) {
        self.allow_shell &= shell;
        self.allow_network &= network;
    }

    pub fn can_read_note(&self, id: &str) -> bool {
        self.allow_all_notes_read || self.readable_note_ids.iter().any(|allowed| allowed == id)
    }

    pub fn can_read_log(&self, id: &str) -> bool {
        self.readable_log_session_ids
            .iter()
            .any(|allowed| allowed == id)
    }

    pub fn authorized_path(&self, target: &Path, protected_root: &Path) -> Result<PathBuf, String> {
        validate_path(target)?;
        let parent = target
            .parent()
            .ok_or("目标文件需要父目录")?
            .canonicalize()
            .map_err(|_| "找不到目标文件的父目录")?;
        let name = target.file_name().ok_or("请选择文件")?;
        let resolved = parent.join(name);
        if !self
            .writable_dirs
            .iter()
            .any(|root| resolved.starts_with(root))
        {
            return Err("文件超出当前任务的目录授权".into());
        }
        let protected = protected_root
            .canonicalize()
            .map_err(|_| "无法核对笔记库保护路径")?;
        if resolved.starts_with(&protected) {
            return Err("笔记库内的变更必须使用笔记审阅入口".into());
        }
        match fs::symlink_metadata(&resolved) {
            Ok(metadata) if metadata.is_file() && !is_reparse(&metadata) => {
                if resolved.canonicalize().map_err(|_| "目标路径已变化")? != resolved {
                    return Err("目标文件指向不同路径".into());
                }
            }
            Ok(_) => return Err("只允许访问普通文件".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => (),
            Err(_) => return Err("无法核对目标文件".into()),
        }
        Ok(resolved)
    }
}

fn validate_path(path: &Path) -> Result<(), String> {
    if !path.is_absolute()
        || path.components().any(|part| match part {
            Component::ParentDir => true,
            Component::Normal(name) => {
                let text = name.to_string_lossy();
                text.contains(':') || text.ends_with([' ', '.'])
            }
            _ => false,
        })
    {
        return Err("请使用无上级跳转或数据流的绝对文件路径".into());
    }
    #[cfg(windows)]
    {
        use std::path::Prefix;
        if !matches!(path.components().next(), Some(Component::Prefix(prefix))
            if matches!(prefix.kind(), Prefix::Disk(_) | Prefix::VerbatimDisk(_)))
        {
            return Err("只允许本机磁盘路径".into());
        }
        if path.components().any(|part| match part {
            Component::Normal(name) => {
                let text = name.to_string_lossy().to_ascii_uppercase();
                let stem = text.split('.').next().unwrap_or("").trim_end();
                matches!(stem, "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$")
                    || ((stem.starts_with("COM") || stem.starts_with("LPT"))
                        && stem.chars().count() == 4
                        && stem
                            .chars()
                            .last()
                            .is_some_and(|ch| ch.is_ascii_digit() || "¹²³".contains(ch)))
            }
            _ => false,
        }) {
            return Err("目标路径包含 Windows 设备名".into());
        }
    }
    Ok(())
}

fn is_reparse(metadata: &fs::Metadata) -> bool {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn protects_notes_and_rejects_traversal_outside_authorized_directory() -> Result<(), String> {
        let root = std::env::temp_dir()
            .canonicalize()
            .map_err(|error| error.to_string())?;
        let allowed = std::env::current_dir().map_err(|error| error.to_string())?;
        let mut policy = PermissionManifest {
            writable_dirs: vec![allowed.clone()],
            ..Default::default()
        };
        policy.validate()?;
        assert!(policy
            .authorized_path(&allowed.join("allowed-fixture.txt"), &root)
            .is_ok());
        assert!(policy
            .authorized_path(&allowed.join("..").join("outside.txt"), &root)
            .is_err());
        assert!(policy
            .authorized_path(&root.join("outside.txt"), &root)
            .is_err());
        assert!(policy
            .authorized_path(&allowed.join("protected.txt"), &allowed)
            .is_err());
        #[cfg(windows)]
        assert!(policy
            .authorized_path(&allowed.join("file.txt:stream"), &root)
            .is_err());
        Ok(())
    }

    #[test]
    fn skill_permissions_cannot_expand_task_capabilities() {
        let mut policy = PermissionManifest {
            allow_network: true,
            ..Default::default()
        };
        policy.restrict_with_skill(true, false);
        assert!(!policy.allow_shell && !policy.allow_network);
        assert!(!policy.can_read_note("unknown") && !policy.can_read_log("unknown"));
    }
}
