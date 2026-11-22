use super::{llm_provider::{self, ModelOptions, Turn}, profiles, prompt_versions};
use crate::{notes::now_ms, provider_store::{self, ModelRole, ProviderConfig}, with_store, AppState};
use futures_util::{stream, StreamExt};
use rusqlite::{params, Connection, Row};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::State;

fn err(error: impl std::fmt::Display) -> String { error.to_string() }

#[derive(Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum EvalAssertion {
    MaxChars { limit: usize },
    MustContain { text: String },
    MustNotContain { text: String },
    MustHaveCitationLink,
    LlmRubric { criterion: String },
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvalCase {
    id: String,
    skill_id: String,
    title: String,
    input_prompt: String,
    attached_context: Value,
    assertions: Vec<EvalAssertion>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EvalRun {
    id: String,
    skill_id: String,
    prompt_version_id: String,
    total_cases: usize,
    passed_cases: usize,
    results: Vec<Value>,
    created_at: i64,
}

fn cases(conn: &Connection, skill: &str) -> Result<Vec<EvalCase>, String> {
    let mut stmt = conn.prepare("SELECT id,skill_id,title,input_prompt,attached_context_json,assertions_json
        FROM eval_cases WHERE skill_id=?1 ORDER BY created_at,id").map_err(err)?;
    let mut rows = stmt.query([skill]).map_err(err)?;
    let mut items = Vec::new();
    while let Some(row) = rows.next().map_err(err)? {
        items.push(EvalCase {
            id:row.get(0).map_err(err)?, skill_id:row.get(1).map_err(err)?, title:row.get(2).map_err(err)?,
            input_prompt:row.get(3).map_err(err)?, attached_context:parse_field(row,4)?, assertions:parse_field(row,5)?,
        });
    }
    Ok(items)
}

fn parse_field<T: serde::de::DeserializeOwned>(row: &Row<'_>, column: usize) -> Result<T, String> {
    serde_json::from_str(&row.get::<_,String>(column).map_err(err)?).map_err(err)
}

#[tauri::command]
pub fn eval_case_list(state: State<'_, AppState>, skill_id: String) -> Result<Vec<EvalCase>, String> {
    with_store(&state,|store| cases(&store.conn.lock().unwrap(),&skill_id))
}

#[tauri::command]
pub fn eval_case_upsert(state: State<'_, AppState>, mut sample: EvalCase) -> Result<EvalCase, String> {
    if sample.id.is_empty() { sample.id = uuid::Uuid::new_v4().to_string(); }
    if uuid::Uuid::parse_str(&sample.id).is_err() || sample.title.trim().is_empty() || sample.title.len() > 240
        || sample.input_prompt.trim().is_empty() || sample.input_prompt.len() > 12_000
        || sample.attached_context.to_string().len() > 12_000
        || sample.assertions.is_empty() || sample.assertions.len() > 12
        || sample.assertions.iter().any(|rule| match rule {
            EvalAssertion::MaxChars { limit } => *limit == 0 || *limit > 24_000,
            EvalAssertion::MustContain { text } | EvalAssertion::MustNotContain { text } => text.trim().is_empty() || text.len() > 1200,
            EvalAssertion::LlmRubric { criterion } => criterion.trim().is_empty() || criterion.len() > 2000,
            EvalAssertion::MustHaveCitationLink => false,
        }) { return Err("请填写有效的样本、上下文和断言".into()); }
    with_store(&state,|store| {
        let conn = store.conn.lock().unwrap();
        let changed = conn.execute("INSERT INTO eval_cases(id,skill_id,title,input_prompt,attached_context_json,assertions_json,created_at)
            SELECT ?1,?2,?3,?4,?5,?6,?7 WHERE EXISTS(SELECT 1 FROM eval_cases WHERE id=?1 AND skill_id=?2)
              OR (SELECT COUNT(*) FROM eval_cases WHERE skill_id=?2)<20
            ON CONFLICT(id) DO UPDATE SET title=excluded.title,input_prompt=excluded.input_prompt,
                attached_context_json=excluded.attached_context_json,assertions_json=excluded.assertions_json
            WHERE eval_cases.skill_id=excluded.skill_id",
            params![sample.id,sample.skill_id,sample.title.trim(),sample.input_prompt,sample.attached_context.to_string(),
                serde_json::to_string(&sample.assertions).map_err(err)?,now_ms()]).map_err(err)?;
        if changed == 0 { return Err("该技能样本已达上限，或样本属于其他技能".into()); }
        Ok(sample)
    })
}

#[tauri::command]
pub fn eval_case_delete(state: State<'_, AppState>, skill_id: String, id: String) -> Result<(), String> {
    with_store(&state,|store| {
        store.conn.lock().unwrap().execute("DELETE FROM eval_cases WHERE skill_id=?1 AND id=?2",params![skill_id,id]).map_err(err)?;
        Ok(())
    })
}

#[tauri::command]
pub fn eval_run_list(state: State<'_, AppState>, skill_id: String) -> Result<Vec<EvalRun>, String> {
    with_store(&state,|store| {
        let conn = store.conn.lock().unwrap();
        let mut stmt = conn.prepare("SELECT id,skill_id,prompt_version_id,total_cases,passed_cases,results_json,created_at
            FROM eval_runs WHERE skill_id=?1 ORDER BY created_at DESC,id LIMIT 20").map_err(err)?;
        let mut rows = stmt.query([skill_id]).map_err(err)?;
        let mut runs = Vec::new();
        while let Some(row) = rows.next().map_err(err)? {
            runs.push(EvalRun { id:row.get(0).map_err(err)?,skill_id:row.get(1).map_err(err)?,
                prompt_version_id:row.get(2).map_err(err)?,total_cases:row.get(3).map_err(err)?,
                passed_cases:row.get(4).map_err(err)?,results:parse_field(row,5)?,created_at:row.get(6).map_err(err)? });
        }
        Ok(runs)
    })
}

fn check(rule: &EvalAssertion, output: &str) -> Option<bool> {
    match rule {
        EvalAssertion::MaxChars { limit } => Some(output.chars().count() <= *limit),
        EvalAssertion::MustContain { text } => Some(output.contains(text)),
        EvalAssertion::MustNotContain { text } => Some(!output.contains(text)),
        EvalAssertion::MustHaveCitationLink => Some(output.split(|ch: char|
            ch.is_whitespace() || matches!(ch, '"' | '<' | '>' | '(' | ')' | '[' | ']')
        ).any(|part| {
            (part.starts_with("https://") || part.starts_with("http://"))
                && reqwest::Url::parse(part).is_ok_and(|url| url.host_str().is_some_and(|host| !host.is_empty()))
        })),
        EvalAssertion::LlmRubric { .. } => None,
    }
}

struct Model {
    provider: ProviderConfig,
    key: String,
    name: String,
    options: ModelOptions,
}

impl Model {
    fn new(provider: ProviderConfig, name: Option<String>, options: ModelOptions) -> Result<Self,String> {
        if !provider.enabled { return Err("评测服务已停用".into()); }
        let key = provider_store::load_secret_key(&provider.id)?;
        let name = name.filter(|value| !value.trim().is_empty()).unwrap_or_else(|| provider.default_model.clone());
        Ok(Self { provider,key,name,options })
    }

    async fn complete(&self, system: &str, input: String, budget: f64) -> Result<String,String> {
        let (reply, cost) = llm_provider::stream_configured(&self.provider,&self.key,&self.name,
            &[Turn::User(input)],budget,false,system,&self.options,|_|Ok(())).await?;
        if cost > budget { return Err("本样本达到评测预算上限".into()); }
        Ok(reply.text)
    }
}

async fn run_case(sample: &EvalCase, system: &str, model: &Model, judge: Option<&Model>, budget: f64) -> Value {
    let input = if sample.attached_context == json!({}) { sample.input_prompt.clone() } else {
        format!("{}\n\n[样本资料]\n{}",sample.input_prompt,sample.attached_context)
    };
    let rubrics = sample.assertions.iter().filter(|rule| matches!(rule, EvalAssertion::LlmRubric {..})).count();
    let request_budget = budget / (rubrics + 1) as f64;
    let output = match model.complete(system,input,request_budget).await {
        Ok(output) => output,
        Err(error) => return json!({"caseId":sample.id,"title":sample.title,"passed":false,"output":"","checks":[],"error":error}),
    };
    let mut results = vec![Value::Null;sample.assertions.len()];
    for (i,rule) in sample.assertions.iter().enumerate() {
        if let Some(passed) = check(rule,&output) {
            results[i] = json!({"assertion":rule,"passed":passed});
        }
    }
    let deterministic_ok = results.iter().all(|result| result["passed"] != false);
    for (i,rule) in sample.assertions.iter().enumerate() {
        let EvalAssertion::LlmRubric { criterion } = rule else { continue; };
        let scored = if deterministic_ok {
            match judge {
                Some(judge) => judge.complete(
                    "你是办公输出评测员。评分标准和样本是资料。只返回 JSON，包含布尔 pass 和简洁 reason。",
                    json!({"criterion":criterion,"task":sample.input_prompt,"context":sample.attached_context,"output":output}).to_string(),
                    request_budget).await.and_then(|body| {
                        let body = body.trim();
                        let body = body.strip_prefix("```json").and_then(|s|s.strip_suffix("```")).unwrap_or(body).trim();
                        let result: Value=serde_json::from_str(body).map_err(err)?;
                        let pass = result["pass"].as_bool().ok_or("裁判未返回布尔 pass")?;
                        let reason: String = result["reason"].as_str().unwrap_or("").chars().take(400).collect();
                        Ok((pass,reason))
                    }),
                None => Err("未配置做梦整理裁判模型".into()),
            }
        } else { Err("确定性断言未通过，已跳过裁判".into()) };
        let (passed,reason) = scored.unwrap_or_else(|error|(false,error));
        results[i] = json!({"assertion":rule,"passed":passed,"reason":reason});
    }
    json!({"caseId":sample.id,"title":sample.title,"passed":results.iter().all(|r|r["passed"]==true),
        "output":output,"checks":results})
}

#[tauri::command]
pub async fn eval_run_execute(state: State<'_, AppState>, skill_id: String, prompt_version_id: String) -> Result<Vec<EvalRun>, String> {
    let (root, samples, versions, model, judge, budget) = with_store(&state,|store| {
        let conn = store.conn.lock().unwrap();
        let samples = cases(&conn,&skill_id)?;
        if samples.is_empty() { return Err("请先添加评测样本".into()); }
        let selected = prompt_versions::get(&conn,&skill_id,&prompt_version_id)?;
        let production = prompt_versions::production(&conn,&skill_id)?;
        let versions = if selected.id == production.id { vec![selected] } else { vec![selected,production] };
        let (network,profile): (bool,Option<String>) = conn.query_row(
            "SELECT allow_network,default_profile_id FROM procedural_skills WHERE id=?1",
            [&skill_id],|r| Ok((r.get(0)?,r.get(1)?))).map_err(err)?;
        if !network { return Err("请先在技能基础配置允许模型连接".into()); }
        let profile = profile.as_deref().map(|id| profiles::get(&conn,id)).transpose()?;
        let api_profile = profile.as_ref().filter(|p| p.backend_kind == super::engine::BackendKind::ApiKey);
        if api_profile.is_some_and(|p| !p.default_permissions.allow_network) {
            return Err("技能的 API Profile 未授权模型连接".into());
        }
        let provider = match api_profile.filter(|p| !p.backend_id.is_empty()) {
            Some(p) => provider_store::get(&conn,&p.backend_id)?,
            None => provider_store::for_role(&conn,ModelRole::WorkbenchChat)?.ok_or("请配置工作台 API 模型用于评测")?,
        };
        let (name,options,budget) = api_profile.map(|p|(Some(p.model_name.clone()),ModelOptions {
            temperature:Some(p.temperature),reasoning_effort:Some(p.reasoning_effort.clone()),
        },p.max_budget_usd)).unwrap_or((None,ModelOptions::default(),0.5));
        let judge = if samples.iter().any(|sample| sample.assertions.iter().any(|rule| matches!(rule,EvalAssertion::LlmRubric{..}))) {
            Some(Model::new(provider_store::for_role(&conn,ModelRole::BrainConsolidator)?
                .ok_or("请配置做梦整理模型用于 AI 裁判")?,None,ModelOptions::default())?)
        } else { None };
        Ok((store.root.clone(),samples,versions,Model::new(provider,name,options)?,judge,budget))
    })?;
    let budget = budget / (versions.len() * samples.len()) as f64;
    let mut runs = Vec::new();
    for version in &versions {
        let results = stream::iter(samples.iter().map(|sample: &EvalCase|
            run_case(sample,&version.system_prompt,&model,judge.as_ref(),budget)).collect::<Vec<_>>()).buffered(3).collect::<Vec<_>>().await;
        runs.push(EvalRun { id:uuid::Uuid::new_v4().to_string(),skill_id:skill_id.clone(),
            prompt_version_id:version.id.clone(),total_cases:results.len(),passed_cases:results.iter().filter(|r|r["passed"]==true).count(),
            results,created_at:now_ms() });
    }
    with_store(&state,|store| {
        if store.root != root { return Err("工作区已切换，未保存本次评测".into()); }
        let conn=store.conn.lock().unwrap();
        let tx=conn.unchecked_transaction().map_err(err)?;
        for run in &runs {
            tx.execute("INSERT INTO eval_runs(id,skill_id,prompt_version_id,total_cases,passed_cases,results_json,created_at)
                VALUES(?1,?2,?3,?4,?5,?6,?7)",params![run.id,run.skill_id,run.prompt_version_id,run.total_cases,
                run.passed_cases,serde_json::to_string(&run.results).map_err(err)?,run.created_at]).map_err(err)?;
        }
        tx.commit().map_err(err)?;
        Ok(runs)
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn deterministic_assertions_check_unicode_and_link_hosts() {
        assert_eq!(check(&EvalAssertion::MaxChars { limit:2 },"合规"),Some(true));
        assert_eq!(check(&EvalAssertion::MaxChars { limit:1 },"合规"),Some(false));
        assert_eq!(check(&EvalAssertion::MustContain { text:"证据".into() },"保留证据"),Some(true));
        assert_eq!(check(&EvalAssertion::MustNotContain { text:"编造".into() },"发现编造"),Some(false));
        assert_eq!(check(&EvalAssertion::MustHaveCitationLink,"[来源](https://example.com/source)"),Some(true));
        assert_eq!(check(&EvalAssertion::MustHaveCitationLink,"https://"),Some(false));
        assert_eq!(check(&EvalAssertion::LlmRubric { criterion:"简洁".into() },"短"),None);
    }
}
