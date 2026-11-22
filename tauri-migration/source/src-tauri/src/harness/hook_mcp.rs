use super::hooks::HookDecision;
use futures_util::StreamExt;
use reqwest::{header::HeaderValue, Client, Response, Url};
use serde_json::{json, Value};

const VERSION: &str = "2025-11-25";
const LIMIT: usize = 196_608;

pub fn parse(value: &str) -> Result<(Url, String), String> {
    let (url, name) = value
        .rsplit_once('#')
        .ok_or("MCP 引用格式为 HTTPS 地址#工具名")?;
    let url = Url::parse(url.trim()).map_err(|_| "MCP 地址无效")?;
    let loopback = matches!(url.host_str(), Some("localhost" | "127.0.0.1" | "[::1]"));
    let name = name.trim();
    if !(url.scheme() == "https" || url.scheme() == "http" && loopback)
        || url.host_str().is_none()
        || url.fragment().is_some()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || name.is_empty()
        || name.len() > 128
        || !name
            .bytes()
            .all(|ch| ch.is_ascii_alphanumeric() || b"_.-".contains(&ch))
    {
        return Err("MCP 需要不含凭据的 HTTPS 或回环地址及工具名".into());
    }
    Ok((url, name.into()))
}

async fn read_reply(response: Response, id: u64) -> Result<Value, String> {
    if !response.status().is_success() {
        return Err(format!(
            "MCP 请求失败（HTTP {}）",
            response.status().as_u16()
        ));
    }
    let sse = response
        .headers()
        .get("content-type")
        .and_then(|header| header.to_str().ok())
        .is_some_and(|h| h.starts_with("text/event-stream"));
    let mut stream = response.bytes_stream();
    let mut buffer = Vec::new();
    while let Some(part) = stream.next().await {
        buffer.extend_from_slice(&part.map_err(|_| "MCP 响应中断")?);
        if buffer.len() > LIMIT {
            return Err("MCP Hook 输出超过大小上限".into());
        }
        if sse {
            let Ok(body) = std::str::from_utf8(&buffer) else {
                continue;
            };
            let body = body.replace("\r\n", "\n");
            for packet in body
                .split_inclusive("\n\n")
                .filter(|frame| frame.ends_with("\n\n"))
            {
                let data = packet
                    .lines()
                    .filter_map(|line| line.strip_prefix("data:"))
                    .collect::<Vec<_>>()
                    .join("\n");
                if let Ok(value) = serde_json::from_str::<Value>(&data) {
                    if value["id"].as_u64() == Some(id) {
                        return result(value, id);
                    }
                }
            }
        }
    }
    if sse {
        return Err("MCP 事件流缺少对应响应".into());
    }
    result(
        serde_json::from_slice(&buffer).map_err(|_| "MCP 返回了无效 JSON")?,
        id,
    )
}

fn result(value: Value, id: u64) -> Result<Value, String> {
    if value["id"].as_u64() != Some(id)
        || value["jsonrpc"] != "2.0"
        || !value["error"].is_null()
        || value["result"].is_null()
    {
        return Err("MCP Hook 返回了协议错误".into());
    }
    Ok(value["result"].clone())
}

fn request(
    client: &Client,
    url: &Url,
    version: &str,
    session: Option<&HeaderValue>,
    body: Value,
) -> reqwest::RequestBuilder {
    let mut req = client
        .post(url.clone())
        .header("Accept", "application/json, text/event-stream")
        .json(&body);
    if !version.is_empty() {
        req = req.header("MCP-Protocol-Version", version);
    }
    if let Some(id) = session {
        req = req.header("MCP-Session-Id", id);
    }
    req
}

pub async fn call(source: &[u8], input: &Value) -> Result<HookDecision, String> {
    let (url, name) = parse(std::str::from_utf8(source).map_err(|_| "MCP 引用编码无效")?)?;
    let client = Client::builder()
        .no_proxy()
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?;
    let init=request(&client,&url,"",None,json!({"jsonrpc":"2.0","id":1,"method":"initialize","params":{
        "protocolVersion":VERSION,"capabilities":{},"clientInfo":{"name":"Plate Workbench","version":env!("CARGO_PKG_VERSION")}
    }})).send().await.map_err(|_|"无法连接 MCP Hook 服务")?;
    let session = init.headers().get("MCP-Session-Id").cloned();
    let initialized = read_reply(init, 1).await?;
    let version = initialized["protocolVersion"]
        .as_str()
        .filter(|version| matches!(*version, VERSION | "2025-06-18" | "2025-03-26"))
        .ok_or("MCP 协议版本不受支持")?;
    let run = async {
        let notification = request(
            &client,
            &url,
            version,
            session.as_ref(),
            json!({"jsonrpc":"2.0","method":"notifications/initialized"}),
        )
        .send()
        .await
        .map_err(|_| "MCP 初始化通知失败")?;
        if !notification.status().is_success() {
            return Err("MCP 服务拒绝初始化通知".into());
        }
        let response = request(
            &client,
            &url,
            version,
            session.as_ref(),
            json!({"jsonrpc":"2.0","id":2,"method":"tools/call",
            "params":{"name":name,"arguments":input}}),
        )
        .send()
        .await
        .map_err(|_| "MCP Hook 工具请求失败")?;
        let answer = read_reply(response, 2).await?;
        if answer["isError"] == true {
            return Err("MCP Hook 工具报告失败".into());
        }
        if let Some(data) = answer.get("structuredContent") {
            return serde_json::from_value(data.clone()).map_err(|e| e.to_string());
        }
        let text = answer["content"]
            .as_array()
            .and_then(|content| content.iter().find(|item| item["type"] == "text"))
            .and_then(|item| item["text"].as_str())
            .ok_or("MCP Hook 缺少 JSON 决策")?;
        serde_json::from_str(text).map_err(|error| error.to_string())
    }
    .await;
    if let Some(id) = session {
        let _ = tokio::time::timeout(
            std::time::Duration::from_millis(350),
            client
                .delete(url)
                .header("MCP-Session-Id", id)
                .header("MCP-Protocol-Version", version)
                .send(),
        )
        .await;
    }
    run
}
