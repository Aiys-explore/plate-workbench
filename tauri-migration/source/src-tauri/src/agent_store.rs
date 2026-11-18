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

fn search_dirs() -> Vec<std::path::PathBuf> {
    let mut dirs: Vec<std::path::PathBuf> = std::env::var("PATH")
        .unwrap_or_default()
        .split(';')
        .filter(|entry| !entry.trim().is_empty())
        .map(std::path::PathBuf::from)
        .collect();
    if let Ok(home) = std::env::var("USERPROFILE") {
        let home = std::path::PathBuf::from(home);
        dirs.push(home.join(".local").join("bin"));
        dirs.push(home.join("AppData").join("Roaming").join("npm"));
        dirs.push(home.join("AppData").join("Local").join("Programs"));
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
                if candidate.is_file() {
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
        if !path.trim().is_empty() {
            return Some(path);
        }
    }
    discover()
        .into_iter()
        .find(|agent| agent.agent_type == agent_type)
        .map(|agent| agent.executable)
}

