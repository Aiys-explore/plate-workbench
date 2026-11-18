// 本机 Agent 自动发现：按名称在 PATH 与常见安装目录中查找可执行文件。
// 不做哈希锁死，也不缓存到磁盘；每次发现即时返回，保证升级后无需清理配置。
pub struct DiscoveredAgent {
    pub agent_type: String,
    pub name: String,
    pub executable: String,
}

pub struct Builtin {
    pub id: &'static str,
    pub name: &'static str,
    pub icon: &'static str,
    pub binary_names: &'static [&'static str],
    pub models: &'static [&'static str],
    pub model_flag: Option<&'static str>,
    pub default_installed: bool,
    pub runnable: bool,
}

pub const BUILTINS: &[Builtin] = &[
    Builtin {
        id: "codex",
        name: "Codex",
        icon: "codex",
        binary_names: &["codex.exe", "codex.cmd", "codex.bat", "codex"],
        models: &["gpt-6.2-sol", "gpt-5.4", "o3", "o4-mini"],
        model_flag: Some("-m"),
        default_installed: true,
        runnable: true,
    },
    Builtin {
        id: "dsh",
        name: "DeepSeek Harness",
        icon: "dsh",
        binary_names: &["dsh.exe", "dsh.cmd", "dsh.bat", "dsh"],
        models: &["deepseek-flash", "deepseek-v4-pro"],
        model_flag: Some("--model"),
        default_installed: true,
        runnable: true,
    },
    Builtin {
        id: "claude",
        name: "Claude Code",
        icon: "claude",
        binary_names: &["claude.exe", "claude.cmd", "claude.bat", "claude"],
        models: &["opus", "sonnet", "haiku"],
        model_flag: Some("--model"),
        default_installed: true,
        runnable: true,
    },
    Builtin {
        id: "opencode",
        name: "OpenCode",
        icon: "opencode",
        binary_names: &["opencode.exe", "opencode.cmd", "opencode.bat", "opencode"],
        models: &[],
        model_flag: Some("--model"),
        default_installed: false,
        runnable: true,
    },
    Builtin {
        id: "zcode",
        name: "ZCode",
        icon: "zcode",
        binary_names: &["zcode.exe", "zcode.cmd", "zcode.bat", "zcode"],
        models: &[],
        model_flag: None,
        default_installed: false,
        runnable: false,
    },
    Builtin {
        id: "minimax-code",
        name: "MiniMax Code",
        icon: "minimax-code",
        binary_names: &["minimax-code.exe", "minimax-code.cmd", "minimax-code"],
        models: &[],
        model_flag: None,
        default_installed: false,
        runnable: false,
    },
    Builtin {
        id: "gemini",
        name: "Gemini CLI",
        icon: "gemini",
        binary_names: &["gemini.exe", "gemini.cmd", "gemini.bat", "gemini"],
        models: &["gemini-2.5-pro", "gemini-2.5-flash"],
        model_flag: Some("--model"),
        default_installed: false,
        runnable: false,
    },
    Builtin {
        id: "kimi",
        name: "Kimi CLI",
        icon: "kimi",
        binary_names: &["kimi.exe", "kimi.cmd", "kimi.bat", "kimi"],
        models: &["kimi-k2", "moonshot-v1-128k"],
        model_flag: Some("--model"),
        default_installed: false,
        runnable: false,
    },
    Builtin {
        id: "copilot",
        name: "GitHub Copilot CLI",
        icon: "copilot",
        binary_names: &["copilot.exe", "copilot.cmd", "copilot.bat", "copilot"],
        models: &["gpt-5", "claude-sonnet-4-5"],
        model_flag: None,
        default_installed: false,
        runnable: false,
    },
    Builtin {
        id: "cursor",
        name: "Cursor Agent",
        icon: "cursor",
        binary_names: &["cursor-agent.exe", "cursor-agent.cmd", "cursor-agent.bat", "cursor-agent"],
        models: &[],
        model_flag: None,
        default_installed: false,
        runnable: false,
    },
    Builtin {
        id: "grok",
        name: "Grok CLI",
        icon: "grok",
        binary_names: &["grok.exe", "grok.cmd", "grok.bat", "grok"],
        models: &["grok-4", "grok-4-fast"],
        model_flag: Some("--model"),
        default_installed: false,
        runnable: false,
    },
    Builtin {
        id: "qwen",
        name: "Qwen Code",
        icon: "qwen",
        binary_names: &["qwen.exe", "qwen.cmd", "qwen.bat", "qwen"],
        models: &["qwen3-coder", "qwen3-max"],
        model_flag: Some("--model"),
        default_installed: false,
        runnable: false,
    },
    Builtin {
        id: "aider",
        name: "Aider",
        icon: "aider",
        binary_names: &["aider.exe", "aider.cmd", "aider.bat", "aider"],
        models: &[],
        model_flag: Some("--model"),
        default_installed: false,
        runnable: false,
    },
    Builtin {
        id: "devin",
        name: "Devin CLI",
        icon: "devin",
        binary_names: &["devin.exe", "devin.cmd", "devin.bat", "devin"],
        models: &[],
        model_flag: None,
        default_installed: false,
        runnable: false,
    },
    Builtin {
        id: "goose",
        name: "Goose",
        icon: "goose",
        binary_names: &["goose.exe", "goose.cmd", "goose.bat", "goose"],
        models: &[],
        model_flag: None,
        default_installed: false,
        runnable: false,
    },
    Builtin {
        id: "cline",
        name: "Cline",
        icon: "cline",
        binary_names: &["cline.exe", "cline.cmd", "cline.bat", "cline"],
        models: &[],
        model_flag: None,
        default_installed: false,
        runnable: false,
    },
    Builtin {
        id: "roo",
        name: "Roo Code",
        icon: "roo",
        binary_names: &["roo.exe", "roo.cmd", "roo.bat", "roo"],
        models: &[],
        model_flag: None,
        default_installed: false,
        runnable: false,
    },
    Builtin {
        id: "kilocode",
        name: "Kilo Code",
        icon: "kilocode",
        binary_names: &["kilo.exe", "kilocode.exe", "kilo.cmd", "kilo.bat", "kilo"],
        models: &[],
        model_flag: None,
        default_installed: false,
        runnable: false,
    },
    Builtin {
        id: "antigravity",
        name: "Antigravity CLI",
        icon: "antigravity",
        binary_names: &["antigravity.exe", "antigravity.cmd", "antigravity.bat", "antigravity"],
        models: &[],
        model_flag: None,
        default_installed: false,
        runnable: false,
    },
    Builtin {
        id: "nanobot",
        name: "nanobot",
        icon: "nanobot",
        binary_names: &["nanobot.exe", "nanobot.cmd", "nanobot.bat", "nanobot"],
        models: &[],
        model_flag: None,
        default_installed: false,
        runnable: false,
    },
    Builtin {
        id: "crush",
        name: "Crush",
        icon: "crush",
        binary_names: &["crush.exe", "crush.cmd", "crush.bat", "crush"],
        models: &[],
        model_flag: None,
        default_installed: false,
        runnable: false,
    },
    Builtin {
        id: "openrew",
        name: "Open Code Review",
        icon: "openrew",
        binary_names: &["openrew.exe", "open-code-review.exe", "openrew.cmd", "openrew"],
        models: &[],
        model_flag: None,
        default_installed: false,
        runnable: false,
    },
];

use std::path::{Path, PathBuf};

const MAX_MODEL_FILE_BYTES: u64 = 256 * 1024;
const MAX_MODEL_ID_LEN: usize = 128;
const MAX_MODELS: usize = 128;

fn builtin(id: &str) -> Option<&'static Builtin> {
    BUILTINS.iter().find(|entry| entry.id == id)
}

fn home() -> Option<PathBuf> {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
}

pub fn supports_entry(agent_type: &str, path: &Path) -> bool {
    !cfg!(windows) || agent_type != "opencode" ||
        path.extension().is_some_and(|ext| ext.eq_ignore_ascii_case("exe"))
}

fn search_dirs() -> Vec<PathBuf> {
    let mut dirs: Vec<PathBuf> = std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default())
        .filter(|path| path.is_absolute())
        .collect();
    if let Ok(home) = std::env::var("USERPROFILE") {
        let home = PathBuf::from(home);
        dirs.push(home.join(".local").join("bin"));
        dirs.push(home.join("AppData").join("Roaming").join("npm"));
        dirs.push(home.join(".cargo").join("bin"));
        dirs.push(home.join(".claude").join("local"));
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        let local = PathBuf::from(local);
        let programs = local.join("Programs");
        dirs.push(programs.join("DeepSeek Harness").join("resources").join("runtime").join("cli").join("bin"));
        dirs.push(programs.join("DeepSeek").join("resources").join("runtime").join("cli").join("bin"));
        dirs.push(programs.join("DeepSeek").join("resources").join("app").join("resources").join("runtime").join("cli").join("bin"));
        dirs.push(programs.join("Codex Desktop").join("resources"));
        dirs.push(local.join("Microsoft").join("WindowsApps"));
        dirs.push(programs);
    }
    if let Some(appdata) = std::env::var_os("APPDATA") {
        let appdata = PathBuf::from(appdata);
        dirs.push(appdata.join("npm"));
        dirs.push(appdata.join("Claude"));
    }
    dirs
}

pub fn discover() -> Vec<DiscoveredAgent> {
    BUILTINS.iter().filter_map(|entry| resolve(entry.id).map(|executable| DiscoveredAgent {
        agent_type: entry.id.to_owned(), name: entry.name.to_owned(), executable,
    })).collect()
}

pub fn resolve(agent_type: &str) -> Option<String> {
    // 隔离验收钩子：PLATE_AGENT_<TYPE>=可执行文件路径，仅测试环境注入。
    if let Ok(path) = std::env::var(format!("PLATE_AGENT_{}", agent_type.to_uppercase())) {
        if Path::new(&path).is_absolute() && Path::new(&path).is_file() &&
            supports_entry(agent_type, Path::new(&path)) {
            return Some(path);
        }
    }
    let entry = builtin(agent_type)?;
    for dir in search_dirs() {
        for file in entry.binary_names {
            let candidate = dir.join(file);
            if candidate.is_file() && supports_entry(entry.id, &candidate) {
                return Some(candidate.to_string_lossy().into_owned());
            }
        }
    }
    None
}

fn sanitize_model(value: &str) -> Option<String> {
    let value = value.trim().trim_matches(|ch: char| ch.is_whitespace() || ch == '"' || ch == '\'' || ch == '`');
    let lowered = value.to_ascii_lowercase();
    if value.is_empty()
        || value.len() > MAX_MODEL_ID_LEN
        || value.contains(['\0', '\r', '\n'])
        || lowered.starts_with("sk-")
        || ["api_key", "apikey", "token", "secret", "password"].iter().any(|word| lowered.contains(word))
    {
        return None;
    }
    Some(value.to_string())
}

fn push_model(models: &mut Vec<String>, value: &str) {
    if models.len() >= MAX_MODELS {
        return;
    }
    if let Some(model) = sanitize_model(value) {
        if !models.contains(&model) {
            models.push(model);
        }
    }
}

fn read_model_file(path: &Path, models: &mut Vec<String>) {
    let Ok(metadata) = std::fs::metadata(path) else { return };
    if !metadata.is_file() || metadata.len() > MAX_MODEL_FILE_BYTES {
        return;
    }
    let Ok(content) = std::fs::read_to_string(path) else { return };
    read_model_content(&content, models);
}

fn read_model_content(content: &str, models: &mut Vec<String>) {
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(&content) {
        collect_json_model_ids(&value, models);
    } else {
        for line in content.lines().take(2048) {
            let line = line.split('#').next().unwrap_or(line).trim();
            let Some((key, value)) = line.split_once('=') else { continue };
            let key = key.trim();
            if !(key.eq_ignore_ascii_case("model")
                || key.eq_ignore_ascii_case("models")
                || key.eq_ignore_ascii_case("model_id")
                || key.eq_ignore_ascii_case("model_ids"))
            {
                continue;
            }
            for item in value.split(',').take(MAX_MODELS) {
                let item = item.trim().trim_matches(['[', ']']).trim();
                push_model(models, item);
            }
        }
    }
}

fn collect_json_model_ids(value: &serde_json::Value, models: &mut Vec<String>) {
    match value {
        serde_json::Value::String(text) => push_model(models, text),
        serde_json::Value::Array(items) => {
            for item in items {
                collect_json_model_ids(item, models);
            }
        }
        serde_json::Value::Object(map) => {
            for (key, item) in map {
                if key.eq_ignore_ascii_case("model")
                    || key.eq_ignore_ascii_case("models")
                    || key.eq_ignore_ascii_case("model_id")
                    || key.eq_ignore_ascii_case("modelids")
                    || key.eq_ignore_ascii_case("model_ids")
                    || key == "slug"
                {
                    collect_json_model_ids(item, models);
                }
            }
        }
        _ => {}
    }
}

fn model_files(id: &str) -> Vec<PathBuf> {
    let Some(home) = home() else { return Vec::new() };
    match id {
        "codex" => {
            let dir = std::env::var_os("CODEX_HOME").map(PathBuf::from)
                .filter(|dir| dir.is_absolute()).unwrap_or_else(|| home.join(".codex"));
            vec![dir.join("models_cache.json"), dir.join("models.json"), dir.join("config.toml")]
        }
        "dsh" => vec![
            home.join(".dsh").join("models.json"),
            home.join(".dsh").join("config.toml"),
        ],
        "claude" => vec![
            home.join(".claude").join("models.json"),
            home.join(".claude").join("settings.json"),
        ],
        _ => Vec::new(),
    }
}

pub fn local_models(id: &str) -> Vec<String> {
    let mut models = Vec::new();
    for path in model_files(id) {
        read_model_file(&path, &mut models);
        if models.len() >= MAX_MODELS {
            break;
        }
    }
    models.truncate(MAX_MODELS);
    models
}

#[cfg(windows)]
pub fn desktop_version(id: &str, executable: &str) -> Option<String> {
    // Resolve only an associated desktop executable beside the detected resources tree.
    let names: &[&str] = match id {
        "dsh" => &["DeepSeek Harness.exe", "DeepSeek.exe", "DSH.exe"],
        "codex" => &["Codex.exe", "OpenAI Codex.exe"],
        _ => return None,
    };
    let executable = Path::new(executable);
    executable.ancestors().take(9).filter(|path| path.file_name().is_some_and(|name|
        name.eq_ignore_ascii_case("resources"))).filter_map(Path::parent)
        .flat_map(|root| names.iter().map(move |name| root.join(name)))
        .find_map(|path| (path != executable).then(|| file_version(&path)).flatten())
}

#[cfg(not(windows))]
pub fn desktop_version(_: &str, _: &str) -> Option<String> { None }

#[cfg(windows)]
fn file_version(path: &Path) -> Option<String> {
    use std::{mem::size_of, os::windows::ffi::OsStrExt, ptr::null_mut};
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW, VS_FIXEDFILEINFO,
    };
    if !path.is_file() { return None; }
    let path: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let mut handle = 0;
    let size = unsafe { GetFileVersionInfoSizeW(path.as_ptr(), &mut handle) };
    if size == 0 || size > 1024 * 1024 { return None; }
    let mut data = vec![0u8; size as usize];
    if unsafe { GetFileVersionInfoW(path.as_ptr(), 0, size, data.as_mut_ptr().cast()) } == 0 { return None; }
    let mut value = null_mut();
    let mut length = 0;
    if unsafe { VerQueryValueW(data.as_ptr().cast(), [92u16, 0].as_ptr(), &mut value, &mut length) } == 0 ||
        value.is_null() || (length as usize) < size_of::<VS_FIXEDFILEINFO>() { return None; }
    // The version resource can be unaligned. Only read the fixed header returned by the OS.
    let info = unsafe { value.cast::<VS_FIXEDFILEINFO>().read_unaligned() };
    if info.dwSignature != 0xfeef04bd || (info.dwProductVersionMS == 0 && info.dwProductVersionLS == 0) {
        return None;
    }
    Some(format!("{}.{}.{}.{}", info.dwProductVersionMS >> 16, info.dwProductVersionMS & 0xffff,
        info.dwProductVersionLS >> 16, info.dwProductVersionLS & 0xffff))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::Path;

    #[test]
    fn builtin_catalog_is_ordered_and_only_originals_are_runnable() {
        assert_eq!(BUILTINS.len(), 22);
        assert_eq!(BUILTINS[0].id, "codex");
        assert_eq!(BUILTINS[1].id, "dsh");
        assert_eq!(BUILTINS[2].id, "claude");
        assert_eq!(BUILTINS[3].id, "opencode");
        assert!(BUILTINS.iter().filter(|entry| entry.runnable).all(|entry| {
            matches!(entry.id, "codex" | "dsh" | "claude" | "opencode")
        }));
    }

    #[test]
    fn opencode_keeps_windows_exe_semantics() {
        assert!(supports_entry("opencode", Path::new("opencode.exe")));
        assert_eq!(supports_entry("opencode", Path::new("opencode.cmd")), !cfg!(windows));
        assert!(supports_entry("claude", Path::new("claude.cmd")));
    }

    #[test]
    fn model_parsing_reads_ids_and_skips_sensitive_values() {
        let mut models = vec!["base-model".to_string()];
        read_model_content(
            r#"
            # comment
            model = "local-model"
            models = ["second-model", "base-model"]
            api_key = "not-a-model"
            "#,
            &mut models,
        );
        assert_eq!(models, vec!["base-model", "local-model", "second-model"]);

        let mut rejected = Vec::new();
        push_model(&mut rejected, "OPENAI_API_KEY");
        push_model(&mut rejected, "");
        assert!(rejected.is_empty());
    }
}

