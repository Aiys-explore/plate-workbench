use crate::{notes::now_ms, with_store, AppState};
use keyring::Entry;
use reqwest::{Client, RequestBuilder, Url};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tauri::State;

const SERVICE: &str = "local.plate.workbench.providers";
const SELECT: &str = "SELECT id, name, kind, base_url, default_model, roles_json, key_hint,
    input_price_per_1m, output_price_per_1m, enabled, updated_at FROM llm_providers";

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ProviderKind {
    Openai,
    Anthropic,
    Gemini,
    OpenaiCompatible,
}

impl ProviderKind {
    fn as_str(self) -> &'static str {
        match self {
            Self::Openai => "openai",
            Self::Anthropic => "anthropic",
            Self::Gemini => "gemini",
            Self::OpenaiCompatible => "openai_compatible",
        }
    }

    pub fn authenticate(self, request: RequestBuilder, secret: &str) -> RequestBuilder {
        match self {
            Self::Openai | Self::OpenaiCompatible => request.bearer_auth(secret),
            Self::Anthropic => request
                .header("x-api-key", secret)
                .header("anthropic-version", "2023-06-01"),
            Self::Gemini => request.header("x-goog-api-key", secret),
        }
    }
}

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ModelRole {
    WorkbenchChat,
    BrainConsolidator,
    Embedding,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderConfig {
    pub id: String,
    pub name: String,
    pub kind: ProviderKind,
    pub base_url: String,
    pub default_model: String,
    pub roles: Vec<ModelRole>,
    pub key_hint: String,
    pub input_price_per_1m: f64,
    pub output_price_per_1m: f64,
    pub enabled: bool,
    pub updated_at: i64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpsertProviderInput {
    id: Option<String>,
    name: String,
    kind: ProviderKind,
    base_url: String,
    default_model: String,
    roles: Vec<ModelRole>,
    api_key: Option<String>,
    input_price_per_1m: f64,
    output_price_per_1m: f64,
    enabled: bool,
}

fn decode<T: serde::de::DeserializeOwned>(
    value: serde_json::Value,
    index: usize,
) -> rusqlite::Result<T> {
    serde_json::from_value(value).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            index,
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })
}

fn from_row(row: &Row<'_>) -> rusqlite::Result<ProviderConfig> {
    let roles: String = row.get(5)?;
    let roles = serde_json::from_str(&roles).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(5, rusqlite::types::Type::Text, Box::new(error))
    })?;
    Ok(ProviderConfig {
        id: row.get(0)?,
        name: row.get(1)?,
        kind: decode(serde_json::Value::String(row.get(2)?), 2)?,
        base_url: row.get(3)?,
        default_model: row.get(4)?,
        roles,
        key_hint: row.get(6)?,
        input_price_per_1m: row.get(7)?,
        output_price_per_1m: row.get(8)?,
        enabled: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

fn list(conn: &Connection) -> Result<Vec<ProviderConfig>, String> {
    let mut stmt = conn
        .prepare(&format!("{SELECT} ORDER BY updated_at DESC, id"))
        .map_err(db_error)?;
    let rows = stmt.query_map([], from_row).map_err(db_error)?;
    rows.collect::<rusqlite::Result<_>>().map_err(db_error)
}

pub fn get(conn: &Connection, id: &str) -> Result<ProviderConfig, String> {
    conn.query_row(&format!("{SELECT} WHERE id=?1"), [id], from_row)
        .optional()
        .map_err(db_error)?
        .ok_or_else(|| "找不到该模型服务商".into())
}

fn db_error(error: rusqlite::Error) -> String {
    format!("模型服务商数据库操作失败：{error}")
}

fn entry(id: &str) -> Result<Entry, String> {
    #[cfg(any(windows, target_os = "macos"))]
    return Entry::new(SERVICE, id).map_err(|_| "无法打开系统钥匙串".into());
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = id;
        Err("此平台尚未配置系统钥匙串".into())
    }
}

fn read_secret(entry: &Entry) -> Result<Option<String>, String> {
    match entry.get_password() {
        Ok(key) => Ok(Some(key)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err("无法读取系统钥匙串".into()),
    }
}

pub fn load_secret_key(id: &str) -> Result<String, String> {
    read_secret(&entry(id)?)?.ok_or_else(|| "请先为该服务商保存 API Key".into())
}

fn remove_secret(entry: &Entry) -> Result<(), String> {
    match entry.delete_credential() {
        Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
        Err(_) => Err("无法删除系统钥匙串中的 API Key".into()),
    }
}

fn replace_secret(entry: &Entry, value: Option<&str>) -> Result<(), String> {
    match value {
        Some(key) => entry
            .set_password(key)
            .map_err(|_| "无法写入系统钥匙串".into()),
        None => remove_secret(entry),
    }
}

fn normalize_url(kind: ProviderKind, value: &str) -> Result<String, String> {
    let url = Url::parse(value.trim()).map_err(|_| "请输入完整的服务地址")?;
    let loopback = url.host_str().is_some_and(|host| {
        host.eq_ignore_ascii_case("localhost")
            || host
                .trim_matches(['[', ']'])
                .parse::<std::net::IpAddr>()
                .is_ok_and(|address| address.is_loopback())
    });
    if url.host().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || (url.scheme() != "https"
            && !(url.scheme() == "http" && kind == ProviderKind::OpenaiCompatible && loopback))
    {
        return Err(
            "请使用无账号、查询参数或片段的 HTTPS 地址。本机兼容服务可以使用回环 HTTP 地址。"
                .into(),
        );
    }
    Ok(url.as_str().trim_end_matches('/').to_string())
}

fn upsert(conn: &Connection, input: UpsertProviderInput) -> Result<ProviderConfig, String> {
    let name = input.name.trim();
    let model = input.default_model.trim();
    if name.is_empty() || name.len() > 240 || model.is_empty() || model.len() > 240 {
        return Err("请填写有效的服务商名称和默认模型".into());
    }
    if [input.input_price_per_1m, input.output_price_per_1m]
        .into_iter()
        .any(|price| !price.is_finite() || price < 0.0)
    {
        return Err("每百万 token 价格必须为非负数字".into());
    }
    let base_url = normalize_url(input.kind, &input.base_url)?;
    let key = input
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|key| !key.is_empty());
    if key.is_some_and(|value| {
        value.len() > 2048 || !value.bytes().all(|byte| byte.is_ascii_graphic())
    }) {
        return Err("API Key 含有不支持的字符或长度超限".into());
    }
    let existing = input.id.as_deref().map(|id| get(conn, id)).transpose()?;
    if let Some(old) = &existing {
        if !old.key_hint.is_empty()
            && key.is_none()
            && (old.base_url != base_url || old.kind != input.kind)
        {
            return Err("更改服务地址或类型时，请重新填写要用于该服务的 API Key".into());
        }
    }
    let id = existing
        .as_ref()
        .map(|old| old.id.clone())
        .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
    let mut roles = Vec::new();
    for role in input.roles {
        if !roles.contains(&role) {
            roles.push(role);
        }
    }
    let key_hint = match key {
        Some(value) if value.len() >= 8 => format!("…{}", &value[value.len() - 4..]),
        Some(_) => "••••".into(),
        None => existing
            .as_ref()
            .map(|old| old.key_hint.clone())
            .unwrap_or_default(),
    };
    let updated_at = now_ms();
    let roles_json = serde_json::to_string(&roles).map_err(|error| error.to_string())?;
    let tx = conn.unchecked_transaction().map_err(db_error)?;
    tx.execute(
        "INSERT INTO llm_providers (id, name, kind, base_url, default_model, roles_json, key_hint,
            input_price_per_1m, output_price_per_1m, enabled, updated_at)
        VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
        ON CONFLICT(id) DO UPDATE SET name=excluded.name, kind=excluded.kind, base_url=excluded.base_url,
            default_model=excluded.default_model, roles_json=excluded.roles_json, key_hint=excluded.key_hint,
            input_price_per_1m=excluded.input_price_per_1m, output_price_per_1m=excluded.output_price_per_1m,
            enabled=excluded.enabled, updated_at=excluded.updated_at",
        params![id, name, input.kind.as_str(), base_url, model, roles_json, key_hint,
            input.input_price_per_1m, input.output_price_per_1m, input.enabled, updated_at],
    ).map_err(db_error)?;
    let credential_change = if let Some(key) = key {
        let entry = entry(&id)?;
        let previous = read_secret(&entry)?;
        replace_secret(&entry, Some(key))?;
        Some((entry, previous))
    } else {
        None
    };
    if let Err(error) = tx.commit() {
        if let Some((entry, previous)) = credential_change {
            replace_secret(&entry, previous.as_deref())?;
        }
        return Err(db_error(error));
    }
    get(conn, &id)
}

fn delete(conn: &Connection, id: &str) -> Result<(), String> {
    let provider = get(conn, id)?;
    let tx = conn.unchecked_transaction().map_err(db_error)?;
    tx.execute("DELETE FROM llm_providers WHERE id=?1", [id])
        .map_err(db_error)?;
    let credential_change = if provider.key_hint.is_empty() {
        None
    } else {
        let entry = entry(id)?;
        let previous = read_secret(&entry)?;
        remove_secret(&entry)?;
        Some((entry, previous))
    };
    if let Err(error) = tx.commit() {
        if let Some((entry, previous)) = credential_change {
            replace_secret(&entry, previous.as_deref())?;
        }
        return Err(db_error(error));
    }
    Ok(())
}

pub fn http_client() -> Result<Client, String> {
    Client::builder()
        .connect_timeout(Duration::from_secs(8))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|_| "无法初始化模型服务连接".into())
}

#[tauri::command]
pub fn provider_list(state: State<'_, AppState>) -> Result<Vec<ProviderConfig>, String> {
    with_store(&state, |store| list(&store.conn.lock().unwrap()))
}

#[tauri::command]
pub fn provider_upsert(
    state: State<'_, AppState>,
    input: UpsertProviderInput,
) -> Result<ProviderConfig, String> {
    with_store(&state, |store| upsert(&store.conn.lock().unwrap(), input))
}

#[tauri::command]
pub fn provider_delete(state: State<'_, AppState>, id: String) -> Result<(), String> {
    with_store(&state, |store| delete(&store.conn.lock().unwrap(), &id))
}

#[tauri::command]
pub async fn provider_test_connection(
    state: State<'_, AppState>,
    id: String,
) -> Result<(), String> {
    let (config, key) = with_store(&state, |store| {
        let config = get(&store.conn.lock().unwrap(), &id)?;
        if !config.enabled {
            return Err("请先启用该服务商".into());
        }
        Ok((config, load_secret_key(&id)?))
    })?;
    let base = normalize_url(config.kind, &config.base_url)?;
    let request = http_client()?
        .get(format!("{base}/models"))
        .timeout(Duration::from_secs(15));
    let response = config
        .kind
        .authenticate(request, &key)
        .send()
        .await
        .map_err(|_| "无法连接模型服务，请检查地址与网络".to_string())?;
    if response.status().is_success() {
        Ok(())
    } else {
        Err(format!(
            "模型列表请求失败（HTTP {}）",
            response.status().as_u16()
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn provider_url_rejects_embedded_credentials_and_remote_http() {
        assert!(normalize_url(ProviderKind::Openai, "https://user@host.example/v1").is_err());
        assert!(normalize_url(ProviderKind::Openai, "https://host.example/v1?key=secret").is_err());
        assert!(normalize_url(ProviderKind::OpenaiCompatible, "http://host.example/v1").is_err());
        assert_eq!(
            normalize_url(ProviderKind::OpenaiCompatible, "http://127.0.0.1:8080/v1/").unwrap(),
            "http://127.0.0.1:8080/v1"
        );
    }

    #[test]
    #[cfg(windows)]
    fn provider_key_round_trips_in_windows_vault_without_entering_sqlite() -> Result<(), String> {
        let conn = Connection::open_in_memory().map_err(db_error)?;
        crate::db::migrate_s10(&conn).map_err(db_error)?;
        let key = format!("plate-test-{}", uuid::Uuid::new_v4());
        let input = UpsertProviderInput {
            id: None,
            name: "Test".into(),
            kind: ProviderKind::Openai,
            base_url: "https://api.openai.com/v1".into(),
            default_model: "fixture".into(),
            roles: vec![ModelRole::WorkbenchChat],
            api_key: Some(key.clone()),
            input_price_per_1m: 0.0,
            output_price_per_1m: 0.0,
            enabled: true,
        };
        let saved = upsert(&conn, input)?;
        let checked = (|| {
            assert_eq!(load_secret_key(&saved.id)?, key);
            let listed = list(&conn)?.pop().ok_or("missing provider")?;
            let serialized = serde_json::to_string(&listed).map_err(|error| error.to_string())?;
            assert!(!serialized.contains(&key));
            assert_eq!(listed.key_hint, format!("…{}", &key[key.len() - 4..]));
            Ok::<_, String>(())
        })();
        let removed = delete(&conn, &saved.id);
        checked?;
        removed?;
        assert!(load_secret_key(&saved.id).is_err());
        Ok(())
    }
}
