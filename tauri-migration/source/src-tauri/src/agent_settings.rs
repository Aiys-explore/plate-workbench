use serde::{Deserialize, Serialize};
use std::{fs, io::ErrorKind, path::PathBuf, sync::Mutex};
use tauri::{AppHandle, Manager, State};

pub const DSH_KEY_ENV: &str = "DEEPSEEK_API_KEY";

#[derive(Default)]
pub struct AgentSettings(Mutex<()>);

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct StoredSettings {
    default_agent: Option<String>,
    deepseek_protected: Option<Vec<u8>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SettingsView {
    default_agent: Option<String>,
    deepseek_key: &'static str,
}

impl StoredSettings {
    fn view(self) -> SettingsView {
        let deepseek_key = if self.deepseek_protected.is_some() {
            "saved"
        } else if std::env::var(DSH_KEY_ENV).is_ok_and(|value| !value.trim().is_empty()) {
            "environment"
        } else {
            "unset"
        };
        SettingsView { default_agent: self.default_agent, deepseek_key }
    }
}

impl AgentSettings {
    fn path(app: &AppHandle) -> Result<PathBuf, String> {
        if let Some(directory) = std::env::var_os("PLATE_AGENT_SETTINGS_DIR").map(PathBuf::from) {
            if directory.is_absolute() { return Ok(directory.join("agent-settings.json")); }
        }
        app.path().app_local_data_dir().map(|dir| dir.join("agent-settings.json"))
            .map_err(|error| error.to_string())
    }

    fn read(app: &AppHandle) -> Result<StoredSettings, String> {
        match fs::read(Self::path(app)?) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| "本地 Agent 设置无法读取".into()),
            Err(error) if error.kind() == ErrorKind::NotFound => Ok(StoredSettings::default()),
            Err(error) => Err(format!("无法读取 Agent 设置：{error}")),
        }
    }

    pub fn default_agent(&self, app: &AppHandle) -> Result<Option<String>, String> {
        let _guard = self.0.lock().unwrap();
        Ok(Self::read(app)?.default_agent)
    }

    pub fn deepseek_key(&self, app: &AppHandle) -> Result<Option<String>, String> {
        let _guard = self.0.lock().unwrap();
        Self::read(app)?.deepseek_protected.map(|bytes| {
            let secret = protect(&bytes, false)?;
            String::from_utf8(secret).map_err(|_| "DeepSeek 密钥已损坏，请在 Agent 设置中重新保存".into())
        }).transpose()
    }
}

#[tauri::command]
pub fn agent_settings_get(app: AppHandle, state: State<'_, AgentSettings>) -> Result<SettingsView, String> {
    let _guard = state.0.lock().unwrap();
    Ok(AgentSettings::read(&app)?.view())
}

#[tauri::command]
pub fn agent_settings_save(
    app: AppHandle, state: State<'_, AgentSettings>, default_agent: Option<String>,
    deepseek_key: Option<String>, clear_deepseek_key: bool,
) -> Result<SettingsView, String> {
    if default_agent.as_deref().is_some_and(|value| !["dsh", "codex", "claude", "opencode"].contains(&value)) {
        return Err("请选择受支持的 Agent".into());
    }
    let _guard = state.0.lock().unwrap();
    let mut settings = AgentSettings::read(&app)?;
    settings.default_agent = default_agent;
    if let Some(key) = deepseek_key {
        let key = key.trim();
        if key.is_empty() || key.len() > 1024 || key.chars().any(|character| character.is_whitespace() || character.is_control()) {
            return Err("请输入有效格式的 DeepSeek API Key".into());
        }
        settings.deepseek_protected = Some(protect(key.as_bytes(), true)?);
    } else if clear_deepseek_key {
        settings.deepseek_protected = None;
    }
    let path = AgentSettings::path(&app)?;
    let directory = path.parent().ok_or("找不到本地 Agent 设置目录")?;
    fs::create_dir_all(directory).map_err(|error| format!("无法创建 Agent 设置目录：{error}"))?;
    let temporary = directory.join(format!("agent-settings-{}.tmp", uuid::Uuid::new_v4()));
    let bytes = serde_json::to_vec(&settings).map_err(|error| error.to_string())?;
    if let Err(error) = fs::write(&temporary, bytes).and_then(|()| fs::rename(&temporary, path)) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("无法保存 Agent 设置：{error}"));
    }
    Ok(settings.view())
}

#[cfg(windows)]
fn protect(bytes: &[u8], encrypt: bool) -> Result<Vec<u8>, String> {
    use std::{ptr::{null, null_mut}, slice};
    use windows_sys::Win32::{Foundation::LocalFree, Security::Cryptography::{
        CryptProtectData, CryptUnprotectData, CRYPTPROTECT_UI_FORBIDDEN, CRYPT_INTEGER_BLOB,
    }};
    if bytes.is_empty() { return Err("DeepSeek 密钥为空，请在 Agent 设置中重新保存".into()); }
    let input = CRYPT_INTEGER_BLOB { cbData: bytes.len() as u32, pbData: bytes.as_ptr().cast_mut() };
    let mut output = CRYPT_INTEGER_BLOB { cbData: 0, pbData: null_mut() };
    let succeeded = unsafe {
        if encrypt {
            CryptProtectData(&input, null(), null(), null(), null(), CRYPTPROTECT_UI_FORBIDDEN, &mut output)
        } else {
            CryptUnprotectData(&input, null_mut(), null(), null(), null(), CRYPTPROTECT_UI_FORBIDDEN, &mut output)
        }
    };
    if succeeded == 0 {
        return Err(if encrypt { "Windows 无法保护 DeepSeek 密钥" }
            else { "当前 Windows 用户无法解锁 DeepSeek 密钥，请在 Agent 设置中重新保存" }.into());
    }
    if output.pbData.is_null() { return Err("Windows 返回的 DeepSeek 密钥为空".into()); }
    let buffer = unsafe { slice::from_raw_parts_mut(output.pbData, output.cbData as usize) };
    let value = buffer.to_vec();
    if !encrypt { buffer.fill(0); }
    unsafe { LocalFree(output.pbData.cast()) };
    Ok(value)
}

#[cfg(not(windows))]
fn protect(_bytes: &[u8], _encrypt: bool) -> Result<Vec<u8>, String> {
    Err("当前平台请通过启动环境提供 DEEPSEEK_API_KEY".into())
}
