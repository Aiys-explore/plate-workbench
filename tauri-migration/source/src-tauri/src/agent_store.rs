// 本机 Agent 自动发现：按名称在 PATH 与常见安装目录中查找可执行文件。
// 不做哈希锁死，也不缓存到磁盘；每次发现即时返回，保证升级后无需清理配置。
pub struct DiscoveredAgent {
    pub agent_type: String,
    pub name: String,
    pub executable: String,
}

const CANDIDATES: &[(&str, &str, &[&str])] = &[
    ("dsh", "DeepSeek Harness", &["dsh.exe", "dsh.cmd", "dsh.bat", "dsh"]),
    ("codex", "Codex", &["codex.exe", "codex.cmd", "codex.bat", "codex"]),
    ("claude", "Claude Code", &["claude.exe", "claude.cmd", "claude.bat", "claude"]),
    ("opencode", "OpenCode", &["opencode.exe", "opencode.cmd", "opencode.bat", "opencode"]),
];

use std::path::{Path, PathBuf};

pub fn supports_entry(agent_type: &str, path: &Path) -> bool {
    !cfg!(windows) || agent_type != "opencode" ||
        path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("exe"))
}

fn search_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
        .filter(|path| path.is_absolute())
        .collect();
    if let Ok(home) = std::env::var("USERPROFILE") {
        let home = std::path::PathBuf::from(home);
        dirs.push(home.join(".local").join("bin"));
        dirs.push(home.join("AppData").join("Roaming").join("npm"));
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let programs = PathBuf::from(local).join("Programs");
        dirs.push(programs.join("DeepSeek Harness").join("resources").join("runtime").join("cli").join("bin"));
        dirs.push(programs);
    }
    dirs
}

pub fn discover() -> Vec<DiscoveredAgent> {
    let dirs = search_dirs();
    let mut found = Vec::new();
    for (agent_type, name, files) in CANDIDATES {
        'per_type: for dir in &dirs {
            for file in *files {
                let candidate = dir.join(file);
                if candidate.is_file() && supports_entry(agent_type, &candidate) {
                    found.push(DiscoveredAgent {
                        agent_type: (*agent_type).to_string(),
                        name: (*name).to_string(),
                        executable: candidate.to_string_lossy().into_owned(),
                    });
                    break 'per_type;
                }
            }
        }
    }
    found
}

pub fn resolve(agent_type: &str) -> Option<String> {
    // 隔离验收钩子：PLATE_AGENT_<TYPE>=可执行文件路径，仅测试环境注入。
    if let Ok(path) = std::env::var(format!("PLATE_AGENT_{}", agent_type.to_uppercase())) {
        if Path::new(&path).is_absolute() && Path::new(&path).is_file() &&
            supports_entry(agent_type, Path::new(&path)) {
            return Some(path);
        }
    }
    discover()
        .into_iter()
        .find(|agent| agent.agent_type == agent_type)
        .map(|agent| agent.executable)
}

