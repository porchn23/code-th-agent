//! หัวใจของ agent — agent loop (เทียบ agentLoopCore ใน research-agent.js)
//!
//! วงจร: ส่ง (task + ประวัติ + tools) → โมเดลตอบ → รัน tool → ยัดผลกลับ → ตัดของเก่า → วน
//! orchestrator (depth 0) และ sub-agent (depth 1) ใช้ฟังก์ชันเดียวกัน

pub mod calc;
pub mod checkpoint;
pub mod evals;
pub mod exec;
pub mod llm;
pub mod playbook;
pub mod prompt;
pub mod skills;
pub mod tools;

use crate::config::Config;
use crate::error::{AppError, Result};
use crate::state::{PlanFile, Store};
use exec::ToolCtx;
use llm::{est_tok, LlmClient, LlmMessage};
use parking_lot::RwLock;
use prompt::PlanInjection;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

pub const MAX_SUBAGENT_DEPTH: u32 = 1;

/// เหตุการณ์ที่ส่งไป UI — ชื่อ type ตรงกับ SSE ของเวอร์ชัน JS
#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", content = "data", rename_all = "kebab-case")]
pub enum AgentEvent {
    Log(String),
    Answer(String),
    AnswerDelta(String),
    AnswerReset,
    Error(String),
    Run(exec::RunResult),
    Plan(PlanFile),
    Queued,
}

pub type EventSink = Arc<dyn Fn(AgentEvent) + Send + Sync>;

/// ข้อความในประวัติแชท (จาก UI)
#[derive(Debug, Clone)]
pub struct ChatMsg {
    pub role: String,
    pub content: String,
}

/// ตัวเลือกของการรัน 1 ครั้ง
pub struct RunOptions {
    pub depth: u32,
    /// ถ้าไม่ระบุ → สร้างจาก get_tools(mode)
    pub tools: Option<Vec<Value>>,
    pub max_steps: usize,
    pub no_banner: bool,
    pub temp: Option<f32>,
    pub history: Vec<ChatMsg>,
    pub mode: String,
    pub plan_mode: bool,
    pub approved_plan: Option<PlanInjection>,
    pub root: Option<PathBuf>,
    pub trusted: bool,
    pub signal: Arc<AtomicBool>,
    pub emit: EventSink,
    /// ส่งผล run_command เข้าแผง run ของ UI
    pub on_run: Option<exec::RunSink>,
    /// ส่งแผนที่อัปเดตเข้า UI (การ์ดแผน)
    pub on_plan: Option<exec::PlanSink>,
}

impl Default for RunOptions {
    fn default() -> Self {
        RunOptions {
            depth: 0,
            tools: None,
            max_steps: 12,
            no_banner: false,
            temp: None,
            history: Vec::new(),
            mode: "research".to_string(),
            plan_mode: false,
            approved_plan: None,
            root: None,
            trusted: true,
            signal: Arc::new(AtomicBool::new(false)),
            emit: Arc::new(|_| {}),
            on_run: None,
            on_plan: None,
        }
    }
}

/// โครงสร้างหลักของ agent (แชร์กันทั้งแอป)
#[derive(Clone)]
pub struct Agent {
    pub config: Arc<RwLock<Config>>,
    pub store: Store,
    pub llm: Arc<LlmClient>,
}

impl Agent {
    pub fn new(config: Arc<RwLock<Config>>, store: Store) -> Self {
        Agent {
            config,
            store,
            llm: Arc::new(LlmClient::new()),
        }
    }
}

/// ตัดผล tool เก่าให้สั้นลง (token thrift) — เทียบ trimToolResults ใน JS
fn trim_tool_results(messages: &mut [Value], keep: usize, trim_chars: usize) {
    let idx: Vec<usize> = messages
        .iter()
        .enumerate()
        .filter(|(_, m)| m.get("role").and_then(|v| v.as_str()) == Some("tool"))
        .map(|(i, _)| i)
        .collect();
    let keep_from = idx.len().saturating_sub(keep);
    for &i in idx.iter().take(keep_from) {
        let content = messages[i]
            .get("content")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();
        if content.chars().count() > trim_chars {
            let short = content.chars().take(trim_chars).collect::<String>();
            messages[i]["content"] = json!(format!("{short} …[trimmed to save context]"));
        }
    }
}

// ---------------------------------------------------------------------
// agent loop
// ---------------------------------------------------------------------
pub async fn agent_loop(agent: &Agent, user_task: &str, opts: RunOptions) -> Result<String> {
    let cfg = agent.config.read().clone();

    let mut tools = match &opts.tools {
        Some(t) => t.clone(),
        None => tools::get_tools(
            &opts.mode,
            &tools::ToolOptions {
                trusted: opts.trusted,
                ..Default::default()
            },
            &skills::load_skills(&agent.store),
        ),
    };

    let emit = opts.emit.clone();
    let log = |line: String| emit(AgentEvent::Log(line));

    // ---- system prompt (orchestrator เท่านั้นที่ได้ playbook/evals/AGENTS.md) ----
    let (system, sys_logs) = build_system(agent, user_task, &opts);
    for l in sys_logs {
        log(l);
    }

    let mut messages: Vec<Value> = vec![json!({ "role": "system", "content": system })];
    let history_start = opts.history.len().saturating_sub(cfg.max_history_msgs);
    for m in opts.history.iter().skip(history_start) {
        messages.push(json!({
            "role": m.role,
            "content": exec::truncate(&m.content, cfg.max_history_chars)
        }));
    }
    messages.push(json!({ "role": "user", "content": user_task }));

    if !opts.no_banner {
        log(format!("Task: {user_task}"));
        log(format!(
            "Model: {} | maxSteps: {}{}{}",
            cfg.model,
            opts.max_steps,
            opts.temp
                .map(|t| format!(" | temp: {t}"))
                .unwrap_or_default(),
            if opts.mode == "code" {
                " | mode: 💻 code"
            } else {
                ""
            }
        ));
    }

    let specs_tok = est_tok(&serde_json::to_string(&tools).unwrap_or_default());

    // ---- สถานะของ run (ใช้เรียนรู้หลังจบ) ----
    let mut tok_total = 0u64;
    let mut errors: Vec<String> = Vec::new();
    let mut tools_used: HashMap<String, u32> = HashMap::new();
    let mut cache: HashMap<String, String> = HashMap::new();
    let mut steps_used = 0u32;
    let mut outcome: Option<&'static str> = None;
    let run_id = format!(
        "{:x}{}",
        playbook::now_ms(),
        (playbook::now_ms() % 36_000_000)
    );
    let live_specs = Arc::new(parking_lot::Mutex::new(Vec::<Value>::new()));

    for step in 1..=opts.max_steps {
        steps_used = step as u32;
        if !opts.no_banner {
            log(format!("── step {step} ───────────────────────────────"));
        }

        trim_tool_results(
            &mut messages,
            cfg.keep_tool_results,
            cfg.trim_old_tool_chars,
        );

        let msgs_json = serde_json::to_string(&messages).unwrap_or_default();
        let in_tok = specs_tok + est_tok(&msgs_json);
        log(format!("  ⛁ ~{in_tok} tok in"));
        tok_total += in_tok;

        let mut body = json!({
            "model": cfg.model,
            "messages": messages,
            "tools": tools,
        });
        if let Some(t) = opts.temp {
            body["temperature"] = json!(t);
        }

        // ---- เรียกโมเดล ----
        let msg: LlmMessage = {
            let emit2 = emit.clone();
            let mut on_delta = move |t: Option<&str>| match t {
                Some(s) => emit2(AgentEvent::AnswerDelta(s.to_string())),
                None => emit2(AgentEvent::AnswerReset),
            };
            let emit3 = emit.clone();
            let mut on_retry = move |line: &str| emit3(AgentEvent::Log(line.to_string()));

            let r = agent
                .llm
                .call_stream(&cfg, &body, &opts.signal, &mut on_delta, &mut on_retry)
                .await;
            match r {
                Ok(m) => m,
                Err(e) => {
                    // stream พัง → ลองแบบไม่ stream ก่อนยอมแพ้
                    let emit4 = emit.clone();
                    let mut on_retry2 = move |line: &str| emit4(AgentEvent::Log(line.to_string()));
                    match agent
                        .llm
                        .call(&cfg, &body, &opts.signal, &mut on_retry2)
                        .await
                    {
                        Ok(m2) => {
                            emit(AgentEvent::AnswerReset);
                            m2
                        }
                        Err(e2) => {
                            outcome = Some(if opts.signal.load(Ordering::Relaxed) {
                                "stopped"
                            } else {
                                "crashed"
                            });
                            finalize(
                                agent,
                                &opts,
                                user_task,
                                &run_id,
                                &cfg,
                                steps_used,
                                &tools_used,
                                &errors,
                                tok_total,
                                outcome.unwrap(),
                                &emit,
                            )
                            .await;
                            return Err(e2);
                        }
                    }
                }
            }
        };

        let out_tok = msg
            .usage
            .map(|u| u.completion_tokens)
            .filter(|t| *t > 0)
            .unwrap_or_else(|| {
                est_tok(&msg.content)
                    + est_tok(&serde_json::to_string(&msg.tool_calls).unwrap_or_default())
            });
        log(format!("  ⛁ ~{out_tok} tok out"));
        tok_total += out_tok;

        // เก็บเฉพาะ field ที่ API ต้องการ
        let mut assistant = json!({ "role": "assistant", "content": msg.content });
        if !msg.tool_calls.is_empty() {
            let tcs: Vec<Value> = msg
                .tool_calls
                .iter()
                .map(|tc| {
                    json!({
                        "id": tc.id,
                        "type": tc.kind,
                        "function": { "name": tc.function.name, "arguments": tc.function.arguments }
                    })
                })
                .collect();
            assistant["tool_calls"] = json!(tcs);
        }
        messages.push(assistant);

        // ---- โมเดลขอใช้ tool ----
        if !msg.tool_calls.is_empty() {
            emit(AgentEvent::AnswerReset);
            log(format!(
                "  Model requests: {}",
                msg.tool_calls
                    .iter()
                    .map(|t| t.function.name.clone())
                    .collect::<Vec<_>>()
                    .join(", ")
            ));

            let results = run_tool_calls(
                agent,
                &cfg,
                &opts,
                &msg.tool_calls,
                &mut cache,
                &mut errors,
                &mut tools_used,
                &live_specs,
                &emit,
                &run_id,
            )
            .await;

            for r in results {
                messages.push(json!({
                    "role": "tool",
                    "tool_call_id": r.id,
                    "content": exec::truncate(&r.result, 8000)
                }));
            }
            // live-spec: tool ที่เพิ่งสร้างสำเร็จ → ใช้ได้ทันทีใน run เดียวกัน
            let fresh = live_specs.lock().clone();
            for spec in fresh {
                if !tools
                    .iter()
                    .any(|t| t.pointer("/function/name") == spec.pointer("/function/name"))
                {
                    tools.push(spec);
                }
            }
            continue;
        }

        // ---- โมเดลตอบจบ ----
        if !opts.no_banner {
            log("══════════ FINAL ANSWER ══════════".to_string());
        }
        outcome = Some(if errors.is_empty() {
            "ok"
        } else {
            "answered-with-errors"
        });
        log(format!("  ⛁ session total ~{tok_total} tok"));

        finalize(
            agent,
            &opts,
            user_task,
            &run_id,
            &cfg,
            steps_used,
            &tools_used,
            &errors,
            tok_total,
            outcome.unwrap(),
            &emit,
        )
        .await;

        return Ok(msg.content);
    }

    // ---- ครบ maxSteps ----
    let stop_msg = format!("Stopped: reached max steps ({}).", opts.max_steps);
    log(format!(
        "  Reached maxSteps ({}) — stopping to avoid runaway loop.",
        opts.max_steps
    ));
    outcome = Some("maxsteps");
    log(format!("  ⛁ session total ~{tok_total} tok"));
    finalize(
        agent,
        &opts,
        user_task,
        &run_id,
        &cfg,
        steps_used,
        &tools_used,
        &errors,
        tok_total,
        outcome.unwrap(),
        &emit,
    )
    .await;
    Ok(stop_msg)
}

// ---------------------------------------------------------------------
// system prompt
// ---------------------------------------------------------------------
fn build_system(agent: &Agent, user_task: &str, opts: &RunOptions) -> (String, Vec<String>) {
    if opts.depth != 0 {
        return (prompt::SYSTEM_PROMPT.to_string(), Vec::new());
    }
    let today = chrono::Local::now().format("%Y-%m-%d").to_string();
    let memory_keys: Vec<String> = agent
        .store
        .load_memory()
        .iter()
        .map(|m| m.key.clone())
        .collect();
    let pb = playbook::load_playbook_for_task(&agent.store, user_task);
    let ev = evals::load_evals_for_task(&agent.store, user_task);
    let ag = agent.store.read_agents_rules();

    prompt::build_system_prompt(
        &opts.mode,
        opts.trusted,
        opts.plan_mode,
        opts.approved_plan.as_ref(),
        &memory_keys,
        if pb.is_empty() {
            None
        } else {
            Some(pb.as_str())
        },
        if ev.is_empty() {
            None
        } else {
            Some(ev.as_str())
        },
        ag.as_deref(),
        &today,
    )
}

// ---------------------------------------------------------------------
// เรียก tool ทั้งชุด (ขนาน + dedupe cache)
// ---------------------------------------------------------------------
struct ToolResult {
    id: String,
    result: String,
}

#[allow(clippy::too_many_arguments)]
async fn run_tool_calls(
    agent: &Agent,
    cfg: &Config,
    opts: &RunOptions,
    tool_calls: &[llm::ToolCall],
    cache: &mut HashMap<String, String>,
    errors: &mut Vec<String>,
    tools_used: &mut HashMap<String, u32>,
    live_specs: &Arc<parking_lot::Mutex<Vec<Value>>>,
    emit: &EventSink,
    run_id: &str,
) -> Vec<ToolResult> {
    let root = opts
        .root
        .clone()
        .unwrap_or_else(|| agent.config.read().data_dir.clone());

    let mut futs = Vec::new();
    for tc in tool_calls {
        let args: Value =
            serde_json::from_str(&tc.function.arguments).unwrap_or_else(|_| json!({}));
        let key = format!(
            "{}::{}",
            tc.function.name,
            serde_json::to_string(&args).unwrap_or_default()
        );

        emit(AgentEvent::Log(format!(
            "  → {}({})",
            tc.function.name,
            exec::truncate(&serde_json::to_string(&args).unwrap_or_default(), 120)
        )));

        // dedupe: เคยเรียกเดียวกันใน run นี้ → ใช้ผลเดิม
        let cached = cache.get(&key).cloned();
        if cached.is_some() {
            emit(AgentEvent::Log(format!(
                "  ↻ cached ({}) — reused to save cost",
                tc.function.name
            )));
        }

        let ctx = ToolCtx {
            root: root.clone(),
            trusted: opts.trusted,
            depth: opts.depth,
            fetch_chars: if opts.depth > 0 {
                cfg.subagent_fetch_chars
            } else {
                cfg.fetch_max_chars
            },
            signal: opts.signal.clone(),
            store: agent.store.clone(),
            config: agent.config.clone(),
            llm: agent.llm.clone(),
            on_run: opts.on_run.clone(),
            on_plan: opts.on_plan.clone(),
            live_specs: live_specs.clone(),
        };

        let name = tc.function.name.clone();
        let id = tc.id.clone();
        let emit2 = emit.clone();
        let run_id = run_id.clone();

        futs.push(async move {
            let result = match cached {
                Some(hit) => hit,
                None => {
                    // Tier 1: snapshot ก่อนแตะไฟล์ (ห้ามทำให้ run พัง — error ถูกกลืนไว้)
                    if let Some(rec) =
                        checkpoint::checkpoint_before(&ctx.store, &name, &args, &ctx.root, &run_id)
                    {
                        emit2(AgentEvent::Log(format!(
                            "  🔒 checkpoint ({} file{}) ก่อน {name}",
                            rec.files.len(),
                            if rec.files.len() > 1 { "s" } else { "" }
                        )));
                    }
                    match exec::run_tool(&name, &args, &ctx).await {
                        Ok(r) => r,
                        Err(e) => {
                            let msg = format!("Error: {}", e);
                            emit2(AgentEvent::Log(format!("  ✗ {msg}")));
                            msg
                        }
                    }
                }
            };
            Some(ToolResult { id, result })
        });
    }

    let results = futures_util::future::join_all(futs).await;

    let mut out = Vec::new();
    for (i, r) in results.into_iter().enumerate() {
        let Some(r) = r else { continue };
        // cache + error accounting
        let tc = &tool_calls[i];
        let args: Value =
            serde_json::from_str(&tc.function.arguments).unwrap_or_else(|_| json!({}));
        let key = format!(
            "{}::{}",
            tc.function.name,
            serde_json::to_string(&args).unwrap_or_default()
        );
        if r.result.starts_with("Error: ") {
            let msg = playbook::scrub_secrets(&r.result.chars().skip(7).collect::<String>());
            errors.push(msg.chars().take(200).collect());
            if errors.len() > 8 {
                errors.remove(0);
            }
        }
        cache.insert(key, r.result.clone());
        *tools_used.entry(tc.function.name.clone()).or_insert(0) += 1;
        out.push(r);
    }
    out
}

// ---------------------------------------------------------------------
// ปิดงาน: event log + circuit 1 (reflect) + circuit 3 (eval)
// ---------------------------------------------------------------------
#[allow(clippy::too_many_arguments)]
async fn finalize(
    agent: &Agent,
    opts: &RunOptions,
    user_task: &str,
    run_id: &str,
    cfg: &Config,
    steps: u32,
    tools_used: &HashMap<String, u32>,
    errors: &[String],
    tok: u64,
    outcome: &str,
    emit: &EventSink,
) {
    if opts.depth != 0 {
        return;
    }

    // event log (append-only)
    let ev = crate::state::RunEvent {
        run_id: run_id.to_string(),
        ts: playbook::now_ms(),
        task: user_task.to_string(),
        steps,
        tools: json!(tools_used),
        outcome: outcome.to_string(),
        errors: errors.to_vec(),
        tok,
        model: cfg.model.clone(),
    };
    let _ = agent.store.append_event(&ev);
    agent.store.trim_events(playbook::EVENTS_CAP);

    // circuit 1: reflect (เฉพาะ run ที่มี error) — 1 LLM call
    if !errors.is_empty() {
        let reflect = reflect_on_run(agent, cfg, user_task, errors, opts).await;
        if let Some((bumped, rule)) = reflect {
            emit(AgentEvent::Log(format!(
                "  📓 playbook {}: {}",
                if bumped { "⬆ bump" } else { "➕ new rule" },
                exec::truncate(&rule.rule, 120)
            )));
        }
    }

    // circuit 3: eval (เฉพาะงานสำเร็จ + ≥3 steps + ใช้ tool)
    if !crate::config::evals_off() && outcome == "ok" && steps >= 3 && !tools_used.is_empty() {
        if let Some((keywords, check)) = eval_on_run(agent, cfg, user_task, opts).await {
            let (bumped, entry) = evals::add_eval(&agent.store, &keywords, &check);
            emit(AgentEvent::Log(format!(
                "  🎯 eval {}: {}",
                if bumped {
                    "⬆ bump"
                } else {
                    "➕ new checklist"
                },
                exec::truncate(&entry.check.join(" → "), 90)
            )));
        }
    }
}

async fn reflect_on_run(
    agent: &Agent,
    cfg: &Config,
    user_task: &str,
    errors: &[String],
    opts: &RunOptions,
) -> Option<(bool, crate::state::Rule)> {
    let errs = errors.join("; ");
    let body = json!({
        "model": cfg.model,
        "messages": [
            { "role": "system", "content": prompt::REFLECT_SYSTEM },
            { "role": "user", "content": format!(
                "Task: {}\nErrors: {}",
                exec::truncate(user_task, 200),
                exec::truncate(&errs, 600)
            ) }
        ],
        "temperature": 0,
        "max_tokens": 120
    });
    let msg = agent
        .llm
        .call(cfg, &body, &opts.signal, &mut |_| {})
        .await
        .ok()?;
    let text = msg.content.trim();
    // รูปแบบ: "TAG: rule-text"
    let (tag, rule) = text.split_once(':')?;
    let tag = tag.trim().to_lowercase();
    let rule = rule.trim();
    if rule.is_empty() {
        return None;
    }
    playbook::add_rule(&agent.store, rule, &tag)
}

async fn eval_on_run(
    agent: &Agent,
    cfg: &Config,
    user_task: &str,
    opts: &RunOptions,
) -> Option<(Vec<String>, Vec<String>)> {
    let body = json!({
        "model": cfg.model,
        "messages": [
            { "role": "system", "content": prompt::EVAL_SYSTEM },
            { "role": "user", "content": format!("Task: {}", exec::truncate(user_task, 200)) }
        ],
        "temperature": 0,
        "max_tokens": 120
    });
    let msg = agent
        .llm
        .call(cfg, &body, &opts.signal, &mut |_| {})
        .await
        .ok()?;
    let text = msg.content.trim();

    // "PATTERN: keywords | CHECK: step1; step2; step3"
    let (pattern, check) = text.split_once('|')?;
    let pattern = pattern
        .trim()
        .strip_prefix("PATTERN:")
        .unwrap_or(pattern.trim())
        .trim();
    let check = check
        .trim()
        .strip_prefix("CHECK:")
        .unwrap_or(check.trim())
        .trim();

    let keywords = evals::task_words(pattern);
    let checks: Vec<String> = check
        .split(';')
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .take(3)
        .map(|s| s.chars().take(80).collect())
        .collect();
    if keywords.is_empty() || checks.is_empty() {
        return None;
    }
    Some((keywords, checks))
}

// ---------------------------------------------------------------------
// sub-agent (multi-agent)
// ---------------------------------------------------------------------
pub async fn run_subagent(
    agent: &Agent,
    brief: &str,
    opts: &RunOptions,
    emit: &EventSink,
) -> Result<String> {
    if opts.depth + 1 > MAX_SUBAGENT_DEPTH {
        return Err(AppError::msg(
            "Depth limit reached: this agent cannot spawn further sub-agents",
        ));
    }
    emit(AgentEvent::Log(format!(
        "  spawning d{} for brief: \"{}\"...",
        opts.depth + 1,
        exec::truncate(brief, 80)
    )));

    let sub_tools = tools::get_tools(
        "research",
        &tools::ToolOptions {
            trusted: opts.trusted,
            subagent: true,
            ..Default::default()
        },
        &[],
    );

    let mut sub_opts = RunOptions {
        depth: opts.depth + 1,
        tools: Some(sub_tools),
        max_steps: 6,
        no_banner: true,
        temp: opts.temp,
        trusted: opts.trusted,
        signal: opts.signal.clone(),
        emit: emit.clone(),
        ..Default::default()
    };
    sub_opts.mode = "research".to_string();

    let report = agent_loop(agent, brief, sub_opts).await?;
    Ok(format!(
        "### SUB-AGENT REPORT\n{}",
        exec::truncate(&report, 4000)
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn event_type_names_match_js() {
        let cases = [
            (AgentEvent::Log("x".into()), "log"),
            (AgentEvent::Answer("x".into()), "answer"),
            (AgentEvent::AnswerDelta("x".into()), "answer-delta"),
            (AgentEvent::AnswerReset, "answer-reset"),
            (AgentEvent::Error("x".into()), "error"),
            (AgentEvent::Queued, "queued"),
        ];
        for (ev, want) in cases {
            let v = serde_json::to_value(&ev).unwrap();
            assert_eq!(v.get("type").unwrap().as_str().unwrap(), want);
        }
    }

    #[test]
    fn trims_old_tool_results_only() {
        let mut msgs = vec![
            json!({"role":"tool","content":"x".repeat(500)}),
            json!({"role":"tool","content":"y".repeat(500)}),
            json!({"role":"tool","content":"z".repeat(500)}),
            json!({"role":"user","content":"hello"}),
        ];
        trim_tool_results(&mut msgs, 2, 300);
        // ผลเก่าสุด (index 0) ถูกตัด, อีก 2 ตัวหลังเต็ม
        assert!(msgs[0]["content"].as_str().unwrap().contains("trimmed"));
        assert_eq!(msgs[1]["content"].as_str().unwrap().len(), 500);
        assert_eq!(msgs[2]["content"].as_str().unwrap().len(), 500);
        assert_eq!(msgs[3]["content"].as_str().unwrap(), "hello");
    }
}
