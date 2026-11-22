use crate::provider_store::{self, ProviderConfig, ProviderKind};
use futures_util::StreamExt;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::time::Duration;

const STREAM_FRAME_LIMIT: usize = 512 * 1024;
const RESPONSE_LIMIT: usize = 192 * 1024;

#[derive(Default, Clone)]
pub struct ToolCall {
    pub id: String,
    pub name: String,
    pub args: String,
    part: Option<Value>,
}

#[derive(Default)]
pub struct Reply {
    pub text: String,
    calls: BTreeMap<u64, ToolCall>,
    pub input: u64,
    pub output: u64,
    ending: bool,
}

impl Reply {
    pub fn calls(&self) -> impl Iterator<Item = &ToolCall> {
        self.calls.values()
    }
}

pub struct ToolResult {
    pub call: ToolCall,
    pub result: Value,
}

pub enum Turn {
    User(String),
    Assistant(Reply),
    Results(Vec<ToolResult>),
}

fn schema(name: &str, description: &str, fields: &[(&str, &str)]) -> Value {
    let properties = fields
        .iter()
        .map(|(field, hint)| {
            (
                (*field).to_string(),
                json!({"type":"string","description":hint}),
            )
        })
        .collect::<serde_json::Map<String, Value>>();
    json!({"name":name,"description":description,"parameters":{
        "type":"object","properties":properties,
        "required":fields.iter().filter(|(field,_)| !matches!(*field, "rationale" | "offset")).map(|(field,_)| *field).collect::<Vec<_>>(),
    }})
}

fn tools() -> Vec<Value> {
    vec![
        schema(
            "read_hook_context",
            "Read a spill file referenced by a hook in the current run.",
            &[("path","Path from the hook preview"),("offset","Character offset, start at 0")],
        ),
        schema(
            "read_workspace_file",
            "Read a UTF-8 file from the user's approved task directories.",
            &[("path", "Absolute file path")],
        ),
        schema(
            "propose_file_write",
            "Stage a UTF-8 replacement or new file for human review.",
            &[
                ("path", "Absolute file path"),
                ("content", "Complete proposed file content"),
                ("rationale", "Reason for change"),
            ],
        ),
        schema(
            "search_notes",
            "Search the notes authorized for this task.",
            &[("query", "Search term")],
        ),
        schema(
            "search_agent_logs",
            "Search authorized local session summaries.",
            &[("query", "Search term")],
        ),
        schema(
            "propose_note_update",
            "Stage a complete Markdown revision of an authorized note.",
            &[
                ("noteId", "Note ID"),
                ("content", "Complete proposed Markdown"),
                ("rationale", "Reason for change"),
            ],
        ),
    ]
}

fn openai_messages(history: &[Turn]) -> Vec<Value> {
    let mut messages = Vec::new();
    for turn in history {
        match turn {
            Turn::User(text) => messages.push(json!({"role":"user","content":text})),
            Turn::Assistant(reply) => {
                let mut value = json!({"role":"assistant","content":reply.text});
                if !reply.calls.is_empty() {
                    value["tool_calls"] = json!(reply.calls().map(|call| json!({
                        "id":call.id,"type":"function","function":{"name":call.name,"arguments":call.args},
                    })).collect::<Vec<_>>());
                }
                messages.push(value);
            }
            Turn::Results(results) => messages.extend(results.iter().map(|result| {
                json!({
                    "role":"tool","tool_call_id":result.call.id,"content":result.result.to_string(),
                })
            })),
        }
    }
    messages
}

fn anthropic_messages(history: &[Turn]) -> Vec<Value> {
    history
        .iter()
        .map(|turn| match turn {
            Turn::User(text) => json!({"role":"user","content":text}),
            Turn::Assistant(reply) => {
                let mut blocks = Vec::new();
                if !reply.text.is_empty() {
                    blocks.push(json!({"type":"text","text":reply.text}));
                }
                blocks.extend(reply.calls().map(|call| json!({
                "type":"tool_use","id":call.id,"name":call.name,
                "input":serde_json::from_str::<Value>(&call.args).unwrap_or_else(|_| json!({})),
            })));
                json!({"role":"assistant","content":blocks})
            }
            Turn::Results(results) => {
                json!({"role":"user","content":results.iter().map(|result| json!({
            "type":"tool_result","tool_use_id":result.call.id,"content":result.result.to_string(),
        })).collect::<Vec<_>>()})
            }
        })
        .collect()
}

fn gemini_messages(history: &[Turn]) -> Vec<Value> {
    history
        .iter()
        .map(|turn| match turn {
            Turn::User(text) => json!({"role":"user","parts":[{"text":text}]}),
            Turn::Assistant(reply) => {
                let mut parts = Vec::new();
                if !reply.text.is_empty() {
                    parts.push(json!({"text":reply.text}));
                }
                parts.extend(reply.calls().filter_map(|call| call.part.clone()));
                json!({"role":"model","parts":parts})
            }
            Turn::Results(results) => json!({"role":"user","parts":results.iter().map(|result| {
            let mut response = json!({"name":result.call.name,"response":result.result});
            if !result.call.id.is_empty() { response["id"] = json!(result.call.id); }
            json!({"functionResponse":response})
        }).collect::<Vec<_>>()}),
        })
        .collect()
}

fn body(kind: ProviderKind, model: &str, history: &[Turn], limit: u64, allow_tools: bool) -> Value {
    let declarations = if allow_tools { tools() } else { vec![] };
    match kind {
        ProviderKind::Openai | ProviderKind::OpenaiCompatible => {
            let mut request = json!({"model":model,"messages":openai_messages(history),"stream":true,
                "max_completion_tokens":limit});
            if kind == ProviderKind::Openai {
                request["stream_options"] = json!({"include_usage":true});
            } else {
                request
                    .as_object_mut()
                    .unwrap()
                    .remove("max_completion_tokens");
                request["max_tokens"] = json!(limit);
            }
            if allow_tools {
                request["tools"] = json!(declarations
                    .into_iter()
                    .map(|function| json!({"type":"function","function":function}))
                    .collect::<Vec<_>>());
            }
            request
        }
        ProviderKind::Anthropic => {
            let mut request = json!({"model":model,"messages":anthropic_messages(history),"stream":true,"max_tokens":limit});
            if allow_tools {
                request["tools"] = json!(declarations.into_iter().map(|entry| json!({
                    "name":entry["name"],"description":entry["description"],"input_schema":entry["parameters"],
                })).collect::<Vec<_>>());
            }
            request
        }
        ProviderKind::Gemini => {
            let mut request = json!({"contents":gemini_messages(history),"generationConfig":{"maxOutputTokens":limit}});
            if allow_tools {
                request["tools"] = json!([{"functionDeclarations":declarations}]);
            }
            request
        }
    }
}

fn append(target: &mut String, data: Option<&str>) -> Result<(), String> {
    if let Some(data) = data {
        if target.len() + data.len() > RESPONSE_LIMIT {
            return Err("模型流式回复超出长度上限".into());
        }
        target.push_str(data);
    }
    Ok(())
}

fn extend_text(
    reply: &mut Reply,
    text: Option<&str>,
    delta: &mut impl FnMut(&str) -> Result<(), String>,
) -> Result<(), String> {
    append(&mut reply.text, text)?;
    if let Some(value) = text.filter(|value| !value.is_empty()) {
        delta(value)?;
    }
    Ok(())
}

fn update_usage(reply: &mut Reply, input: &Value, output: &Value) {
    reply.input = input.as_u64().unwrap_or(reply.input);
    reply.output = output.as_u64().unwrap_or(reply.output);
}

fn event(
    kind: ProviderKind,
    reply: &mut Reply,
    value: Value,
    delta: &mut impl FnMut(&str) -> Result<(), String>,
) -> Result<(), String> {
    if value.get("error").is_some() || value["type"] == "error" {
        return Err("模型服务返回了流式错误".into());
    }
    match kind {
        ProviderKind::Openai | ProviderKind::OpenaiCompatible => {
            let choice = &value["choices"][0];
            let chunk = &choice["delta"];
            extend_text(reply, chunk["content"].as_str(), delta)?;
            if let Some(calls) = chunk["tool_calls"].as_array() {
                for item in calls {
                    let idx = item["index"].as_u64().unwrap_or(0);
                    if idx >= 16 {
                        return Err("模型单轮工具调用过多".into());
                    }
                    let call = reply.calls.entry(idx).or_default();
                    append(&mut call.id, item["id"].as_str())?;
                    append(&mut call.name, item["function"]["name"].as_str())?;
                    append(&mut call.args, item["function"]["arguments"].as_str())?;
                }
            }
            let usage = &value["usage"];
            update_usage(reply, &usage["prompt_tokens"], &usage["completion_tokens"]);
            reply.ending |= choice["finish_reason"].is_string();
        }
        ProviderKind::Anthropic => {
            let index = value["index"].as_u64().unwrap_or(0);
            let block = &value["content_block"];
            match value["type"].as_str() {
                Some("message_start") => update_usage(
                    reply,
                    &value["message"]["usage"]["input_tokens"],
                    &Value::Null,
                ),
                Some("content_block_start") if block["type"] == "tool_use" => {
                    if reply.calls.len() >= 16 {
                        return Err("模型单轮工具调用过多".into());
                    }
                    reply.calls.insert(
                        index,
                        ToolCall {
                            id: block["id"].as_str().unwrap_or("").into(),
                            name: block["name"].as_str().unwrap_or("").into(),
                            args: if block["input"]
                                .as_object()
                                .is_some_and(|object| !object.is_empty())
                            {
                                block["input"].to_string()
                            } else {
                                String::new()
                            },
                            part: None,
                        },
                    );
                }
                Some("content_block_start") if block["type"] == "text" => {
                    extend_text(reply, block["text"].as_str(), delta)?
                }
                Some("content_block_delta") => {
                    extend_text(reply, value["delta"]["text"].as_str(), delta)?;
                    if let Some(call) = reply.calls.get_mut(&index) {
                        append(&mut call.args, value["delta"]["partial_json"].as_str())?;
                    }
                }
                Some("message_delta") => update_usage(
                    reply,
                    &value["usage"]["input_tokens"],
                    &value["usage"]["output_tokens"],
                ),
                Some("message_stop") => reply.ending = true,
                _ => (),
            }
        }
        ProviderKind::Gemini => {
            let candidate = &value["candidates"][0];
            if let Some(parts) = candidate["content"]["parts"].as_array() {
                for part in parts.iter().filter(|part| part["thought"] != true) {
                    extend_text(reply, part["text"].as_str(), delta)?;
                    if let Some(call) = part.get("functionCall") {
                        if reply.calls.len() >= 16 {
                            return Err("模型单轮工具调用过多".into());
                        }
                        reply.calls.insert(
                            reply.calls.len() as u64,
                            ToolCall {
                                id: call["id"].as_str().unwrap_or("").into(),
                                name: call["name"].as_str().unwrap_or("").into(),
                                args: call["args"].to_string(),
                                part: Some(part.clone()),
                            },
                        );
                    }
                }
            }
            let usage = &value["usageMetadata"];
            if let Some(prompt) = usage["promptTokenCount"].as_u64() {
                reply.input = prompt;
            }
            if usage.get("candidatesTokenCount").is_some()
                || usage.get("thoughtsTokenCount").is_some()
            {
                reply.output = usage["candidatesTokenCount"]
                    .as_u64()
                    .unwrap_or(0)
                    .saturating_add(usage["thoughtsTokenCount"].as_u64().unwrap_or(0));
            }
            reply.ending |= candidate["finishReason"].is_string();
        }
    }
    Ok(())
}

#[derive(Clone, Default)]
pub struct ModelOptions {
    pub temperature: Option<f64>,
    pub reasoning_effort: Option<String>,
}

fn configured_body(kind: ProviderKind, model: &str, history: &[Turn], limit: u64, tools: bool,
    system: &str, options: &ModelOptions) -> Value {
    let mut payload = body(kind, model, history, limit, tools);
    if !system.is_empty() {
        match kind {
            ProviderKind::Openai | ProviderKind::OpenaiCompatible => {
                payload["messages"].as_array_mut().unwrap().insert(0, json!({"role":"system","content":system}));
            }
            ProviderKind::Anthropic => payload["system"] = json!(system),
            ProviderKind::Gemini => payload["systemInstruction"] = json!({"parts":[{"text":system}]}),
        }
    }
    let reasoning = kind == ProviderKind::Openai
        && ["o1","o3","o4","gpt-5"].iter().any(|prefix| model.starts_with(prefix));
    if reasoning {
        if let Some(effort) = &options.reasoning_effort { payload["reasoning_effort"] = json!(effort); }
    } else if let Some(temp) = options.temperature {
        if kind == ProviderKind::Gemini { payload["generationConfig"]["temperature"] = json!(temp); }
        else { payload["temperature"] = json!(temp); }
    }
    payload
}

pub async fn stream(
    provider: &ProviderConfig, key: &str, model: &str, history: &[Turn],
    remaining_cost: f64, allow_tools: bool,
    delta: impl FnMut(&str) -> Result<(), String>,
) -> Result<(Reply, f64), String> {
    stream_configured(provider,key,model,history,remaining_cost,allow_tools,"",&ModelOptions::default(),delta).await
}

pub async fn stream_configured(
    provider: &ProviderConfig,
    key: &str,
    model: &str,
    history: &[Turn],
    remaining_cost: f64,
    allow_tools: bool,
    system: &str,
    options: &ModelOptions,
    mut delta: impl FnMut(&str) -> Result<(), String>,
) -> Result<(Reply, f64), String> {
    let payload = configured_body(provider.kind, model, history, 1024, allow_tools, system, options);
    let input_bound = payload.to_string().len() as u64 + 256;
    let estimated_input_cost = input_bound as f64 * provider.input_price_per_1m / 1_000_000.0;
    if estimated_input_cost > remaining_cost {
        return Err("余额不足以覆盖下一轮预计输入成本".into());
    }
    let limit = if provider.output_price_per_1m > 0.0 {
        ((remaining_cost - estimated_input_cost) * 1_000_000.0 / provider.output_price_per_1m)
            .floor()
            .min(1024.0) as u64
    } else {
        1024
    };
    if limit < 16 {
        return Err("余额不足以覆盖下一轮回复".into());
    }
    let url = provider_store::normalized_endpoint(provider)?;
    let address = match provider.kind {
        ProviderKind::Openai | ProviderKind::OpenaiCompatible => format!("{url}/chat/completions"),
        ProviderKind::Anthropic => format!("{url}/messages"),
        ProviderKind::Gemini => {
            let model = model.strip_prefix("models/").unwrap_or(model);
            if !model
                .bytes()
                .all(|ch| ch.is_ascii_alphanumeric() || b"-_.".contains(&ch))
            {
                return Err("Gemini 模型标识无效".into());
            }
            format!("{url}/models/{model}:streamGenerateContent?alt=sse")
        }
    };
    let request = provider_store::http_client()?
        .post(address)
        .timeout(Duration::from_secs(90))
        .json(&configured_body(provider.kind, model, history, limit, allow_tools, system, options));
    let response = provider
        .kind
        .authenticate(request, key)
        .send()
        .await
        .map_err(|_| "模型服务请求失败，请检查地址与网络".to_string())?;
    if !response.status().is_success() {
        return Err(format!(
            "模型请求失败（HTTP {}）",
            response.status().as_u16()
        ));
    }
    let mut reply = Reply::default();
    let mut stream = response.bytes_stream();
    let mut buffer = Vec::new();
    let mut data = String::new();
    'sse: while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|_| "模型流连接中断".to_string())?;
        buffer.extend_from_slice(&chunk);
        if buffer.len() > STREAM_FRAME_LIMIT {
            return Err("模型流事件超出长度上限".into());
        }
        let mut consumed = 0;
        for line in buffer.split_inclusive(|byte| *byte == b'\n') {
            if !line.ends_with(b"\n") {
                break;
            }
            consumed += line.len();
            let text = std::str::from_utf8(line)
                .map_err(|_| "模型流不是 UTF-8")?
                .trim_end_matches(['\r', '\n']);
            if let Some(payload) = text.strip_prefix("data:") {
                if !data.is_empty() {
                    data.push('\n');
                }
                append(
                    &mut data,
                    Some(payload.strip_prefix(' ').unwrap_or(payload)),
                )?;
            } else if text.is_empty() && !data.is_empty() {
                if data == "[DONE]" {
                    reply.ending = true;
                    break 'sse;
                }
                let value = serde_json::from_str(&data).map_err(|_| "模型流事件 JSON 无效")?;
                event(provider.kind, &mut reply, value, &mut delta)?;
                data.clear();
            }
        }
        buffer.drain(..consumed);
    }
    if !reply.ending {
        return Err("模型流未正常结束".into());
    }
    if reply.text.is_empty() && reply.calls.is_empty() {
        return Err("模型没有返回文字或工具调用".into());
    }
    if reply.input == 0 {
        reply.input = input_bound;
    }
    if reply.output == 0 {
        reply.output = limit;
    }
    let cost = (reply.input as f64 * provider.input_price_per_1m
        + reply.output as f64 * provider.output_price_per_1m)
        / 1_000_000.0;
    Ok((reply, cost))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn fragmented_openai_and_anthropic_tool_input_reassemble() {
        let mut reply = Reply::default();
        let mut delta = |_: &str| Ok(());
        for args in ["{\"path\":", "\"notes.md\"}"] {
            event(
                ProviderKind::Openai,
                &mut reply,
                json!({"choices":[{"delta":{"tool_calls":[
                    {"index":0,"function":{"arguments":args}}
                ]}}]}),
                &mut delta,
            )
            .unwrap();
        }
        assert_eq!(
            reply.calls().next().unwrap().args,
            "{\"path\":\"notes.md\"}"
        );
        let mut reply = Reply::default();
        event(ProviderKind::Anthropic, &mut reply, json!({
            "type":"content_block_start","index":2,"content_block":{"type":"tool_use","id":"t","name":"search_notes","input":{}}
        }), &mut delta).unwrap();
        event(ProviderKind::Anthropic, &mut reply, json!({
            "type":"content_block_delta","index":2,"delta":{"partial_json":"{\"query\":\"fixture\"}"}
        }), &mut delta).unwrap();
        assert_eq!(
            reply.calls().next().unwrap().args,
            "{\"query\":\"fixture\"}"
        );
    }

    #[test]
    fn gemini_round_trips_tool_signature() {
        let mut reply = Reply::default();
        event(ProviderKind::Gemini, &mut reply, json!({"candidates":[{"content":{"parts":[
            {"functionCall":{"name":"read_workspace_file","args":{"path":"fixture"}},"thoughtSignature":"signature"}
        ]},"finishReason":"STOP"}]}), &mut |_| Ok(())).unwrap();
        let messages = gemini_messages(&[Turn::Assistant(reply)]);
        assert_eq!(messages[0]["parts"][0]["thoughtSignature"], "signature");
    }
}

impl ToolCall {
    pub fn proposal(args: Value) -> Self {
        let tool = if args.get("noteId").is_some() { "propose_note_update" } else { "propose_file_write" };
        Self {
            name: tool.into(),
            args: args.to_string(),
            ..Self::default()
        }
    }
}
